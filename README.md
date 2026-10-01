# winchrome

**从 WSL 里直接操控 Windows 端 Chrome。** 把 `chrome-devtools-mcp` 放到 Windows 侧运行，
让 WSL 中的 AI agent（DeepSeek Harness、Claude Code、Cursor…）能导航、点击、填表、执行 JS、
读无障碍树、截图——就像浏览器长在 WSL 里一样。

> **EN:** Drive Windows-side Chrome from WSL. The MCP server runs on Windows (via WSL interop)
> so it can reach Chrome's loopback-only DevTools endpoint, which WSL cannot. All paths are
> auto-detected, so there is no config to fill in. Built for `chrome-devtools-mcp`.

---

## 为什么需要它

三个限制叠在一起，导致「WSL 直接连 Windows 的 Chrome 调试端口」走不通：

| 限制 | 后果 |
| --- | --- |
| Chrome 只监听 `127.0.0.1`，且新版忽略 `--remote-debugging-address` | 从 WSL 连 `192.168.x.x:9222` 一律失败 |
| WSL2 默认 NAT 网络，到不了 Windows 的 loopback | 端口开着也连不上 |
| Chrome 136+ 用默认 user data 目录时禁用远程调试 | 必须显式 `--user-data-dir` 指向非默认目录 |

绕法只有一条：**把 MCP 服务器放到 Windows 侧跑**（用 Windows 自带的 `node.exe`，通过 WSL
interop 启动），它到 Chrome 就是本机连接。不需要管理员权限、不需要 `netsh portproxy`、
不需要把 WSL 改成 mirrored 网络模式。

```
WSL: agent / CLI
      │  stdio (JSON-RPC over WSL interop)
      ▼
Windows: node.exe + chrome-devtools-mcp ──本机 ws──► 浏览器 127.0.0.1:9222
```

## 安装

### 前置条件

- Windows 10/11，装有 Chrome（或 Edge）
- WSL2 + 任一发行版，且 WSL interop 可用（默认开启，在 WSL 里能跑 `cmd.exe` 就说明可用）
- **Windows 侧装有 Node.js**（用来跑 chrome-devtools-mcp）：<https://nodejs.org>
- WSL 侧装有 Node.js ≥ 18

### 第 1 步：在 Windows 侧安装 chrome-devtools-mcp

在 **Windows** 的 PowerShell / cmd 里执行：

```bat
npm install --prefix "%USERPROFILE%\.winchrome" chrome-devtools-mcp
```

装到别处也行，用环境变量 `WIN_MCP` 指过去即可（见下方「环境变量」）。
本工具会自动在这几个位置找它：

```
%USERPROFILE%\.winchrome\node_modules\chrome-devtools-mcp\...
%USERPROFILE%\.dsh-mcp\node_modules\chrome-devtools-mcp\...
%APPDATA%\npm\node_modules\chrome-devtools-mcp\...   （npm i -g 的全局安装）
```

### 第 2 步：在 WSL 侧获取本项目

```bash
git clone https://github.com/ZinChl/winchrome.git ~/extensions/winchrome
cd ~/extensions/winchrome
```

**零依赖，不需要 `npm install`**——只用 Node 内置模块。

### 第 3 步：确认探测结果

```bash
node winchrome.mjs status
```

正常会打印自动探测到的 Windows 用户名、浏览器路径、调试 profile 与端口状态。某项不对就用
环境变量覆盖。

### 第 4 步：启动调试用浏览器并验证

```bash
node winchrome.mjs start     # 用独立 profile 启动浏览器（不影响你日常那个）
node winchrome.mjs pages     # 应列出当前标签页
```

到这里 CLI 已经可用。想让浏览器由你自己手动开关，见下方「日常使用」。

### 第 5 步（可选）：接入 MCP 客户端

以 DeepSeek Harness 的 `~/.dsh/profiles/web/cordis.patch.yml` 为例：

```yaml
- insert:
    - id: mcp-winchrome
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: winchrome
        command: /home/<你>/.nvm/versions/node/v22.23.1/bin/node   # WSL 里的 node 绝对路径
        args:
          - /home/<你>/extensions/winchrome/mcp-entry.mjs
        env:
          WIN_CHROME_MODE: debug          # 专用调试 profile，零授权弹窗
          WIN_CHROME_AUTOSTART: '0'       # 不自动拉起浏览器，交给开关脚本
          WIN_MCP_EXTRA: '--screenshotFormat jpeg --screenshotQuality 70'
        toolCallTimeoutMs: 120000
```

其它 MCP 客户端（Claude Desktop / Cursor / Cline…）用同样的 `command` + `args` 即可。
工具名会以 `mcp__winchrome__` 开头，例如 `mcp__winchrome__navigate_page`。

## 日常使用

### 手动开关浏览器（推荐）

