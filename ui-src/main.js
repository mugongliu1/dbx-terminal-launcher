import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { createIcons, Eraser, Plus, RotateCcw, Square, X, Columns2, Rows2, Maximize2 } from "lucide";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

const TERMINAL_SCROLLBACK_LINES = 100000;
const MAX_VISIBLE_TERMINALS = 4;

const copy = {
  "zh-CN": {
    controls: "终端控制",
    terminalLabel: (number) => `终端 ${number}`,
    clear: "清屏",
    newTerminal: "新建终端",
    splitRight: "左右分屏并新建终端",
    splitDown: "上下分屏并新建终端",
    singlePane: "返回单屏",
    splitLimit: "最多同时显示 4 个终端",
    restart: "重新启动",
    stop: "停止终端",
    closeTab: "关闭终端标签",
    starting: "正在启动",
    active: "运行中",
    stopped: "已关闭",
    exited: "已退出",
    error: "发生错误",
    startingMessage: "正在启动终端...",
    stoppedMessage: "终端已关闭",
    exitedMessage: (code) => `终端已退出（代码 ${code}）`,
    unavailableMessage: "DBX 插件接口不可用",
  },
  en: {
    controls: "Terminal controls",
    terminalLabel: (number) => `Terminal ${number}`,
    clear: "Clear",
    newTerminal: "New terminal",
    splitRight: "Split left/right with a new terminal",
    splitDown: "Split top/bottom with a new terminal",
    singlePane: "Return to single pane",
    splitLimit: "At most 4 terminals can be visible",
    restart: "Restart",
    stop: "Stop terminal",
    closeTab: "Close terminal tab",
    starting: "Starting",
    active: "Running",
    stopped: "Closed",
    exited: "Exited",
    error: "Error",
    startingMessage: "Starting terminal...",
    stoppedMessage: "Terminal is closed",
    exitedMessage: (code) => `Terminal exited (code ${code})`,
    unavailableMessage: "DBX plugin API is unavailable",
  },
};

const elements = {
  shell: document.querySelector("#terminal-shell"),
  panels: document.querySelector("#terminal-panels"),
  tabs: document.querySelector("#terminal-tabs"),
  newButton: document.querySelector("#new-button"),
  splitRightButton: document.querySelector("#split-right-button"),
  splitDownButton: document.querySelector("#split-down-button"),
  singleButton: document.querySelector("#single-button"),
  clearButton: document.querySelector("#clear-button"),
  restartButton: document.querySelector("#restart-button"),
  closeButton: document.querySelector("#close-button"),
  toolbar: document.querySelector('[role="toolbar"]'),
};

const instances = new Map();
const sessions = new Map();
let sdk;
let strings = copy["zh-CN"];
let activeInstanceId = null;
let instanceSequence = 0;
let removeEventListener;
let removeContextListener;
let workbenchContext = {};
let paneLayout = null;

createIcons({ icons: { Eraser, Plus, RotateCcw, Square, X, Columns2, Rows2, Maximize2 } });
localize();

elements.newButton.addEventListener("click", () => createTerminalInstance(true));
elements.splitRightButton.addEventListener("click", () => splitTerminal("columns"));
elements.splitDownButton.addEventListener("click", () => splitTerminal("rows"));
elements.singleButton.addEventListener("click", () => {
  paneLayout = activeInstanceId;
  renderPaneLayout();
  activeInstance()?.terminal.focus();
});
elements.clearButton.addEventListener("click", () => {
  const instance = activeInstance();
  instance?.terminal.clear();
  instance?.terminal.focus();
});
elements.restartButton.addEventListener("click", () => {
  const instance = activeInstance();
  if (instance) restartTerminal(instance);
});
elements.closeButton.addEventListener("click", () => {
  const instance = activeInstance();
  if (instance) stopTerminal(instance);
});

const resizeObserver = new ResizeObserver(() => {
  fitVisibleTerminals();
});
resizeObserver.observe(elements.shell);

window.addEventListener("dbx-plugin-env", () => {
  selectLocale();
  applyTheme();
});
window.addEventListener("pagehide", closeAllSessions);
window.addEventListener("unload", dispose);

