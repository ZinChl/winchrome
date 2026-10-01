# winchrome — 从 WSL 直接操控 Windows 端 Chrome

在 WSL2 里驱动 Windows 上那个 Chrome：导航、读无障碍树、执行 JS、真实键鼠输入、截图（截图会回拷到 WSL，模型可直接看）。

## 为什么需要这层桥

三个限制叠在一起，导致“WSL 直接连 Windows 的 Chrome 调试端口”走不通：

| 限制 | 后果 |
| --- | --- |
| Chrome 只监听 `127.0.0.1`，且新版忽略 `--remote-debugging-address` | 从 WSL 连 `192.168.x.x:9222` 一律失败 |
| WSL2 默认 NAT 网络，到不了 Windows 的 loopback | 即使端口开着也连不上 |
| Chrome 136+ 用默认 profile 时禁用远程调试 | 必须显式指定 `--user-data-dir` |

绕法：**把 chrome-devtools-mcp 放到 Windows 侧运行**（用 Windows 自带的 `node.exe`，通过 WSL interop 启动），它到 Chrome 就是本机连接。不需要管理员权限、不需要 `netsh portproxy`、不需要改 WSL 网络模式（那要 `wsl --shutdown`）。

```
WSL: Claude/DSH 或本脚本
      │  stdio (JSON-RPC over WSL interop)
      ▼
Windows: node.exe + chrome-devtools-mcp ──本机 ws──► Chrome 127.0.0.1:9222
```

## 文件

- `winchrome.mjs` — 命令行驱动（本目录主入口），默认走守护进程
- `winchromed.mjs` — 常驻 MCP 客户端：只向 Chrome 建**一条**连接，CLI 全部复用它（避免每次调用弹授权框）
- `mcp-entry.mjs` — 自愈启动入口：先确保 Chrome 调试端口，再拉起 MCP 服务器；供 DSH 的 mcp-client 直接调用
- `out/` — 截图默认落地目录

## 常用命令

```bash
cd ~/extensions/winchrome

node winchrome.mjs start                 # 若未在调试模式则启动 Windows Chrome（独立 profile）
node winchrome.mjs status                # 端口 + DevTools 端点状态
node winchrome.mjs tools                 # 29 个工具及其说明
node winchrome.mjs daemon status           # 守护进程状态（start / stop）
node winchrome.mjs pages                 # 列出页面
node winchrome.mjs goto https://x.com    # 导航
node winchrome.mjs snap                  # 无障碍树快照（拿 uid）
node winchrome.mjs click 1_29            # 按 uid 点击
node winchrome.mjs type "你好"            # 在当前焦点输入
node winchrome.mjs search "关键词"        # 快照→找输入框→填词→回车（同一次会话内）
node winchrome.mjs eval 'document.title' # 页面内执行 JS
node winchrome.mjs shot out/x.png        # 截图（大图自动从 Windows 临时文件回拷）
node winchrome.mjs call fill '{"uid":"1_29","value":"x"}'
node winchrome.mjs seq '[{"name":"take_snapshot"},{"name":"click","args":{"uid":"1_5"}}]'
```

要点：**uid 只在同一次 MCP 会话内有效**（快照缓存在服务器进程里）。需要“看一页再点”的连续操作，用 `seq` 或 `search`，别用两次独立的 `call`。

## 已实测验证

- 握手：`chrome_devtools 1.9.0`，tools/list 返回 29 个工具
- `navigate_page` 到 example.com / bing.com，`list_pages` 显示真实标题与 URL
- `take_snapshot` 读到无障碍树、`evaluate_script` 取到 `document.title`/`h1`
- `take_screenshot` 截图回拷 WSL 并被模型读取（example.com、Bing 首页、搜索结果页）
- `fill` + `press_key Enter` 真实输入并跳转到 `bing.com/search?q=...`
- `mcp-entry.mjs` 作为 stdio MCP 服务器可正常 initialize

## 接入 DSH（已写入 web profile）

`@deepseek-ai/dsh-mcp-client` 会从 dsh 安装目录解析，**不需要** `dsh plugin add`。在
`~/.dsh/profiles/web/cordis.patch.yml` 追加（注意新行必须挂在 `insert:` 下——裸写
`- id: xxx` 会被当成「找不到目标行」而静默跳过）：

```yaml
- insert:
    - id: mcp-winchrome
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: winchrome
        command: ~/.nvm/versions/node/v22.23.1/bin/node
        args:
          - ~/extensions/winchrome/mcp-entry.mjs
        env:
          WIN_CHROME_MODE: auto          # 优先接你日常的 Chrome（登录态），失败回退调试实例
          WIN_MCP_EXTRA: '--screenshotFormat jpeg --screenshotQuality 70'
        toolCallTimeoutMs: 120000
```

