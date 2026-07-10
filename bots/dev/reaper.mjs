import { execFile } from 'child_process'
import os from 'os'
import { promisify } from 'util'

import {
  isPlaywrightBrowserArgs,
  selectOrphanAgentProcesses,
} from '../../agent-runtime/daemon-guards.mjs'

const execFileP = promisify(execFile)

export function formatReaperMarkdownReport(status = {}) {
  if (!status || status.error) return '## Dev Reaper\n\nNo reaper status is available yet.'
  const pct = Number.isFinite(status.pressure) ? Math.round(status.pressure * 100) : null
  const lines = [
    '## Dev Reaper',
    '',
    'Memory pressure: ' + (pct === null ? 'unknown' : pct + '%'),
    'Sweep: #' + (status.sweepCount ?? '-'),
    '',
    '| Kind | Count | Notes |',
    '| --- | ---: | --- |',
    '| Vite servers | ' + (status.vites?.length ?? 0) + ' | ' + (status.vites?.filter(v => !v.hasClient).length ?? 0) + ' without browser clients |',
    '| Playwright browsers | ' + (status.browsers?.length ?? 0) + ' | ' + (status.browsers?.filter(b => !b.controllerAlive).length ?? 0) + ' orphan candidates |',
    '| Agent processes | ' + (status.agentProcesses?.length ?? 0) + ' | ' + (status.agentProcessSkippedCount ?? 0) + ' skipped as protected/recent |',
  ]
  if (status.lastKills?.length) {
    lines.push('', '### Recent Kills', '', '| PID | Kind | Agent | Reason |', '| ---: | --- | --- | --- |')
    for (const kill of status.lastKills.slice(-10).reverse()) {
      const reason = String(kill.reason ?? '').replace(/\|/g, '\\|')
      lines.push('| ' + (kill.pid ?? '-') + ' | ' + (kill.kind ?? '-') + ' | ' + (kill.agent ?? '-') + ' | ' + reason + ' |')
    }
  }
  return lines.join('\n')
}