const initialInstance = createTerminalInstance(false);
initialize(initialInstance);

async function initialize(instance) {
  sdk = window.dbxPlugin;
  if (!sdk) {
    showError(instance, new Error(strings.unavailableMessage));
    return;
  }

  removeEventListener = sdk.onEvent(handleHostEvent);
  try {
    workbenchContext = (await sdk.ready) || {};
    removeContextListener = sdk.onContext?.((context) => {
      workbenchContext = { ...workbenchContext, ...(context || {}) };
    });
    selectLocale();
    applyTheme();
    await startTerminal(instance);
  } catch (error) {
    showError(instance, error);
  }
}

function createTerminalInstance(startImmediately, splitDirection = null) {
  if (splitDirection && paneIds().length >= MAX_VISIBLE_TERMINALS) return null;
  const instance = buildTerminalInstance(++instanceSequence);
  instances.set(instance.id, instance);
  elements.tabs.append(instance.tabItem);
  elements.panels.append(instance.panel);
  if (splitDirection && activeInstanceId) {
    paneLayout = replacePane(paneLayout, activeInstanceId, {
      direction: splitDirection, first: activeInstanceId, second: instance.id,
    });
  }
  activateTerminal(instance);

  instance.terminal.open(instance.terminalHost);
  resizeObserver.observe(instance.terminalHost);
  installHistoryScrolling(instance);
  installHistoryProtection(instance);
  instance.colorQueryHandlers = [
    instance.terminal.parser.registerOscHandler(10, (data) => handleTerminalColorQuery(instance, 10, data)),
    instance.terminal.parser.registerOscHandler(11, (data) => handleTerminalColorQuery(instance, 11, data)),
  ];
  instance.disposables.push(instance.terminal.onData((data) => bufferInput(instance, data)));

  createIcons({ icons: { X } });
  updateTabCloseButtons();
  setState(instance, "starting");
  requestAnimationFrame(() => {
    fitTerminal(instance);
    if (startImmediately) startTerminal(instance);
  });
  return instance;
}

function installHistoryProtection(instance) {
  const { terminal } = instance;
  // scrollOnEraseInDisplay preserves ED2, but xterm still deletes the entire
  // scrollback on ED3. Keep normal-buffer history until the user explicitly
  // clears/restarts the terminal. Parser hooks also handle split PTY chunks.
  const preserveScrollback = (params) =>
    terminal.buffer.active.type === "normal" && params[0] === 3;
  instance.disposables.push(
    terminal.parser.registerCsiHandler({ final: "J" }, preserveScrollback),
    terminal.parser.registerCsiHandler({ prefix: "?", final: "J" }, preserveScrollback),
  );
}

function installHistoryScrolling(instance) {
  const { terminal, terminalHost } = instance;
  let pendingPixels = 0;
  const onWheel = (event) => {
    const buffer = terminal.buffer.active;
    // Full-screen applications own the alternate buffer. In the normal buffer,
    // history navigation must win over application mouse reporting (which can
    // otherwise send input and jump the viewport back to the prompt).
    if (buffer.type !== "normal" || buffer.baseY === 0 || event.ctrlKey || event.deltaY === 0) {
      pendingPixels = 0;
      return;
    }

    const screen = terminal.element?.querySelector(".xterm-screen");
    const rowHeight = screen?.getBoundingClientRect().height / terminal.rows;
    if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;

    event.preventDefault();
    event.stopPropagation();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? rowHeight
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rowHeight * terminal.rows : 1;
    const pixels = event.deltaY * unit * terminal.options.scrollSensitivity;
    if (Math.sign(pendingPixels) !== Math.sign(pixels)) pendingPixels = 0;
    pendingPixels += pixels;
    const lines = Math.trunc(pendingPixels / rowHeight);
    if (lines) {
      pendingPixels -= lines * rowHeight;
      terminal.scrollLines(lines);
    }
    if ((pixels < 0 && buffer.viewportY === 0)
      || (pixels > 0 && buffer.viewportY === buffer.baseY)) pendingPixels = 0;
  };

  // Capture before xterm's wheel listeners, including over the host padding.
  terminalHost.addEventListener("wheel", onWheel, { capture: true, passive: false });
  instance.disposables.push({
    dispose: () => terminalHost.removeEventListener("wheel", onWheel, true),
  });
}

