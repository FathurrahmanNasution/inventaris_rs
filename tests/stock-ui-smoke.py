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
        page.set_default_timeout(10000)
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
        stock_posts = []
        page.on('request', lambda request: stock_posts.append(request) if request.method == 'POST' and request.url.endswith('/api/stock/out') else None)
        page.locator('#refNo').fill('RSP-UI-001')
        page.locator('#unit').fill('IGD Uji')
        held_batches = []
        batch_pattern = '**/api/stock/medicines/MED-UI/batches'
        page.route(batch_pattern, lambda route: held_batches.append(route))
        page.locator('#drug').select_option('MED-UI')
        page.locator('#qty').fill('6')
        expect(page.locator('#batchAuto')).to_have_value('Memuat ketersediaan batch...')
        expect(page.locator('#saveOut')).to_be_disabled()
        page.locator('#outForm').dispatch_event('submit')
        expect(page.locator('#message')).to_contain_text('Tunggu sampai')
        assert not stock_posts
        available = context.request.get(origin + '/api/stock/medicines/MED-UI/batches').json()
        assert len(held_batches) == 1
        with page.expect_response(batch_pattern):
            held_batches[0].fulfill(json=available)
        page.unroute(batch_pattern)
        expect(page.locator('#batchList')).to_contain_text('PRE-EARLY')
        page.locator('#qty').fill('17')
        expect(page.locator('#saveOut')).to_be_disabled()
        expect(page.locator('#message')).to_contain_text('Tersedia: 16')
        page.locator('#outForm').dispatch_event('submit')
        assert not stock_posts
        page.locator('#qty').fill('6')
        expect(page.locator('#batchAuto')).to_have_value('PRE-EARLY: 3 | UI-IN: 3')
        expect(page.locator('#saveOut')).to_be_enabled()
        page.locator('#note').fill('Catatan pengeluaran UI')
        confirmations = []

        def cancel(dialog):
            confirmations.append(dialog.message)
            dialog.dismiss()

        page.once('dialog', cancel)
        page.locator('#saveOut').click()
        for value in ['Obat Uji Browser', '6 Tablet', 'RSP-UI-001', 'PRE-EARLY: 3', 'UI-IN: 3']:
            assert value in confirmations[0]
        assert not stock_posts
        assert context.request.get(origin + '/api/stock/history?medicine_code=MED-UI').json()['data']['final_balance'] == 16
        expect(page.locator('#qty')).to_have_value('6')
        expect(page.locator('#note')).to_have_value('Catatan pengeluaran UI')

        # Hold the POST before it reaches the local server and attempt a second submit.
        held_out = []
        out_pattern = '**/api/stock/out'
        page.route(out_pattern, lambda route: held_out.append(route))
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('#saveOut').click()
        expect(page.locator('#saveOut')).to_be_disabled()
        page.locator('#outForm').dispatch_event('submit')
        assert len(stock_posts) == 1 and len(held_out) == 1
        with page.expect_response(out_pattern):
            held_out[0].continue_()
        page.unroute(out_pattern)
        expect(page.locator('#receipt')).to_contain_text('RSP-UI-001')
        expect(page.locator('#receipt')).to_contain_text('IGD Uji')
        expect(page.locator('#receipt')).to_contain_text('Batch PRE-EARLY')
        expect(page.locator('#receipt')).to_contain_text('Batch UI-IN')
        expect(page.locator('#message')).to_contain_text('2 batch')
        expect(page.locator('#refNo')).to_have_value('RSP-UI-001')
        expect(page.locator('#unit')).to_have_value('IGD Uji')
        expect(page.locator('#drug')).to_have_value('MED-UI')
        expect(page.locator('#qty')).to_have_value('')
        expect(page.locator('#note')).to_have_value('')
        expect(page.locator('#batchList')).to_contain_text('Sisa: 2')
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
    print('PASS: browser login/IN, batch loading, insufficient-stock block, multi-batch FEFO confirmation/cancel, duplicate-submit prevention, preserved form context, refreshed stock, receipts/print/history; no page errors.')
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
