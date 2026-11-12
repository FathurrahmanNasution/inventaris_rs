"""Optional real-browser integration check: Python + playwright + installed Edge.

Uses STOCK_TEST_DATABASE_URL with the same local-only guard as the PostgreSQL suite.
Creates and removes only its own fresh schema. Never uses DATABASE_URL.
"""
import json
import os
from pathlib import Path
import subprocess

from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
server = subprocess.Popen(
    ['node', 'tests/helpers/stock-ui-server.cjs'], cwd=root, env=os.environ.copy(),
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, encoding='utf-8', errors='replace',
)
try:
    config = None
    for line in server.stdout:
        if line.startswith('{'):
            config = json.loads(line)
            if config.get('ready'):
                break
    if not config:
        raise RuntimeError('UI fixture server failed: ' + server.stderr.read())
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        context = browser.new_context(timezone_id='Asia/Jakarta')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        origin = config['origin']
        # Exercise the existing login page against our isolated fixture user.
        page.goto(origin + '/login')
        page.locator('#username').fill('ui_kepala')
        page.locator('#password').fill('StockUi123!')
        page.locator('button[type=submit]').click()
        page.wait_for_url('**/dashboard')

        page.goto(origin + '/stok-masuk')
        expect(page.locator('#med option')).to_have_count(2)
        page.locator('#ref').fill('FAK-UI-001')
        page.locator('#supplier').fill('PBF Uji Browser')
        page.locator('#med').select_option('MED-UI')
        page.locator('#batch').fill('UI-IN')
        page.locator('#exp').fill(config['expiry'])
        page.locator('#qty').fill('5')
        page.locator('#price').fill('100.25')
        page.locator('#notes').fill('Catatan penerimaan UI')
        page.locator('#save').click()
        expect(page.locator('#ok')).to_be_visible()
        expect(page.locator('#recent')).to_contain_text('FAK-UI-001')
        expect(page.locator('#receipt')).to_contain_text('100,25')
        page.evaluate('window.print = () => { window.__printed = true; }')
        page.locator('#print').click()
        assert page.evaluate('window.__printed')
        page.emulate_media(media='print')
        expect(page.locator('#receipt')).to_be_visible()
        page.emulate_media(media='screen')

        page.goto(origin + '/stok-keluar')
        expect(page.locator('#drug option')).to_have_count(2)
        page.locator('#refNo').fill('RSP-UI-001')
        page.locator('#unit').fill('IGD Uji')
        page.locator('#drug').select_option('MED-UI')
        expect(page.locator('#batchList')).to_contain_text('PRE-EARLY')
        page.locator('#qty').fill('6')
        expect(page.locator('#batchAuto')).to_have_value('PRE-EARLY: 3 | UI-IN: 3')
        page.locator('#note').fill('Catatan pengeluaran UI')
        page.locator('#saveOut').click()
        expect(page.locator('#receipt')).to_contain_text('RSP-UI-001')
        expect(page.locator('#receipt')).to_contain_text('IGD Uji')
        expect(page.locator('#receipt')).to_contain_text('Batch PRE-EARLY')
        expect(page.locator('#receipt')).to_contain_text('Batch UI-IN')
        expect(page.locator('#message')).to_contain_text('2 batch')
        page.evaluate('window.print = () => { window.__printed = true; }')
        page.locator('#printOut').click()
        assert page.evaluate('window.__printed')
        page.emulate_media(media='print')
        expect(page.locator('#receipt')).to_be_visible()
        response = context.request.get(origin + '/api/stock/history?medicine_code=MED-UI')
        assert response.status == 200
        history = response.json()['data']
        assert history['final_balance'] == 10
        assert [entry['quantity'] for entry in history['entries'][-2:]] == [3, 3]
        assert not errors, errors
        context.close()
        browser.close()
    print('PASS: browser login, stock IN, decimal price, FEFO preview, multi-batch OUT, receipts, print controls, persisted history; no page errors.')
finally:
    if server.poll() is None:
        server.stdin.write('stop\n')
        server.stdin.flush()
        try:
            server.wait(timeout=15)
        except subprocess.TimeoutExpired:
            server.terminate()
            server.wait(timeout=5)
    if server.returncode:
        raise RuntimeError('UI fixture cleanup/server failed: ' + server.stderr.read())
