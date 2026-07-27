import { execFile } from 'child_process'
import os from 'os'
import { promisify } from 'util'

import { isPlaywrightBrowserArgs } from './daemon-guards.mjs'
import { sweepOrphanPreviewDirs } from '../cli/lib/dev-worktree.mjs'
import { expiredLeases, formatLeaseMarkdownTable, listLeases, releaseLease, renewLease } from '../cli/lib/resource-leases.mjs'

const execFileP = promisify(execFile)

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'unknown'
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return 'unknown'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let n = value
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function cpuPressureSnapshot() {
  const cpuCount = os.cpus()?.length || 1
  const loadAverage = os.loadavg?.()[0]
  return {
    cpuCount,
    loadAverage,
    cpuPressure: Number.isFinite(loadAverage) ? Math.min(1, loadAverage / cpuCount) : null,
  }
}

export function formatReaperMarkdownReport(status = {}) {
  if (!status || status.error) return '## Dev Reaper\n\nNo reaper status is available yet.'
  const usedMem = Number.isFinite(status.totalMem) && Number.isFinite(status.freeMem)
    ? Math.max(0, status.totalMem - status.freeMem)
    : null
  const lines = [
    '## Dev Reaper',
    '',
    'Sweep: #' + (status.sweepCount ?? '-'),
    '',
    '### Machine Pressure',
    '',
    '| Resource | Pressure | Detail |',
    '| --- | ---: | --- |',
    '| Memory | ' + formatPercent(status.pressure) + ' | ' + formatBytes(usedMem) + ' used / ' + formatBytes(status.totalMem) + ' total |',
    '| CPU | ' + formatPercent(status.cpuPressure) + ' | 1m load ' + (Number.isFinite(status.loadAverage) ? status.loadAverage.toFixed(2) : 'unknown') + ' / ' + (status.cpuCount ?? 'unknown') + ' cores |',
    '',
    '### Reaper Surface',
    '',
    '| Kind | Count | Notes |',
    '| --- | ---: | --- |',
    '| Vite servers | ' + (status.vites?.length ?? 0) + ' | ' + (status.vites?.filter(v => !v.hasClient).length ?? 0) + ' without browser clients |',
    '| Playwright browsers | ' + (status.browsers?.length ?? 0) + ' | ' + (status.browsers?.filter(b => !b.controllerAlive).length ?? 0) + ' orphan candidates |',
  ]
  lines.push('', formatLeaseMarkdownTable(status.leases || []))
  if (status.unleased?.length) {
    lines.push('', '### Unleased / Legacy Resources', '', '| Kind | PID | Detail |', '| --- | ---: | --- |')
    for (const item of status.unleased) lines.push(`| ${item.kind} | ${item.pid ?? '—'} | ${item.detail || 'not represented by tlda-dev lease authority'} |`)
  }
  if (status.lastKills?.length) {
    lines.push('', '### Recent Kills', '', '| PID | Kind | Agent | Reason |', '| ---: | --- | --- | --- |')
    for (const kill of status.lastKills.slice(-10).reverse()) {
      const reason = String(kill.reason ?? '').replace(/\|/g, '\\|')
      lines.push('| ' + (kill.pid ?? '-') + ' | ' + (kill.kind ?? '-') + ' | ' + (kill.agent ?? '-') + ' | ' + reason + ' |')
    }
  }
  return lines.join('\n')
}

