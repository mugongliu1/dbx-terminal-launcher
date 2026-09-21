"""Browser regression for split layouts, session routing and resize."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SDK = r"""(() => {
  window.calls = [];
  window.dbxPlugin = {
    ready: Promise.resolve({}), locale: 'en',
    onEvent: callback => { window.emit = callback; return () => {}; },
    invoke: async (method, params) => { calls.push({method, ...params}); return {}; },
    notify: async (method, params) => { calls.push({method, ...params}); },
    decodeBase64: data => Uint8Array.from(atob(data), c => c.charCodeAt(0))
  };
  window.output = (sessionId, text) => emit({type: 'event', method: 'terminal/output',
    params: {sessionId, dataBase64: btoa(text)}});
})()"""


def run():
    with sync_playwright() as p:
        options = {'headless': True}
        if os.environ.get('BROWSER_EXECUTABLE'):
            options['executable_path'] = os.environ['BROWSER_EXECUTABLE']
        browser = p.chromium.launch(**options)
        page = browser.new_page(viewport={'width': 1200, 'height': 800})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('http://terminal.test/**', lambda r: r.fulfill(
            path=str(ROOT / 'ui' / r.request.url.rsplit('/', 1)[-1])))
        page.add_init_script(SDK)
        page.goto('http://terminal.test/index.html')
        panels = page.locator('.terminal-panel:visible')

        def settled(count):
            page.wait_for_function(
                "n => document.querySelectorAll('.terminal-tab-item[data-state=active]').length === n",
                arg=count)
            page.wait_for_timeout(200)

        def starts():
            return page.evaluate("calls.filter(c => c.method === 'terminal/start')")

        def box(index):
            return panels.nth(index).bounding_box()

        settled(1)
        page.locator('#split-right-button').click()
        settled(2)
        assert panels.count() == 2
        a, b = box(0), box(1)
        assert abs(a['y'] - b['y']) < 1 and abs(a['x'] + a['width'] - b['x']) < 1
        assert abs(a['width'] - b['width']) < 1
        page.locator('#split-down-button').click()
        settled(3)
        b, c = box(1), box(2)
        assert abs(b['x'] - c['x']) < 1 and abs(b['y'] + b['height'] - c['y']) < 1
        page.locator('.terminal-tab-button').nth(0).click()
        page.locator('#split-down-button').click()
        settled(4)
        assert panels.count() == 4
        assert page.locator('#split-right-button').is_disabled()
        assert page.locator('#split-down-button').is_disabled()
        boxes = [box(i) for i in range(4)]
        assert max(b['width'] for b in boxes) - min(b['width'] for b in boxes) < 1
        assert max(b['height'] for b in boxes) - min(b['height'] for b in boxes) < 1
        print('PASS: left/right, top/bottom, four-pane grid and visible limit')

        session_ids = [c['sessionId'] for c in starts()]
        for i, sid in enumerate(session_ids):
            page.evaluate('([sid, text]) => output(sid, text)', [sid, f'PANE_{i}\r\n'])
        page.wait_for_timeout(150)
        for i, sid in enumerate(session_ids):
            panel = panels.nth(i)
            assert f'PANE_{i}' in panel.inner_text()
            assert all(f'PANE_{j}' not in panel.inner_text() for j in range(4) if i != j)
            panel.locator('.xterm-screen').click()
            page.keyboard.type(f'input_{i}')
            page.wait_for_timeout(40)
            assert panel.get_attribute('data-active') == 'true'
            inputs = page.evaluate("sid => calls.filter(c => c.method === 'terminal/input' && c.sessionId === sid).map(c => c.data).join('')", sid)
            assert inputs == f'input_{i}', inputs
        print('PASS: each pane routes output, focus and keyboard input to its own session')

        page.evaluate('window.calls = []')
        page.set_viewport_size({'width': 1000, 'height': 650})
        page.wait_for_timeout(400)
        sizes = page.evaluate("calls.filter(c => c.method === 'terminal/resize')")
        assert {c['sessionId'] for c in sizes} == set(session_ids)
        assert all(2 <= c['cols'] <= 500 and 2 <= c['rows'] <= 500 for c in sizes)
        for i in range(4):
            panel = panels.nth(i).bounding_box()
            screen = panels.nth(i).locator('.xterm-screen').bounding_box()
            assert screen['width'] <= panel['width'] and screen['height'] <= panel['height'] - 28
        print('PASS: all visible PTYs resize, including panes without focus')

        page.locator('#single-button').click()
        page.wait_for_timeout(200)
        assert panels.count() == 1
        assert page.locator('.terminal-tab-item').count() == 4
        assert page.evaluate("calls.filter(c => c.method === 'terminal/close').length") == 0
        page.locator('.terminal-tab-button').nth(0).click()
        page.wait_for_timeout(100)
        assert 'PANE_0' in panels.inner_text()
        page.locator('#split-right-button').click()
        settled(5)
        assert panels.count() == 2
        # Selecting a hidden tab replaces only the active pane and preserves its peer.
        page.locator('.terminal-tab-button').nth(1).click()
        page.wait_for_timeout(150)
        assert panels.count() == 2
        assert 'PANE_0' in panels.nth(0).inner_text() and 'PANE_1' in panels.nth(1).inner_text()
        panels.nth(1).locator('.pane-header button').click()
        page.wait_for_timeout(200)
        assert panels.count() == 1
        assert 'PANE_0' in panels.inner_text()
        closed = page.evaluate("calls.filter(c => c.method === 'terminal/close').map(c => c.sessionId)")
        assert closed == [session_ids[1]], closed
        assert page.locator('.terminal-tab-item').count() == 4
        print('PASS: single view retains sessions; hidden tabs replace one pane; closing merges space')

        page.set_viewport_size({'width': 340, 'height': 600})
        page.wait_for_timeout(200)
        assert page.locator('#split-right-button').is_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not errors, errors
        browser.close()
        print('PASS: narrow toolbar remains accessible; no browser errors')


if __name__ == '__main__':
    run()
