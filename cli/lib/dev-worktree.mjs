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
 *  2. tokens: a non-standard PORT disables auth entirely (server/lib/auth.mjs).
 *     The preview runs on a free high port, so it is tokenless by construction —
 *     no `?token=` in the URL, ever.
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
import { join } from 'path'
import { homedir } from 'os'
import { X509Certificate } from 'crypto'
import { hasTls, resolveConfig, CONFIG_DIR } from '../../shared/config.mjs'
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
  tlda-dev serve [start] [--sandbox] [--real-fleet] [--project NAME] [--port N] [--no-build]
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

export function worktreeBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']) || 'detached'
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

function writePreviewConfig(branch, base, { realFleet = false } = {}) {
  const source = resolveConfig()
  const database = realFleet ? source.database.http : base
  // Preview servers get an isolated copy. Writing the shared config would both
  // corrupt the real daemon's authority surface and violate the app-dev fence.
  const dir = previewConfigDir(branch)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'server.yaml'), '')
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

async function health(base) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function waitForSandboxDaemon(pid, socketPath, logPath) {
  for (let i = 0; i < 60; i++) {
    if (!alive(pid)) {
      const detail = existsSync(logPath) ? ` — see ${logPath}` : ''
      throw new Error(`sandbox daemon exited during startup${detail}`)
    }
    if (existsSync(socketPath)) return
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`sandbox daemon did not create lifecycle socket ${socketPath} within 15s — see ${logPath}`)
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
  writePreviewConfig(branch, base, { realFleet })

  // Delegate to the SAME robust detached spawn `tlda server start` uses — don't
  // hand-roll a parallel spawn (a hand-rolled `node … &` is exactly what dies
  // when the launching agent hibernates). reclaimPort:false — our port came from
  // findFreePort, so we must never SIGKILL whatever might be on it.
  const pid = spawnDetachedServer({
    serverScript: join(worktreeDir, 'server', 'unified-server.mjs'),
    port,
    logFile: logFile(branch),
    reclaimPort: false,
    pidFile: pidFile(branch),
    env: {
      HOST: '0.0.0.0',
      TLDA_ENV: configName(branch),
      TLDA_CONFIG_DIR: previewConfigDir(branch),
      TLDA_DEV_SERVER: '1',          // no daemon supervisor / hibernate; isolated
      PROJECTS_DIR: projectsDir(branch),
      TLDA_FLEET_DB: fleetDb(branch),
      TLDA_FLEET_SERVER: realFleet ? '' : base,
    },
  })

  console.log(`preview server starting (pid ${pid}) on ${base} …`)
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise(r => setTimeout(r, 500))
    up = await health(base)
    if (!up && !alive(pid)) {
      console.error(`server exited during startup — see ${logFile(branch)}`)
      removePreviewConfig(branch)
      process.exit(1)
    }
  }
  if (!up) { console.error(`server didn't answer on ${base} within 30s — see ${logFile(branch)}`); process.exit(1) }

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
    dchild.unref()
    daemonPid = dchild.pid
    writeFileSync(daemonPidFile(branch), String(daemonPid))
    try {
      await waitForSandboxDaemon(daemonPid, daemonSocket, daemonLogFile(branch))
    } catch (error) {
      try { process.kill(daemonPid) } catch { /* already exited */ }
      try { process.kill(pid) } catch { /* already exited */ }
      removePreviewConfig(branch)
      console.error(error.message)
      process.exit(1)
    }
    console.log(`sandbox daemon started (pid ${daemonPid}) → ${base} (sandbox-locked, cannot reach prod)`)
  }

  const url = viewerUrl(base, project)
  const manifest = {
    branch, worktreeDir, base, project, port, host: reach.host, kind: reach.kind,
    url, pid, daemonPid, sandbox: flags.has('sandbox'), realFleet, tokenless: true, config: configName(branch),
    projectsDir: projectsDir(branch), fleetDb: fleetDb(branch),
  }
  writeFileSync(manifestFile(branch), JSON.stringify(manifest, null, 2))
  acquireLease({
    kind: 'preview-server', resource_id: previewLeaseId(branch),
    owner: { id: process.env.FLEET_ID || process.env.USER || 'local', type: process.env.FLEET_ID ? 'agent' : 'human' },
    metadata: { pid, ports: [port], cwd: process.cwd(), worktree: worktreeDir, branch, base, daemon_pid: daemonPid },
    policy: { ttl_ms: 30 * 60_000, idle_policy: 'expire-kill-preview' },
  })
  // `tlda-dev dev-url` reads <cwd>/.dev-url — keep it the reachable, tokenless URL.
  try { writeFileSync(join(worktreeDir, '.dev-url'), url) } catch { /* non-fatal */ }

  if (json) { console.log(JSON.stringify(manifest, null, 2)); return }
  console.log(`\nworktree preview up — reachable from your other devices, no token:`)
  console.log(`  branch:  ${branch}`)
  console.log(`  ${url}\n`)
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
  const url = viewerUrl(m.base, project)
  console.log(`Worktree preview (${branch}) — reachable, no token:`)
  console.log(`  ${url}\n`)
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
  const up = pid && m ? await health(m.base) : false
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
