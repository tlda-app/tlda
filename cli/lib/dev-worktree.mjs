/**
 * Worktree-relative `tlda-dev` mirrors.
 *
 * Skip's rule: `tlda-dev <cmd>` is the worktree-relative mirror of `tlda <cmd>`.
 * Where `tlda project share` shares the *live* :5176 server (token, real rooms),
 * `tlda-dev serve` / `tlda-dev share` stand up and share THIS worktree's branch,
 * reachable from Skip's other devices, with the SPA's injected config pointed at
 * the reachable host — and NO token.
 *
 * How the three recurring traps are closed:
 *
 *  1. "blank page / no document" (localhost trap): the server re-injects the
 *     active config's database/store into the SPA at serve time. If that config
 *     says `localhost`, a remote browser talks to ITS OWN machine. We write a
 *     throwaway config whose database+store point at the *reachable* host:port,
 *     so the remote SPA connects back here. Single port, same origin, no CORS.
 *
 *  2. tokens: a preview is tokenless because the isolated `server.yaml` written
 *     here does not set `tokenGating`, and gating is off unless a config turns it
 *     on. (It used to be because a non-standard port disabled auth; that escape
 *     hatch was deliberately removed — see the header of `server/lib/auth.mjs` —
 *     so the port has nothing to do with it now.) `--gated` opts one preview into
 *     real token gating, for the student-facing paths that cannot be reached
 *     without it; every preview without the flag behaves exactly as before.
 *
 *  3. cert warnings: the mkcert dev cert already carries SANs for this machine's
 *     Tailscale MagicDNS name and 100.x IP, so `https://<magicdns>:<port>` serves
 *     a VALID cert on every tailnet device. We only ever print a host that is in
 *     the cert's SANs.
 *
 * Isolation: the preview gets its own projects dir + fleet DB (room snapshots live
 * under PROJECTS_DIR, so sharing the live one would corrupt real rooms). `--project`
 * copies one project in so Skip can open a real document; otherwise it's the UI
 * shell. Nothing touches the live :5176 server or its rooms.
 */

import { spawn, spawnSync, execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, cpSync, rmSync, readdirSync, statSync } from 'fs'
import { basename, join } from 'path'
import { homedir } from 'os'
import { X509Certificate, createHash, randomBytes } from 'crypto'
import { hasTls, resolveConfig, loadServerConfig, CONFIG_DIR } from '../../shared/config.mjs'
import { daemonLifecycleSocketPath } from '../../shared/daemon-socket-path.mjs'
import { resolveRepoRoot, findFreePort } from './dev-vite.mjs'
import { spawnDetachedServer } from './server-start.mjs'
import { findTailscaleIPv4 } from './share-url.mjs'
import { acquireLease, releaseLease, listLeases } from './resource-leases.mjs'

const BASE_DIR = join(homedir(), '.config', 'tlda', 'dev-worktree')
const TLS_CERT = join(CONFIG_DIR, 'localhost+2.pem')
const PREVIEW_PORT_MIN = 5190
const PREVIEW_PORT_MAX = 5299

const SERVE_HELP = `tlda-dev serve — run THIS worktree as an isolated preview

Usage:
  tlda-dev serve [start] [--sandbox] [--real-fleet] [--gated] [--project NAME] [--port N] [--no-build]
  tlda-dev serve stop [--json]
  tlda-dev serve status [--all] [--json]
  tlda-dev serve url [--project NAME]
  tlda-dev serve reap-orphans [--json]

Notes:
  tlda-dev serve is worktree-relative. It serves the branch checked out in the
  current working tree; it does not accept a positional branch name.
`

// ---- worktree identity (everything is relative to cwd, not a positional) ----

function git(argsArr) {
  try {
    return execFileSync('git', argsArr, { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

export function worktreeRoot() {
  return git(['rev-parse', '--show-toplevel']) || process.cwd()
}

// A detached worktree has no branch name to key on: `--abbrev-ref HEAD` answers
// the literal string "HEAD", identically in every detached worktree on the box,
// so all of them shared one state dir and `serve status` answered about whichever
// one wrote last. The worktree root path is the key instead — unique per worktree
// and, unlike the commit sha, unchanged when HEAD moves, so a running preview's
// state does not become unreachable the moment you check out something else.
export function worktreeBranch() {
  const named = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (named && named !== 'HEAD') return named
  const root = worktreeRoot()
  const digest = createHash('sha1').update(root).digest('hex').slice(0, 8)
  return `detached-${sanitize(basename(root)).slice(0, 16)}-${digest}`
}

// The MAIN checkout (parent of the shared .git dir), regardless of which worktree
// we're in — that's where the real projects live, so it's the seed source.
export function mainRepoRoot() {
  const common = git(['rev-parse', '--git-common-dir'])
  if (common) {
    const abs = common.startsWith('/') ? common : join(process.cwd(), common)
    return abs.replace(/\/\.git\/?$/, '')
  }
  return resolveRepoRoot()
}

function sanitize(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '-')
}

// ---- per-branch state on disk ----

function stateDir(branch) { return join(BASE_DIR, sanitize(branch)) }
function pidFile(branch) { return join(stateDir(branch), 'server.pid') }
function logFile(branch) { return join(stateDir(branch), 'server.log') }
function daemonPidFile(branch) { return join(stateDir(branch), 'daemon.pid') }
function daemonLogFile(branch) { return join(stateDir(branch), 'daemon.log') }
// Own config dir for the sandbox daemon → its OWN machine_id + pidfile, so it
// coexists with the real machine daemon instead of tripping its singleton. (It
// can't evict the real daemon: eviction is server-side and this one only ever
// connects to the sandbox server.)
function daemonConfigDir(branch) { return join(stateDir(branch), 'daemon-cfg') }
function manifestFile(branch) { return join(stateDir(branch), 'manifest.json') }
function previewLeaseId(branch) { return `preview-server:${sanitize(branch)}` }
function projectsDir(branch) { return join(stateDir(branch), 'projects') }
function fleetDb(branch) { return join(stateDir(branch), 'fleet.db') }
function configName(branch) { return `dev-preview/${sanitize(branch)}` }

function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }

function readPid(branch) {
  const f = pidFile(branch)
  if (!existsSync(f)) return null
  const pid = parseInt(readFileSync(f, 'utf8').trim(), 10)
  return Number.isInteger(pid) && alive(pid) ? pid : null
}

function readManifest(branch) {
  const f = manifestFile(branch)
  if (!existsSync(f)) return null
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null }
}

function readRawPidFile(branch) {
  const f = pidFile(branch)
  if (!existsSync(f)) return null
  const pid = parseInt(readFileSync(f, 'utf8').trim(), 10)
  return Number.isInteger(pid) ? pid : null
}

function listPreviewStates() {
  if (!existsSync(BASE_DIR)) return []
  const dirs = readdirSync(BASE_DIR, { withFileTypes: true }).filter(d => d.isDirectory())
  return dirs.map(d => {
    const branch = d.name
    const m = readManifest(branch)
    const rawPid = readRawPidFile(branch)
    const pid = rawPid && alive(rawPid) ? rawPid : null
    return {
      key: branch,
      branch: m?.branch || branch,
      worktreeDir: m?.worktreeDir || null,
      base: m?.base || null,
      project: m?.project || null,
      port: m?.port || null,
      pid,
      rawPid,
      manifest: !!m,
      log: logFile(branch),
    }
  })
}

function parseListenPort(name) {
  const m = String(name || '').match(/:(\d+)(?:\s|\b).*LISTEN/)
  if (!m) return null
  const port = Number(m[1])
  return Number.isInteger(port) ? port : null
}

function previewListeners() {
  const out = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout || ''
  const listeners = []
  const lines = out.split('\n').slice(1)
  for (const line of lines) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 9) continue
    const pid = Number(parts[1])
    const port = parseListenPort(parts.slice(8).join(' '))
    if (!Number.isInteger(pid) || !port) continue
    if (port < PREVIEW_PORT_MIN || port > PREVIEW_PORT_MAX) continue
    listeners.push({ command: parts[0], pid, port, name: parts.slice(8).join(' ') })
  }
  return listeners
}

