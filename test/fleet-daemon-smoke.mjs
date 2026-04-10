#!/usr/bin/env node
/**
 * Smoke test: spawn the fleet-daemon against a mock server, verify the
 * handshake + a source-change roundtrip.
 *
 * Not part of any CI suite; run manually with `node test/fleet-daemon-smoke.mjs`.
 */

import { WebSocketServer } from 'ws'
import { spawn } from 'child_process'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const TMP_DIR = path.join(tmpdir(), 'fleet-daemon-smoke-' + Date.now())
const SRC_DIR = path.join(TMP_DIR, 'project-source')
mkdirSync(SRC_DIR, { recursive: true })
writeFileSync(path.join(SRC_DIR, 'main.tex'), '\\documentclass{article}\\begin{document}hi\\end{document}')

const PORT = 5189 + Math.floor(Math.random() * 100)

const wss = new WebSocketServer({ port: PORT, path: '/ws/fleet-daemon' })
const received = []
let helloOk = false
let sourceChangeOk = false

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    received.push(msg)
    console.log(`[mock-server] received ${msg.type}`)
    if (msg.type === 'daemon-hello') {
      helloOk = true
      ws.send(JSON.stringify({
        type: 'daemon-welcome',
        agents: [],
        projects: [{ name: 'smoketest', sourceDir: SRC_DIR, format: 'svg' }],
      }))
    }
    if (msg.type === 'source-change') {
      sourceChangeOk = true
      const hasMain = (msg.files || []).some(f => f.path.endsWith('.tex'))
      if (!hasMain) console.error('[smoke] source-change missing tex file:', msg)
    }
  })
})

console.log(`[smoke] mock server listening on ws://localhost:${PORT}/ws/fleet-daemon`)
console.log(`[smoke] tmp source dir: ${SRC_DIR}`)

const daemonScript = path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'fleet-daemon.mjs')
const child = spawn(process.execPath, [daemonScript], {
  env: {
    ...process.env,
    TLDA_SERVER: `http://localhost:${PORT}`,
    TLDA_TOKEN: '',
    HOME: TMP_DIR, // sandbox the daemon's config dir + cursors + pidfile
  },
  stdio: ['ignore', 'inherit', 'inherit'],
})

// Touch a source file after the daemon should have set up its watcher.
setTimeout(() => {
  console.log('[smoke] touching main.tex to trigger source-change')
  writeFileSync(path.join(SRC_DIR, 'main.tex'), '\\documentclass{article}\\begin{document}hello world\\end{document}')
}, 1500)

setTimeout(() => {
  console.log(`\n[smoke] === results ===`)
  console.log(`  daemon-hello received: ${helloOk}`)
  console.log(`  source-change received: ${sourceChangeOk}`)
  console.log(`  total messages: ${received.length}`)
  child.kill('SIGTERM')
  wss.close()
  rmSync(TMP_DIR, { recursive: true, force: true })
  if (helloOk && sourceChangeOk) {
    console.log('PASS')
    process.exit(0)
  } else {
    console.error('FAIL')
    process.exit(1)
  }
}, 4000)