function buildTerminalInstance(number) {
  const id = makeSessionId().replace("terminal-", "tab-");
  const tabItem = document.createElement("div");
  tabItem.className = "terminal-tab-item";
  tabItem.dataset.state = "starting";

  const tabButton = document.createElement("button");
  tabButton.className = "terminal-tab-button";
  tabButton.type = "button";
  tabButton.role = "tab";
  tabButton.setAttribute("aria-selected", "false");

  const statusDot = document.createElement("span");
  statusDot.className = "terminal-tab-status";
  statusDot.setAttribute("aria-hidden", "true");
  const tabLabel = document.createElement("span");
  tabLabel.className = "terminal-tab-label";
  tabButton.append(statusDot, tabLabel);

  const closeTabButton = document.createElement("button");
  closeTabButton.className = "terminal-tab-close";
  closeTabButton.type = "button";
  closeTabButton.innerHTML = '<i data-lucide="x" aria-hidden="true"></i>';
  tabItem.append(tabButton, closeTabButton);

  const panel = document.createElement("div");
  panel.className = "terminal-panel";
  panel.hidden = true;
  panel.dataset.instanceId = id;
  const paneHeader = document.createElement("div");
  paneHeader.className = "pane-header";
  const paneLabel = document.createElement("span");
  const paneCloseButton = document.createElement("button");
  paneCloseButton.className = "terminal-tab-close";
  paneCloseButton.type = "button";
  paneCloseButton.innerHTML = '<i data-lucide="x" aria-hidden="true"></i>';
  paneHeader.append(paneLabel, paneCloseButton);
  const terminalHost = document.createElement("div");
  terminalHost.className = "terminal";
  terminalHost.setAttribute("aria-label", "Interactive terminal");

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.dataset.visible = "true";
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  const overlayMessage = document.createElement("p");
  const overlayAction = document.createElement("button");
  overlayAction.className = "command-button";
  overlayAction.type = "button";
  overlayAction.hidden = true;
  overlay.append(spinner, overlayMessage, overlayAction);
  panel.append(paneHeader, terminalHost, overlay);

  const fitAddon = new FitAddon();
  const terminal = new Terminal({
    allowTransparency: false,
    // Codex redraws its prompt rapidly and toggles the cursor on every
    // synchronized update. A blinking bar cursor can leave one-cell paint
    // remnants in the canvas while those updates are in flight, which appear
    // as scattered dots around the input line. Let the application control
    // visibility and keep xterm's own cursor animation disabled.
    cursorBlink: false,
    cursorStyle: "block",
    fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, "Microsoft YaHei", "Microsoft YaHei UI", "Liberation Mono", monospace',
    fontSize: 13,
    lineHeight: 1.22,
    scrollback: TERMINAL_SCROLLBACK_LINES,
    scrollOnEraseInDisplay: true,
    tabStopWidth: 4,
    theme: terminalTheme(),
    ...(isWindowsHost() ? { windowsPty: { backend: "conpty" } } : {}),
  });
  terminal.loadAddon(fitAddon);

  const instance = {
    id,
    number,
    tabItem,
    tabButton,
    tabLabel,
    closeTabButton,
    panel,
    paneLabel,
    paneCloseButton,
    terminalHost,
    overlay,
    overlayMessage,
    overlayAction,
    spinner,
    terminal,
    fitAddon,
    colorQueryHandlers: [],
    disposables: [],
    sessionId: null,
    state: "starting",
    lastExitCode: null,
    operation: 0,
    resizeTimer: null,
    inputBuffer: "",
    inputBufferSessionId: null,
    inputFlushTimer: null,
    inputQueue: Promise.resolve(),
    outputRemainder: "",
    outputDecoder: new TextDecoder(),
  };

  tabButton.addEventListener("click", () => activateTerminal(instance));
  closeTabButton.addEventListener("click", () => closeTerminalTab(instance));
  paneCloseButton.addEventListener("click", () => closeTerminalTab(instance));
  panel.addEventListener("pointerdown", () => activateTerminal(instance, false));
  panel.addEventListener("focusin", () => {
    if (activeInstanceId !== instance.id) activateTerminal(instance, false);
  });
  overlayAction.addEventListener("click", () => restartTerminal(instance));
  return instance;
}