loader 会监听该文件并**热加载**，无需重启：写完后 `ps aux | grep mcp-entry` 应能看到
`dsh web` 的子进程。工具名形如 `mcp__winchrome__navigate_page`、`mcp__winchrome__take_screenshot`。

离线校验（不启动服务）：

```bash
dsh --profile web --dump-config | grep -A 10 mcp-winchrome   # 应能看到该行且无告警
dsh --profile headless --patch /tmp/mcp-test.yml "调用 mcp__winchrome__list_pages"   # 独立进程实测
```

回滚：删除 `insert:` 那一段，或还原 `cordis.patch.yml.bak-*`。

## 手动开关：桌面上的「Chrome调试开关.cmd」

**DSH 不再自动拉起浏览器**（配置里 `WIN_CHROME_AUTOSTART: '0'`）。浏览器完全由你控制：

- 桌面 `Chrome调试开关.cmd` —— 双击即切换：没开就启动调试实例，已开就关掉它。
- 底层逻辑在 `<你的Windows用户>\.dsh-mcp\chrome-debug.ps1`，也支持显式动作：

```
powershell -NoProfile -ExecutionPolicy Bypass -File "<你的Windows用户>\.dsh-mcp\chrome-debug.ps1" start|stop|status|toggle
```

行为要点：

- **关掉调试 Chrome 不影响 DSH**：MCP 服务器仍常驻，浏览器一回来，下一次工具调用会**自动重连**，无需重启 DSH。
- 浏览器没开时，浏览器类工具会报 `Could not connect to Chrome` —— 这是预期行为，双击脚本即恢复。
- 想改回自动拉起：把 `WIN_CHROME_AUTOSTART` 改成 `'1'`（热加载即生效）。

## 日常使用：让 Chrome 一直是可被我操作的那个

已配置好三个入口，**都带调试参数**，点哪个都进同一个调试 profile：

| 入口 | 路径 |
| --- | --- |
| 桌面 | `D:\Users\<你的Windows用户>\Desktop\Chrome MCP.lnk` |
| 开始菜单 | `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Chrome MCP.lnk` |
| 任务栏固定项 | 原「Google Chrome」固定项已就地加上参数（备份 `Google Chrome.lnk.bak`） |

参数：

```
--remote-debugging-port=9222 --user-data-dir="<你的Windows用户>\winchrome-profile"
--no-first-run --no-default-browser-check
```

**为什么这样就零弹窗**：走的是传统端口模式（不是 `chrome://inspect` 的实例级授权），
传统模式不做逐连接授权。代价是 profile 必须是非默认目录——这正是 Chrome 136 的硬性要求。

**首次要做的一次性动作**：在这个 profile 里登录你要用的站点（中文站基本都能扫码）。
登录态存在 `winchrome-profile` 里，长期有效，不用重复登。

**三个注意点**

1. 从其它程序点开的链接、以及「所有用户」开始菜单里那个 Chrome，仍会走**默认 profile**——
   那个实例我操作不到。想让所有入口都进调试 profile，就得动 `ChromeHTML` 的注册表（风险高，未做）。
2. 任务栏固定项若没立刻生效（Windows 会缓存），取消固定再重新固定一次即可。
3. 想回到日常 profile：把快捷方式参数清空，或还原 `Google Chrome.lnk.bak`。
   想临时接回真实 Chrome 拿它的登录态：profile 里设 `WIN_CHROME_MODE: auto`（每条新连接会弹一次授权）。

## 接入你日常的 Chrome（登录态/Cookie）

在 Chrome 里打开 `chrome://inspect/#remote-debugging`，勾选 *Allow remote debugging for this browser
instance*（页面会显示 `Server running at: 127.0.0.1:<port>`）。然后在 profile 的 env 里设
`WIN_CHROME_MODE: auto`（已是默认），入口脚本就会优先接这个 Chrome；读不到就自动回退到独立调试实例。

两个实测坑：

1. **这套实例级远程调试没有 `/json/*` HTTP 端点**。`GET /json/version` 返回 `404`，只有一条
   browser WebSocket 可用（`ws://127.0.0.1:<port>/devtools/browser/<uuid>`）。
2. **`--autoConnect` 实测会挂**（list_pages 超时）。因此 `mcp-entry.mjs` 自己读
   `%LOCALAPPDATA%\Google\Chrome\User Data\DevToolsActivePort`（第一行端口、第二行 ws 路径）
   拼出 `--wsEndpoint`——端口与 uuid 每次开启都会变，所以每次启动都重读。