// The dev reaper takes no agent list and no tmux handle. It reaps dev
// resources — vite servers, playwright browsers, preview dirs, expired leases —
// and it decides on each resource's own idleness. It cannot reach an agent, by
// construction: killing agents is Todd's job.
export function createDevReaper({ sendMsg = () => {} } = {}) {
  // ─── Memory pressure ────────────────────────────────────────────────

  function getMemoryPressure() {
    const total = os.totalmem()
    const free = os.freemem()
    return 1 - free / total  // 0 = empty, 1 = full
  }

  // Scale an idle timeout by memory pressure. At ≥90% usage the timeout
  // drops to 1/10 of the base; below 50% usage it stays at the full base.
  function pressureScaledTimeout(baseMs) {
    const p = getMemoryPressure()
    if (p < 0.5) return baseMs
    const scale = Math.max(0.1, 1 - (p - 0.5) / 0.4)  // linear 1→0.1 over 50%→90%
    return Math.round(baseMs * scale)
  }

  // ─── Resource → owner label ────────────────────────────────────────
  // Ownership comes from the lease. `tlda-dev serve` and `tlda-dev pw` stamp it
  // from FLEET_ID at acquire time, so it is a declaration by the process that
  // created the resource, not a guess about it.
  //
  // The ppid-walking attribution that used to live here is deleted, not moved:
  // inferring which agent owns a pid is what let this reaper kill live agents,
  // and a dev reaper has no business identifying agents at all. Reaping decides
  // on the resource's own idleness; the owner is only ever a label.
  function ownerByPid(leases = listLeases()) {
    const map = new Map()
    for (const lease of leases) {
      const pid = lease.metadata?.pid
      if (Number.isInteger(pid)) map.set(pid, lease.owner?.id || null)
    }
    return map
  }

  async function attributeViteByCwd(pid) {
    try {
      const { stdout } = await execFileP('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
        { timeout: 2000, encoding: 'utf8' })
      const cwdLine = stdout.split('\n').find(l => l.startsWith('n/'))
      if (!cwdLine) return null
      const cwd = cwdLine.slice(1)
      const wtMatch = cwd.match(/\.worktrees\/([^/]+)/)
      if (wtMatch) return wtMatch[1]
    } catch {
      // Process cwd attribution is advisory; an inaccessible lsof entry only drops the label.
    }
    return null
  }

  // ─── Vite reaper — kill dev servers nobody's using ──────────────────
  const VITE_IDLE_THRESHOLD_MS = parseInt(process.env.REAPER_VITE_MS, 10) || 10 * 60 * 1000
  // Floor the pressure-scaled timeout: even at 99% memory the threshold collapsed
  // to ~1 min, which SIGKILLed dev servers during a normal edit pause (the "idle"
  // signal is just "no browser currently on the port" — true for most of an agent's
  // edit loop). Never reap a dev server with less than this much idle, so a brief
  // pause can't lose an in-use server; a genuinely abandoned one still gets reaped.
  const VITE_MIN_IDLE_MS = parseInt(process.env.REAPER_VITE_MIN_MS, 10) || 5 * 60 * 1000
  const VITE_SWEEP_INTERVAL_MS = parseInt(process.env.REAPER_VITE_INTERVAL_MS, 10) || 60 * 1000
  const _viteLastClient = new Map()
  const BROWSER_NAME_RE = /Google|Chrome|Chromium|Firefox|Safari|WebKit/i

  function isViteArgs(args) {
    if (!args.startsWith('node ')) return false
    return /[\/\\]vite(\.js)?(\s|$)/.test(args)
  }

  async function findListeningPorts(pid) {
    try {
      const { stdout } = await execFileP('lsof',
        ['-a', '-nP', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-F', 'n'],
        { timeout: 3000, encoding: 'utf8' })
      const ports = []
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('n')) continue
        const m = line.slice(1).match(/:(\d+)$/)
        if (m) ports.push(parseInt(m[1], 10))
      }
      return [...new Set(ports)]
    } catch { return [] }
  }

  async function listVites() {
    let psOut = ''
    try {
      const { stdout } = await execFileP('ps', ['-axo', 'pid=,args='], { timeout: 5000, encoding: 'utf8' })
      psOut = stdout
    } catch (e) {
      throw new Error(`listVites ps failed: ${e.message}`)
    }
    const vites = []
    for (const line of psOut.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/)
      if (!m) continue
      const pid = parseInt(m[1], 10)
      const args = m[2]
      if (!isViteArgs(args)) continue
      const ports = await findListeningPorts(pid)
      if (ports.length > 0) vites.push({ pid, ports, args })
    }
    return vites
  }

  async function viteHasBrowserClient(port) {
    let lsofOut = ''
    try {
      const { stdout } = await execFileP('lsof',
        ['-nP', '-iTCP:' + port, '-sTCP:ESTABLISHED', '-F', 'pcn'],
        { timeout: 3000, encoding: 'utf8' })
      lsofOut = stdout
    } catch { return false }
    const records = []
    let cur = null
    for (const line of lsofOut.split('\n')) {
      if (!line) continue
      const k = line[0], v = line.slice(1)
      if (k === 'p') { if (cur) records.push(cur); cur = { pid: v, names: [] } }
      else if (k === 'c' && cur) cur.command = v
      else if (k === 'n' && cur) cur.names.push(v)
    }
    if (cur) records.push(cur)
    const remoteTag = ':' + port
    for (const r of records) {
      if (!r.names.some(n => n.endsWith(remoteTag))) continue
      if (BROWSER_NAME_RE.test(r.command || '')) return true
    }
    return false
  }

  async function reapVites() {
    const vites = await listVites()
    const now = Date.now()
    const killed = []
    for (const v of vites) {
      let hasClient = false
      for (const port of v.ports) {
        if (await viteHasBrowserClient(port)) { hasClient = true; break }
      }
      if (hasClient) {
        _viteLastClient.set(v.pid, now)
        continue
      }
      if (!_viteLastClient.has(v.pid)) _viteLastClient.set(v.pid, now)
      const idleMs = now - _viteLastClient.get(v.pid)
      const threshold = Math.max(VITE_MIN_IDLE_MS, pressureScaledTimeout(VITE_IDLE_THRESHOLD_MS))
      if (idleMs > threshold) {
        try {
          process.kill(v.pid, 'SIGKILL')
          console.log(`[vite-reaper] killed pid=${v.pid} ports=${v.ports.join(',')} idle=${Math.round(idleMs / 60000)}m pressure=${(getMemoryPressure() * 100).toFixed(0)}%`)
          killed.push({ pid: v.pid, kind: 'vite', ts: now, reason: `idle ${Math.round(idleMs / 60000)}m`, agent: ownerByPid().get(v.pid) || null })
        } catch (e) {
          // Reaper sweep continues after one kill race; process may have exited first.
          console.log(`[vite-reaper] kill pid=${v.pid} failed: ${e.message}`)
        }
        _viteLastClient.delete(v.pid)
      }
    }
    const liveVites = new Set(vites.map(v => v.pid))
    for (const pid of [..._viteLastClient.keys()]) {
      if (!liveVites.has(pid)) _viteLastClient.delete(pid)
    }
    return { vites, killed }
  }

  // ─── Playwright reaper — kill orphan chromium browsers ──────────────
  const PW_IDLE_THRESHOLD_MS = parseInt(process.env.REAPER_PW_MS, 10) || 5 * 60 * 1000
  const _pwLastSeen = new Map()

  async function listPlaywrightBrowsers() {
    let psOut = ''
    try {
      const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,args='], { timeout: 5000, encoding: 'utf8' })
      psOut = stdout
    } catch (e) {
      throw new Error(`listPlaywrightBrowsers ps failed: ${e.message}`)
    }
    const browsers = []
    for (const line of psOut.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) continue
      const pid = parseInt(m[1], 10)
      const ppid = parseInt(m[2], 10)
      const args = m[3]
      if (!isPlaywrightBrowserArgs(args)) continue
      if (args.includes('--type=')) continue
      // Skip the playwright-cli session DAEMON itself (`run-cli-server`). Its
      // --daemon-session path lives under .../ms-playwright/..., so it matches the
      // browser filter above — but it's a node daemon, not a browser. It's detached
      // (ppid=1) so the orphan heuristic always flags it, and killing it orphans
      // the Chrome it owns and closes the session — the recurring "shared browser
      // keeps dying / nobody can use pw" bug. The reaper still reaps real orphan Chrome.
      if (args.includes('run-cli-server')) continue
      // Never reap the canonical `tlda-dev pw` shared browser. It's a launcher-less
      // daemon by design (persists until `tlda pw reap`), so the orphan heuristic
      // always flags it — and under memory pressure the threshold collapses to ~30s,
      // killing it every minute, which strands agents on a blank data: tab.
      if (args.includes('ud-shared-chrome')) continue
      browsers.push({ pid, ppid, args })
    }
    return browsers
  }

  async function isPlaywrightControllerAlive(ppid) {
    if (!ppid || ppid <= 1) return false
    try {
      const { stdout } = await execFileP('ps', ['-p', String(ppid), '-o', 'args='],
        { timeout: 2000, encoding: 'utf8' })
      const args = stdout.trim()
      return args.includes('playwright') || args.includes('node')
    } catch { return false }
  }

  async function reapPlaywright() {
    const browsers = await listPlaywrightBrowsers()
    if (browsers.length === 0) return { browsers: [], killed: [] }
    const now = Date.now()
    const threshold = pressureScaledTimeout(PW_IDLE_THRESHOLD_MS)
    const killed = []
    const enriched = []
    let orphanCount = 0
    for (const b of browsers) {
      const controllerAlive = await isPlaywrightControllerAlive(b.ppid)
      const idleMs = controllerAlive ? 0 : (now - (_pwLastSeen.get(b.pid) || now))
      enriched.push({ pid: b.pid, ppid: b.ppid, controllerAlive, idleMs })
      if (controllerAlive) {
        _pwLastSeen.set(b.pid, now)
        continue
      }
      orphanCount++
      if (!_pwLastSeen.has(b.pid)) _pwLastSeen.set(b.pid, now)
      const orphanMs = now - _pwLastSeen.get(b.pid)
      if (orphanMs > threshold) {
        try {
          process.kill(b.pid, 'SIGKILL')
          try { await execFileP('pkill', ['-9', '-P', String(b.pid)], { timeout: 2000 }) } catch {
            // Child processes may already be gone after killing the browser parent.
          }
          console.log(`[pw-reaper] killed pid=${b.pid} orphan=${Math.round(orphanMs / 1000)}s threshold=${Math.round(threshold / 1000)}s pressure=${(getMemoryPressure() * 100).toFixed(0)}%`)
          killed.push({ pid: b.pid, kind: 'playwright', ts: now, reason: `orphan ${Math.round(orphanMs / 1000)}s`, agent: ownerByPid().get(b.pid) || null })
        } catch (e) {
          // Reaper sweep continues after one kill race; process may have exited first.
          console.log(`[pw-reaper] kill pid=${b.pid} failed: ${e.message}`)
        }
        _pwLastSeen.delete(b.pid)
      } else {
        console.log(`[pw-reaper] orphan pid=${b.pid} age=${Math.round(orphanMs / 1000)}s waiting (threshold=${Math.round(threshold / 1000)}s)`)
      }
    }
    const livePids = new Set(browsers.map(b => b.pid))
    for (const pid of [..._pwLastSeen.keys()]) {
      if (!livePids.has(pid)) _pwLastSeen.delete(pid)
    }
    return { browsers: enriched, killed }
  }

  // ─── Combined reaper sweep with status broadcast ──────────────────
  let _reaperTimer = null
  let _sweepCount = 0
  const _recentKills = []  // last 10 kills across sweeps
  const MAX_RECENT_KILLS = 10

  async function reaperSweep() {
    // Lease expiry is authoritative and ordered: park tabs, then close an empty
    // pooled session, then kill an expired preview. Heuristic scans below still
    // classify legacy processes explicitly rather than pretending they are leased.
    const due = expiredLeases()
    const leaseActions = []
    for (const lease of due) {
      const meta = lease.metadata || {}
      try {
        if (lease.kind === 'playwright-tab') {
          await execFileP('tlda-dev', ['pw', 'release'], { timeout: 20_000, env: { ...process.env, TLDA_PW_AS: lease.owner?.id || '', TLDA_PW_SESSION: meta.session } })
        } else if (lease.kind === 'playwright-session') {
          const hasTabs = listLeases().some(other => other.kind === 'playwright-tab' && other.metadata?.session === meta.session && !other.expired)
          if (hasTabs) continue
          await execFileP('tlda-dev', ['pw', 'reap'], { timeout: 20_000, env: { ...process.env, TLDA_PW_SESSION: meta.session } })
        } else if (lease.kind === 'preview-server' && (Number.isInteger(meta.pid) || Number.isInteger(meta.daemon_pid))) {
          for (const pid of [meta.pid, meta.daemon_pid]) {
            if (!Number.isInteger(pid)) continue
            try { process.kill(pid, 'SIGTERM') }
            catch (e) {
              if (e?.code !== 'ESRCH') throw e
            }
          }
        } else continue
        releaseLease(lease.resource_id)
        leaseActions.push({ kind: lease.kind, resource_id: lease.resource_id, action: lease.kind === 'playwright-tab' ? 'parked' : 'killed' })
      } catch (error) {
        // Keep the lease for the next sweep; one dead CLI/process must not block other expiry cleanup.
        console.error(`[lease-reaper] ${lease.resource_id} cleanup failed: ${error.message}`)
      }
    }
    const viteResult = await reapVites().catch(e => { console.error('[vite-reaper] sweep failed:', e.message); return { vites: [], killed: [] } })
    const pwResult = await reapPlaywright().catch(e => { console.error('[pw-reaper] sweep failed:', e.message); return { browsers: [], killed: [] } })
    // Preview-dir reaper — reclaim orphaned tlda-dev preview data dirs (dead
    // process + non-today mtime), so 32GB of fleet.db copies + projects never
    // re-accumulates from previews that died without a clean `stop`.
    let previewDirResult
    try { previewDirResult = sweepOrphanPreviewDirs() }
    catch (e) { console.error('[preview-dir-reaper] sweep failed:', e.message); previewDirResult = { swept: [], kept: [] } }
    for (const b of previewDirResult.swept) console.log(`[preview-dir-reaper] swept orphaned preview dir: ${b}`)
    _sweepCount++

    const allKills = [...(viteResult.killed || []), ...(pwResult.killed || [])]
    _recentKills.push(...allKills)
    while (_recentKills.length > MAX_RECENT_KILLS) _recentKills.shift()

    const now = Date.now()
    const pressure = getMemoryPressure()
    const cpu = cpuPressureSnapshot()

    // Label each resource from its lease owner. A vite server with no lease
    // still gets its worktree name, which is a property of the process's own
    // cwd rather than a claim about who is using it.
    const owners = ownerByPid()
    const viteWorktrees = await Promise.all((viteResult.vites || []).map(v => attributeViteByCwd(v.pid)))

    const viteSnap = (viteResult.vites || []).map((v, i) => ({
      pid: v.pid,
      ports: v.ports,
      hasClient: _viteLastClient.has(v.pid) && (now - _viteLastClient.get(v.pid)) < 1000,
      idleMs: _viteLastClient.has(v.pid) ? now - _viteLastClient.get(v.pid) : 0,
      agent: owners.get(v.pid) || viteWorktrees[i] || null,
      agentId: owners.get(v.pid) || null,
    }))

    // The reaper is also the renewer for long-lived server/session leases.
    // Tabs deliberately renew only through their owner's wrapper activity.
    for (const lease of listLeases().filter(l => !l.expired && l.kind !== 'playwright-tab')) {
      const pid = lease.metadata?.pid
      const alive = Number.isInteger(pid) && (() => { try { process.kill(pid, 0); return true } catch { return false } })()
      if (alive) renewLease(lease.resource_id)
    }
    const leases = listLeases()
    const leasedPids = new Set(leases.map(l => l.metadata?.pid).filter(Number.isInteger))
    const unleased = [
      ...(viteResult.vites || []).filter(v => !leasedPids.has(v.pid)).map(v => ({ kind: 'vite/legacy', pid: v.pid, detail: `ports ${v.ports.join(',')}` })),
      ...(pwResult.browsers || []).filter(b => !leasedPids.has(b.pid)).map(b => ({ kind: 'playwright/legacy', pid: b.pid, detail: 'not represented by lease authority' })),
    ]
    const status = {
        pressure,
        ...cpu,
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        vites: viteSnap,
        browsers: (pwResult.browsers || []).map(b => ({
          ...b,
          agent: owners.get(b.pid) || null,
          agentId: owners.get(b.pid) || null,
        })),
        lastKills: _recentKills.slice(),
        leases,
        unleased,
        leaseActions,
        thresholds: { viteMs: VITE_IDLE_THRESHOLD_MS, pwMs: PW_IDLE_THRESHOLD_MS },
        scaledThresholds: { viteMs: pressureScaledTimeout(VITE_IDLE_THRESHOLD_MS), pwMs: pressureScaledTimeout(PW_IDLE_THRESHOLD_MS) },
        sweepCount: _sweepCount,
        lastSweep: now,
      }
    status.markdownReport = formatReaperMarkdownReport(status)
    sendMsg({ type: 'reaper-status', data: status })
  }

  function start() {
    if (_reaperTimer) return
    setTimeout(() => {
      reaperSweep()
      _reaperTimer = setInterval(reaperSweep, VITE_SWEEP_INTERVAL_MS)
      _reaperTimer.unref?.()
    }, 10_000)
  }

  // ─── Reaper RPC handlers ──────────────────────────────────────────
  async function rpcKill({ pid }) {
    if (!pid) throw new Error('missing pid')
    const owner = ownerByPid().get(pid) || null
    try {
      process.kill(pid, 'SIGKILL')
      try { await execFileP('pkill', ['-9', '-P', String(pid)], { timeout: 2000 }) } catch {
        // Child cleanup is advisory after the requested process was killed.
      }
      _recentKills.push({ pid, kind: 'manual', ts: Date.now(), reason: 'manual kill', agent: owner })
      while (_recentKills.length > MAX_RECENT_KILLS) _recentKills.shift()
      return { killed: true, pid }
    } catch (e) {
      return { killed: false, error: e.message }
    }
  }

  async function rpcSweep() {
    await reaperSweep()
    return { ok: true, sweepCount: _sweepCount }
  }


  return {
    start,
    sweep: reaperSweep,
    rpcKill,
    rpcSweep,
  }
}