function paneIds(node = paneLayout) {
  if (!node) return [];
  return typeof node === "string" ? [node] : [...paneIds(node.first), ...paneIds(node.second)];
}

function replacePane(node, id, replacement) {
  if (!node || typeof node === "string") return node === id ? replacement : node;
  const first = replacePane(node.first, id, replacement);
  const second = replacePane(node.second, id, replacement);
  return first && second ? { ...node, first, second } : first || second;
}

function splitTerminal(direction) {
  if (paneIds().length < MAX_VISIBLE_TERMINALS) createTerminalInstance(true, direction);
}

function fitVisibleTerminals() {
  for (const id of paneIds()) {
    const instance = instances.get(id);
    if (!instance) continue;
    fitTerminal(instance);
    scheduleBackendResize(instance);
  }
}

function renderPaneLayout() {
  const visible = paneIds();
  elements.panels.dataset.split = String(visible.length > 1);
  for (const instance of instances.values()) {
    instance.panel.hidden = !visible.includes(instance.id);
    instance.panel.dataset.active = String(instance.id === activeInstanceId);
    instance.tabItem.dataset.active = String(instance.id === activeInstanceId);
    instance.tabButton.setAttribute("aria-selected", String(instance.id === activeInstanceId));
  }
  const place = (node, x, y, width, height) => {
    if (!node) return;
    if (typeof node === "string") {
      const panel = instances.get(node)?.panel;
      if (panel) Object.assign(panel.style, { left: `${x}%`, top: `${y}%`, width: `${width}%`, height: `${height}%` });
    } else if (node.direction === "columns") {
      place(node.first, x, y, width / 2, height);
      place(node.second, x + width / 2, y, width / 2, height);
    } else {
      place(node.first, x, y, width, height / 2);
      place(node.second, x, y + height / 2, width, height / 2);
    }
  };
  place(paneLayout, 0, 0, 100, 100);
  updateToolbar();
  requestAnimationFrame(fitVisibleTerminals);
}

function activateTerminal(instance, focus = true) {
  if (!instances.has(instance.id) && instances.size) return;
  if (!paneIds().includes(instance.id)) {
    paneLayout = paneLayout ? replacePane(paneLayout, activeInstanceId, instance.id) : instance.id;
  }
  activeInstanceId = instance.id;
  renderPaneLayout();
  requestAnimationFrame(() => {
    if (focus && activeInstanceId === instance.id && instances.has(instance.id)) instance.terminal.focus();
  });
}

async function startTerminal(instance) {
  if (!sdk || !instances.has(instance.id)) return;
  const token = ++instance.operation;
  const sessionId = makeSessionId();
  clearPendingInput(instance);
  instance.outputRemainder = "";
  instance.outputDecoder = new TextDecoder();
  instance.lastExitCode = null;
  instance.sessionId = sessionId;
  sessions.set(sessionId, instance);
  setState(instance, "starting");
  fitTerminal(instance);

  try {
    const cwd = terminalWorkingDirectory();
    await sdk.invoke(
      "terminal/start",
      {
        sessionId,
        cols: clampDimension(instance.terminal.cols),
        rows: clampDimension(instance.terminal.rows),
        ...(cwd ? { cwd } : {}),
      },
      { timeoutMs: 30000 },
    );
    if (token !== instance.operation || instance.sessionId !== sessionId || !instances.has(instance.id)) {
      sdk.notify("terminal/close", { sessionId }).catch(() => {});
      return;
    }
    setState(instance, "active");
    scheduleBackendResize(instance);
    if (activeInstanceId === instance.id) instance.terminal.focus();
  } catch (error) {
    sessions.delete(sessionId);
    if (instance.sessionId === sessionId) instance.sessionId = null;
    if (token === instance.operation && instances.has(instance.id)) showError(instance, error);
  }
}

