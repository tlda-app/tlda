#!/usr/bin/env node

// Does an edit on the mini reach the browser? Asked continuously, on the real
// path, so an operator is not the one who finds out that it stopped.
//
// Unit suites exercise functions. This watcher instead exercises the complete
// edit-to-browser loop:
//
//   write a file on the mini  ->  daemon settles and pushes  ->  server accepts
//   the revision and renders  ->  the text is in what the browser fetches
//
// It is deliberately NOT a test of any component. Every step here is one his
// editing does, in the order his editing does it, and the only thing asserted is
// the user-visible result: the edited words are in what the app serves.
//
// **The marker is unique per cycle and is checked absent before it is written.**
// Without that, a watcher that fetched a cached or stale render would report
// success forever -- which is the exact failure mode it exists to catch, so it
// has to be unable to pass by accident.
//
// Usage:
//   node bin/live-watcher.mjs --setup     create and link the probe project once
//   node bin/live-watcher.mjs             one cycle, exit 0 if the loop closed
//   node bin/live-watcher.mjs --watch     forever, prints only failures and recoveries

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

const PROJECT = process.env.TLDA_WATCH_PROJECT || 'live-watcher-probe'
const CHECKOUT = process.env.TLDA_WATCH_DIR || join(homedir(), 'worktrees', 'live-watcher-probe')
const DOC = 'watch.md'
// A settle is debounced and a build follows it. Two minutes is generous for a
// one-file markdown project; if it is not there by then something is wrong, and
// saying so late is worse than saying so wrong.
const DEADLINE_MS = Number(process.env.TLDA_WATCH_DEADLINE_MS || 120_000)
const PERIOD_MS = Number(process.env.TLDA_WATCH_PERIOD_MS || 300_000)

const args = process.argv.slice(2)
const watch = args.includes('--watch')
const setup = args.includes('--setup')

const sh = (cmd, cmdArgs, cwd) =>
  execFileSync(cmd, cmdArgs, { cwd, encoding: 'utf8', timeout: 120_000 }).trim()

function server() {
  // The same resolution the CLI uses, so the watcher cannot be watching a
  // different server from the configured environment.
  return sh('node', ['-e', "import('./shared/config.mjs').then(m=>process.stdout.write(m.getServerUrl()))"], ROOT)
}

async function fetchDoc(base) {
  const url = `${base}/docs/${encodeURIComponent(PROJECT)}/${DOC.replace(/\.md$/, '.html')}`
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) return { error: `HTTP ${res.status}` }
  return { text: await res.text() }
}

function doSetup(base) {
  mkdirSync(CHECKOUT, { recursive: true })
  if (!existsSync(join(CHECKOUT, '.git'))) {
    sh('git', ['init', '-b', 'main'], CHECKOUT)
    sh('git', ['config', 'user.name', 'live-watcher'], CHECKOUT)
    sh('git', ['config', 'user.email', 'live-watcher@fleet.local'], CHECKOUT)
  }
  writeFileSync(join(CHECKOUT, DOC), '# live watcher\n\nThis file exists to be edited every few minutes.\n')
  sh('git', ['add', DOC], CHECKOUT)
  try {
    sh('git', ['commit', '-m', 'live watcher probe document'], CHECKOUT)
  } catch (e) {
    // Setup is idempotent on purpose: re-run against an existing checkout, git
    // finds the document already committed and exits non-zero with nothing to
  // do. Anything else is a real failure and must bubble.
    if (!/nothing to commit|no changes added/i.test(String(e.stdout || e.message))) throw e
  }
  sh('tlda', ['project', 'link', PROJECT, DOC], CHECKOUT)
  console.log(`linked ${PROJECT} from ${CHECKOUT}`)
}

async function cycle(base) {
  const marker = `WATCH-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  // Absent first. A watcher that cannot fail cannot report.
  const before = await fetchDoc(base)
  if (before.error) return { ok: false, stage: 'fetch', detail: before.error }
  if (before.text.includes(marker)) return { ok: false, stage: 'control', detail: 'marker already present' }

  const file = join(CHECKOUT, DOC)
  writeFileSync(file, readFileSync(file, 'utf8').replace(/\nWATCH-[^\n]*\n?$/, '') + `\n${marker}\n`)
  // Tracked, because the closure is computed over the settled tree and an
  // untracked file is not in it. Staging is what an editor does; the watcher
  // does the same thing.
  sh('git', ['add', DOC], CHECKOUT)
  sh('git', ['commit', '-m', `watch ${marker}`], CHECKOUT)

  const started = Date.now()
  for (;;) {
    if (Date.now() - started > DEADLINE_MS) {
      return { ok: false, stage: 'arrive', detail: `not served after ${Math.round(DEADLINE_MS / 1000)}s`, ms: Date.now() - started }
    }
    await new Promise(r => setTimeout(r, 3000))
    const now = await fetchDoc(base)
    if (now.error) continue
    if (now.text.includes(marker)) return { ok: true, ms: Date.now() - started }
  }
}

const base = server()
if (setup) { doSetup(base); process.exit(0) }
if (!existsSync(join(CHECKOUT, DOC))) {
  console.error(`no probe checkout at ${CHECKOUT} — run with --setup first`)
  process.exit(2)
}

if (!watch) {
  const r = await cycle(base)
  console.log(r.ok ? `ok  edit reached the browser in ${(r.ms / 1000).toFixed(1)}s` : `FAIL  ${r.stage}: ${r.detail}`)
  process.exit(r.ok ? 0 : 1)
}

// Only failures and recoveries are printed. A watcher that prints every success
// is one nobody reads, and then it catches nothing.
let broken = false
for (;;) {
  let r
  try { r = await cycle(base) } catch (e) { r = { ok: false, stage: 'watcher', detail: e.message } }
  const stamp = new Date().toLocaleTimeString()
  if (!r.ok && !broken) { broken = true; console.log(`${stamp}  BROKEN  ${r.stage}: ${r.detail}`) }
  else if (!r.ok) { console.log(`${stamp}  still broken  ${r.stage}: ${r.detail}`) }
  else if (broken) { broken = false; console.log(`${stamp}  RECOVERED  edit reached the browser in ${(r.ms / 1000).toFixed(1)}s`) }
  await new Promise(res => setTimeout(res, PERIOD_MS))
}