**礼貌约定**：真实 Chrome 里 `--no-page-id-routing`（默认）作用于“当前选中页”，直接 `navigate_page`
会导航你正在看的标签。所以要用 `new_page` 开自己的标签页干活，用完 `close_page`；不要动你的标签。
想要更严格的定位，设 `WIN_PAGE_ID_ROUTING: on`，此后每个页面级调用都必须显式传 `pageId`。

**隐私**：该开关的授权范围就是页面里写的那句——外部程序可获得完整控制权，包括读取已保存数据与
Cookie。不用时在 `chrome://inspect` 里关掉即可断开（工具会回退到独立调试实例）。

## 关于「要允许远程调试吗」弹窗

**原因**：Chrome 144+ 的实例级远程调试授权**不做持久化**——每建立一条新的 CDP 连接就弹一次。
上游 [chrome-devtools-mcp#825](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/825)
请求「记住选择」，被 **closed as not planned**。本机核实：`Local State` 里只有
`devtools.remote_debugging.user-enabled: true` 这个开关状态，**没有任何按应用/进程记录的信任表**，
所以「默认信任」在当前 Chrome 上做不到。

**唯一有效的办法是减少连接数**：

| 连接来源 | 是否常驻 | 弹窗代价 |
| --- | --- | --- |
| DSH 原生工具（`mcp-entry.mjs`） | 常驻，跟 dsh web 同生命周期 | 每个 Chrome 会话 1 次 |
| CLI（`winchromed.mjs` 守护进程） | 常驻，懒启动 | 每个 Chrome 会话 1 次 |
| ~~CLI 每次调用新开 MCP 会话~~ | 已废弃 | ~~每次调用 1 次~~ |

所以现在的总代价是**每个 Chrome 会话 2 次**，与调用次数无关。三个会让它重新弹的动作：重启
DSH、改动 profile 配置（会重启插件）、重启 Chrome。想做到零弹窗只能用 `WIN_CHROME_MODE: debug`
（独立调试实例，代价是没有登录态）。

## 性能实测与优化

| 项 | 优化前 | 优化后 | 说明 |
| --- | --- | --- | --- |
| 截图格式 | PNG 5.4MB（Bing 首页） | JPEG q70 0.55MB | 模型侧看到的是同一张——harness 按 `imagePixelBudget`(640k px) 归一化，省的是传输/编码/落盘 |
| 启动窗口 | 1602×2324 → 预览 664×963 | 1280×800 → 预览 1011×633 | 同样 token 预算下**文字明显更清晰**（预览更接近预算上限且是桌面比例） |
| 调用路径 | wrapper 每次新开进程 ≈1.1s | 原生 `mcp__winchrome__*`（常驻服务器） | 无进程启动开销；**快照 uid 可跨调用复用** |
| 工具 schema | 29 个 / 23.8KB | 22 个 / 17.1KB（可选） | 裁掉 performance/network/emulation 三类，每轮约省 1.7k tokens |

截图默认值来自 profile 里的 `env.WIN_MCP_EXTRA`；命令行可用同样的环境变量覆盖：

```bash
WIN_MCP_EXTRA="--screenshotMaxWidth 1000" node winchrome.mjs shot out/x.png
```

**2026-09-17 复测发现**：Chrome 被关掉后，常驻 MCP 服务器**不会自己把浏览器拉回来**，所有工具报
`Could not connect to Chrome ... fetch failed`；但服务器本身存活，Chrome 一旦恢复，**下一次调用会惰性重连成功**，无需重启 MCP。所以浏览器类任务失败时先跑一次：

```bash
node ~/extensions/winchrome/winchrome.mjs start   # 幂等，已开则直接返回
```

## 注意事项

- **调试实例 vs 真实 Chrome**：`WIN_CHROME_MODE=auto`（默认）优先接你日常的 Chrome，用它的登录态；
  切到 `debug` 才只用独立 profile（`<你的Windows用户>\winchrome-profile`，无登录态、不干扰你在用的浏览器）。
- 独立调试实例用完可直接关掉；`mcp-entry.mjs` 在需要时会按 `--window-size=1280,800` 重新拉起。
- Chrome 大版本升级后，若启动失败，先跑 `node winchrome.mjs status` 确认端点；必要时删掉调试 profile 目录重来。
- 截图体积大（Bing 首页 PNG 5.5MB），会吃上下文；需要小图可用 `call take_screenshot '{"format":"jpeg"}'` 或加 `--screenshotMaxWidth` 参数。
- 端口 9222 打开期间，本机任何进程都能接管该浏览器；用完可关掉那个调试实例。