function orphanPreviewListeners(states = listPreviewStates()) {
  const knownPorts = new Set(states.filter(s => s.pid && s.port).map(s => Number(s.port)))
  const knownPids = new Set(states.filter(s => s.pid).map(s => Number(s.pid)))
  return previewListeners().filter(l => !knownPorts.has(l.port) && !knownPids.has(l.pid))
}

function printOrphanHint(orphans) {
  if (!orphans.length) return
  console.error(`possible orphan preview listener(s) on tlda-dev preview ports ${PREVIEW_PORT_MIN}-${PREVIEW_PORT_MAX}:`)
  for (const o of orphans) console.error(`  pid ${o.pid} ${o.command} listening on :${o.port}`)
  console.error('  inspect all previews with: tlda-dev serve status --all')
  console.error('  reap unmatched preview-port listeners with: tlda-dev serve reap-orphans')
}

// ---- reachable-host resolution (only ever a cert-valid host) ----

function certSans() {
  try {
    const cert = new X509Certificate(readFileSync(TLS_CERT))
    const dns = new Set(), ips = new Set()
    for (const tok of (cert.subjectAltName || '').split(',').map(s => s.trim())) {
      if (tok.startsWith('DNS:')) dns.add(tok.slice(4))
      else if (tok.startsWith('IP Address:')) ips.add(tok.slice(11))
    }
    return { dns, ips }
  } catch {
    return { dns: new Set(), ips: new Set() }
  }
}

function magicDnsName() {
  try {
    const json = execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
    const name = JSON.parse(json)?.Self?.DNSName
    return name ? name.replace(/\.$/, '') : null
  } catch {
    return null
  }
}

/**
 * Best reachable host that the dev cert actually covers. MagicDNS name first
 * (resolves on every tailnet device, nicest URL), then the 100.x IP, both gated
 * on being present in the cert SANs so we never print a cert-mismatch URL.
 */
export function resolveReachableHost() {
  const scheme = hasTls ? 'https' : 'http'
  const sans = certSans()
  const magic = magicDnsName()
  const ip = findTailscaleIPv4()

  if (magic && (!hasTls || sans.dns.has(magic))) {
    return { scheme, host: magic, shareable: true, kind: 'magicdns' }
  }
  if (ip && (!hasTls || sans.ips.has(ip))) {
    return { scheme, host: ip, shareable: true, kind: 'tailscale-ip' }
  }
  if (ip) {
    return { scheme, host: ip, shareable: true, kind: 'tailscale-ip-uncerted',
      warn: `cert has no SAN for ${ip} — the browser will warn` }
  }
  return { scheme, host: 'localhost', shareable: false, kind: 'localhost',
    reason: 'no Tailscale MagicDNS name or 100.x IP on this machine' }
}

// ---- throwaway config pointing the SPA back at the reachable host ----

function previewConfigDir(branch) { return join(stateDir(branch), 'config') }

/**
 * A read/RW token pair for a gated preview.
 *
 * Generated per preview rather than borrowed from this machine's `tokens.json`:
 * a preview is reachable on the tailnet and its tokens get printed and pasted
 * around, so it must never be handing out the real ones.
 */
function previewTokens() {
  return { read: randomBytes(24).toString('base64url'), rw: randomBytes(24).toString('base64url') }
}

function writePreviewConfig(branch, base, { realFleet = false, tokens = null } = {}) {
  const source = resolveConfig()
  const database = realFleet ? source.database.http : base
  // Preview servers get an isolated copy. Writing the shared config would both
  // corrupt the real daemon's authority surface and violate the app-dev fence.
  const dir = previewConfigDir(branch)
  mkdirSync(dir, { recursive: true })
  // A preview server runs the same backend-list path as a real one. Copy the
  // configured Deepgram bridge when this machine has one, and leave it absent
  // otherwise so the preview picker follows configuration the same way.
  const { deepgramBridgeUrl } = loadServerConfig()
  const serverYaml = []
  if (deepgramBridgeUrl) serverYaml.push(`deepgramBridgeUrl: ${JSON.stringify(deepgramBridgeUrl)}`)
  if (tokens) {
    // Gating is a config decision, not an env one: setting TLDA_TOKEN_READ alone
    // leaves `validateToken` returning 'rw' for every caller, which
    // `classroomPrincipal` maps to instructor. So anything student-facing is
    // unreachable on a preview until this line exists — and a test against an
    // ungated server passes every check while proving the opposite.
    serverYaml.push('tokenGating: true')
    // Take the tokens from the environment only, never this machine's
    // tokens.json, so a preview cannot fall back to the real ones.
    serverYaml.push('tokensFromEnvironmentOnly: true')
  }
  writeFileSync(join(dir, 'server.yaml'), serverYaml.length ? `${serverYaml.join('\n')}\n` : '')
  writeFileSync(join(dir, 'daemon.yaml'), [
    'environments:',
    `  default: ${JSON.stringify(configName(branch))}`,
    '  values:',
    `    ${JSON.stringify(configName(branch))}:`,
    `      database: ${JSON.stringify(database)}`,
    `      store: ${JSON.stringify(base)}`,
    `      licenseKey: ${JSON.stringify(source.licenseKey ?? '')}`,
    '',
  ].join('\n'))
}

