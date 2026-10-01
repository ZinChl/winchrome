#!/usr/bin/env node
/**
 * winchrome — 从 WSL 直接操控 Windows 端 Chrome。
 *
 * 原理：chrome-devtools-mcp 以 MCP server 身份 **运行在 Windows 侧**（用它自带的
 * Node.exe，通过 WSL interop 启动），因此它能以本机身份连上 Chrome 的 DevTools
 * 端口 127.0.0.1:9222 —— 绕开了「WSL2 到不了 Windows loopback」「Chrome 只绑
 * 127.0.0.1」「新版 Chrome 忽略 --remote-debugging-address」这三重限制，
 * 不需要管理员权限、不需要 netsh portproxy、不需要改 WSL 网络模式。
 *
 * 用法：
 *   node winchrome.mjs start                 # 若未在调试模式则启动 Windows Chrome
 *   node winchrome.mjs status                # 检查端口与连接
 *   node winchrome.mjs tools                 # 列出全部可用工具
 *   node winchrome.mjs pages                 # 列出页面
 *   node winchrome.mjs goto <url>            # 打开/导航
 *   node winchrome.mjs shot [out.png]        # 截图（默认存 ./out/）
 *   node winchrome.mjs snap                  # 页面无障碍树快照
 *   node winchrome.mjs eval '<js>'           # 在页面里执行 JS（函数体或表达式）
 *   node winchrome.mjs call <tool> '<json>'  # 任意工具，原始调用
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WIN_NODE, WIN_USER, BROWSER_URL, PORT, DEBUG_PROFILE, MODE, AUTOSTART,
  serverArgs, assertReady, portListening, launchBrowser, realChromeWsEndpoint,
} from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = process.env.WINCHROME_OUT || resolve(HERE, 'out')
const DAEMON = resolve(HERE, 'winchromed.mjs')
const SOCK = process.env.WINCHROME_SOCK || '/tmp/winchrome.sock'
const NO_DAEMON = process.env.WINCHROME_NO_DAEMON === '1'

assertReady('winchrome')

const SERVER_ARGS = serverArgs('winchrome')

/** 检查 DevTools HTTP 端点是否可读（仅传统端口模式支持；实例级调试没有 /json/*）。 */
function endpointAlive() {
  const r = spawnSync(WIN_NODE, ['-e', `fetch('${BROWSER_URL}/json/version').then(r=>r.json()).then(j=>console.log(j.Browser)).catch(()=>{process.exit(1)})`], { encoding: 'utf8', timeout: 20000 })
  return r.status === 0 ? String(r.stdout).trim() : null
}

function startChrome() {
  if (portListening()) {
    console.log(`端口 ${PORT} 已在监听，不重复启动。`)
    return true
  }
  console.log('正在以调试模式启动浏览器（独立 profile，不影响你日常那个）...')
  const ok = launchBrowser('winchrome')
  if (ok) console.log(`调试端口已就绪：${BROWSER_URL}`)
  return ok
}

/** 跑一次 MCP 会话：连上 Windows 侧服务器，顺序执行调用，返回结果数组。 */
function withServer(calls, { timeoutMs = 120000 } = {}) {
  return new Promise((res, rej) => {
    const child = spawn(WIN_NODE, SERVER_ARGS, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' },
    })
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n')
    const results = []
    const errs = []
    let buf = ''
    let idx = 0
    const timer = setTimeout(() => { child.kill('SIGKILL'); rej(new Error('MCP 会话超时')) }, timeoutMs)

    const next = () => {
      if (idx >= calls.length) {
        clearTimeout(timer)
        child.kill('SIGTERM')
        setTimeout(() => { child.kill('SIGKILL'); res({ results, errs }) }, 500)
        return
      }
      const c = calls[idx]
      // args 可以是函数：用已有结果动态推导（uid 只能在同一次会话的快照里拿到）
      const args = typeof c.args === 'function' ? c.args(results) : (c.args ?? {})
      send({ jsonrpc: '2.0', id: 100 + idx, method: 'tools/call', params: { name: c.name, arguments: args } })
    }

    child.stderr.on('data', (d) => {
      const s = d.toString().trim()
      if (s && !/usage statistics|exposes content|debug, and modify|Avoid sharing|Performance tools/.test(s)) errs.push(s)
    })
    child.on('error', (e) => { clearTimeout(timer); rej(e) })

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        let msg; try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
          next()
        } else if (typeof msg.id === 'number' && msg.id >= 100) {
          const c = calls[msg.id - 100]
          const parts = msg.result?.content ?? []
          const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
          const image = parts.find((p) => p.type === 'image')
          let saved
          if (image?.data) {
            mkdirSync(OUT_DIR, { recursive: true })
            const ext = c.args?.format === 'jpeg' ? '.jpg' : c.args?.format === 'webp' ? '.webp' : '.png'
            saved = c.out ? resolve(c.out) : resolve(OUT_DIR, `shot-${Date.now()}${ext}`)
            writeFileSync(saved, Buffer.from(image.data, 'base64'))
          } else if (text) {
            // 大截图会被服务器落盘成 Windows 临时文件：从 /mnt/c 回拷
            const m = text.match(/Saved screenshot to (.+?\.(?:png|jpe?g|webp))\.?\s*$/im)
            if (m) {
              const linux = m[1].trim().replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/')
              try {
                mkdirSync(OUT_DIR, { recursive: true })
                saved = c.out ? resolve(c.out) : resolve(OUT_DIR, `shot-${Date.now()}${linux.slice(linux.lastIndexOf('.'))}`)
                copyFileSync(linux, saved)
              } catch (e) { errs.push(`截图回拷失败: ${e.message} (${linux})`); saved = undefined }
            }
          }
          results.push({ tool: c.name, text, image: saved, raw: msg.result, isError: msg.result?.isError ?? Boolean(msg.error), error: msg.error })
          idx++
          next()
        }
      }
    })

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'winchrome', version: '1.0.0' } } })
  })
}

