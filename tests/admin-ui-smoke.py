"""Real Admin UI regression on a fresh local schema without stock migrations.

Requires ADMIN_TEST_DATABASE_URL, Python Playwright and installed Microsoft Edge.
All accounts/passwords here are disposable fixtures, never README/shared accounts.
"""
import json
import os
from pathlib import Path
import subprocess

from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[1]
server = subprocess.Popen(
    ['node', 'tests/helpers/admin-ui-server.cjs'], cwd=root, env=os.environ.copy(),
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
        raise RuntimeError('Admin UI fixture failed: ' + server.stderr.read())
    with sync_playwright() as p:
        browser = p.chromium.launch(channel='msedge', headless=True)
        context = browser.new_context()
        page = context.new_page()
        page.set_default_timeout(10000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        origin = config['origin']

        def login(username, password):
            page.goto(origin + '/login')
            page.locator('#username').fill(username)
            page.locator('#password').fill(password)
            page.locator('#submitButton').click()
            page.wait_for_url('**/admin')
            expect(page.locator('#addUser')).to_be_enabled()

        def added_row():
            return page.locator('#usersBody tr').filter(has_text='ui_added')

        login('ui_admin', 'UiOriginal123!')
        expect(page.locator('aside a[href="/stok-masuk"]')).to_be_hidden()
        expect(page.locator('aside a[href="/stok-keluar"]')).to_be_hidden()
        expect(page.locator('#userHelp')).to_contain_text('detail terbaru')
        expect(page.locator('#usersBody tr')).to_have_count(20)
        page.locator('#nextUsers').click()
        expect(page.locator('#usersBody tr')).to_have_count(4)
        page.locator('#prevUsers').click()

        # Preserve and exercise the existing Add Account card/form, including errors.
        page.locator('#addUser').click()
        expect(page.locator('#formTitle')).to_have_text('Tambah Pengguna')
        expect(page.locator('#statusField')).to_be_hidden()
        page.locator('#username').fill('ui_added')
        page.locator('#role').select_option('pelayanan')
        page.locator('#password').fill('UiAdded123!')
        page.locator('#confirmPassword').fill('Different123!')
        page.locator('#saveUser').click()
        expect(page.locator('#formError')).to_contain_text('Konfirmasi kata sandi tidak cocok')
        page.locator('#confirmPassword').fill('UiAdded123!')
        page.locator('#saveUser').click()
        expect(page.locator('#userDialog')).not_to_be_visible()
        expect(page.locator('#message')).to_contain_text('ditambahkan')
        accounts = context.request.get(origin + '/api/users').json()['data']['users']
        account = next(user for user in accounts if user['username'] == 'ui_added')
        account_id = account['user_id']
        assert account['status'] == 'aktif' and 'password_hash' not in account
        target_context = browser.new_context()
        assert target_context.request.post(origin + '/api/auth/login', data={
            'username': 'ui_added', 'password': 'UiAdded123!'
        }).status == 200

        # Search/filter use the existing 20-row browser pagination contract.
        page.locator('#userSearch').fill('ui_added')
        page.locator('#roleFilter').select_option('gudang')
        expect(page.locator('#usersBody')).to_contain_text('Tidak ada pengguna')
        page.locator('#roleFilter').select_option('pelayanan')
        expect(added_row()).to_have_count(1)
        page.locator('#roleFilter').select_option('')

        # Change the DB through the API after list load: Edit must fetch fresh details.
        assert context.request.patch(origin + '/api/users/' + str(account_id), data={
            'username': 'ui_added_updated', 'role': 'pelayanan', 'status': 'aktif'
        }).status == 200
        with page.expect_response('**/api/users/' + str(account_id)) as detail:
            added_row().get_by_role('button', name='Edit', exact=True).click()
        assert detail.value.status == 200
        expect(page.locator('#username')).to_have_value('ui_added_updated')
        expect(page.locator('#initialPasswordFields')).to_be_hidden()
        page.locator('#role').select_option('gudang')
        page.locator('#status').select_option('nonaktif')
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('#saveUser').click()
        expect(page.locator('#userDialog')).not_to_be_visible()
        expect(added_row()).to_contain_text('Nonaktif')
        assert target_context.request.get(origin + '/api/auth/me').status == 401
        inactive_login = target_context.request.post(origin + '/api/auth/login', data={
            'username': 'ui_added_updated', 'password': 'UiAdded123!'
        })
        assert inactive_login.status == 401
        page.locator('#statusFilter').select_option('aktif')
        expect(page.locator('#usersBody')).to_contain_text('Tidak ada pengguna')
        page.locator('#statusFilter').select_option('nonaktif')
        expect(added_row()).to_have_count(1)
        page.locator('#statusFilter').select_option('')

        added_row().get_by_role('button', name='Edit', exact=True).click()
        expect(page.locator('#userDialog')).to_be_visible()
        page.locator('#status').select_option('aktif')
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('#saveUser').click()
        expect(page.locator('#userDialog')).not_to_be_visible()
        expect(added_row()).to_contain_text('Aktif')
        added_row().locator('button.danger').click()
        page.locator('#resetPassword').fill('UiReset123!')
        page.locator('#resetConfirm').fill('Different123!')
        page.locator('#saveReset').click()
        expect(page.locator('#resetError')).to_contain_text('Konfirmasi kata sandi tidak cocok')
        page.locator('#resetConfirm').fill('UiReset123!')
        page.locator('#saveReset').click()
        expect(page.locator('#resetDialog')).not_to_be_visible()
        assert target_context.request.get(origin + '/api/auth/me').status == 401
        assert target_context.request.post(origin + '/api/auth/login', data={
            'username': 'ui_added_updated', 'password': 'UiReset123!'
        }).status == 200
        assert target_context.request.get(origin + '/api/users').status == 403

        page.locator('#logSearch').fill('reset_password')
        page.locator('#logFilter button').click()
        expect(page.locator('#logsBody tr')).to_have_count(1)
        expect(page.locator('#logsBody')).to_contain_text('reset_password: target=' + str(account_id))
        page.locator('#logSearch').fill('fixture_event')
        page.locator('#logFilter button').click()
        expect(page.locator('#logsBody tr')).to_have_count(50)
        page.locator('#nextLogs').click()
        expect(page.locator('#logsBody tr')).to_have_count(5)
        assert 'UiReset123!' not in page.locator('#logsBody').inner_text()

        # A detail-load failure must not open an editor containing stale list data.
        pattern = '**/api/users/' + str(account_id)
        page.route(pattern, lambda route: route.fulfill(status=404, json={
            'success': False, 'message': 'Pengguna tidak ditemukan.'
        }))
        added_row().get_by_role('button', name='Edit', exact=True).click()
        expect(page.locator('#message')).to_contain_text('Pengguna tidak ditemukan')
        expect(page.locator('#userDialog')).not_to_be_visible()
        page.unroute(pattern)

        # Own credentials remain on the existing self-service page.
        page.goto(origin + '/account/password')
        page.locator('#oldPassword').fill('wrong')
        page.locator('#newPassword').fill('UiChanged123!')
        page.locator('#confirmation').fill('UiChanged123!')
        page.locator('#save').click()
        expect(page.locator('#message')).to_contain_text('Kata sandi lama tidak sesuai')
        page.locator('#oldPassword').fill('UiOriginal123!')
        page.locator('#save').click()
        expect(page.locator('#loginLink')).to_be_visible()
        assert context.request.get(origin + '/api/auth/me').status == 401
        login('ui_admin', 'UiChanged123!')
        page.locator('#userSearch').fill('ui_admin')
        page.locator('#usersBody tr').get_by_role('button', name='Edit', exact=True).click()
        expect(page.locator('#role')).to_be_disabled()
        expect(page.locator('#status')).to_be_disabled()
        page.locator('[data-close="userDialog"]').click()
        page.locator('#logout').click()
        page.wait_for_url('**/login')
        assert context.request.get(origin + '/api/auth/me').status == 401
        assert not errors, errors
        target_context.close()
        context.close()
        browser.close()
    print('PASS: Admin login/logout, list/filter/pagination, untouched Add Account, fresh details, edit roles/status, reset/change password, audit search/pagination, validation/error states, self protection; no page errors.')
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
        raise RuntimeError('Admin UI fixture/cleanup failed: ' + server.stderr.read())
