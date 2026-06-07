/**
 * tlda pw — one shared playwright-cli browser any agent can drive.
 *
 * The problem this solves: agents each ran their own `playwright-cli open`/`close`
 * per task, so the backing browser kept dying between commands ("keeps closing and
 * opening"). The fix is a single canonical session that nobody opens or closes by
 * hand — it pops up lazily on first use, persists across separate calls (riding
 * playwright-cli's own session daemon), and only dies when reaped.
 *
 * Usage:
 *   tlda pw <verb> [args...]   forward a playwright-cli verb to the shared session
 *   tlda pw acquire            take the lock + open the shared browser (lazy)
 *   tlda pw release            give up the lock (browser stays up for the next agent)
 *   tlda pw status             show lock holder + session state + current URL
 *   tlda pw reap               close the shared browser (the reaper)
 *
 * Any non-admin verb (goto, click, screenshot, snapshot, eval, …) is forwarded to
 * `playwright-cli -s=<SESSION>`. The verbs that cause churn — open, close,
 * close-all, kill-all, delete-data — are NOT forwarded; lifecycle is acquire/reap.
 *
 * Identity for the lock comes from TLDA_PW_AS → AGENT_WIN → FLEET_ID → $USER@local.
 */

import { spawnSync } from 'child_process'
import { join } from 'path'

const SESSION = 'shared'

// Verbs the wrapper owns — agents must not drive browser lifecycle directly.
const BLOCKED_VERBS = new Set(['open', 'close', 'close-all', 'kill-all', 'delete-data'])

function who() {
  return (
    process.env.TLDA_PW_AS ||
    process.env.AGENT_WIN ||
    process.env.FLEET_ID ||
    `${process.env.USER || 'unknown'}@local`
  )
}

function lockScript(repoRoot) {
  return join(repoRoot, 'bin', 'pw-lock.sh')
}

// Returns { holder, ageSecs } or null if unlocked.
function lockStatus(repoRoot) {
  const r = spawnSync('bash', [lockScript(repoRoot), 'status'], { encoding: 'utf8' })
  const out = (r.stdout || '').trim()
  if (!out || out === 'unlocked') return null
  const m = out.match(/^(.*) \(acquired (\d+)s ago\)$/)
  if (!m) return { holder: out, ageSecs: null }
  return { holder: m[1], ageSecs: parseInt(m[2], 10) }
}

function lockAcquire(repoRoot, me) {
  const r = spawnSync('bash', [lockScript(repoRoot), 'acquire', me], { encoding: 'utf8' })
  return { ok: r.status === 0, msg: ((r.stdout || '') + (r.stderr || '')).trim() }
}

function lockRelease(repoRoot, me) {
  const r = spawnSync('bash', [lockScript(repoRoot), 'release', me], { encoding: 'utf8' })
  return { ok: r.status === 0, msg: ((r.stdout || '') + (r.stderr || '')).trim() }
}

// Is the shared session currently open? Parses `playwright-cli list`.
function sessionOpen() {
  const r = spawnSync('playwright-cli', ['list'], { encoding: 'utf8' })
  const out = r.stdout || ''
  // Block headings look like:  - shared:\n    - status: open
  const re = new RegExp(`- ${SESSION}:\\s*\\n\\s*- status: (\\w+)`, 'm')
  const m = out.match(re)
  return m ? m[1] === 'open' : false
}

// Open the shared browser if it isn't already up (lazy pop-up).
function ensureOpen() {
  if (sessionOpen()) return { opened: false }
  const r = spawnSync(
    'playwright-cli',
    [`-s=${SESSION}`, 'open', '--headed', '--persistent'],
    { encoding: 'utf8', stdio: 'inherit' }
  )
  if (r.status !== 0) throw new Error('failed to open shared browser')
  return { opened: true }
}

function forward(verb, rest) {
  const r = spawnSync('playwright-cli', [`-s=${SESSION}`, verb, ...rest], { stdio: 'inherit' })
  return r.status ?? 0
}

export async function cmdPw(args, repoRoot) {
  const verb = args[0]
  const rest = args.slice(1)
  const me = who()

  if (!verb || verb === 'help' || verb === '--help') {
    console.log(
      [
        'tlda pw — one shared playwright browser any agent can drive',
        '',
        '  tlda pw acquire           take the lock + open the shared browser',
        '  tlda pw release           give up the lock (browser stays up)',
        '  tlda pw status            lock holder + session state + URL',
        '  tlda pw reap              close the shared browser',
        '  tlda pw <verb> [args]     forward a playwright-cli verb (goto, click,',
        '                            screenshot, snapshot, eval, press, …)',
        '',
        `  identity for the lock: ${me}`,
        '  (override with TLDA_PW_AS)',
      ].join('\n')
    )
    return
  }

  if (verb === 'status') {
    const lk = lockStatus(repoRoot)
    const open = sessionOpen()
    console.log(`lock:    ${lk ? `${lk.holder} (${lk.ageSecs}s ago)` : 'unlocked'}`)
    console.log(`browser: ${open ? 'up' : 'down'} (session "${SESSION}")`)
    if (open) {
      const r = spawnSync('playwright-cli', [`-s=${SESSION}`, 'eval', '() => location.href'], {
        encoding: 'utf8',
      })
      const m = (r.stdout || '').match(/"([^"]*)"/)
      if (m) console.log(`url:     ${m[1]}`)
    }
    return
  }

  if (verb === 'acquire') {
    const res = lockAcquire(repoRoot, me)
    console.log(res.msg)
    if (!res.ok) process.exit(1)
    const { opened } = ensureOpen()
    console.log(opened ? 'browser opened' : 'browser already up')
    return
  }

  if (verb === 'release') {
    const res = lockRelease(repoRoot, me)
    console.log(res.msg)
    if (!res.ok) process.exit(1)
    return
  }

  if (verb === 'reap') {
    if (!sessionOpen()) {
      console.log('browser already down')
    } else {
      spawnSync('playwright-cli', [`-s=${SESSION}`, 'close'], { stdio: 'inherit' })
      console.log('browser reaped')
    }
    // Reaping frees the lock too, regardless of holder.
    spawnSync('bash', [lockScript(repoRoot), 'steal', `reaper:${me}`], { encoding: 'utf8' })
    spawnSync('bash', [lockScript(repoRoot), 'release', `reaper:${me}`], { encoding: 'utf8' })
    return
  }

  if (BLOCKED_VERBS.has(verb)) {
    console.error(
      `"${verb}" is not an agent verb — the shared browser's lifecycle is managed.\n` +
        `  • to start it:  tlda pw acquire\n` +
        `  • to stop it:   tlda pw reap`
    )
    process.exit(2)
  }

  // Forwarded verb: acquire-or-refresh the lock on EVERY verb. pw-lock.sh
  // acquire() takes a free lock, re-stamps it if it's already mine (so active
  // use keeps it fresh against the short idle-expiry), and fails if another
  // agent holds it. So one call does acquire + heartbeat + collision-check.
  const before = lockStatus(repoRoot)
  const res = lockAcquire(repoRoot, me)
  if (!res.ok) {
    const lk = lockStatus(repoRoot)
    console.error(
      `pw-lock held by ${lk ? `${lk.holder} (${lk.ageSecs}s ago)` : 'another agent'}. ` +
        `Wait, or: tlda-dev pw status / bin/pw-lock.sh steal ${me}`
    )
    process.exit(1)
  }
  if (!before) console.error(`(auto-acquired pw-lock as ${me})`)

  ensureOpen()
  process.exit(forward(verb, rest))
}