function removePreviewConfig(branch) {
  rmSync(previewConfigDir(branch), { recursive: true, force: true })
}

// ---- QR ----

async function printQr(url) {
  try {
    const qr = await import('qrcode-terminal')
    qr.default.generate(url, { small: true })
  } catch { /* qrcode-terminal missing — URL alone is enough */ }
}

function viewerUrl(base, project) {
  return project ? `${base}/?project=${encodeURIComponent(project)}` : `${base}/`
}

const HEALTH_PROBE_MS = 1500

// One probe, bounded by the budget its caller still has. A probe that opens its
// own fresh window is how N serial probes outrun the deadline they were meant
// to sit inside, so `budgetMs` is not optional in the wait below — the standalone
// default is only for a one-shot `status` check that has no deadline.
export async function health(base, budgetMs = HEALTH_PROBE_MS) {
  const timeout = Math.max(1, Math.floor(budgetMs))
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(timeout) })
    return { ok: res.ok, status: res.status, error: null, budgetMs: timeout }
  } catch (error) {
    return { ok: false, status: null, error: error.message, budgetMs: timeout }
  }
}

// A child that dies before it logs a line leaves `alive(pid)` saying only
// "gone". Node knows more: `error` for a child that never started, and
// `exit(code, signal)` for one that started and died. Those facts arrive once,
// so record them from spawn time and read them in the wait.
//
// `died` makes them raceable as well as readable. A waiter that only reads the
// fields learns of a death at its next convenient moment — which, if it is
// sitting inside a probe that owns the rest of the deadline, is after the
// deadline, and the death then gets misreported as a timeout. Waiting ON the
// death is what makes it arrive when it happens.
export function watchSpawnedChild(child) {
  const facts = { spawnError: null, exit: null, died: null }
  facts.died = new Promise(resolve => {
    child.once('error', error => { facts.spawnError = error; resolve() })
    child.once('exit', (code, signal) => { facts.exit = { code, signal }; resolve() })
  })
  return facts
}

// Facts for a child that does not exist yet (or never will). `died` never
// settles, so racing against it is a no-op rather than a special case.
export function noChildFacts() {
  return { spawnError: null, exit: null, died: new Promise(() => {}) }
}

function startupLogEvidence(logPath) {
  if (!existsSync(logPath)) return { path: logPath, exists: false, size: 0, tail: '' }
  const size = statSync(logPath).size
  const tail = readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-10).join('\n')
  return { path: logPath, exists: true, size, tail }
}

function describeStartupLog(log) {
  if (!log.exists) return `no log written at ${log.path}`
  if (!log.size) return `empty log at ${log.path} (0 bytes)`
  return `${log.path} (${log.size} bytes), last lines:\n${log.tail}`
}

function startupFailure(message, diagnosis) {
  return Object.assign(new Error(message), { diagnosis })
}

export async function waitForSandboxDaemon(facts, socketPath, logPath, { attempts = 60, intervalMs = 250 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const log = startupLogEvidence(logPath)
    if (facts.spawnError) {
      throw startupFailure(
        `sandbox daemon failed to spawn: ${facts.spawnError.message} — ${describeStartupLog(log)}`,
        { outcome: 'spawn-error', error: facts.spawnError.message, code: facts.spawnError.code ?? null, signal: null, log },
      )
    }
    if (facts.exit) {
      const { code, signal } = facts.exit
      throw startupFailure(
        `sandbox daemon exited before creating lifecycle socket ${socketPath} (code ${code}, signal ${signal}) — ${describeStartupLog(log)}`,
        { outcome: 'exit-before-lifecycle', code, signal, log },
      )
    }
    if (existsSync(socketPath)) return { outcome: 'socket-ready', socketPath, log }
    await new Promise(r => setTimeout(r, intervalMs))
  }
  const log = startupLogEvidence(logPath)
  throw startupFailure(
    `sandbox daemon did not create lifecycle socket ${socketPath} within ${Math.round(attempts * intervalMs / 1000)}s — ${describeStartupLog(log)}`,
    { outcome: 'no-lifecycle-socket', code: null, signal: null, log },
  )
}

// ---- preview server readiness ----

const SERVER_READY_MS = 30_000
const SERVER_POLL_MS = 500

const monotonic = () => performance.now()
const napper = ms => new Promise(r => setTimeout(r, ms))

/**
 * Wait for exactly the server we just spawned to answer `/api/health`.
 *
 * Two things the old poll could not do. It counted attempts rather than time,
 * and every attempt opened a fresh 1.5s fetch budget, so a wedged listener that
 * accepts the connection and never answers stretched a "30s" wait into minutes —
 * the loop's own probes paid for the overrun. And it only asked `alive(pid)`,
 * which says "gone" for a child that never started and for one that exited 1 and
 * for one the OOM killer took, without distinguishing them.
 *
 * So: one absolute deadline, taken once, and every probe bounded by whatever is
 * left of it; plus the child's own `error`/`exit(code, signal)` facts, RACED
 * against the probe and against the interval sleep rather than merely read
 * between them. Reading between them is not enough: a probe is entitled to the
 * whole remaining deadline, so a child that dies inside one would not be noticed
 * until the deadline had passed, and would then be reported as a timeout —
 * naming the wrong cause for a death the parent already knew about.
 * Success exists only when health is observed before that deadline.
 *
 * The probe is required to settle within the budget it is handed; `health()`
 * enforces that with an `AbortSignal` timeout. Nothing here can rescue a probe
 * that ignores its own budget and never settles.
 */
