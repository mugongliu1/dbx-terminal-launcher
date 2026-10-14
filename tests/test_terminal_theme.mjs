import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === "win32" ? { channel: "msedge" } : {}),
});

try {
  const saved = new Map();
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeBinding("themeStorageGet", (_source, key) => saved.get(key) ?? null);
  await page.exposeBinding("themeStorageSet", (_source, key, value) => saved.set(key, value));
  await page.addInitScript(() => {
    window.dbxPlugin = {
      ready: Promise.resolve({}),
      locale: "en",
      capabilities: { storage: true },
      storage: { get: (key) => window.themeStorageGet(key), set: (key, value) => window.themeStorageSet(key, value) },
      onEvent: (callback) => { window.emit = callback; return () => {}; },
      invoke: async (method, params) => {
        if (method === "terminal/start") window.sessionId = params.sessionId;
        return {};
      },
      notify: async () => {},
      decodeBase64: (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0)),
    };
    window.output = (value) => window.emit({
      type: "event", method: "terminal/output",
      params: { sessionId: window.sessionId, dataBase64: btoa(value) },
    });
  });
  await page.route("http://terminal.test/**", (route) => route.fulfill({
    path: path.join(root, "ui", route.request().url().split("/").at(-1)),
  }));

  async function openTerminal() {
    await page.goto("http://terminal.test/index.html");
    await page.waitForSelector('.terminal-tab-item[data-state="active"]');
    await page.evaluate(() => window.output("\x1b[97m0123456789\x1b[0m\r\n\x1b[37mdefault text\x1b[0m\r\n\x1b[93mGet-Item\x1b[0m \x1b[36m'hello'\x1b[0m \x1b[90m-Path\x1b[0m"));
    await page.waitForTimeout(150);
  }

  async function numberColor() {
    return page.locator(".xterm-rows .xterm-fg-15").first().evaluate((element) => getComputedStyle(element).color);
  }

  await openTerminal();
  assert.equal(await page.locator(".xterm-rows .xterm-fg-15").first().textContent(), "0123456789");
  assert.equal(await numberColor(), "rgb(35, 75, 121)", "ANSI 97 digits must contrast with the light background");
  assert.equal(await page.locator(".xterm-rows .xterm-fg-7").first().evaluate((element) => getComputedStyle(element).color), "rgb(32, 35, 39)");
  await page.evaluate(() => {
    document.documentElement.dataset.dbxTheme = "dark";
    window.dispatchEvent(new Event("dbx-plugin-env"));
  });
  assert.equal(await numberColor(), "rgb(244, 246, 248)", "host scheme must follow DBX dark mode");
  await page.evaluate(() => {
    document.documentElement.dataset.dbxTheme = "light";
    window.dispatchEvent(new Event("dbx-plugin-env"));
  });

  await page.locator("#theme-button").click();
  await page.locator("#theme-scheme").selectOption("custom");
  if (process.env.THEME_SCREENSHOT) {
    await page.screenshot({ path: path.join(root, ".dbx-dev", "theme-dialog-desktop.png") });
    await page.setViewportSize({ width: 360, height: 640 });
    await page.screenshot({ path: path.join(root, ".dbx-dev", "theme-dialog-mobile.png") });
    await page.setViewportSize({ width: 900, height: 600 });
  }
  await page.locator("#theme-command").fill("#a22424");
  await page.locator("#theme-string").fill("#1a804a");
  await page.locator("#theme-number").fill("#c01462");
  await page.locator("#theme-symbol").fill("#5462a5");
  await page.locator("#theme-save-button").click();
  await page.waitForFunction(() => !document.querySelector("#theme-dialog").open);
  assert.equal(saved.get("terminal-theme-v1")?.colors.number, "#c01462");
  assert.equal(await numberColor(), "rgb(192, 20, 98)", "custom number color must repaint existing text");
  assert.equal(await page.locator(".xterm-fg-11").first().evaluate((element) => getComputedStyle(element).color), "rgb(162, 36, 36)");
  assert.equal(await page.locator(".xterm-fg-6").first().evaluate((element) => getComputedStyle(element).color), "rgb(26, 128, 74)");
  assert.equal(await page.locator(".xterm-fg-8").first().evaluate((element) => getComputedStyle(element).color), "rgb(84, 98, 165)");

  await openTerminal();
  assert.equal(await numberColor(), "rgb(192, 20, 98)", "custom number color must survive reload");
  assert.deepEqual(errors, []);
  console.log("PASS: readable digits and persistent custom colors");
} finally {
  await browser.close();
}
