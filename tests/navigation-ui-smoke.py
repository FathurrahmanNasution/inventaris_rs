"""Sidebar/403 smoke tests in Edge using the read-only mock HTTP fixture.

Requires Python Playwright and Microsoft Edge. Does not connect to PostgreSQL.
"""
import json
from pathlib import Path
import subprocess
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
server = subprocess.Popen(
    ['node', 'tests/helpers/navigation-ui-server.cjs'], cwd=root,
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
        raise RuntimeError('Navigation fixture did not become ready')
    origin = config['origin']
    cases = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        for role, allow_in, allow_out in [
            ('admin', False, False), ('gudang', True, False),
            ('pelayanan', False, True), ('kepala_farmasi', True, True),
        ]:
            context = browser.new_context()
            assert context.request.get(origin + '/__fixture/session/' + role).ok
            denied = [href for href, allowed in [('/stok-masuk', allow_in), ('/stok-keluar', allow_out)] if not allowed]
            # Observe parsing, dynamic menu insertion, delayed /me and later frames.
            context.add_init_script('''(() => {
              const denied = DENIED_PATHS;
              window.stockMenuFlashes = [];
              function inspect() {
                for (const a of document.querySelectorAll('a[href]'))
                  if (denied.includes(a.getAttribute('href')) && a.getClientRects().length &&
                      getComputedStyle(a).display !== 'none' && !a.hidden)
                    window.stockMenuFlashes.push(a.getAttribute('href'));
              }
              new MutationObserver(inspect).observe(document, { childList: true, subtree: true, attributes: true });
              function frame() { inspect(); requestAnimationFrame(frame); }
              requestAnimationFrame(frame);
            })();'''.replace('DENIED_PATHS', json.dumps(denied)))
            pages = ['dashboard', 'data-obat', 'monitoring', 'laporan']
            if allow_in:
                pages.append('stok-masuk')
            if allow_out:
                pages.append('stok-keluar')
            if role == 'admin':
                pages.append('admin')
            for name in pages:
                page = context.new_page()
                page.set_default_timeout(5000)
                errors, pending_auth = [], []
                page.on('pageerror', lambda error: errors.append(str(error)))

                def api(route):
                    pathname = urlsplit(route.request.url).path
                    assert route.request.method == 'GET', 'Unexpected mutation in navigation smoke'
                    if pathname == '/api/auth/me':
                        pending_auth.append(route)
                        return
                    data = {
                        '/api/users': {'users': []},
                        '/api/audit-logs': {'logs': [], 'page': 1, 'hasMore': False},
                        '/api/monitoring/expiry': {'alerts': [], 'summary': {'all': 0, 'critical': 0, 'warning': 0}},
                        '/api/laporan/opname': {'sessions': []},
                        '/api/stock/medicines': {'data': []},
                        '/api/stock/receipts': [],
                    }
                    assert pathname in data, 'Unexpected fixture request: ' + pathname
                    route.fulfill(json={'success': True, 'data': data[pathname]})

                page.route('**/api/**', api)
                response = page.goto(origin + '/' + name, wait_until='domcontentloaded')
                assert response.status == 200
                for href, allowed in [('/stok-masuk', allow_in), ('/stok-keluar', allow_out)]:
                    link = page.locator('aside[aria-label="Menu utama"] a[href="' + href + '"]')
                    expect(link).to_have_count(1)
                    (expect(link).to_be_visible if allowed else expect(link).to_be_hidden)()
                # Wait with /me deliberately unresolved; no forbidden link may flash.
                page.wait_for_timeout(250)
                assert pending_auth, 'Expected existing /me request'
                assert page.evaluate('window.stockMenuFlashes') == []
                pending_auth[0].fulfill(json={'success': True, 'data': {'user': {
                    'username': 'nav_' + role, 'role': role, 'user_id': 1, 'status': 'aktif',
                }}})
                expect(page.locator('#identity')).to_contain_text('nav_' + role)
                if name == 'admin':
                    expect(page.locator('#addUser')).to_be_enabled()
                    page.locator('#addUser').click()
                    expect(page.locator('#userDialog')).to_be_visible()
                    page.locator('[data-close="userDialog"]').click()
                page.wait_for_timeout(50)
                assert page.evaluate('window.stockMenuFlashes') == []
                assert not errors, errors
                page.close()
                cases += 1

            # Real direct navigation returns a readable 403 with the original status.
            for href in denied:
                page = context.new_page()
                response = page.goto(origin + href)
                assert response.status == 403
                expect(page.get_by_role('heading', name='Akses ditolak')).to_be_visible()
                expect(page.get_by_role('link', name='Kembali ke Dashboard')).to_have_attribute('href', '/dashboard')
                page.close()
                cases += 1
            context.close()

            # Server-side visibility also applies when browser JavaScript is disabled.
            no_js = browser.new_context(java_script_enabled=False)
            assert no_js.request.get(origin + '/__fixture/session/' + role).ok
            page = no_js.new_page()
            assert page.goto(origin + '/monitoring').status == 200
            for href, allowed in [('/stok-masuk', allow_in), ('/stok-keluar', allow_out)]:
                link = page.locator('aside a[href="' + href + '"]')
                (expect(link).to_be_visible if allowed else expect(link).to_be_hidden)()
            no_js.close()
            cases += 1

        invalid = browser.new_context()
        invalid.add_cookies([{'name': 'token', 'value': 'invalid-session', 'url': origin}])
        page = invalid.new_page()
        for target in ['/stok-masuk', '/stok-keluar']:
            page.goto(origin + target)
            expect(page).to_have_url(origin + '/login')
            cases += 1
        invalid.close()
        browser.close()
    print(json.dumps({'browser': 'Edge headless', 'cases_passed': cases, 'unauthorized_menu_flashes': 0,
                      'postgres_connections': 0, 'writes': 0}))
finally:
    if server.stdin:
        server.stdin.close()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.terminate()
        server.wait(timeout=5)