export async function waitForSandboxServer(facts, base, logPath, {
  timeoutMs = SERVER_READY_MS,
  intervalMs = SERVER_POLL_MS,
  now = monotonic,
  probe = health,
  sleep = napper,
} = {}) {
  const started = now()
  const deadline = started + timeoutMs
  const elapsedMs = () => Math.round(now() - started)
  let lastHealth = null

  // Whatever we are waiting on, we are also waiting on the child dying.
  const died = facts.died ?? new Promise(() => {})
  const DEAD = Symbol('child-died')
  const orDeath = pending => Promise.race([pending, died.then(() => DEAD)])

  // A death sends us back to the top of the loop, where the recorded facts turn
  // it into the failure that names it. Once. `died` stays resolved forever, so
  // if the top does NOT throw — no facts recorded, or a future edit that drops a
  // branch — a second lap would find the same dead child and go round again, and
  // a wait that spins on a corpse is worse than either answer. The second death
  // therefore stops the loop and the deadline failure is reported instead.
  let deathSeen = false
  const afterDeath = () => {
    if (deathSeen) return 'stop'
    deathSeen = true
    return facts.spawnError || facts.exit ? 'again' : 'stop'
  }

  const fail = (message, diagnosis) => startupFailure(
    message,
    { code: null, signal: null, error: null, ...diagnosis, elapsedMs: elapsedMs(), lastHealth, log: startupLogEvidence(logPath) },
  )

  for (;;) {
    if (facts.spawnError) {
      const log = startupLogEvidence(logPath)
      throw fail(
        `preview server failed to spawn: ${facts.spawnError.message} — ${describeStartupLog(log)}`,
        { outcome: 'spawn-error', error: facts.spawnError.message, code: facts.spawnError.code ?? null },
      )
    }
    if (facts.exit) {
      const { code, signal } = facts.exit
      const log = startupLogEvidence(logPath)
      throw fail(
        `preview server exited during startup (code ${code}, signal ${signal}) — ${describeStartupLog(log)}`,
        { outcome: 'exit-before-health', code, signal },
      )
    }

    const remaining = deadline - now()
    if (remaining <= 0) break
    const probed = await orDeath(probe(base, remaining))
    // The child died mid-probe. Go back to the top, where the facts it left
    // behind name which death it was; whatever the probe eventually says about
    // a process that no longer exists is not evidence about this startup.
    if (probed === DEAD) {
      if (afterDeath() === 'stop') break
      continue
    }
    lastHealth = probed
    // `ok` is not enough on its own: a probe that returns at or past the
    // deadline is a late answer, and a late answer is a failed startup.
    if (lastHealth.ok && now() < deadline) {
      return { outcome: 'healthy', base, elapsedMs: elapsedMs(), lastHealth, log: startupLogEvidence(logPath) }
    }

    const idle = Math.min(intervalMs, deadline - now())
    if (idle <= 0) break
    const rested = await orDeath(sleep(idle))
    if (rested === DEAD) {
      if (afterDeath() === 'stop') break
      continue
    }
  }

  const log = startupLogEvidence(logPath)
  throw fail(
    `preview server did not answer ${base}/api/health within ${Math.round(timeoutMs / 1000)}s — ${describeStartupLog(log)}`,
    { outcome: 'health-deadline' },
  )
}

/**
 * Give up on a started preview server: kill exactly the pid we spawned, prove it
 * is gone, and remove the state that pid owns.
 *
 * The pid is the one `spawn` handed back, never one read out of a pidfile and
 * never one found by sweeping the port — either of those can name a stranger
 * that inherited the number or the socket, and this function's whole job is to
 * be unable to touch anything but our own child.
 *
 * State is removed only after death is VERIFIED. A server that survives SIGTERM
 * and SIGKILL keeps its pidfile and its preview config, and comes back as
 * `still-alive`: those files are the only record that the process on that port
 * is ours, so deleting them while it runs manufactures exactly the unowned,
 * unmanifested server this repair exists to prevent. Losing the paperwork is
 * worse than the leak, because it is what makes the leak invisible.
 */
export async function discardStartedServer(pid, {
  configDir = null,
  pidPath = null,
  graceMs = 2000,
  pollMs = 50,
  now = monotonic,
  sleep = napper,
  isAlive = alive,
  signalTo = (p, sig) => process.kill(p, sig),
  removePath = p => rmSync(p, { recursive: true, force: true }),
} = {}) {
  const removed = []
  const remove = () => {
    for (const p of [configDir, pidPath]) {
      if (!p) continue
      removePath(p)
      removed.push(p)
    }
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    remove()
    return { pid: pid ?? null, signalled: false, escalated: false, gone: true, reason: 'never-spawned', removed, retained: [] }
  }
  if (!isAlive(pid)) {
    remove()
    return { pid, signalled: false, escalated: false, gone: true, reason: 'already-exited', removed, retained: [] }
  }

  const waitGone = async budgetMs => {
    const until = now() + budgetMs
    while (isAlive(pid) && now() < until) await sleep(pollMs)
    return !isAlive(pid)
  }

  try { signalTo(pid, 'SIGTERM') } catch { /* it raced us and exited */ }
  let escalated = false
  let gone = await waitGone(graceMs)
  if (!gone) {
    escalated = true
    try { signalTo(pid, 'SIGKILL') } catch { /* it exited between the grace poll and this signal */ }
    gone = await waitGone(graceMs)
  }
  if (!gone) {
    return { pid, signalled: true, escalated, gone: false, reason: 'still-alive', removed, retained: [configDir, pidPath].filter(Boolean) }
  }
  remove()
  return { pid, signalled: true, escalated, gone: true, reason: 'terminated', removed, retained: [] }
}

// ---- verbs ----

function parseArgs(args) {
  const flags = new Set(), values = new Map(), positionals = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) { positionals.push(a); continue }
    const eq = a.indexOf('=')
    if (eq !== -1) { values.set(a.slice(2, eq), a.slice(eq + 1)); continue }
    const key = a.slice(2), next = args[i + 1]
    if (next && !next.startsWith('--')) { values.set(key, next); i++ } else flags.add(key)
  }
  return { flags, values, positionals }
}