`scripts/chrome-debug.ps1` 提供 `start` / `stop` / `status` / `toggle` 四个动作，
同目录的 `scripts/chrome-debug.cmd` 双击即切换启停。想放桌面就把这两个文件一起复制过去
（保持在同一目录）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File chrome-debug.ps1 toggle
```

关掉浏览器不影响 agent：MCP 服务器仍常驻，浏览器一回来，下一次工具调用会**自动重连**。

### 命令行

```bash
node winchrome.mjs start                 # 启动调试浏览器（独立 profile）
node winchrome.mjs status                # 探测结果 + 端口/端点状态
node winchrome.mjs tools                 # 列出 chrome-devtools-mcp 的全部工具
node winchrome.mjs daemon status         # CLI 加速守护进程（start / stop）
node winchrome.mjs pages                 # 列出页面
node winchrome.mjs goto https://x.com    # 导航
node winchrome.mjs snap                  # 无障碍树快照（拿 uid）
node winchrome.mjs click 1_29            # 按 uid 点击
node winchrome.mjs type "你好"            # 在当前焦点输入
node winchrome.mjs search "关键词"        # 快照→找输入框→填词→回车（同一次会话）
node winchrome.mjs eval 'document.title' # 页面内执行 JS
node winchrome.mjs shot out/x.png        # 截图（默认回拷到 WSL）
node winchrome.mjs call fill '{"uid":"1_29","value":"x"}'
node winchrome.mjs seq '[{"name":"take_snapshot"},{"name":"click","args":{"uid":"1_5"}}]'
```

两点经验：

- **uid 只在同一次 MCP 会话内有效**。需要「看一页再点」的连续操作，用 `seq`，或者直接用
  MCP 客户端里的原生工具（服务器常驻，uid 天然跨调用有效）。
- CLI 默认走常驻守护进程，所以连续调用很快，也不会反复新建浏览器连接。加
  `WINCHROME_NO_DAEMON=1` 可退回每次新开会话。

## 环境变量

全部可选，不设就自动探测。

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `WIN_USER` | Windows 用户名 | 自动探测（问 `cmd.exe`，失败则扫 `/mnt/c/Users`） |
| `WIN_NODE` | Windows 侧 `node.exe` | `C:\Program Files\nodejs\node.exe` 等 |
| `WIN_MCP` | `chrome-devtools-mcp` 入口 `.js` | 见「安装」一节的三处候选 |
| `WIN_CHROME_EXE` | 浏览器可执行文件（可指向 Edge） | Chrome 常见安装路径 |
| `WIN_CHROME_PROFILE` | 调试用数据目录（Windows 路径） | 优先沿用已存在的旧目录，否则新建 `winchrome-profile` |
| `WIN_CHROME_URL` | 调试端点 | `http://127.0.0.1:9222` |
| `WIN_CHROME_MODE` | `debug` = 专用 profile；`auto` = 接入你日常的 Chrome | `debug` |
| `WIN_CHROME_AUTOSTART` | `1` = 需要时自动拉起浏览器 | `0`（手动） |
| `WIN_CHROME_WINDOW_SIZE` | 自动拉起时的窗口尺寸 | `1280,800` |
| `WIN_PAGE_ID_ROUTING` | `on` = 页面级调用必须显式传 `pageId` | `off` |
| `WIN_MCP_EXTRA` | 追加给 chrome-devtools-mcp 的参数 | 空 |
| `WINCHROME_SOCK` | 守护进程 socket 路径 | `/tmp/winchrome.sock` |
| `WINCHROME_OUT` | 截图落地目录 | `./out` |

## 安全须知

这个工具本质上是**把浏览器的完整控制权交给 WSL 里的程序**，请知悉：

- 调试端口只绑 `127.0.0.1`，Windows 防火墙之外访问不到；但仍不要把它暴露到局域网。
- 默认使用**独立 profile**，里面没有你日常浏览器的 Cookie 和登录态。这是有意的隔离——
  它同时意味着你在里面是「未登录」状态，需要单独登录一次（之后会持久保存）。
- 想接日常 Chrome 的登录态，得先在 `chrome://inspect/#remote-debugging` 手动开启实例级
  远程调试，再把 `WIN_CHROME_MODE` 设为 `auto`。**代价是每建立一条新连接就弹一次授权框**：
  这是 Chrome 144+ 的设计，上游
  [chrome-devtools-mcp#825](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/825)
  请求「记住选择」被 closed as not planned。本项目用常驻守护进程把连接数压到最低（2 条），
  但无法消除该弹窗。
- 不要把带敏感信息的截图提交进仓库（`.gitignore` 已排除 `out/`）。

## 兼容性

- 在 Windows 11 + WSL2（Ubuntu）+ Chrome 154 + Node 22 上实测通过。
- Edge 同样可用（`chrome-devtools-mcp` 官方支持 Chromium 系浏览器）：把 `WIN_CHROME_EXE`
  指向 `msedge.exe`。注意 Edge 也继承了 Chrome 136 的默认 profile 限制。
- 不依赖 DSH：任何能执行命令的 MCP 客户端都能用它。

## 文档

- [docs/NOTES.md](docs/NOTES.md) — 踩坑记录：为什么必须这样绕、实测性能数据、
  大截图回拷、工具 schema 开销等。

## License

[MIT](LICENSE)
