#!/usr/bin/env node
/**
 * mcp-entry — 供 MCP 客户端（DSH 的 mcp-client、Claude Desktop 等）直接调用的入口。
 *
 * 它做两件事：
 *   1) 按 lib.mjs 的规则决定连哪里（默认：调试 profile 的端口模式；可选：日常 Chrome）。
 *   2) 用 Windows 侧自带的 node.exe 启动 chrome-devtools-mcp，把 stdio 原样接通。
 *
 * 为什么 MCP 服务器必须跑在 Windows 侧：Chrome 只监听 127.0.0.1，而 WSL2(NAT)
 * 到不了 Windows 的 loopback；让服务器跑在 Windows 上，它就是本机连接。
 *
 * 注意：本进程的 stdout 是 JSON-RPC 通道，任何日志只能写 stderr。
 */
import { spawn } from 'node:child_process'
import { WIN_NODE, serverArgs, assertReady, log } from './lib.mjs'

const tag = 'mcp-entry'
assertReady(tag)

const child = spawn(WIN_NODE, serverArgs(tag), {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CI: '1' }, // CI=1：关掉 chrome-devtools-mcp 的使用统计上报
})

process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.on('data', (d) => process.stderr.write(d))
child.on('exit', (code) => { log(tag)('server exited', code); process.exit(code ?? 0) })
child.on('error', (e) => { log(tag)('spawn error:', e.message); process.exit(1) })
process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0) })