export async function cmdServeWorktree(args) {
  const { flags, values, positionals } = parseArgs(args)
  if (flags.has('help') || flags.has('h') || positionals[0] === 'help' || positionals[0] === '--help' || positionals[0] === '-h') {
    console.log(SERVE_HELP)
    return
  }

  const subcommands = new Set(['start', 'stop', 'status', 'url', 'reap-orphans'])
  const verb = subcommands.has(positionals[0]) ? positionals[0] : 'start'
  const unexpected = subcommands.has(positionals[0]) ? positionals.slice(1) : positionals
  if (unexpected.length) {
    console.error(`Unexpected positional argument: ${unexpected[0]}`)
    console.error('tlda-dev serve is worktree-relative. Run it from the worktree you want to serve, or create/switch to that worktree first.')
    process.exit(2)
  }

  const json = flags.has('json')
  const branch = worktreeBranch()
  const worktreeDir = worktreeRoot()

  if (verb === 'stop') return stopPreview(branch, json)
  if (verb === 'status') return statusPreview(branch, json, flags)
  if (verb === 'reap-orphans') return reapOrphanPreviews(json)
  if (verb === 'url') {
    const m = readManifest(branch)
    if (m && readPid(branch)) { console.log(viewerUrl(m.base, values.get('project') || m.project)); return }
    console.error(`no preview running for ${branch} — run: tlda-dev serve`); process.exit(1)
  }

  // start
  if (readPid(branch)) {
    const m = readManifest(branch)
    console.log(`preview already running for ${branch} (pid ${readPid(branch)}) — tlda-dev serve stop first`)
    if (m) console.log(`  ${viewerUrl(m.base, m.project)}`)
    return
  }

  const reach = resolveReachableHost()
  if (!reach.shareable) {
    console.error(`Can't build a reachable URL: ${reach.reason}`)
    console.error('Install/auth Tailscale on this machine, then retry.')
    process.exit(1)
  }
  if (reach.warn) console.error(`warning: ${reach.warn}`)

  const port = values.has('port') ? parseInt(values.get('port'), 10) : await findFreePort(5190)
  const base = `${reach.scheme}://${reach.host}:${port}`
  const project = values.get('project') || null

  console.log(`Serving worktree: ${worktreeDir}`)
  console.log(`Branch: ${branch}`)

  mkdirSync(stateDir(branch), { recursive: true })
  mkdirSync(projectsDir(branch), { recursive: true })

  // Seed a real project (copy the project so its assets exist; room snapshot stays
  // isolated under the preview's own projects dir).
  if (project) {
    const src = join(mainRepoRoot(), 'server', 'projects', project)
    if (!existsSync(src)) {
      console.error(`--project ${project}: no such project under ${join(mainRepoRoot(), 'server', 'projects')}`); process.exit(1)
    }
    cpSync(src, join(projectsDir(branch), project), { recursive: true })
  }

  // Build the branch's SPA (vite only — skip `tsc -b` so WIP type errors don't
  // block a preview). distDir = <worktree>/dist, exactly where its server serves.
  if (!flags.has('no-build')) {
    console.log(`Building ${branch} SPA (vite build)…`)
    const viteBin = [
      join(worktreeDir, 'node_modules', '.bin', 'vite'),
      join(resolveRepoRoot(), 'node_modules', '.bin', 'vite'),
    ].find(p => existsSync(p))
    if (!viteBin) { console.error('vite binary not found'); process.exit(1) }
    const b = spawnSync(viteBin, ['build'], { cwd: worktreeDir, stdio: 'inherit' })
    if (b.status !== 0) { console.error('vite build failed'); process.exit(1) }
  } else if (!existsSync(join(worktreeDir, 'dist', 'index.html'))) {
    console.error('--no-build but no dist/index.html — build first'); process.exit(1)
  }

  const realFleet = flags.has('real-fleet')
  if (realFleet && flags.has('sandbox')) {
    console.error('--real-fleet cannot be combined with --sandbox')
    process.exit(2)
  }
  // `--gated` turns on real token gating for this preview. Off by default, so
  // every existing preview is unchanged. It exists because the student-facing
  // paths cannot be exercised without it: ungated, `validateToken` answers 'rw'
  // for everyone and `classroomPrincipal` short-circuits to instructor before an
  // enrolment token is ever read — so a student check passes for the wrong
  // reason, which is the hardest kind of green to notice.
  const tokens = flags.has('gated') ? previewTokens() : null
  writePreviewConfig(branch, base, { realFleet, tokens })

  // Delegate to the SAME robust detached spawn `tlda server start` uses — don't
  // hand-roll a parallel spawn (a hand-rolled `node … &` is exactly what dies
  // when the launching agent hibernates). reclaimPort:false — our port came from
  // findFreePort, so we must never SIGKILL whatever might be on it.
  let serverFacts = noChildFacts()
  const pid = spawnDetachedServer({
    serverScript: join(worktreeDir, 'server', 'unified-server.mjs'),
    port,
    logFile: logFile(branch),
    reclaimPort: false,
    pidFile: pidFile(branch),
    onSpawn: child => { serverFacts = watchSpawnedChild(child) },
    env: {
      HOST: '0.0.0.0',
      TLDA_ENV: configName(branch),
      TLDA_CONFIG_DIR: previewConfigDir(branch),
      TLDA_DEV_SERVER: '1',          // no daemon supervisor / hibernate; isolated
      PROJECTS_DIR: projectsDir(branch),
      TLDA_FLEET_DB: fleetDb(branch),
      TLDA_FLEET_SERVER: realFleet ? '' : base,
      // The URL the server should use to reach ITSELF over git. It cannot be
      // loopback under TLS: the listener answers `127.0.0.1`/`localhost` SNI
      // with the mkcert cert, whose root git does not trust, so a self-push
      // dies on `unable to get local issuer certificate`. `base` is the host
      // the tailnet cert is actually issued for, and it is already computed
      // here -- so hand it over rather than making the server re-derive it.
      TLDA_SELF_BASE_URL: base,
      // Only meaningful alongside `tokenGating: true` in the config written
      // above; on their own these do nothing.
      ...(tokens ? { TLDA_TOKEN_READ: tokens.read, TLDA_TOKEN_RW: tokens.rw } : {}),
    },
  })

  console.log(`preview server starting (pid ${pid}) on ${base} …`)
  try {
    const ready = await waitForSandboxServer(serverFacts, base, logFile(branch))
    console.log(`preview server answered health in ${ready.elapsedMs}ms`)
  } catch (error) {
    // The startup we abandon is ours to clean up. A recorded exit is proof the
    // child is gone even when the pid is still a zombie awaiting reap, so it
    // answers ahead of the liveness probe.
    const discarded = await discardStartedServer(pid, {
      configDir: previewConfigDir(branch),
      pidPath: pidFile(branch),
      isAlive: p => (serverFacts.exit ? false : alive(p)),
    })
    console.error(error.message)
    if (!discarded.gone) {
      console.error(
        `pid ${discarded.pid} SURVIVED SIGTERM AND SIGKILL and may still be on ${base}. Its pidfile ` +
        `${pidFile(branch)} and config ${previewConfigDir(branch)} are DELIBERATELY LEFT IN PLACE — ` +
        'they are what marks that process as this preview\'s. Inspect it, then: tlda-dev serve stop',
      )
    }
    console.error(JSON.stringify({ ...error.diagnosis, pid, base, discarded }, null, 2))
    process.exit(1)
  }

  // No --project: seed a scratch document so the preview opens on something.
  //
  // Skip: "it just does what agents are doing now automatically." What agents do
  // now is hand-create a throwaway project so their preview isn't a blank
  // canvas — which is why ~/work/tlda/server/projects has accumulated
  // inbox-test, inbox-test2, chat-scroll-proof-341d, hud-perf-ec59 and fifty
  // more. The junk is the workaround for the empty preview, so automating it is
  // what stops it: this one is created through the preview's own API, lands in
  // the preview's own projects dir, and goes when the preview goes.
  //
  // Not fabricated on disk — created and built the same way an agent would, so
  // it cannot drift from what a real build produces.
  let previewProject = project
  if (!project) {
    previewProject = await seedScratchProject(base, branch, tokens?.rw ?? null)
    if (previewProject) console.log(`seeded scratch project: ${previewProject}`)
    // Loud on purpose. This printing is the only reason a silently unseeded
    // gated preview was caught in one run rather than ten — an empty canvas
    // looks exactly like the transport failures we spent a day clearing.
    else console.error(`scratch project not seeded — preview will open on an EMPTY CANVAS${tokens ? ' (gated preview: the seeder was refused)' : ''}`)
  }

  // --sandbox: also bring up a fleet-daemon wired ONLY to this sandbox server.
  // TLDA_DEV_DAEMON names the authorized base; the sandbox config must resolve
  // to that base on a non-:5176 port, so this daemon can never join the real
  // fleet. Detached + unref'd so it outlives the launcher, like the server.
  let daemonPid = null
  if (flags.has('sandbox')) {
    // Give the sandbox daemon its own config dir with a DISTINCT machine_id so it
    // coexists with the real daemon (own pidfile = no singleton clash; own
    // machine_id = no eviction). TLDA_ENV selects the sandbox environment.
    const dcfg = daemonConfigDir(branch)
    mkdirSync(dcfg, { recursive: true })
    writeFileSync(join(dcfg, 'server.yaml'), '')
    writeFileSync(join(dcfg, 'daemon.yaml'), [
      `machineId: ${JSON.stringify(`dev-${sanitize(branch)}`)}`,
      'statusScanSeconds: 3',
      'environments:',
      `  default: ${JSON.stringify(configName(branch))}`,
      '  values:',
      `    ${JSON.stringify(configName(branch))}:`,
      `      database: ${JSON.stringify(base)}`,
      `      store: ${JSON.stringify(base)}`,
      '      licenseKey: ""',
      'regions:',
      '  machine: ["**"]',
      'profiles:',
      '  ops:',
      '    read: { allow: [machine], deny: [] }',
      '    write: { allow: [machine], deny: [] }',
      'grants:',
      '  localhost: ops',
      'models: {}',
      'default: ops',
      '',
    ].join('\n'))
    const dlogFd = openSync(daemonLogFile(branch), 'a')
    const daemonSocket = daemonLifecycleSocketPath(dcfg, configName(branch))
    const dchild = spawn(process.execPath, [join(worktreeDir, 'bin', 'fleet-daemon.mjs')], {
      detached: true,
      stdio: ['ignore', dlogFd, dlogFd],
      env: {
        ...process.env,
        TLDA_DAEMON_CONFIG_DIR: dcfg,    // own machine_id + pidfile (coexist with real daemon)
        TLDA_CONFIG_DIR: dcfg,           // resolve the sandbox's named server authority
        TLDA_DEV_DAEMON: base,           // the authorized sandbox target; arms the invariant
        TLDA_ENV: configName(branch),
        TLDA_FLEET_DB: fleetDb(branch),
        PROJECTS_DIR: projectsDir(branch),
        TMUX: undefined,
        TMUX_PANE: undefined,
      },
    })
    const dfacts = watchSpawnedChild(dchild)
    dchild.unref()
    daemonPid = dchild.pid
    writeFileSync(daemonPidFile(branch), String(daemonPid))
    try {
      await waitForSandboxDaemon(dfacts, daemonSocket, daemonLogFile(branch))
    } catch (error) {
      try { process.kill(daemonPid) } catch { /* already exited */ }
      try { process.kill(pid) } catch { /* already exited */ }
      removePreviewConfig(branch)
      console.error(error.message)
      process.exit(1)
    }
    console.log(`sandbox daemon started (pid ${daemonPid}) → ${base} (sandbox-locked, cannot reach prod)`)
  }

  // A gated preview's URL carries the read token, or it opens to a 401 and the
  // next half hour goes on working out why. Token and project params are the
  // safe ones to hand someone; a `name=` would not be.
  const url = tokens
    ? `${viewerUrl(base, previewProject)}${previewProject ? '&' : '?'}token=${tokens.read}`
    : viewerUrl(base, previewProject)
  const manifest = {
    branch, worktreeDir, base, project: previewProject, port, host: reach.host, kind: reach.kind,
    url, pid, daemonPid, sandbox: flags.has('sandbox'), realFleet, tokenless: !tokens, config: configName(branch),
    ...(tokens ? { tokens } : {}),
    projectsDir: projectsDir(branch), fleetDb: fleetDb(branch),
  }
  writeFileSync(manifestFile(branch), JSON.stringify(manifest, null, 2))
  acquireLease({
    kind: 'preview-server', resource_id: previewLeaseId(branch),
    owner: { id: process.env.FLEET_ID || process.env.USER || 'local', type: process.env.FLEET_ID ? 'agent' : 'human' },
    metadata: { pid, ports: [port], cwd: process.cwd(), worktree: worktreeDir, branch, base, daemon_pid: daemonPid },
    policy: { ttl_ms: 30 * 60_000, idle_policy: 'expire-kill-preview' },
  })
  // `tlda-dev dev-url` reads <cwd>/.dev-url — keep it the URL that actually
  // opens, which on a gated preview is the one carrying the read token.
  try { writeFileSync(join(worktreeDir, '.dev-url'), url) } catch { /* non-fatal */ }

  if (json) { console.log(JSON.stringify(manifest, null, 2)); return }
  console.log(tokens
    ? `\nworktree preview up — reachable from your other devices, token gating ON:`
    : `\nworktree preview up — reachable from your other devices, no token:`)
  console.log(`  branch:  ${branch}`)
  console.log(`  ${url}\n`)
  if (tokens) {
    // Printed because a tester who cannot discover the read token cannot be a
    // student, and there is nowhere else to look them up.
    console.log(`  read token (a reader):      ${tokens.read}`)
    console.log(`  rw token   (an instructor): ${tokens.rw}`)
    console.log(`\n  A student also needs their enrolment token: &classroomToken=<token>`)
    console.log(`  Both stay on the URL — they are read from it on every request.\n`)
  }
  await printQr(url)
  console.log(`\n  stop with: tlda-dev serve stop`)
}