function terminalWorkingDirectory() {
  const context = workbenchContext || {};
  const value = context.cwd || context.workingDirectory || context.initialDirectory;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function restartTerminal(instance) {
  if (!sdk || instance.state === "starting" || !instances.has(instance.id)) return;
  const previous = instance.sessionId;
  clearPendingInput(instance);
  instance.outputRemainder = "";
  instance.sessionId = null;
  ++instance.operation;
  setState(instance, "starting");
  instance.terminal.reset();

  if (previous) {
    sessions.delete(previous);
    try {
      await sdk.invoke("terminal/close", { sessionId: previous });
    } catch {
      // The process may already have exited between the UI action and this request.
    }
  }
  await startTerminal(instance);
}

async function stopTerminal(instance) {
  if (!sdk || !instance.sessionId) return;
  const sessionId = instance.sessionId;
  clearPendingInput(instance);
  instance.outputRemainder = "";
  instance.sessionId = null;
  sessions.delete(sessionId);
  ++instance.operation;
  setState(instance, "stopped");

  try {
    await sdk.invoke("terminal/close", { sessionId });
  } catch (error) {
    showError(instance, error);
  }
}

function closeTerminalTab(instance) {
  if (instances.size <= 1 || !instances.has(instance.id)) return;
  const ordered = [...instances.values()];
  const index = ordered.indexOf(instance);
  destroyTerminalInstance(instance);
  const next = instances.get(activeInstanceId) || instances.get(paneIds()[0]) || ordered[index + 1] || ordered[index - 1];
  if (next) activateTerminal(next);
}

function destroyTerminalInstance(instance) {
  paneLayout = replacePane(paneLayout, instance.id, null);
  resizeObserver.unobserve(instance.terminalHost);
  clearPendingInput(instance);
  clearTimeout(instance.resizeTimer);
  ++instance.operation;
  if (instance.sessionId) {
    sessions.delete(instance.sessionId);
    sdk?.notify("terminal/close", { sessionId: instance.sessionId }).catch(() => {});
    instance.sessionId = null;
  }
  instance.colorQueryHandlers.forEach((handler) => handler.dispose());
  instance.disposables.forEach((handler) => handler.dispose());
  instance.terminal.dispose();
  instance.tabItem.remove();
  instance.panel.remove();
  instances.delete(instance.id);
  updateTabCloseButtons();
}

function handleHostEvent(message) {
  if (message?.type !== "event") return;
  const params = message.params || {};
  const instance = sessions.get(params.sessionId);
  if (!instance || instance.sessionId !== params.sessionId) return;

  if (message.method === "terminal/output") {
    try {
      writeTerminalOutput(instance, sdk.decodeBase64(params.dataBase64 || ""));
    } catch (error) {
      showError(instance, error);
    }
    return;
  }

  if (message.method === "terminal/exit") {
    sessions.delete(params.sessionId);
    instance.sessionId = null;
    ++instance.operation;
    instance.lastExitCode = params.exitCode ?? "?";
    setState(instance, "exited", strings.exitedMessage(instance.lastExitCode));
    return;
  }

  if (message.method === "terminal/error") {
    const failedSessionId = instance.sessionId;
    sessions.delete(failedSessionId);
    instance.sessionId = null;
    ++instance.operation;
    sdk.notify("terminal/close", { sessionId: failedSessionId }).catch(() => {});
    showError(instance, new Error(params.message || strings.error));
  }
}

function writeTerminalOutput(instance, data) {
  const chunk = typeof data === "string" ? data : instance.outputDecoder.decode(data, { stream: true });
  const normalized = normalizeOutputChunk(`${instance.outputRemainder}${chunk}`, isLightTheme());
  instance.outputRemainder = normalized.remainder;
  if (normalized.text) instance.terminal.write(normalized.text);
}

function normalizeOutputChunk(data, normalizeBlackBackground) {
  let text = "";
  let index = 0;

  while (index < data.length) {
    const escapeIndex = data.indexOf("\x1b", index);
    if (escapeIndex < 0) {
      text += data.slice(index);
      return { text, remainder: "" };
    }

    text += data.slice(index, escapeIndex);
    if (escapeIndex + 1 >= data.length) return { text, remainder: data.slice(escapeIndex) };

    if (data[escapeIndex + 1] !== "[") {
      text += "\x1b";
      index = escapeIndex + 1;
      continue;
    }

    let finalIndex = escapeIndex + 2;
    while (finalIndex < data.length) {
      const code = data.charCodeAt(finalIndex);
      if (code >= 0x40 && code <= 0x7e) break;
      finalIndex += 1;
    }
    if (finalIndex >= data.length) return { text, remainder: data.slice(escapeIndex) };

    const sequence = data.slice(escapeIndex, finalIndex + 1);
    text += normalizeBlackBackground && data[finalIndex] === "m" ? normalizeSgr(sequence) : sequence;
    index = finalIndex + 1;
  }

  return { text, remainder: "" };
}

function normalizeSgr(sequence) {
  const body = sequence.slice(2, -1);
  if (!body) return sequence;

  const params = body.split(";");
  for (let index = 0; index < params.length; index += 1) {
    const value = params[index];
    if (value === "40" || value === "100") {
      params[index] = "49";
      continue;
    }

    if (value === "48" && params[index + 1] === "5") {
      const colorIndex = Number(params[index + 2]);
      if (isBlackAnsiIndex(colorIndex)) params.splice(index, 3, "49");
      continue;
    }

    if (value === "48" && params[index + 1] === "2") {
      const red = Number(params[index + 2]);
      const green = Number(params[index + 3]);
      const blue = Number(params[index + 4]);
      if (isBlackRgb(red, green, blue)) params.splice(index, 5, "49");
      continue;
    }

    if (isBlackColonBackground(value)) params[index] = "49";
  }

  const normalized = params.join(";");
  return normalized === body ? sequence : `\x1b[${normalized}m`;
}

function isBlackAnsiIndex(value) {
  return value === 0 || value === 16 || (value >= 232 && value <= 236);
}

function isBlackRgb(red, green, blue) {
  const channels = [red, green, blue];
  return channels.every((value) => Number.isFinite(value) && value >= 0 && value <= 48)
    && Math.max(...channels) - Math.min(...channels) <= 4;
}

function isBlackColonBackground(value) {
  const parts = value.split(":");
  if (parts[0] !== "48") return false;
  if (parts[1] === "5") return isBlackAnsiIndex(Number(parts[2]));
  if (parts[1] !== "2") return false;

  const channels = parts.slice(2).filter((part) => part !== "").map(Number);
  return channels.length >= 3 && isBlackRgb(channels[0], channels[1], channels[2]);
}

function handleTerminalColorQuery(instance, slot, data) {
  if (data.trim() !== "?") return false;

  const rgb = terminalColorRgb(slot === 11 ? "--terminal-background" : "--terminal-foreground");
  const component = (value) => value.toString(16).padStart(2, "0").repeat(2);
  const response = `\x1b]${slot};rgb:${component(rgb[0])}/${component(rgb[1])}/${component(rgb[2])}\x1b\\`;
  sendControlInput(instance, response);
  return true;
}

function sendControlInput(instance, data) {
  const sessionId = instance.sessionId;
  if (!sdk || !sessionId || !["starting", "active"].includes(instance.state)) return;

  instance.inputQueue = instance.inputQueue
    .then(() => {
      if (instance.sessionId !== sessionId) return undefined;
      return sdk.invoke("terminal/input", { sessionId, data });
    })
    .catch(() => {});
}

function bufferInput(instance, data) {
  if (!sdk || !instance.sessionId || !["starting", "active"].includes(instance.state)) return;
  if (instance.inputBufferSessionId && instance.inputBufferSessionId !== instance.sessionId) {
    instance.inputBuffer = "";
  }
  instance.inputBufferSessionId = instance.sessionId;
  instance.inputBuffer += data;
  clearTimeout(instance.inputFlushTimer);
  if (instance.inputBuffer.length >= 16384) {
    flushInput(instance);
  } else {
    instance.inputFlushTimer = setTimeout(() => flushInput(instance), 8);
  }
}

function flushInput(instance) {
  clearTimeout(instance.inputFlushTimer);
  const sessionId = instance.inputBufferSessionId;
  const data = instance.inputBuffer;
  instance.inputBuffer = "";
  instance.inputBufferSessionId = null;
  if (!sdk || !sessionId || !data) return;

  instance.inputQueue = instance.inputQueue
    .then(() => {
      if (instance.sessionId !== sessionId) return undefined;
      return sdk.invoke("terminal/input", { sessionId, data });
    })
    .catch((error) => {
      if (instance.sessionId === sessionId) showError(instance, error);
    });
}

function clearPendingInput(instance) {
  clearTimeout(instance.inputFlushTimer);
  instance.inputBuffer = "";
  instance.inputBufferSessionId = null;
}

function fitTerminal(instance) {
  if (instance.panel.hidden || instance.terminalHost.clientWidth < 20 || instance.terminalHost.clientHeight < 20) return;
  try {
    instance.fitAddon.fit();
  } catch {
    // ResizeObserver retries after the active panel has completed layout.
  }
}

function scheduleBackendResize(instance) {
  clearTimeout(instance.resizeTimer);
  if (!sdk || !instance.sessionId || !["starting", "active"].includes(instance.state)) return;
  instance.resizeTimer = setTimeout(() => {
    const sessionId = instance.sessionId;
    if (!sessionId) return;
    sdk.notify("terminal/resize", {
      sessionId,
      cols: clampDimension(instance.terminal.cols),
      rows: clampDimension(instance.terminal.rows),
    }).catch(() => {});
  }, 80);
}

function setState(instance, nextState, message) {
  instance.state = nextState;
  instance.tabItem.dataset.state = nextState;
  const isActive = nextState === "active";
  const isStarting = nextState === "starting";
  instance.overlay.dataset.visible = String(!isActive);
  instance.spinner.hidden = !isStarting;
  instance.overlayAction.hidden = isStarting;
  instance.overlayMessage.textContent = message || stateMessage(nextState);
  updateInstanceLabel(instance);
  if (activeInstanceId === instance.id) updateToolbar();
}

function stateMessage(value) {
  if (value === "starting") return strings.startingMessage;
  if (value === "stopped") return strings.stoppedMessage;
  return strings.error;
}

function showError(instance, error) {
  const message = error instanceof Error ? error.message : String(error);
  setState(instance, "error", message || strings.error);
}

function activeInstance() {
  return instances.get(activeInstanceId) || null;
}

function updateToolbar() {
  const instance = activeInstance();
  const atLimit = paneIds().length >= MAX_VISIBLE_TERMINALS;
  elements.splitRightButton.disabled = atLimit || !instance;
  elements.splitDownButton.disabled = atLimit || !instance;
  elements.singleButton.disabled = paneIds().length <= 1;
  setButtonLabel(elements.splitRightButton, atLimit ? strings.splitLimit : strings.splitRight);
  setButtonLabel(elements.splitDownButton, atLimit ? strings.splitLimit : strings.splitDown);
  elements.clearButton.disabled = !instance;
  elements.restartButton.disabled = !instance || instance.state === "starting";
  elements.closeButton.disabled = !instance?.sessionId || !["starting", "active"].includes(instance.state);
}

function updateTabCloseButtons() {
  const disabled = instances.size <= 1;
  for (const instance of instances.values()) {
    instance.closeTabButton.disabled = disabled;
    instance.paneCloseButton.disabled = disabled;
  }
}

function selectLocale() {
  const locale = sdk?.locale || document.documentElement.lang;
  strings = locale.toLowerCase().startsWith("zh") ? copy["zh-CN"] : copy.en;
  document.documentElement.lang = locale || "en";
  localize();
  for (const instance of instances.values()) {
    if (instance.state === "starting" || instance.state === "stopped") {
      setState(instance, instance.state);
    } else if (instance.state === "exited") {
      setState(instance, instance.state, strings.exitedMessage(instance.lastExitCode ?? "?"));
    } else {
      updateInstanceLabel(instance);
    }
  }
}

function localize() {
  elements.toolbar.setAttribute("aria-label", strings.controls);
  setButtonLabel(elements.newButton, strings.newTerminal);
  setButtonLabel(elements.splitRightButton, strings.splitRight);
  setButtonLabel(elements.splitDownButton, strings.splitDown);
  setButtonLabel(elements.singleButton, strings.singlePane);
  setButtonLabel(elements.clearButton, strings.clear);
  setButtonLabel(elements.restartButton, strings.restart);
  setButtonLabel(elements.closeButton, strings.stop);
}

function updateInstanceLabel(instance) {
  const label = strings.terminalLabel(instance.number);
  const stateLabel = strings[instance.state] || strings.error;
  instance.tabLabel.textContent = label;
  instance.paneLabel.textContent = `${label} · ${stateLabel}`;
  instance.panel.setAttribute("aria-label", label);
  setButtonLabel(instance.paneCloseButton, `${strings.closeTab}: ${label}`);
  instance.tabButton.title = `${label} · ${stateLabel}`;
  instance.tabButton.setAttribute("aria-label", `${label}, ${stateLabel}`);
  instance.closeTabButton.title = `${strings.closeTab}: ${label}`;
  instance.closeTabButton.setAttribute("aria-label", `${strings.closeTab}: ${label}`);
  instance.overlayAction.textContent = strings.restart;
}

function setButtonLabel(button, label) {
  button.title = label;
  button.setAttribute("aria-label", label);
}

function applyTheme() {
  const theme = terminalTheme();
  for (const instance of instances.values()) {
    instance.terminal.options.theme = theme;
    if (instance.terminal.rows > 0) instance.terminal.refresh(0, instance.terminal.rows - 1);
  }
}

function terminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  const color = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.dataset.dbxTheme === "dark";
  return {
    background: color("--terminal-background", dark ? "#111315" : "#ffffff"),
    foreground: color("--terminal-foreground", dark ? "#e7e9ec" : "#202327"),
    cursor: color("--terminal-cursor", dark ? "#5ecf98" : "#087f5b"),
    cursorAccent: color("--terminal-background", dark ? "#111315" : "#ffffff"),
    selectionBackground: dark ? "#315f4e99" : "#90d5b899",
    black: dark ? "#25292d" : "#343a40",
    red: "#d34a4a",
    green: "#2d9d65",
    yellow: "#b47813",
    blue: "#3d7fca",
    magenta: "#9b62b5",
    cyan: "#258d9c",
    white: dark ? "#d9dde1" : "#e9ecef",
    brightBlack: "#737b84",
    brightRed: "#f06a6a",
    brightGreen: "#5ecf98",
    brightYellow: "#e2ad45",
    brightBlue: "#69a7ec",
    brightMagenta: "#c68bdf",
    brightCyan: "#56bdc9",
    brightWhite: "#ffffff",
  };
}

