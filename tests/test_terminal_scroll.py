"""Browser regression check: pip install playwright; playwright install chromium."""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SDK = """(() => {
  window.inputs = [];
  window.dbxPlugin = {
    ready: Promise.resolve({}), locale: 'en',
    onEvent: callback => { window.emit = callback; return () => {}; },
    invoke: async (method, params) => {
      if (method === 'terminal/start') window.sessionId = params.sessionId;
      if (method === 'terminal/input') window.inputs.push(params.data);
      return {};
    },
    notify: async () => {},
    decodeBase64: data => atob(data)
  };
  window.output = text => window.emit({type: 'event', method: 'terminal/output',
    params: {sessionId: window.sessionId, dataBase64: btoa(text)}});
})()"""


def run():
    with sync_playwright() as p:
        options = {"headless": True}
        if os.environ.get("BROWSER_EXECUTABLE"):
            options["executable_path"] = os.environ["BROWSER_EXECUTABLE"]
        browser = p.chromium.launch(**options)
        page = browser.new_page(viewport={"width": 900, "height": 600})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("http://terminal.test/**", lambda route: route.fulfill(
            path=str(ROOT / "ui" / route.request.url.rsplit("/", 1)[-1])))
        page.add_init_script(SDK)
        page.goto("http://terminal.test/index.html")
        page.wait_for_function("document.querySelector('.terminal-tab-item').dataset.state === 'active'")
        page.evaluate("output(Array.from({length: 200}, (_, i) => `history ${i}\\r\\n`).join(''))")
        page.wait_for_function("document.querySelector('.xterm-rows').textContent.includes('history 199')")
        rows = page.locator(".xterm-rows")
        bottom = rows.inner_text()
        page.locator(".xterm-screen").hover()
        page.mouse.wheel(0, -400)
        page.wait_for_function("bottom => document.querySelector('.xterm-rows').innerText !== bottom", arg=bottom)
        print("PASS: ordinary shell history scrolls")

        # A TUI in the normal buffer enables SGR mouse reporting.
        page.evaluate("output('\\x1b[?1000h\\x1b[?1006h')")
        page.wait_for_selector(".xterm.enable-mouse-events")
        before = rows.inner_text()
        page.evaluate("window.inputs = []")
        page.mouse.wheel(0, -400)
        page.wait_for_timeout(150)
        assert rows.inner_text() != before, "Mouse reporting swallowed history scrolling"
        assert page.evaluate("inputs.length") == 0, "History wheel leaked into application input"
        print("PASS: mouse reporting does not swallow history wheel events")

        before = rows.inner_text()
        page.evaluate("output('\\x1b[2J\\x1b[Hnew output\\r\\n')")
        page.wait_for_timeout(150)
        assert rows.inner_text() == before, "New output/ED2 moved the history viewport"
        page.mouse.wheel(0, 400)
        page.wait_for_timeout(150)
        assert rows.inner_text() != before, "Cannot scroll down through history"
        print("PASS: output and clear-screen preserve reading position; scroll down works")

        # Typing returns to the prompt; small trackpad deltas must accumulate
        # even when starting at the bottom. Line/page wheel modes also work.
        page.locator('.xterm-helper-textarea').focus()
        page.keyboard.type('x')
        page.wait_for_function("document.querySelector('.xterm-rows').textContent.includes('new output')")
        before = rows.inner_text()
        page.evaluate("""() => {
          const target = document.querySelector('.xterm-screen');
          for (let i = 0; i < 25; i++) target.dispatchEvent(new WheelEvent('wheel',
            {deltaY: -1, deltaMode: 0, bubbles: true, cancelable: true}));
        }""")
        page.wait_for_function("before => document.querySelector('.xterm-rows').innerText !== before", arg=before)
        for mode in (1, 2):
            before = rows.inner_text()
            page.locator('.xterm-screen').dispatch_event('wheel', {
                'deltaY': -1, 'deltaMode': mode, 'bubbles': True, 'cancelable': True})
            page.wait_for_function("before => document.querySelector('.xterm-rows').innerText !== before", arg=before)
        print("PASS: trackpad, line and page wheel deltas scroll history")

        # Full-screen apps own their alternate buffer and must still get mouse input.
        page.evaluate("output('\\x1b[?1049hALT_BUFFER')")
        page.wait_for_function("document.querySelector('.xterm-rows').textContent.includes('ALT_BUFFER')")
        page.evaluate("window.inputs = []")
        page.mouse.wheel(0, -400)
        page.wait_for_function("inputs.some(data => data.startsWith('\\x1b[<64;'))")
        assert not errors, errors
        print("PASS: alternate-buffer application receives wheel input; no browser errors")

        # Return to normal history. ED3 (unlike ED2) used to destroy every
        # saved line, including while the user was reading older output.
        page.evaluate("output('\\x1b[?1049l\\x1b[?1000l\\x1b[?1006l')")
        page.wait_for_timeout(100)
        page.mouse.wheel(0, -1000000)
        page.wait_for_function("document.querySelector('.xterm-rows').textContent.includes('history 0')")
        before = rows.inner_text()
        page.evaluate("output('\\x1b['); output('3'); output('J')")
        page.wait_for_timeout(150)
        assert rows.inner_text() == before, "ED3 deleted scrollback or moved the reading position"
        page.evaluate("output('\\x1b[?3J')")
        page.wait_for_timeout(150)
        assert rows.inner_text() == before, "Selective ED3 deleted scrollback"
        page.mouse.wheel(0, 1000000)
        page.wait_for_function("document.querySelector('.xterm-rows').textContent.includes('new output')")
        page.evaluate("output('\\x1b[2J\\x1b[3J\\x1b[Hafter redraw')")
        page.wait_for_function("document.querySelector('.xterm-rows').textContent.includes('after redraw')")
        page.mouse.wheel(0, -1000000)
        page.wait_for_function("document.querySelector('.xterm-rows').textContent.includes('history 0')")
        print("PASS: ED3, selective ED3 and ED2+ED3 preserve the oldest history")

        for width, height in ((650, 400), (1100, 750)):
            page.set_viewport_size({'width': width, 'height': height})
            page.wait_for_timeout(150)
            page.locator('.xterm-screen').hover()
            page.mouse.wheel(0, -1000000)
            page.wait_for_function("document.querySelector('.xterm-rows').textContent.includes('history 0')")
        print("PASS: shrinking and expanding the terminal keeps the oldest history accessible")

        page.locator('#clear-button').click()
        page.locator('.xterm-screen').hover()
        page.mouse.wheel(0, -1000000)
        page.wait_for_timeout(150)
        assert 'history 0' not in rows.inner_text(), "Explicit toolbar clear must still erase history"
        assert not errors, errors
        print("PASS: explicit toolbar clear still erases history")
        browser.close()


if __name__ == "__main__":
    run()
