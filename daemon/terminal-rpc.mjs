import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  terminalBackscrollCaptureArgs,
  terminalVisibleCaptureArgs,
  trimTerminalSeedBlankRows,
} from '../shared/terminal-seed.mjs'

const execFileP = promisify(execFile)
const SAFE_SESSION_RE = /^[^\s:\x00-\x1f]+$/
const QUEUED_LINE_RE = /^\s*←\s/

function tmuxSessionAlreadyGone(error) {
  const text = `${error?.stderr || ''}\n${error?.stdout || ''}\n${error?.message || ''}`
  return /no server running/i.test(text)
    || /no sessions?/i.test(text)
    || /can't find session/i.test(text)
    || /no session/i.test(text)
}

export function promptAcceptanceInput(acceptKey = '1') {
  if (acceptKey === 'Enter') return { pty: '\r', tmuxKeys: ['Enter'] }
  return { pty: `${acceptKey}\r`, tmuxKeys: [acceptKey, 'Enter'] }
}

export function createTerminalRpc({
  tmuxArgs,
  log,
  sendMsg,
  detectPrompt,
  stripAnsi,
  promptCooldowns,
  surfacedPrompts,
  alivenessCache,
  thinkingSpinnerRe,
  interruptHintRe,
  thinkingScanLines,
  terminalSizePollMs,
  decideTerminalWatchExit,
  ptyModuleImpl = null,
  onArmAgent,
  onArmBySession,
  onEmitAgentStatus,
  onPlanModeSeen,
  onPlanModeGone,
  hasPlanMode,
  resolveAgentRoute,
  validateTmuxOwner,
  resolveTerminalCapability,
  execFileImpl = execFileP,
}) {
  const TMUX_ARGS = tmuxArgs || []
  const TERMINAL_SIZE_POLL_MS = terminalSizePollMs || 5000
  const terminalWatchPtys = new Map()
  let ptyModule = ptyModuleImpl

  function checkSession(session) {
    if (!session || !SAFE_SESSION_RE.test(session)) {
      throw new Error(`unsafe tmux session name: ${session}`)
    }
  }

  function checkTmuxOwner(agentId, sessionId, tmuxSession) {
    if (!agentId || !validateTmuxOwner) return
    const result = validateTmuxOwner({ agentId, sessionId, tmuxSession })
    if (result === false) throw new Error(`tmux endpoint ownership rejected for ${agentId}/${tmuxSession}`)
  }

  function resolveTerminalEndpoint({ agent_id, agentId, terminal_capability, terminalCapability } = {}, { allowUnavailable = false } = {}) {
    const fleetId = agent_id || agentId
    const capability = terminal_capability || terminalCapability
    if (!fleetId || !capability) throw new Error('terminal capability required')
    if (!resolveTerminalCapability) throw new Error('terminal capability resolution unavailable')
    const row = resolveTerminalCapability({ agentId: fleetId, terminalCapability: capability })
    if (!row) throw new Error(`terminal capability unavailable for ${fleetId}`)
    if (!row.tmuxSession || !row.sessionId) {
      if (allowUnavailable) return { unavailable: true, reason: 'terminal already unavailable', agentId: row.id || fleetId }
      throw new Error(`terminal capability unavailable for ${fleetId}`)
    }
    return { tmuxSession: row.tmuxSession, sessionId: row.sessionId, agentId: row.id }
  }

  async function tmux(...args) {
    return execFileImpl('tmux', [...TMUX_ARGS, ...args], {
      timeout: 5000,
      encoding: 'utf8',
      env: { ...process.env, TMUX: '', TMUX_PANE: '' },
    })
  }

  async function autoAcceptPrompt(tmuxSession, reason, acceptKey = '1') {
    try {
      const input = promptAcceptanceInput(acceptKey)
      const ptyState = terminalWatchPtys.get(tmuxSession)
      if (ptyState?.alive) {
        ptyState.pty.write(input.pty)
      } else {
        for (const [index, key] of input.tmuxKeys.entries()) {
          if (index > 0) await new Promise(r => setTimeout(r, 100))
          await tmux('send-keys', '-t', tmuxSession, key)
        }
      }
      log.info(`auto-accepted prompt (${reason}, key=${acceptKey}) in ${tmuxSession}`)
      return true
    } catch (e) {
      log.error(`auto-accept failed in ${tmuxSession}: ${e.message}`)
      return false
    }
  }

  async function rpcSendKey(args = {}) {
    if (!resolveAgentRoute) throw new Error('agent route resolution unavailable')
    const { tmux_session: tmuxSession } = resolveAgentRoute(args)
    const { key } = args
    checkSession(tmuxSession)
    if (!key) throw new Error('missing key')
    onArmBySession(tmuxSession)
    const tmuxKey = key.replace(/^ctrl\+(.)/i, (_, c) => `C-${c}`)
    await tmux('send-keys', '-t', tmuxSession, tmuxKey)
    return { ok: true }
  }

  async function rpcSendText(args = {}) {
    if (!resolveAgentRoute) throw new Error('agent route resolution unavailable')
    const { tmux_session: tmuxSession } = resolveAgentRoute(args)
    const { text, enter, enter_delay_ms } = args
    checkSession(tmuxSession)
    onArmBySession(tmuxSession)
    // A live tmux can still be unable to consume task text. Clear only prompts
    // already classified as safe auto-accepts before injecting the queued text;
    // unknown, permission, and choice prompts remain untouched.
    try {
      const pane = await capturePaneTail(tmuxSession)
      const prompt = detectPrompt(pane)
      if (prompt.type === 'auto-accept') {
        await autoAcceptPrompt(tmuxSession, prompt.reason, prompt.acceptKey)
      }
    } catch {
      // Capture is advisory. Preserve the existing send path when unavailable.
    }
    const pty = terminalWatchPtys.get(tmuxSession)?.alive
      ? terminalWatchPtys.get(tmuxSession).pty
      : null
    if (pty) {
      if (text) pty.write(text)
      if (enter !== false) {
        const delay = Number(enter_delay_ms ?? 120)
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
        await tmux('send-keys', '-t', tmuxSession, 'Enter')
      }
      return { ok: true, via: 'pty' }
    }
    if (text) await tmux('send-keys', '-t', tmuxSession, '--', text)
    if (enter !== false) {
      const delay = Number(enter_delay_ms ?? 120)
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      await tmux('send-keys', '-t', tmuxSession, 'Enter')
    }
    return { ok: true, via: 'tmux' }
  }

  async function gooseKickSend({ tmux_session, text }) {
    checkSession(tmux_session)
    if (text) await tmux('send-keys', '-t', tmux_session, '--', text)
    await new Promise(r => setTimeout(r, 300))
    await tmux('send-keys', '-t', tmux_session, 'Enter')
    return { ok: true, via: 'tmux-sendkeys' }
  }

  async function rpcCapturePane(args = {}) {
    if (!resolveAgentRoute) throw new Error('agent route resolution unavailable')
    const route = resolveAgentRoute(args)
    const tmuxSession = route.tmux_session
    const sessionId = route.session_id
    const agentId = route.agent_id
    const { lines, visible } = args
    checkSession(tmuxSession)
    const captureArgs = visible
      ? terminalVisibleCaptureArgs(tmuxSession, { ansi: true })
      : terminalBackscrollCaptureArgs(tmuxSession, lines, { ansi: true })
    const { stdout } = await execFileImpl('tmux',
      [...TMUX_ARGS, ...captureArgs],
      { timeout: 5000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    const prompt = detectPrompt(stdout)
    if (prompt.type === 'auto-accept') {
      const lastAction = promptCooldowns.get(tmuxSession)
      if (!lastAction || Date.now() - lastAction >= 10_000) {
        promptCooldowns.set(tmuxSession, Date.now())
        autoAcceptPrompt(tmuxSession, prompt.reason, prompt.acceptKey)
        if (agentId) sendMsg({ type: 'prompt-auto-accepted', agent_id: agentId, reason: prompt.reason, ts: new Date().toISOString() })
      }
    } else if (prompt.type === 'surface' && agentId) {
      if (surfacedPrompts.get(tmuxSession) !== prompt.reason) {
        surfacedPrompts.set(tmuxSession, prompt.reason)
        sendMsg({ type: 'terminal_attention', agent_id: agentId, text: prompt.reason, reason: prompt.reason, snippet: prompt.snippet || null })
      }
    } else {
      surfacedPrompts.delete(tmuxSession)
    }
    return { ok: true, pane: stdout }
  }

  async function capturePaneTail(tmux_session, lines = 50) {
    const cap = await execFileImpl('tmux',
      [...TMUX_ARGS, ...terminalBackscrollCaptureArgs(tmux_session, lines)],
      { timeout: 3000, encoding: 'utf8' })
    return cap.stdout
  }

  function paneIsWorking(pane) {
    const tail = pane.split('\n').slice(-thinkingScanLines).join('\n')
    return thinkingSpinnerRe.test(tail) || interruptHintRe.test(tail)
  }

  async function rpcInterrupt(args = {}) {
    if (!resolveAgentRoute) throw new Error('agent route resolution unavailable')
    const { tmux_session: tmuxSession } = resolveAgentRoute(args)
    checkSession(tmuxSession)
    try { await tmux('send-keys', '-t', tmuxSession, 'Escape') } catch {
      // Interrupt is best-effort; the capture loop below reports whether it stopped.
    }
    let stopped = false
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 1200))
      let pane = ''
      try { pane = await capturePaneTail(tmuxSession) } catch {
        // Missing capture means no proof of ongoing work; keep trying escape.
      }
      if (!paneIsWorking(pane)) { stopped = true; break }
      try { await tmux('send-keys', '-t', tmuxSession, 'Escape') } catch {
        // Repeated escape is best-effort; stopped=false reports remaining uncertainty.
      }
    }
    return { ok: true, stopped }
  }

  function pendingQueuedIdx(lines) {
    let s = -1
    for (let i = lines.length - 1; i >= 0; i--) { if (thinkingSpinnerRe.test(lines[i])) { s = i; break } }
    if (s < 0) return -1
    for (let i = s + 1; i < lines.length; i++) if (QUEUED_LINE_RE.test(lines[i])) return i
    return -1
  }

  async function rpcSoftInterrupt(args = {}) {
    const { tmuxSession, agentId } = resolveTerminalEndpoint(args)
    checkSession(tmuxSession)
    if (agentId) onArmAgent(agentId); else onArmBySession(tmuxSession)
    let pane = ''
    try { pane = await capturePaneTail(tmuxSession) } catch {
      // Missing capture means there is no queued prompt to promote.
    }
    let lines = pane.split('\n').slice(-thinkingScanLines)
    if (!paneIsWorking(pane) || pendingQueuedIdx(lines) < 0) {
      return { ok: true, promoted: false, reason: 'nothing-queued' }
    }
    try { await tmux('send-keys', '-t', tmuxSession, 'Escape') } catch {
      // Soft interrupt is best-effort; queued-state polling below determines result.
    }
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 700))
      try { pane = await capturePaneTail(tmuxSession) } catch {
        // Missing capture leaves the queued state unknown for this iteration.
      }
      lines = pane.split('\n').slice(-thinkingScanLines)
      if (pendingQueuedIdx(lines) < 0) return { ok: true, promoted: true }
    }
    return { ok: true, promoted: false, reason: 'timeout' }
  }

  async function rpcListSessions() {
    try {
      const { stdout } = await tmux('list-sessions', '-F', '#{session_name}')
      return { ok: true, sessions: stdout.trim().split('\n').filter(Boolean) }
    } catch (e) {
      if (/no server running|no sessions/i.test(e.stderr || '')) return { ok: true, sessions: [] }
      throw e
    }
  }

  async function rpcCheckAlive(args = {}) {
    const { tmuxSession } = resolveTerminalEndpoint(args)
    if (!tmuxSession) return { alive: false }
    const cached = alivenessCache.get(tmuxSession)
    if (cached !== undefined) return { alive: cached }
    try {
      const r = await rpcListSessions()
      const alive = (r.sessions || []).includes(tmuxSession)
      alivenessCache.set(tmuxSession, alive)
      return { alive }
    } catch {
      return { alive: true }
    }
  }

  async function rpcKillSession(args = {}) {
    const { tmuxSession, agentId, unavailable, reason } = resolveTerminalEndpoint(args, { allowUnavailable: true })
    if (unavailable) {
      if (agentId) onEmitAgentStatus(agentId, 'hibernating')
      return { ok: true, already_unavailable: true, reason }
    }
    checkSession(tmuxSession)
    try {
      await tmux('kill-session', '-t', tmuxSession)
    } catch (e) {
      if (!tmuxSessionAlreadyGone(e)) throw e
      if (agentId) onEmitAgentStatus(agentId, 'hibernating')
      alivenessCache.set(tmuxSession, false)
      return { ok: true, already_unavailable: true, reason: 'tmux session already absent' }
    }
    if (agentId) onEmitAgentStatus(agentId, 'hibernating')
    alivenessCache.set(tmuxSession, false)
    return { ok: true }
  }

  async function getPty() {
    if (!ptyModule) {
      try {
        const mod = await import('node-pty')
        ptyModule = mod.default || mod
      } catch (e) { throw new Error('node-pty not available: ' + e.message) }
    }
    return ptyModule
  }

  function detectPromptFromPty(agentId, tmuxSession, state) {
    const result = detectPrompt(state.recentOutput)
    if (result.type === 'auto-accept') {
      const lastAccept = promptCooldowns.get(tmuxSession)
      if (lastAccept && Date.now() - lastAccept < 10_000) return
      promptCooldowns.set(tmuxSession, Date.now())
      state.lastPromptSurfaced = ''
      if (state.alive) {
        const acceptKey = result.acceptKey || '1'
        state.pty.write(`${acceptKey}\r`)
        log.info(`pty auto-accepted prompt (${result.reason}, key=${acceptKey}) in ${tmuxSession}`)
        sendMsg({ type: 'prompt-auto-accepted', agent_id: agentId, reason: result.reason, ts: new Date().toISOString() })
      }
    } else if (result.type === 'surface') {
      if (state.lastPromptSurfaced === result.reason) return
      state.lastPromptSurfaced = result.reason
      log.info(`pty surfacing prompt for ${agentId}: ${result.reason}`)
      sendMsg({ type: 'terminal_attention', agent_id: agentId, text: result.reason, reason: result.reason, snippet: result.snippet || null })
    } else {
      state.lastPromptSurfaced = ''
    }
    if (state.recentOutput.includes("Here is Claude's plan") && state.recentOutput.includes('Would you like to')) {
      if (!hasPlanMode(agentId)) onPlanModeSeen(agentId)
    } else {
      onPlanModeGone(agentId)
    }
  }

  async function sendTerminalSnapshot(agentId, tmuxSession, state) {
    try {
      const { stdout } = await execFileImpl('tmux',
        [...TMUX_ARGS, ...terminalVisibleCaptureArgs(tmuxSession)],
        { timeout: 3000, encoding: 'utf8' })
      const snapshot = trimTerminalSeedBlankRows(stdout).replace(/\n/g, '\r\n')
      if (snapshot.trim()) {
        sendMsg({
          type: 'terminal-data',
          agent_id: agentId,
          data: Buffer.from(snapshot).toString('base64'),
        })
        state.recentOutput = stripAnsi(snapshot).slice(-4000)
        detectPromptFromPty(agentId, tmuxSession, state)
      }
    } catch (e) {
      // Initial snapshot is optional; live PTY data follows after attach.
      log.warn(`terminal-watch: initial capture failed for ${tmuxSession}: ${e?.message || e}`)
    }
  }

  async function queryWindowSize(tmux_session) {
    try {
      const { stdout } = await tmux('display-message', '-p', '-t', tmux_session, '#{window_width} #{window_height}')
      const [w, h] = stdout.trim().split(/\s+/).map(n => parseInt(n, 10))
      if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) return { cols: w, rows: h }
    } catch {
      // Size probing is optional; terminal watch falls back to its pinned dimensions.
    }
    return null
  }

  async function tmuxPaneIsLive(tmux_session) {
    try {
      const { stdout } = await tmux('display-message', '-p', '-t', tmux_session, '#{pane_dead}')
      return stdout.trim() === '0'
    } catch {
      // A failed probe is not evidence that the pane died. Treat it as unknown
      // so a transient tmux routing failure cannot erase a live terminal.
      return null
    }
  }

  async function rpcStartTerminalWatch(args = {}) {
    const { tmuxSession, agentId } = resolveTerminalEndpoint(args)
    checkSession(tmuxSession)
    {
      const existing = terminalWatchPtys.get(tmuxSession)
      if (existing) {
        sendMsg({ type: 'terminal-size', agent_id: agentId, cols: existing.cols, rows: existing.rows })
        await sendTerminalSnapshot(agentId, tmuxSession, existing)
        return { ok: true, already: true, cols: existing.cols, rows: existing.rows }
      }
    }

    try { await execFileImpl('tmux', [...TMUX_ARGS, 'set-option', '-t', tmuxSession, 'status', 'off'], { timeout: 3000 }) } catch {
      // Hiding tmux status is cosmetic; terminal streaming still works.
    }

    const PINNED_COLS = 120, PINNED_ROWS = 40
    try {
      await execFileImpl('tmux', [...TMUX_ARGS, 'set-option', '-t', tmuxSession, 'window-size', 'manual'], { timeout: 3000 })
      await execFileImpl('tmux', [...TMUX_ARGS, 'resize-window', '-t', tmuxSession, '-x', String(PINNED_COLS), '-y', String(PINNED_ROWS)], { timeout: 3000 })
    } catch (e) {
      // Pinning improves stable rendering; existing tmux size remains usable.
      log.warn(`terminal-watch: failed to pin window for ${tmuxSession}: ${e?.message || e}`)
    }

    const size = await queryWindowSize(tmuxSession) || { cols: PINNED_COLS, rows: PINNED_ROWS }
    const nodePty = await getPty()
    const pty = nodePty.spawn('tmux', [...TMUX_ARGS, 'attach-session', '-t', tmuxSession], {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      env: { ...process.env, TERM: 'xterm-256color', TMUX: '', TMUX_PANE: '' },
    })

    const state = { pty, alive: true, recentOutput: '', lastPromptSurfaced: '', cols: size.cols, rows: size.rows, sizePoll: null }
    terminalWatchPtys.set(tmuxSession, state)

    sendMsg({ type: 'terminal-size', agent_id: agentId, cols: size.cols, rows: size.rows })
    await sendTerminalSnapshot(agentId, tmuxSession, state)

    state.sizePoll = setInterval(async () => {
      if (!state.alive) return
      const cur = await queryWindowSize(tmuxSession)
      if (!cur || (cur.cols === state.cols && cur.rows === state.rows)) return
      state.cols = cur.cols
      state.rows = cur.rows
      try { state.pty.resize(Math.max(1, cur.cols), Math.max(1, cur.rows)) } catch {
        // Resize failures are transient; next poll can retry.
      }
      sendMsg({ type: 'terminal-size', agent_id: agentId, cols: cur.cols, rows: cur.rows })
    }, TERMINAL_SIZE_POLL_MS)

    pty.onData((data) => {
      if (!state.alive) return
      sendMsg({
        type: 'terminal-data',
        agent_id: agentId,
        data: Buffer.from(data).toString('base64'),
      })
      state.recentOutput += stripAnsi(data)
      if (state.recentOutput.length > 8000) state.recentOutput = state.recentOutput.slice(-4000)
      detectPromptFromPty(agentId, tmuxSession, state)
    })

    pty.onExit(({ exitCode }) => {
      state.alive = false
      if (state.sizePoll) { clearInterval(state.sizePoll); state.sizePoll = null }
      terminalWatchPtys.delete(tmuxSession)
      void (async () => {
        const decision = decideTerminalWatchExit({ paneLive: await tmuxPaneIsLive(tmuxSession) })
        if (!decision.terminalDead) {
          log.warn(`terminal-watch exited without positive pane-death evidence: agent=${agentId} exitCode=${exitCode}; suppressing terminal-dead`)
          return
        }
        log.info(`terminal exited: agent=${agentId} exitCode=${exitCode}`)
        sendMsg({ type: 'terminal-dead', agent_id: agentId, exitCode })
      })()
    })

    return { ok: true, streaming: true, cols: size.cols, rows: size.rows }
  }

  function rpcStopTerminalWatch(args = {}) {
    const { tmuxSession } = resolveTerminalEndpoint(args)
    checkSession(tmuxSession)
    const state = terminalWatchPtys.get(tmuxSession)
    if (!state) return { ok: true, already: true }
    state.alive = false
    if (state.sizePoll) { clearInterval(state.sizePoll); state.sizePoll = null }
    try { state.pty.kill() } catch {
      // PTY may already be closed by its exit handler.
    }
    terminalWatchPtys.delete(tmuxSession)
    return { ok: true }
  }

  async function rpcTerminalResize(args = {}) {
    const { tmuxSession } = resolveTerminalEndpoint(args)
    checkSession(tmuxSession)
    const state = terminalWatchPtys.get(tmuxSession)
    if (!state || !state.alive) return { ok: false, reason: 'no active pty' }
    const size = await queryWindowSize(tmuxSession)
    const target = size || { cols: state.cols, rows: state.rows }
    state.cols = target.cols
    state.rows = target.rows
    try {
      state.pty.resize(Math.max(1, target.cols), Math.max(1, target.rows))
    } catch (e) {
      // Resize failure is reported but should not close the watch.
      log.warn(`terminal-watch: failed to resize watcher PTY for ${tmuxSession}: ${e?.message || e}`)
    }
    return { ok: true, cols: target.cols, rows: target.rows }
  }

  function rpcTerminalInput(args = {}) {
    const { tmuxSession } = resolveTerminalEndpoint(args)
    const { data } = args
    checkSession(tmuxSession)
    const state = terminalWatchPtys.get(tmuxSession)
    if (!state || !state.alive) return { ok: false, reason: 'no active pty' }
    state.pty.write(data)
    return { ok: true }
  }

  function hasActiveWatch(tmuxSession) {
    return !!terminalWatchPtys.get(tmuxSession)?.alive
  }

  function stopAllTerminalWatches() {
    for (const [, s] of terminalWatchPtys) {
      s.alive = false
      if (s.sizePoll) { clearInterval(s.sizePoll); s.sizePoll = null }
      try { s.pty.kill() } catch {
        // PTY may already be closed while stopping all watches.
      }
    }
    terminalWatchPtys.clear()
  }

  return {
    autoAcceptPrompt,
    checkAlive: rpcCheckAlive,
    checkSession,
    gooseKickSend,
    hasActiveWatch,
    handlers: {
      'send-key': rpcSendKey,
      'send-text': rpcSendText,
      'capture-pane': rpcCapturePane,
      'interrupt': rpcInterrupt,
      'soft-interrupt': rpcSoftInterrupt,
      'check-alive': rpcCheckAlive,
      'list-sessions': rpcListSessions,
      'kill-session': rpcKillSession,
      'start-terminal-watch': rpcStartTerminalWatch,
      'stop-terminal-watch': rpcStopTerminalWatch,
      'terminal-resize': rpcTerminalResize,
      'terminal-input': rpcTerminalInput,
    },
    listSessions: rpcListSessions,
    stopAllTerminalWatches,
    tmux,
  }
}