/**
 * 走常驻守护进程：复用它与 Chrome 的那一条连接，因此不再触发新的授权弹窗。
 * 守护进程不在就懒启动（首次仍会弹一次），失败则返回 null 由调用方回退。
 */
function daemonCall(calls) {
  return new Promise((res) => {
    if (!existsSync(SOCK)) return res(null)
    const sock = connect(SOCK)
    let data = ''
    const done = (v) => { try { sock.destroy() } catch {} ; res(v) }
    sock.setTimeout(120000, () => done(null))
    sock.on('connect', () => sock.write(JSON.stringify({ calls }) + '\n'))
    sock.on('data', (c) => { data += c.toString() })
    sock.on('end', () => {
      try { done(JSON.parse(data.trim())) } catch { done(null) }
    })
    sock.on('error', () => done(null))
  })
}

function startDaemon() {
  const p = spawn(process.execPath, [DAEMON], { detached: true, stdio: 'ignore' })
  p.unref()
}

/** 统一入口：优先守护进程（零新增连接），否则回退到一次性会话。 */
async function invoke(calls) {
  if (!NO_DAEMON) {
    let r = await daemonCall(calls)
    if (!r) {
      // 没连上（守护进程没跑，或 socket 陈旧）：启动后轮询重试，而不是只看文件是否存在
      startDaemon()
      for (let i = 0; i < 24; i++) {
        await new Promise((s) => setTimeout(s, 500))
        r = await daemonCall(calls)
        if (r) break
      }
    }
    if (r?.results) return { results: r.results, errs: [] }
    if (r?.error) return { results: [{ tool: '(daemon)', text: '', isError: true, error: r.error }], errs: [] }
  }
  return withServer(calls)
}

const [cmd, ...rest] = process.argv.slice(2)

function report({ results, errs }) {
  for (const r of results) {
    if (r.text) console.log(r.text)
    if (r.image) console.log(`[截图已保存] ${r.image}`)
    if (r.isError) console.log(`[工具报错] ${r.error ? JSON.stringify(r.error) : r.text}`)
  }
  if (errs.length) console.error('[server]', errs.join(' ').slice(0, 300))
}