export async function cmdShareWorktree(args) {
  const { values } = parseArgs(args)
  const branch = worktreeBranch()
  const m = readManifest(branch)
  if (!m || !readPid(branch)) {
    console.error(`No preview running for ${branch}. Start one with:  tlda-dev serve`)
    process.exit(1)
  }
  const project = values.get('project') || values.get('0') || m.project
  // On a gated preview the bare URL is a 401. Share the one that opens, and say
  // the tokens out loud — the preview's config dir does not survive a stop, so
  // there is nowhere to look them up afterwards.
  const base = viewerUrl(m.base, project)
  const url = m.tokens ? `${base}${project ? '&' : '?'}token=${m.tokens.read}` : base
  console.log(m.tokens
    ? `Worktree preview (${branch}) — reachable, token gating ON:`
    : `Worktree preview (${branch}) — reachable, no token:`)
  console.log(`  ${url}\n`)
  if (m.tokens) {
    console.log(`  read token (a reader):      ${m.tokens.read}`)
    console.log(`  rw token   (an instructor): ${m.tokens.rw}\n`)
  }
  await printQr(url)
}

function stopPreview(branch, json) {
  const pid = readPid(branch)
  const hadManifest = !!readManifest(branch)
  if (pid) { try { process.kill(pid) } catch { /* gone */ } }
  // Tear down the sandbox daemon too, if --sandbox started one.
  if (existsSync(daemonPidFile(branch))) {
    const dpid = parseInt(readFileSync(daemonPidFile(branch), 'utf8').trim(), 10)
    if (Number.isInteger(dpid)) { try { process.kill(dpid) } catch { /* gone */ } }
  }
  removePreviewConfig(branch)
  releaseLease(previewLeaseId(branch))
  for (const f of [pidFile(branch), manifestFile(branch)]) if (existsSync(f)) unlinkSync(f)
  // Drop the isolated projects + fleet DB so a stopped preview leaves nothing behind.
  try { rmSync(stateDir(branch), { recursive: true, force: true }) } catch { /* best effort */ }
  if (json) console.log(JSON.stringify({ status: 'down', stopped: !!pid, branch }))
  else {
    console.log(pid ? `preview stopped (${branch}, pid ${pid})` : `no preview running for ${branch}`)
    if (!pid && !hadManifest) printOrphanHint(orphanPreviewListeners())
  }
}

