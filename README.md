# DBX 内嵌终端

这是一个 DBX 工作台插件，在宿主界面内提供真正的本机交互式终端，不会弹出独立的系统终端窗口。

插件 ID：`io.github.mugongliu1.terminal`。源码和发行包发布于 <https://github.com/mugongliu1/dbx-terminal-launcher>。

## 功能

- Windows 使用 PowerShell + ConPTY，macOS/Linux 使用系统 shell + PTY
- 支持在同一宿主工作台内新建多个终端标签，每个标签使用独立 PTY 会话
- xterm.js 渲染 ANSI 颜色、光标和交互输入
- 自动适配工作台大小，支持清屏、重启和关闭
- 跟随 DBX 明暗主题，支持中文和英文界面
- shell 固定由后端选择，前端不能指定任意可执行文件

## 开发

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
