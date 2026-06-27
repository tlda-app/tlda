/**
 * Worktree-relative `tlda-dev` mirrors.
 *
 * Skip's rule: `tlda-dev <cmd>` is the worktree-relative mirror of `tlda <cmd>`.
 * Where `tlda doc share` shares the *live* :5176 server (token, real rooms),
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
 * under PROJECTS_DIR, so sharing the live one would corrupt real rooms). `--doc`
 * copies one project in so Skip can open a real document; otherwise it's the UI
 * shell. Nothing touches the live :5176 server or its rooms.
 */

import { spawnSync, execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, cpSync, rmSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { X509Certificate } from 'crypto'
import { hasTls, loadConfig, saveConfig, CONFIG_DIR } from '../../shared/config.mjs'
import { resolveRepoRoot, findFreePort } from './dev-vite.mjs'
import { spawnDetachedServer } from './server-start.mjs'
import { findTailscaleIPv4 } from './share-url.mjs'

const BASE_DIR = join(homedir(), '.config', 'tlda', 'dev-worktree')
const TLS_CERT = join(CONFIG_DIR, 'localhost+2.pem')

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
function manifestFile(branch) { return join(stateDir(branch), 'manifest.json') }
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

function writePreviewConfig(branch, base) {
  const cfg = loadConfig()
  cfg.configs = cfg.configs || {}
  // Borrow a licenseKey from any existing config (tldraw sync license).
  const donor = Object.values(cfg.configs).find(c => typeof c?.licenseKey === 'string')
  cfg.configs[configName(branch)] = {
    database: base,   // fleet/chat/agents → the preview server itself
    store: base,      // shapes + doc assets → the preview server itself
    licenseKey: donor?.licenseKey ?? '',
  }
  // NEVER touch defaultConfig — additive only, so the coherence guard stays quiet.
  saveConfig(cfg)
}

function removePreviewConfig(branch) {
  const cfg = loadConfig()
  if (cfg.configs && cfg.configs[configName(branch)]) {
    delete cfg.configs[configName(branch)]
    saveConfig(cfg)
  }
}

// ---- QR ----

async function printQr(url) {
  try {
    const qr = await import('qrcode-terminal')
    qr.default.generate(url, { small: true })
  } catch { /* qrcode-terminal missing — URL alone is enough */ }
}

function viewerUrl(base, doc) {
  return doc ? `${base}/?doc=${encodeURIComponent(doc)}` : `${base}/`
}

async function health(base) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
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
  const verb = ['start', 'stop', 'status', 'url'].includes(positionals[0]) ? positionals[0] : 'start'
  const json = flags.has('json')
  const branch = worktreeBranch()
  const worktreeDir = worktreeRoot()

  if (verb === 'stop') return stopPreview(branch, json)
  if (verb === 'status') return statusPreview(branch, json)
  if (verb === 'url') {
    const m = readManifest(branch)
    if (m && readPid(branch)) { console.log(viewerUrl(m.base, values.get('doc') || m.doc)); return }
    console.error(`no preview running for ${branch} — run: tlda-dev serve`); process.exit(1)
  }

  // start
  if (readPid(branch)) {
    const m = readManifest(branch)
    console.log(`preview already running for ${branch} (pid ${readPid(branch)}) — tlda-dev serve stop first`)
    if (m) console.log(`  ${viewerUrl(m.base, m.doc)}`)
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
  const doc = values.get('doc') || null

  mkdirSync(stateDir(branch), { recursive: true })
  mkdirSync(projectsDir(branch), { recursive: true })

  // Seed a real doc (copy the project so its assets exist; room snapshot stays
  // isolated under the preview's own projects dir).
  if (doc) {
    const src = join(mainRepoRoot(), 'server', 'projects', doc)
    if (!existsSync(src)) {
      console.error(`--doc ${doc}: no such project under ${join(mainRepoRoot(), 'server', 'projects')}`); process.exit(1)
    }
    cpSync(src, join(projectsDir(branch), doc), { recursive: true })
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

  writePreviewConfig(branch, base)

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
      TLDA_CONFIG: configName(branch),
      TLDA_DEV_SERVER: '1',          // no daemon supervisor / hibernate; isolated
      PROJECTS_DIR: projectsDir(branch),
      TLDA_FLEET_DB: fleetDb(branch),
      TLDA_FLEET_SERVER: base,       // /api/fleet-config → this server (own chat)
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

  const url = viewerUrl(base, doc)
  const manifest = {
    branch, worktreeDir, base, doc, port, host: reach.host, kind: reach.kind,
    url, pid, tokenless: true, config: configName(branch),
    projectsDir: projectsDir(branch), fleetDb: fleetDb(branch),
  }
  writeFileSync(manifestFile(branch), JSON.stringify(manifest, null, 2))
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
  const doc = values.get('doc') || values.get('0') || m.doc
  const url = viewerUrl(m.base, doc)
  console.log(`Worktree preview (${branch}) — reachable, no token:`)
  console.log(`  ${url}\n`)
  await printQr(url)
}

function stopPreview(branch, json) {
  const pid = readPid(branch)
  if (pid) { try { process.kill(pid) } catch { /* gone */ } }
  removePreviewConfig(branch)
  for (const f of [pidFile(branch), manifestFile(branch)]) if (existsSync(f)) unlinkSync(f)
  // Drop the isolated projects + fleet DB so a stopped preview leaves nothing behind.
  try { rmSync(stateDir(branch), { recursive: true, force: true }) } catch { /* best effort */ }
  if (json) console.log(JSON.stringify({ status: 'down', stopped: !!pid, branch }))
  else console.log(pid ? `preview stopped (${branch}, pid ${pid})` : `no preview running for ${branch}`)
}

async function statusPreview(branch, json) {
  const pid = readPid(branch)
  const m = readManifest(branch)
  const up = pid && m ? await health(m.base) : false
  const state = { branch, status: up ? 'up' : pid ? 'starting-or-wedged' : 'down', ...(m || {}), pid }
  if (json) { console.log(JSON.stringify(state, null, 2)); return }
  if (up) {
    console.log(`preview: up (${branch})`)
    console.log(`  ${viewerUrl(m.base, m.doc)}  (reachable, no token)`)
    console.log(`  log: ${logFile(branch)}`)
  } else if (pid) {
    console.log(`preview: pid ${pid} alive but not answering — see ${logFile(branch)}`)
  } else {
    console.log(`preview: down (${branch})`)
  }
}