function isLightTheme() {
  return document.documentElement.dataset.dbxTheme !== "dark";
}

function isWindowsHost() {
  return navigator.userAgent.includes("Windows");
}

function terminalColorRgb(variable) {
  const styles = getComputedStyle(document.documentElement);
  const fallback = variable === "--terminal-background" ? [255, 255, 255] : [32, 35, 39];
  return parseCssRgb(styles.getPropertyValue(variable).trim()) || fallback;
}

function parseCssRgb(value) {
  const hex = value.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      return digits.slice(0, 3).split("").map((digit) => Number.parseInt(digit + digit, 16));
    }
    if (digits.length === 6 || digits.length === 8) {
      return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16));
    }
  }

  const rgb = value.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i);
  if (rgb) return rgb.slice(1, 4).map(Number);
  return null;
}

function closeAllSessions() {
  for (const instance of instances.values()) {
    if (!instance.sessionId) continue;
    const sessionId = instance.sessionId;
    instance.sessionId = null;
    sessions.delete(sessionId);
    sdk?.notify("terminal/close", { sessionId }).catch(() => {});
  }
}

function dispose() {
  removeEventListener?.();
  removeContextListener?.();
  resizeObserver.disconnect();
  for (const instance of [...instances.values()]) destroyTerminalInstance(instance);
}

function makeSessionId() {
  const unique = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `terminal-${unique}`;
}

function clampDimension(value) {
  return Math.min(500, Math.max(2, Number.isFinite(value) ? Math.round(value) : 24));
}
