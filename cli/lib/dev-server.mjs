/**
 * tlda-dev sandbox — an isolated, daemonized unified-server for testing.
 *
 * Why this exists: testing a new custom shape (or any server change) needs the
 * schema loaded by a *running* server. You must NOT do that on a live room and a
 * raw `node server` gets reaped. This starts a fully isolated instance — separate
 * port, its own fleet DB and projects dir, and `TLDA_DEV_SERVER=1` so it never
 * runs the fleet supervisors / hibernate loop. Point a worktree vite at it with
 * `VITE_SERVER_PORT=<port>` and you have a safe end-to-end test loop.
 *
 *   tlda-dev sandbox [start]   start the isolated server (idempotent)
 *   tlda-dev sandbox stop      stop it
 *   tlda-dev sandbox status    is it up? + the URL / vite hint
 */

import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { hasTls } from '../../shared/config.mjs'

const DEV_PORT = 5280
const DATA_DIR = join(homedir(), '.config', 'tlda', 'dev-server')
const PID_FILE = join(DATA_DIR, 'server.pid')
const LOG_FILE = join(DATA_DIR, 'server.log')
const PROJECTS_DIR = join(DATA_DIR, 'projects')
const FLEET_DB = join(DATA_DIR, 'fleet.db')

function alive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

function readPid() {
  if (!existsSync(PID_FILE)) return null
  const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10)
  return Number.isInteger(pid) && alive(pid) ? pid : null
}

async function health(port) {
  for (const scheme of ['https', 'http']) {
    try {
      const res = await fetch(`${scheme}://localhost:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      })
      if (res.ok) return scheme
    } catch { /* not up yet / wrong scheme — try the other, or caller retries */ }
  }
  return null
}

export async function cmdDevServer(args, repoRoot) {
  const sub = args[0] || 'start'
  const portArg = args.find((a, i) => args[i - 1] === '--port')
  const port = portArg ? parseInt(portArg, 10) : DEV_PORT

  if (sub === 'status') {
    const pid = readPid()
    const scheme = pid ? await health(port) : null
    if (pid && scheme) {
      console.log(`sandbox: up (pid ${pid}) — ${scheme}://localhost:${port}`)
      console.log(`point a worktree vite at it:  VITE_SERVER_PORT=${port} <vite>`)
      console.log(`isolated DB:       ${FLEET_DB}`)
      console.log(`isolated projects: ${PROJECTS_DIR}`)
    } else if (pid) {
      console.log(`sandbox: pid ${pid} alive but not answering on :${port} (starting or wedged)`)
    } else {
      console.log('sandbox: down')
    }
    return
  }

  if (sub === 'stop') {
    const pid = readPid()
    if (!pid) { console.log('sandbox: not running'); if (existsSync(PID_FILE)) unlinkSync(PID_FILE); return }
    try { process.kill(pid) } catch { /* already gone — fine */ }
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE)
    console.log(`sandbox: stopped (pid ${pid})`)
    return
  }

  if (sub !== 'start') {
    console.error('Usage: tlda-dev sandbox [start|stop|status] [--port N]')
    process.exit(1)
  }

  // start (idempotent)
  const existing = readPid()
  if (existing) {
    console.log(`sandbox already running (pid ${existing}) on :${port}`)
    return
  }

  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(PROJECTS_DIR, { recursive: true })
  const logFd = openSync(LOG_FILE, 'a')
  const serverScript = join(repoRoot, 'server', 'unified-server.mjs')

  const child = spawn(process.execPath, [serverScript, '--i-am-tlda-cli'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PORT: String(port),
      PROJECTS_DIR,
      TLDA_FLEET_DB: FLEET_DB,
      TLDA_DEV_SERVER: '1',     // disables fleet supervisors + hibernate loop
      TLDA_NO_AUTH: '1',        // dev convenience — no token needed
      // Self-report as the fleet store so /api/fleet-config returns THIS server,
      // not the global one (Fly). Without this the sandbox isolates shapes + DB
      // but chat/fleet still resolves to the shared store — not "fully isolated".
      // A SPA pointed here then has its own chat too. (Override by passing one.)
      TLDA_FLEET_SERVER: process.env.TLDA_FLEET_SERVER || `${hasTls ? 'https' : 'http'}://localhost:${port}`,
    },
  })
  child.unref()
  writeFileSync(PID_FILE, String(child.pid))
  console.log(`sandbox starting (pid ${child.pid}) on :${port} …`)

  // Wait for health (up to ~30s)
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500))
    const scheme = await health(port)
    if (scheme) {
      console.log(`sandbox up — ${scheme}://localhost:${port}`)
      console.log(`isolated (own DB + projects, no supervisors). Point vite at it:`)
      console.log(`  VITE_SERVER_PORT=${port} <your worktree vite>`)
      console.log(`stop with: tlda-dev sandbox stop`)
      return
    }
    if (!alive(child.pid)) {
      console.error(`sandbox exited during startup — see ${LOG_FILE}`)
      process.exit(1)
    }
  }
  console.error(`sandbox didn't answer on :${port} within 30s — see ${LOG_FILE}`)
  process.exit(1)
}