export function createDevReaper({ getAgents, tmuxArgs = [], sendMsg = () => {} } = {}) {
  const currentAgents = () => getAgents?.() || []
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
  
  // ─── Process → agent attribution ───────────────────────────────────
  // Walk up the ppid chain to find a `claude` process. Extract --resume
  // session ID or tmux session name, match against the agent list.
  
  async function getProcessInfo(pid) {
    try {
      const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'pid=,ppid=,args='],
        { timeout: 2000, encoding: 'utf8' })
      const m = stdout.trim().match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) return null
      return { pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), args: m[3] }
    } catch { return null }
  }
  
  async function attributeToAgent(pid) {
    let cur = pid
    const visited = new Set()
    for (let depth = 0; depth < 10; depth++) {
      if (visited.has(cur) || cur <= 1) break
      visited.add(cur)
      const info = await getProcessInfo(cur)
      if (!info) break
      if (info.args.includes('claude') && !info.args.includes('playwright')) {
        const resumeMatch = info.args.match(/--resume\s+([a-f0-9-]+)/)
        if (resumeMatch) {
          const sessionId = resumeMatch[1]
          const agent = currentAgents().find(a => a.session_id === sessionId)
          if (agent) return { id: agent.id, name: agent.name || agent.id.slice(0, 8) }
        }
        const agentByTmux = currentAgents().find(a => a.tmux_session && info.args.includes(a.tmux_session))
        if (agentByTmux) return { id: agentByTmux.id, name: agentByTmux.name || agentByTmux.id.slice(0, 8) }
      }
      cur = info.ppid
    }
    return null
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
    } catch {}
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
    } catch { return [] }
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
          const attr = await attributeToAgent(v.pid).catch(() => null)
          killed.push({ pid: v.pid, kind: 'vite', ts: now, reason: `idle ${Math.round(idleMs / 60000)}m`, agent: attr?.name || null })
        } catch (e) {
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
    } catch { return [] }
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
          try { await execFileP('pkill', ['-9', '-P', String(b.pid)], { timeout: 2000 }) } catch {}
          console.log(`[pw-reaper] killed pid=${b.pid} orphan=${Math.round(orphanMs / 1000)}s threshold=${Math.round(threshold / 1000)}s pressure=${(getMemoryPressure() * 100).toFixed(0)}%`)
          const attr = await attributeToAgent(b.pid).catch(() => null)
          killed.push({ pid: b.pid, kind: 'playwright', ts: now, reason: `orphan ${Math.round(orphanMs / 1000)}s`, agent: attr?.name || null })
        } catch (e) {
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
  
  // ─── Agent-process reaper — kill orphaned harness runtimes ─────────
  const AGENT_PROCESS_ORPHAN_MS = parseInt(process.env.REAPER_AGENT_PROCESS_MS, 10) || 30 * 60 * 1000
  const AGENT_PROCESS_TERM_GRACE_MS = parseInt(process.env.REAPER_AGENT_PROCESS_TERM_GRACE_MS, 10) || 5000
  
  async function listAgentHarnessProcesses() {
    let psOut = ''
    try {
      const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,etimes=,args='], { timeout: 5000, encoding: 'utf8' })
      psOut = stdout
    } catch {
      return []
    }
    const now = Date.now()
    const procs = []
    for (const line of psOut.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) continue
      const pid = parseInt(m[1], 10)
      const ppid = parseInt(m[2], 10)
      const ageSeconds = parseInt(m[3], 10)
      if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(ageSeconds)) continue
      procs.push({ pid, ppid, ageMs: ageSeconds * 1000, startedAt: now - ageSeconds * 1000, args: m[4] })
    }
    return procs
  }
  
  async function liveTmuxSessionNames() {
    try {
      const { stdout } = await execFileP('tmux', [...tmuxArgs, 'list-sessions', '-F', '#S'], { timeout: 3000, encoding: 'utf8' })
      return new Set(stdout.split('\n').map(s => s.trim()).filter(Boolean))
    } catch {
      return new Set()
    }
  }
  
  async function liveTmuxPaneProcessPids(processes) {
    let paneOut = ''
    try {
      const { stdout } = await execFileP('tmux', [...tmuxArgs, 'list-panes', '-a', '-F', '#{pane_pid}'], { timeout: 3000, encoding: 'utf8' })
      paneOut = stdout
    } catch {
      return new Set()
    }
    const roots = paneOut.split('\n').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite)
    const childrenByPpid = new Map()
    for (const proc of processes) {
      const ppid = Number(proc.ppid)
      if (!Number.isFinite(ppid)) continue
      if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, [])
      childrenByPpid.get(ppid).push(Number(proc.pid))
    }
    const protectedPids = new Set()
    const stack = [...roots]
    while (stack.length) {
      const pid = stack.pop()
      if (protectedPids.has(pid)) continue
      protectedPids.add(pid)
      for (const child of (childrenByPpid.get(pid) || [])) stack.push(child)
    }
    return protectedPids
  }
  
  function processAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  
  async function waitForProcessExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!processAlive(pid)) return true
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return !processAlive(pid)
  }
  
  async function terminateOrphanAgentProcess(proc) {
    try {
      process.kill(proc.pid, 'SIGTERM')
      try { await execFileP('pkill', ['-TERM', '-P', String(proc.pid)], { timeout: 2000 }) } catch {
        // Expected when the harness has no child processes left to signal.
      }
    } catch (e) {
      if (!processAlive(proc.pid)) return { ok: true, signal: 'already-exited' }
      throw e
    }
    if (await waitForProcessExit(proc.pid, AGENT_PROCESS_TERM_GRACE_MS)) return { ok: true, signal: 'SIGTERM' }
    process.kill(proc.pid, 'SIGKILL')
    try { await execFileP('pkill', ['-9', '-P', String(proc.pid)], { timeout: 2000 }) } catch {
      // Expected when the harness has no child processes left to kill.
    }
    return { ok: true, signal: 'SIGKILL' }
  }
  
  async function reapOrphanAgentProcesses() {
    const processes = await listAgentHarnessProcesses()
    const [liveSessions, protectedPids] = await Promise.all([
      liveTmuxSessionNames(),
      liveTmuxPaneProcessPids(processes),
    ])
    const { selected, skipped } = selectOrphanAgentProcesses({
      processes,
      agents: currentAgents(),
      liveTmuxSessions: liveSessions,
      protectedPids,
      minAgeMs: AGENT_PROCESS_ORPHAN_MS,
    })
    const killed = []
    const failed = []
    for (const proc of selected) {
      try {
        const result = await terminateOrphanAgentProcess(proc)
        console.log(`[agent-reaper] killed pid=${proc.pid} agent=${proc.agentName || proc.agentId} harness=${proc.harness} tmux=${proc.tmuxSession || '-'} age=${Math.round(proc.ageMs / 60000)}m signal=${result.signal} pressure=${(getMemoryPressure() * 100).toFixed(0)}%`)
        killed.push({
          pid: proc.pid,
          kind: 'agent-process',
          ts: Date.now(),
          reason: `orphan agent process ${Math.round(proc.ageMs / 60000)}m`,
          agent: proc.agentName || null,
          agentId: proc.agentId || null,
          harness: proc.harness,
          signal: result.signal,
        })
      } catch (e) {
        console.log(`[agent-reaper] kill pid=${proc.pid} agent=${proc.agentName || proc.agentId} failed: ${e.message}`)
        failed.push({
          pid: proc.pid,
          agent: proc.agentName || null,
          agentId: proc.agentId || null,
          error: e.message,
        })
      }
    }
    return {
      processes: selected.map(proc => ({
        pid: proc.pid,
        ppid: proc.ppid,
        ageMs: proc.ageMs,
        harness: proc.harness,
        agent: proc.agentName || null,
        agentId: proc.agentId || null,
        tmuxSession: proc.tmuxSession || null,
      })),
      killed,
      failed,
      skippedCount: skipped.length,
    }
  }
  
  async function getMemoryByAgent() {
    try {
      const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { timeout: 5000, encoding: 'utf8' })
      const procs = []
      for (const line of stdout.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
        if (!m) continue
        const rss = parseInt(m[3], 10) * 1024
        if (rss < 10 * 1024 * 1024) continue
        const comm = m[4].trim().split('/').pop()
        procs.push({ pid: parseInt(m[1], 10), ppid: parseInt(m[2], 10), rss, name: comm })
      }
      const attrs = await Promise.all(procs.map(async p => {
        const match = await attributeToAgent(p.pid).catch(() => null)
        return { ...p, agent: match?.name || null }
      }))
      const groups = new Map()
      for (const p of attrs) {
        const key = p.agent || 'system'
        if (!groups.has(key)) groups.set(key, { agent: key, totalRss: 0, processes: [] })
        const g = groups.get(key)
        g.totalRss += p.rss
        g.processes.push({ name: p.name, rss: p.rss })
      }
      const result = [...groups.values()]
      result.sort((a, b) => b.totalRss - a.totalRss)
      return result
    } catch { return [] }
  }
  
  // ─── Combined reaper sweep with status broadcast ──────────────────
  let _reaperTimer = null
  let _sweepCount = 0
  const _recentKills = []  // last 10 kills across sweeps
  const MAX_RECENT_KILLS = 10
  
  async function reaperSweep() {
    const viteResult = await reapVites().catch(e => { console.error('[vite-reaper] sweep failed:', e.message); return { vites: [], killed: [] } })
    const pwResult = await reapPlaywright().catch(e => { console.error('[pw-reaper] sweep failed:', e.message); return { browsers: [], killed: [] } })
    const agentProcessResult = await reapOrphanAgentProcesses().catch(e => { console.error('[agent-reaper] sweep failed:', e.message); return { processes: [], killed: [], failed: [], skippedCount: 0 } })
    _sweepCount++
  
    const allKills = [...(viteResult.killed || []), ...(pwResult.killed || []), ...(agentProcessResult.killed || [])]
    _recentKills.push(...allKills)
    while (_recentKills.length > MAX_RECENT_KILLS) _recentKills.shift()
  
    const now = Date.now()
    const pressure = getMemoryPressure()
  
    // Attribute processes to agents (in parallel for speed)
    const viteAttrs = await Promise.all((viteResult.vites || []).map(async v => {
      const worktree = await attributeViteByCwd(v.pid)
      const agentMatch = await attributeToAgent(v.pid)
      return { pid: v.pid, agent: agentMatch?.name || worktree || null, agentId: agentMatch?.id || null }
    }))
    const browserAttrs = await Promise.all((pwResult.browsers || []).map(async b => {
      const agentMatch = await attributeToAgent(b.pid)
      return { pid: b.pid, agent: agentMatch?.name || null, agentId: agentMatch?.id || null }
    }))
    const viteAgentMap = Object.fromEntries(viteAttrs.map(a => [a.pid, { agent: a.agent, agentId: a.agentId }]))
    const browserAgentMap = Object.fromEntries(browserAttrs.map(a => [a.pid, { agent: a.agent, agentId: a.agentId }]))
  
    const viteSnap = (viteResult.vites || []).map(v => ({
      pid: v.pid,
      ports: v.ports,
      hasClient: _viteLastClient.has(v.pid) && (now - _viteLastClient.get(v.pid)) < 1000,
      idleMs: _viteLastClient.has(v.pid) ? now - _viteLastClient.get(v.pid) : 0,
      agent: viteAgentMap[v.pid]?.agent || null,
      agentId: viteAgentMap[v.pid]?.agentId || null,
    }))
  
    const memoryByAgent = await getMemoryByAgent().catch(() => [])
  
    const status = {
        pressure,
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        memoryByAgent,
        vites: viteSnap,
        browsers: (pwResult.browsers || []).map(b => ({
          ...b,
          agent: browserAgentMap[b.pid]?.agent || null,
          agentId: browserAgentMap[b.pid]?.agentId || null,
        })),
        agentProcesses: agentProcessResult.processes || [],
        agentProcessFailures: agentProcessResult.failed || [],
        agentProcessSkippedCount: agentProcessResult.skippedCount || 0,
        lastKills: _recentKills.slice(),
        thresholds: { viteMs: VITE_IDLE_THRESHOLD_MS, pwMs: PW_IDLE_THRESHOLD_MS, agentProcessMs: AGENT_PROCESS_ORPHAN_MS },
        scaledThresholds: { viteMs: pressureScaledTimeout(VITE_IDLE_THRESHOLD_MS), pwMs: pressureScaledTimeout(PW_IDLE_THRESHOLD_MS), agentProcessMs: AGENT_PROCESS_ORPHAN_MS },
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
    const attr = await attributeToAgent(pid).catch(() => null)
    try {
      process.kill(pid, 'SIGKILL')
      try { await execFileP('pkill', ['-9', '-P', String(pid)], { timeout: 2000 }) } catch {}
      _recentKills.push({ pid, kind: 'manual', ts: Date.now(), reason: 'manual kill', agent: attr?.name || null })
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
