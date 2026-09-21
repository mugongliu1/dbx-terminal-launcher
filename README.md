# DBX 内嵌终端

这是一个 DBX 工作台插件，在宿主界面内提供真正的本机交互式终端，不会弹出独立的系统终端窗口。

插件 ID：`io.github.mugongliu1.terminal`。源码和发行包发布于 <https://github.com/mugongliu1/dbx-terminal-launcher>。

## 功能

- Windows 使用 PowerShell + ConPTY，macOS/Linux 使用系统 shell + PTY
- 支持在同一宿主工作台内新建多个终端标签，每个标签使用独立 PTY 会话
- xterm.js 渲染 ANSI 颜色、光标和交互输入
- 保留最多 100,000 行终端回滚历史，清屏和窗口缩放时也尽量保留已有输出
- 自动适配工作台大小，支持清屏、重启和关闭
- 跟随 DBX 明暗主题，支持中文和英文界面
- shell 固定由后端选择，前端不能指定任意可执行文件

## 开发

### 分屏终端

- 点击工具栏「左右分屏并新建终端」或「上下分屏并新建终端」，拆分当前选中的窗格并启动独立终端；可组合为四宫格，最多同时显示 4 个终端。达到上限后分屏按钮禁用。
- 点击窗格或标签选择终端，清屏、重启、停止只作用于当前选中的终端。窗格标题栏的关闭按钮会关闭该会话，并将空间合并给相邻窗格。
- 「返回单屏」只显示当前终端，其他会话仍保留在标签中。在分屏模式下选择隐藏标签或点击普通「新建终端」，会替换当前窗格显示的终端，其他窗格保持可见。
- 分屏测试：`python tests/test_terminal_split.py`（先构建 UI，并安装 Python Playwright / Chromium）。

需要 Node.js 22+ 和 Rust 工具链。

```powershell
npm install
npm run build:ui
npx --yes @dbx-app/plugin-cli dev --path . --port 5190
```

浏览器打开 `http://127.0.0.1:5190`。工作台加载后会自动在插件页面内启动终端。

## 打包

```powershell
npx --yes @dbx-app/plugin-cli package .
```

产物位于 `dist/`。在 Windows 上编译 Rust 后端需要可用的 MSVC/Windows SDK 链接环境。

## RPC

### Codex 历史回滚

建议使用 `codex --no-alt-screen` 启动需要通过终端滚轮查看历史的会话。本机 Codex CLI 的该选项用于禁用备用屏幕并保留终端回滚历史；备用屏幕的内容由应用自身管理。

普通缓冲区保留最多 100,000 行。插件保护应用发出的 `CSI 3J` / `CSI ? 3J` 清历史指令，避免已保存的输出被删除；工具栏「清屏」、重启、关闭标签或重新加载插件仍会清除相应历史。这不是跨会话的消息存档，也无法恢复修复前已被删除的内容。

滚动回归检查：先执行 `npm run build:ui`，再执行 `python tests/test_terminal_scroll.py`（需要 Python Playwright 和 Chromium）。

前端通过以下后端方法管理会话：

- `terminal/start`
- `terminal/input`
- `terminal/resize`
- `terminal/close`

后端通过 `host.events` 权限发送 `terminal/output`、`terminal/exit` 和 `terminal/error` 事件。

## 安全说明

插件后端会以当前用户身份启动本机 PowerShell（Windows）或系统 shell（macOS/Linux）。插件本身不监听端口，也不主动访问网络；终端中运行的命令拥有与当前用户相同的文件和网络权限，请只执行可信命令。

## 许可证

Apache-2.0