try {
  switch (cmd) {
    case 'start': {
      if (endpointAlive()) { console.log(`已在调试模式运行：${BROWSER_URL}`); break }
      if (!startChrome()) process.exit(1)
      const v = endpointAlive()
      console.log(v ? `已连接：${v}` : '端口开了但 DevTools 端点无响应。')
      break
    }
    case 'status': {
      console.log(`Windows 用户     : ${WIN_USER}`)
      console.log(`模式             : ${MODE}${MODE === 'debug' ? '（专用调试 profile，零授权弹窗）' : '（接入日常 Chrome，逐连接需授权）'}`)
      console.log(`调试 profile     : ${DEBUG_PROFILE}`)
      console.log(`端点             : ${BROWSER_URL}`)
      console.log(`端口 ${PORT} 监听  : ${portListening() ? '是' : '否'}`)
      console.log(`自动拉起浏览器   : ${AUTOSTART ? '开' : '关（用桌面开关脚本手动启停）'}`)
      const v = endpointAlive()
      console.log(v ? `DevTools 端点    : ${v}` : 'DevTools 端点    : 不可读（端口模式应有 /json/version；未启动请先跑 start）')
      break
    }
    case 'tools': {
      const r = await new Promise((res, rej) => {
        const child = spawn(WIN_NODE, SERVER_ARGS, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } })
        let buf = ''
        child.stdout.on('data', (c) => {
          buf += c.toString()
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
            if (!line) continue
            let m; try { m = JSON.parse(line) } catch { continue }
            if (m.id === 1) {
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
            } else if (m.id === 2) { child.kill('SIGTERM'); res(m.result.tools) }
          }
        })
        child.on('error', rej)
      })
      for (const t of r) console.log(`${t.name}\n    ${(t.description || '').split('\n')[0]}`)
      console.log(`\n共 ${r.length} 个工具`)
      break
    }
    case 'pages':
      report(await invoke([{ name: 'list_pages', args: {} }]))
      break
    case 'goto':
      if (!rest[0]) throw new Error('用法: goto <url>')
      report(await invoke([{ name: 'navigate_page', args: { url: rest[0] } }]))
      break
    case 'shot':
      // 不显式指定格式 → 用 profile 注入的默认值（jpeg q70）；可传第二个参数覆盖
      report(await invoke([{ name: 'take_screenshot', args: rest[1] ? { format: rest[1] } : {}, out: rest[0] }]))
      break
    case 'snap':
      report(await invoke([{ name: 'take_snapshot', args: {} }]))
      break
    case 'eval': {
      if (!rest[0]) throw new Error('用法: eval \'<js>\'')
      const body = rest[0].trim()
      const fn = body.startsWith('(') || body.startsWith('function') || body.startsWith('async') ? body : `() => (${body})`
      report(await invoke([{ name: 'evaluate_script', args: { function: fn } }]))
      break
    }
    case 'call': {
      if (!rest[0]) throw new Error('用法: call <tool> \'<json>\'')
      report(await invoke([{ name: rest[0], args: rest[1] ? JSON.parse(rest[1]) : {} }]))
      break
    }
    case 'seq': {
      // 一次会话里顺序执行多个调用：seq '[{"name":"take_snapshot"},{"name":"click","args":{"uid":"1_5"}}]'
      if (!rest[0]) throw new Error('用法: seq \'<JSON 调用数组>\'')
      report(await invoke(JSON.parse(rest[0])))
      break
    }
    case 'search': {
      // 快照 -> 找输入框 uid -> 填词 -> 回车，全在同一次 MCP 会话内完成
      if (!rest[0]) throw new Error('用法: search <关键词>')
      const q = rest.join(' ')
      report(await invoke([
        { name: 'take_snapshot', args: {} },
        {
          name: 'fill',
          args: (rs) => {
            const snap = rs[0]?.text ?? ''
            const m = snap.match(/uid=(\S+)\s+(?:combobox|searchbox|textbox)/) || snap.match(/uid=(\S+)\s+\S*\s*"[^"]*(?:搜索|search)[^"]*"/i)
            if (!m) throw new Error('快照里没找到输入框；可先跑 snap 手工确认')
            return { uid: m[1], value: q }
          },
        },
        { name: 'press_key', args: { key: 'Enter' } },
        { name: 'list_pages', args: {} },
      ]))
      break
    }
    case 'type': {
      // 在当前已聚焦元素上打字（含中文走 insertText，避免输入法问题）
      if (!rest[0]) throw new Error('用法: type <文本>')
      report(await invoke([{ name: 'type_text', args: { text: rest.join(' ') } }]))
      break
    }
    case 'click': {
      if (!rest[0]) throw new Error('用法: click <uid>')
      report(await invoke([{ name: 'click', args: { uid: rest[0] } }]))
      break
    }
    case 'daemon': {
      const sub = rest[0] || 'status'
      if (sub === 'start') {
        if (existsSync(SOCK)) { console.log(`守护进程已在运行: ${SOCK}`); break }
        startDaemon()
        for (let i = 0; i < 24 && !existsSync(SOCK); i++) spawnSync('sleep', ['0.5'])
        console.log(existsSync(SOCK) ? `守护进程已启动: ${SOCK}（此后 CLI 调用不再新增 Chrome 连接）` : '启动失败')
      } else if (sub === 'stop') {
        if (!existsSync(SOCK)) { console.log('没有在运行的守护进程'); break }
        const r = await daemonCall([{ name: 'list_pages', args: {} }]) // 触发一次连接以便确认存活
        unlinkSync(SOCK)
        console.log('已移除 socket；守护进程会在下次空闲/退出时结束（或 kill 掉 winchromed.mjs 进程）')
        void r
      } else {
        console.log(`socket ${SOCK}: ${existsSync(SOCK) ? '存在（守护进程在跑）' : '不存在'}`)
        const r = await daemonCall([{ name: 'list_pages', args: {} }])
        console.log(r?.results ? '守护进程响应正常：\n' + (r.results[0].text || '') : '守护进程无响应')
      }
      break
    }
    default:
      console.log('用法: winchrome.mjs <start|status|tools|daemon|pages|goto|shot|snap|eval|type|click|search|seq|call> [args]')
  }
} catch (e) {
  console.error('错误:', e.message)
  process.exit(1)
}
