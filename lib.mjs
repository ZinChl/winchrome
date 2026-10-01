/**
 * lib.mjs — winchrome 的共享配置与 Windows 侧探测
 *
 * 所有路径都自动探测，可用环境变量覆盖，避免把某台机器的用户名写死：
 *   WIN_USER                Windows 用户名（默认自动探测）
 *   WIN_NODE                Windows 侧 node.exe
 *   WIN_MCP                 chrome-devtools-mcp 的入口 .js（Windows 路径）
 *   WIN_CHROME_EXE          Chrome/Edge 可执行文件（Windows 路径）
 *   WIN_CHROME_PROFILE      调试用数据目录（Windows 路径）
 *   WIN_CHROME_URL          调试端点，默认 http://127.0.0.1:9222
 *   WIN_CHROME_MODE         debug（默认，专用 profile）| auto（接入日常 Chrome）
 *   WIN_CHROME_AUTOSTART    1 = 需要时自动拉起浏览器；默认 0（手动）
 *   WIN_PAGE_ID_ROUTING     on = 页面级调用必须显式传 pageId
 *   WIN_MCP_EXTRA           追加给 chrome-devtools-mcp 的参数，空格分隔
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'

const env = process.env

/** Windows 路径 → WSL 路径（C:\Users\x → /mnt/c/Users/x） */
export function winToWsl(p) {
  if (!p) return null
  const m = /^([A-Za-z]):\\(.*)$/.exec(p)
  if (!m) return p
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

/** WSL 路径 → Windows 路径（/mnt/c/Users/x → C:\Users\x） */
export function wslToWin(p) {
  if (!p) return null
  const m = /^\/mnt\/([a-z])\/(.*)$/.exec(p)
  if (!m) return p
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`
}

const firstExistingWin = (candidates) => candidates.find((c) => c && existsSync(winToWsl(c))) || null

/** Windows 用户名：环境变量 → cmd.exe → 扫 /mnt/c/Users（纯文件系统，不依赖 PATH） */
function detectWinUser() {
  if (env.WIN_USER) return env.WIN_USER
  const r = spawnSync('cmd.exe', ['/c', 'echo %USERNAME%'], { encoding: 'utf8', timeout: 15000 })
  const u = String(r.stdout || '').trim().replace(/\r/g, '')
  if (u && !u.includes('%')) return u
  // 回退：找 /mnt/c/Users 下带 NTUSER.DAT 的目录（排除公共/内置账户）
  try {
    const skip = new Set(['public', 'default', 'default user', 'all users', 'wdagutilityaccount'])
    const dirs = readdirSync('/mnt/c/Users', { withFileTypes: true })
      .filter((d) => d.isDirectory() && !skip.has(d.name.toLowerCase()))
      .filter((d) => existsSync(`/mnt/c/Users/${d.name}/NTUSER.DAT`))
      .map((d) => ({ name: d.name, mtime: statSync(`/mnt/c/Users/${d.name}`).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    if (dirs.length) return dirs[0].name
  } catch {}
  return null
}

export const WIN_USER = detectWinUser()

// 注意两类路径的用途不同：
//   WIN_NODE  —— 由 WSL 侧的 spawn() 直接执行，必须是 /mnt/c/... 形式
//   WIN_MCP / CHROME_EXE / DEBUG_PROFILE —— 交给 Windows 侧进程，必须是 C:\... 形式
export const WIN_NODE = winToWsl(
  firstExistingWin([
    env.WIN_NODE,
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    WIN_USER ? `C:\\Users\\${WIN_USER}\\AppData\\Roaming\\nvm\\node.exe` : null,
    WIN_USER ? `C:\\Users\\${WIN_USER}\\scoop\\apps\\nodejs\\current\\node.exe` : null,
  ]) || env.WIN_NODE,
)

export const WIN_MCP =
  firstExistingWin([
    env.WIN_MCP,
    WIN_USER ? `C:\\Users\\${WIN_USER}\\.winchrome\\node_modules\\chrome-devtools-mcp\\build\\src\\bin\\chrome-devtools-mcp.js` : null,
    WIN_USER ? `C:\\Users\\${WIN_USER}\\.dsh-mcp\\node_modules\\chrome-devtools-mcp\\build\\src\\bin\\chrome-devtools-mcp.js` : null,
    WIN_USER ? `C:\\Users\\${WIN_USER}\\AppData\\Roaming\\npm\\node_modules\\chrome-devtools-mcp\\build\\src\\bin\\chrome-devtools-mcp.js` : null,
  ]) || env.WIN_MCP

export const CHROME_EXE =
  firstExistingWin([
    env.WIN_CHROME_EXE,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    WIN_USER ? `C:\\Users\\${WIN_USER}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe` : null,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ]) || env.WIN_CHROME_EXE

export const BROWSER_URL = env.WIN_CHROME_URL || 'http://127.0.0.1:9222'
export const PORT = Number(new URL(BROWSER_URL).port || 9222)
export const MODE = env.WIN_CHROME_MODE || 'debug'
export const AUTOSTART = env.WIN_CHROME_AUTOSTART === '1'
export const WINDOW_SIZE = env.WIN_CHROME_WINDOW_SIZE || '1280,800'
export const EXTRA = (env.WIN_MCP_EXTRA || '').split(/\s+/).filter(Boolean)
export const ROUTING = (env.WIN_PAGE_ID_ROUTING || 'off') === 'on' ? [] : ['--no-page-id-routing']

/**
 * 调试用数据目录。默认新建 `winchrome-profile`；但如果机器上已经存在旧名字的
 * 调试 profile（本工具早期版本用的 `chrome-dsh-debug`），就沿用那个，避免丢掉
 * 已经登好的登录态。显式设 WIN_CHROME_PROFILE 可以完全接管这个选择。
 */
function detectDebugProfile() {
  if (env.WIN_CHROME_PROFILE) return env.WIN_CHROME_PROFILE
  if (!WIN_USER) return null
  const legacy = `C:\\Users\\${WIN_USER}\\chrome-dsh-debug`
  const modern = `C:\\Users\\${WIN_USER}\\winchrome-profile`
  return existsSync(winToWsl(legacy)) ? legacy : modern
}

export const DEBUG_PROFILE = detectDebugProfile()

/** 日常 Chrome 的 user data 目录（auto 模式用来读 DevToolsActivePort）。 */
export const REAL_CHROME_USER_DATA =
  env.WIN_CHROME_USER_DATA ||
  (WIN_USER ? `C:\\Users\\${WIN_USER}\\AppData\\Local\\Google\\Chrome\\User Data` : null)

export const log = (tag) => (...a) => console.error(`[${tag}]`, ...a)

/** 缺失关键依赖时给出可执行的安装指引。 */
export function assertReady(tag = 'winchrome') {
  const missing = []
  if (!WIN_USER) missing.push('Windows 用户名（设 WIN_USER）')
  if (!WIN_NODE) missing.push('Windows 侧 node.exe（装 Node.js 或设 WIN_NODE）')
  if (!CHROME_EXE) missing.push('Chrome/Edge 可执行文件（设 WIN_CHROME_EXE）')
  if (missing.length) {
    console.error(`[${tag}] 缺少：${missing.join('、')}`)
    console.error(`[${tag}] Chrome 位置可参考：https://github.com/<you>/winchrome#安装`)
    process.exit(2)
  }
  if (!WIN_MCP) {
    console.error(`[${tag}] 找不到 chrome-devtools-mcp。请在 Windows 侧安装：`)
    console.error(`[${tag}]   npm install --prefix "%USERPROFILE%\\.winchrome" chrome-devtools-mcp`)
    process.exit(2)
  }
}

