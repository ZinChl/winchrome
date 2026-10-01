#!/usr/bin/env node
/**
 * winchromed — 常驻 MCP 客户端守护进程（CLI 的加速层）。
 *
 * 存在理由：Chrome 144+ 的「实例级远程调试」授权**不做持久化**——每建立一条新的
 * CDP 连接就弹一次「要允许远程调试吗」（上游 issue #825 被 closed as not planned）。
 * 降低弹窗频率的唯一办法是减少连接数：本守护进程只向浏览器建一条连接，
 * winchrome.mjs 的所有命令都复用它，CLI 因此不再每次调用都新开一条连接。
 *
 * 通信：Unix socket（默认 /tmp/winchrome.sock），一行一个 JSON。
 *   请求  {"calls":[{"name":"navigate_page","args":{"url":"..."}}]}
 *   响应  {"results":[{"tool":"...","text":"...","image":"/path.png","isError":false}]}
 */
import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WIN_NODE, serverArgs, assertReady, log, winToWsl } from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = process.env.WINCHROME_OUT || resolve(HERE, 'out')
const SOCK = process.env.WINCHROME_SOCK || '/tmp/winchrome.sock'
const tag = 'winchromed'

assertReady(tag)

const child = spawn(WIN_NODE, serverArgs(tag), {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CI: '1' },
})

let buf = ''
let ready = false
let nextId = 1000
const pending = new Map()
const waiters = []

child.stderr.on('data', (d) => {
  const s = d.toString().trim()
  if (s && !/usage statistics|exposes content|debug, and modify|Avoid sharing|Performance tools|CrUX/.test(s)) log(tag)('server:', s.slice(0, 200))
})
child.on('exit', (code) => { log(tag)('server exited', code); cleanup(); process.exit(code ?? 0) })
child.on('error', (e) => { log(tag)('spawn error:', e.message); cleanup(); process.exit(1) })

child.stdout.on('data', (chunk) => {
  buf += chunk.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.id === 1) {
      ready = true
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
      for (const w of waiters.splice(0)) w()
      continue
    }
    const p = pending.get(msg.id)
    if (p) { pending.delete(msg.id); p(msg) }
  }
})

child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'winchromed', version: '1.0.0' } } }) + '\n')

const whenReady = () => (ready ? Promise.resolve() : new Promise((r) => waiters.push(r)))

function callOne(name, args = {}, out) {
  return new Promise((res, rej) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${name} 超时`)) }, 120000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      const parts = msg.result?.content ?? []
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      const image = parts.find((p) => p.type === 'image')
      let saved
      if (image?.data) {
        mkdirSync(OUT_DIR, { recursive: true })
        const ext = args?.format === 'jpeg' ? '.jpg' : args?.format === 'webp' ? '.webp' : '.png'
        saved = out ? resolve(out) : resolve(OUT_DIR, `shot-${Date.now()}${ext}`)
        writeFileSync(saved, Buffer.from(image.data, 'base64'))
      } else if (text) {
        // 大截图会被服务器落盘成 Windows 临时文件：从 /mnt/c 回拷
        const m = text.match(/Saved screenshot to (.+?\.(?:png|jpe?g|webp))\.?\s*$/im)
        if (m) {
          const linux = winToWsl(m[1].trim())
          try {
            mkdirSync(OUT_DIR, { recursive: true })
            saved = out ? resolve(out) : resolve(OUT_DIR, `shot-${Date.now()}${linux.slice(linux.lastIndexOf('.'))}`)
            copyFileSync(linux, saved)
          } catch (e) { log(tag)('截图回拷失败:', e.message) }
        }
      }
      res({ tool: name, text, image: saved, isError: msg.result?.isError ?? Boolean(msg.error), error: msg.error })
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n')
  })
}

const server = createServer((sock) => {
  let data = ''
  sock.on('data', async (c) => {
    data += c.toString()
    const nl = data.indexOf('\n')
    if (nl < 0) return
    const line = data.slice(0, nl); data = data.slice(nl + 1)
    try {
      const req = JSON.parse(line)
      await whenReady()
      const results = []
      for (const call of req.calls ?? []) results.push(await callOne(call.name, call.args ?? {}, call.out))
      sock.write(JSON.stringify({ results }) + '\n')
    } catch (e) {
      sock.write(JSON.stringify({ error: e.message }) + '\n')
    }
    sock.end()
  })
  sock.on('error', () => {})
})

function cleanup() {
  try { server.close() } catch {}
  try { if (existsSync(SOCK)) unlinkSync(SOCK) } catch {}
}

if (existsSync(SOCK)) {
  // socket 文件存在不等于守护进程活着（可能上次异常退出留下陈旧文件）：
  // 真正连一下再决定，连不上就删掉陈旧 socket 继续启动。
  const alive = await new Promise((res) => {
    const s = connect(SOCK)
    s.setTimeout(1500, () => { s.destroy(); res(false) })
    s.on('connect', () => { s.destroy(); res(true) })
    s.on('error', () => res(false))
  })
  if (alive) {
    log(tag)('已有守护进程在跑，退出')
    process.exit(0)
  }
  log(tag)('发现陈旧 socket（无进程监听），清理后继续启动')
  try { unlinkSync(SOCK) } catch {}
}

server.listen(SOCK, () => log(tag)(`守护进程就绪: ${SOCK}（对浏览器的连接数：1）`))
process.on('SIGTERM', () => { cleanup(); child.kill('SIGTERM'); process.exit(0) })
process.on('SIGINT', () => { cleanup(); child.kill('SIGTERM'); process.exit(0) })