async function statusPreview(branch, json, flags = new Set()) {
  if (flags.has('all')) {
    return statusAllPreviews(json)
  }
  const pid = readPid(branch)
  const m = readManifest(branch)
  const up = pid && m ? (await health(m.base)).ok : false
  const state = { branch, status: up ? 'up' : pid ? 'starting-or-wedged' : 'down', ...(m || {}), pid }
  if (json) { console.log(JSON.stringify(state, null, 2)); return }
  if (up) {
    console.log(`preview: up (${branch})`)
    console.log(`  ${viewerUrl(m.base, m.project)}  (reachable, no token)`)
    console.log(`  log: ${logFile(branch)}`)
  } else if (pid) {
    console.log(`preview: pid ${pid} alive but not answering — see ${logFile(branch)}`)
  } else {
    console.log(`preview: down (${branch})`)
  }
}

async function statusAllPreviews(json) {
  const states = listPreviewStates()
  const orphans = orphanPreviewListeners(states)
  const leases = listLeases().filter(l => l.kind === 'preview-server')
  if (json) {
    console.log(JSON.stringify({ previews: states, leases, orphanListeners: orphans }, null, 2))
    return
  }
  if (!states.length) {
    console.log('previews: none recorded')
  } else {
    console.log('previews:')
    for (const s of states) {
      const status = s.pid ? 'pid-alive' : s.rawPid ? 'pid-dead' : 'no-pid'
      const url = s.base ? ` ${viewerUrl(s.base, s.project)}` : ''
      console.log(`  ${s.branch}: ${status}${url}`)
      if (s.worktreeDir) console.log(`    worktree: ${s.worktreeDir}`)
      console.log(`    log: ${s.log}`)
    }
  }
  if (leases.length) console.log(`leased previews: ${leases.length}`)
  if (orphans.length) printOrphanHint(orphans)
}

// Sweep orphaned preview STATE DIRS. A clean `stop` already rm's the dir
// (stopPreview), so a surviving dir whose process is dead means the preview was
// killed/crashed without a clean stop — that's what accumulates (32GB of
// fleet.db copies + projects). Skip any dir with today's mtime (active or
// just-crashed-and-may-restart) — the same safe rule the manual reclaim used.
export function sweepOrphanPreviewDirs() {
  const swept = [], kept = []
  const todayStr = new Date().toDateString()
  for (const s of listPreviewStates()) {
    if (s.pid) { kept.push({ branch: s.key, reason: 'running' }); continue }
    const dir = stateDir(s.key)
    let mtime
    try { mtime = statSync(dir).mtime } catch { continue }
    if (mtime.toDateString() === todayStr) { kept.push({ branch: s.key, reason: 'today-mtime' }); continue }
    try { rmSync(dir, { recursive: true, force: true }); swept.push(s.key) }
    catch (e) { kept.push({ branch: s.key, reason: `rm-failed: ${e.message}` }) }
  }
  return { swept, kept }
}

// ---- idle-preview reaper (access-based) ----

// Skip's rule: a dev server nobody has been *using* for ~15 minutes is
// abandoned. Using, not owning, not running — a preview whose process is alive
// tells you nothing, which is why the lease reaper (renewing on process
// liveness) could never reap an abandoned one.
const PREVIEW_IDLE_MS = parseInt(process.env.REAPER_PREVIEW_IDLE_MS, 10) || 15 * 60_000

// First-observed-idle, keyed by pid:port. In a short-lived CLI process this is
// always empty, so a sweep there can never reap on its first look; in the bot
// it persists. A bot restart therefore grants every preview a fresh grace
// period, which errs toward keeping a server alive.
const _previewIdleSince = new Map()

/**
 * Inbound client connections per `pid:port`, counted from the SERVER side of
 * the socket — the records whose local end is the preview port.
 *
 * Deliberately does not look at what the client is. Only the server end is
 * local, so any check on the client process can see local clients only, and
 * would report a preview as idle while it is being read from another machine.
 * Previews exist to be opened from Skip's iPad and phone over Tailscale, so
 * that check would reap the page he is reading. Anyone holding a connection
 * counts, wherever they are.
 */