/** 真实 Chrome 的 browser WebSocket 端点（端口与 uuid 每次开启都会变，所以每次重读）。 */
export function realChromeWsEndpoint() {
  if (!REAL_CHROME_USER_DATA) return null
  try {
    const lines = readFileSync(`${winToWsl(REAL_CHROME_USER_DATA)}/DevToolsActivePort`, 'utf8').split(/\r?\n/)
    const port = (lines[0] || '').trim()
    const path = (lines[1] || '').trim()
    if (!/^\d+$/.test(port) || !path.startsWith('/devtools/')) return null
    return `ws://127.0.0.1:${port}${path}`
  } catch {
    return null
  }
}

// PowerShell 同样按绝对路径解析：环境被裁剪（PATH 里没有 Windows 目录）时也能用
const POWERSHELL =
  firstExistingWin([
    env.WIN_POWERSHELL,
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ]) || 'powershell.exe'

const ps = (script) => spawnSync(winToWsl(POWERSHELL), ['-NoProfile', '-Command', script], { encoding: 'utf8' })

/** 调试端口是否已在监听（Windows 侧）。 */
export function portListening() {
  const r = ps(`(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`)
  return String(r.stdout || '').trim() === '1'
}

/** 启动调试用浏览器（仅当 AUTOSTART=1 或被桌面开关脚本调用时）。 */
export function launchBrowser(tag = 'winchrome') {
  if (portListening()) return true
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${DEBUG_PROFILE}`,
    `--window-size=${WINDOW_SIZE}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]
  const argList = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',')
  ps(`Start-Process -FilePath '${CHROME_EXE.replace(/'/g, "''")}' -ArgumentList ${argList}`)
  for (let i = 0; i < 24; i++) {
    spawnSync('sleep', ['0.5'])
    if (portListening()) return true
  }
  console.error(`[${tag}] 启动后端口 ${PORT} 仍未监听，请检查浏览器路径与策略限制`)
  return false
}

/**
 * 决定本次要连哪里：auto 优先接日常 Chrome（带登录态），否则用调试实例。
 * 返回传给 chrome-devtools-mcp 的连接参数数组。
 */
export function connectionArgs(tag = 'winchrome') {
  const logFn = log(tag)
  if (MODE !== 'debug') {
    const ws = realChromeWsEndpoint()
    if (ws) {
      logFn(`接入日常 Chrome（登录态可用）: ${ws}`)
      return ['--wsEndpoint', ws]
    }
    logFn('未读到 DevToolsActivePort（日常 Chrome 未开远程调试）→ 回退调试实例')
  }
  if (AUTOSTART) launchBrowser(tag)
  else logFn('未自动启动浏览器（手动模式）；请用桌面开关脚本启动')
  return ['--browserUrl', BROWSER_URL]
}

/** chrome-devtools-mcp 的完整启动参数。 */
export function serverArgs(tag = 'winchrome') {
  return [WIN_MCP, ...connectionArgs(tag), ...ROUTING, ...EXTRA]
}