function previewClientsByPidPort() {
  const out = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED'], { encoding: 'utf8' }).stdout || ''
  const counts = new Map()
  for (const line of out.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 9) continue
    const pid = Number(parts[1])
    const m = parts.slice(8).join(' ').match(/:(\d+)->/)
    if (!m || !Number.isInteger(pid)) continue
    const port = Number(m[1])
    if (port < PREVIEW_PORT_MIN || port > PREVIEW_PORT_MAX) continue
    const key = `${pid}:${port}`
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return counts
}

/**
 * Reap preview servers nobody has been connected to for `idleMs`. Intended to
 * run on an interval from the dev bot; returns what it did so a caller can
 * report, and logs every reap itself so a kill is never silent.
 */
export function reapIdlePreviews({ now = Date.now(), idleMs = PREVIEW_IDLE_MS } = {}) {
  const listeners = previewListeners()
  const clients = previewClientsByPidPort()
  const reaped = [], inUse = [], waiting = [], failed = []
  const seen = new Set()

  for (const l of listeners) {
    const key = `${l.pid}:${l.port}`
    seen.add(key)

    const open = clients.get(key) || 0
    if (open > 0) {
      _previewIdleSince.delete(key)
      inUse.push({ pid: l.pid, port: l.port, clients: open })
      continue
    }

    if (!_previewIdleSince.has(key)) _previewIdleSince.set(key, now)
    const idle = now - _previewIdleSince.get(key)
    if (idle < idleMs) {
      waiting.push({ pid: l.pid, port: l.port, idleMs: idle })
      continue
    }
    // Our port range is ours by convention, not by ownership. Never signal a
    // process that isn't one of our node preview servers.
    if (!/^node/i.test(l.command)) {
      waiting.push({ pid: l.pid, port: l.port, idleMs: idle, skipped: 'not-a-node-preview' })
      continue
    }

    try {
      process.kill(l.pid, 'SIGTERM')
      console.log(`[preview-reaper] reaped pid=${l.pid} port=${l.port} — no client connected for ${Math.round(idle / 60000)}m`)
      reaped.push({ pid: l.pid, port: l.port, idleMs: idle })
      _previewIdleSince.delete(key)
    } catch (e) {
      if (e?.code === 'ESRCH') { _previewIdleSince.delete(key); continue }  // exited on its own
      console.error(`[preview-reaper] kill pid=${l.pid} port=${l.port} failed: ${e.message}`)
      failed.push({ pid: l.pid, port: l.port, error: e.message })
    }
  }

  for (const k of [..._previewIdleSince.keys()]) if (!seen.has(k)) _previewIdleSince.delete(k)
  return { reaped, inUse, waiting, failed }
}

function reapOrphanPreviews(json) {
  const orphans = orphanPreviewListeners()
  const reaped = []
  for (const o of orphans) {
    if (!/^node/i.test(o.command)) continue
    try {
      process.kill(o.pid)
      reaped.push(o)
    } catch { /* already gone */ }
  }
  // Also sweep orphaned preview data dirs (dead process, non-today mtime).
  const dirs = sweepOrphanPreviewDirs()
  if (json) {
    console.log(JSON.stringify({
      reaped,
      skipped: orphans.filter(o => !reaped.includes(o)),
      sweptDirs: dirs.swept,
      keptDirs: dirs.kept,
    }, null, 2))
    return
  }
  if (!orphans.length && !dirs.swept.length) {
    console.log('no orphan preview listeners or dirs found')
    return
  }
  for (const o of reaped) console.log(`reaped orphan preview listener pid ${o.pid} on :${o.port}`)
  for (const o of orphans.filter(o => !reaped.includes(o))) {
    console.log(`left listener pid ${o.pid} ${o.command} on :${o.port} (not a node preview process)`)
  }
  for (const b of dirs.swept) console.log(`swept orphaned preview dir: ${b}`)
}

/** Create and build a small markdown project through the preview's own API. */
/**
 * Seed the preview's scratch document.
 *
 * `rwToken` is the gated preview's RW token, or null when the preview is
 * ungated. Creating a project is a write, so on a gated preview an
 * unauthenticated seeder is refused and the preview opens on an empty canvas —
 * which is indistinguishable from the transport failures that cost a day, and
 * sends the next person debugging the wrong thing entirely.
 *
 * One seeder that authenticates when it has to, rather than a second seeding
 * path for the gated case.
 */
export async function seedScratchProject(base, branch, rwToken = null) {
  const name = `scratch-${sanitize(branch)}`.slice(0, 48).replace(/-+$/, '')
  const authHeaders = rwToken ? { authorization: `Bearer ${rwToken}` } : {}
  const post = async (path, body) => {
    try {
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify(body),
      })
      if (r.ok || r.status === 409) return r
      console.error(`  scratch project: ${path} → HTTP ${r.status} ${(await r.text()).slice(0, 160)}`)
      return null
    } catch (e) { console.error(`  scratch project: ${path} threw ${e?.message || e}`); return null }
  }
  const created = await post('/api/projects', {
    name, title: `Scratch (${branch})`, mainFile: 'main.md', format: 'markdown',
  })
  if (!created) return null
  const pushed = await post(`/api/projects/${name}/source-room/files`, {
    // The manifest is the complete file list the snapshot consists of, and
    // every path in it must have an entry in `files` -- the snapshot IS the
    // project, so a path that leaves the manifest is deleted by not being
    // named. One file here, so the two match by construction.
    sourceManifest: ['main.md'],
    // A bootstrap. `expectedRevision` is the commit's parent, so null is a
    // parentless root commit: the server has no ref for a fresh project and
    // accepts it. It is no longer a sentinel that has to survive being
    // distinguished from absent -- absent means the same thing now.
    expectedRevision: null,
    files: [{
      path: 'main.md',
      content: [
        `# Scratch (${branch})`,
        '',
        'A preview needs a document to render, so `tlda-dev serve` made this one.',
        'It belongs to this preview and disappears with it — edit it freely.',
        '',
        '## Second heading',
        '',
        'Here so the table of contents has more than one entry.',
        '',
      ].join('\n'),
    }],
    editedBy: 'tlda-dev serve',
  })
  if (!pushed) return null
  // Archived by construction. Skip: "they should definitely just be archived by
  // construction." A preview's scratch document is real enough to render and
  // build, but it is not one of his projects and should never appear beside
  // them. Archiving at birth is what keeps the index clean without anything
  // having to remember to clean up later — the alternative, deleting on
  // teardown, only works if teardown runs, and a preview outlives the agent
  // that started it often enough that it would not.
  try {
    await fetch(`${base}/api/projects/${name}/archive`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ archived: true }),
    })
  } catch { /* the project is usable either way; archiving is tidiness */ }
  return name
}
