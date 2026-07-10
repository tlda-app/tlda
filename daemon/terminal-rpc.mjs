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
  onArmAgent,
  onArmBySession,
  onEmitAgentStatus,
  onPlanModeSeen,
  onPlanModeGone,
  hasPlanMode,
}) {
  const TMUX_ARGS = tmuxArgs || []
  const TERMINAL_SIZE_POLL_MS = terminalSizePollMs || 5000
  const terminalWatchPtys = new Map()
  let ptyModule = null

  function checkSession(session) {
    if (!session || !SAFE_SESSION_RE.test(session)) {
      throw new Error(`unsafe tmux session name: ${session}`)
    }
  }

  async function tmux(...args) {
    return execFileP('tmux', [...TMUX_ARGS, ...args], {
      timeout: 5000,
      encoding: 'utf8',
      env: { ...process.env, TMUX: '', TMUX_PANE: '' },
    })
  }

  async function autoAcceptPrompt(tmuxSession, reason, acceptKey = '1') {
    try {
      const ptyState = terminalWatchPtys.get(tmuxSession)
      if (ptyState?.alive) {
        ptyState.pty.write(`${acceptKey}\r`)
      } else {
        await tmux('send-keys', '-t', tmuxSession, acceptKey)
        await new Promise(r => setTimeout(r, 100))
        await tmux('send-keys', '-t', tmuxSession, 'Enter')
      }
      log.info(`auto-accepted prompt (${reason}, key=${acceptKey}) in ${tmuxSession}`)
      return true
    } catch (e) {
      log.error(`auto-accept failed in ${tmuxSession}: ${e.message}`)
      return false
    }
  }

  async function rpcSendKey({ tmux_session, key }) {
    checkSession(tmux_session)
    if (!key) throw new Error('missing key')
    onArmBySession(tmux_session)
    const tmuxKey = key.replace(/^ctrl\+(.)/i, (_, c) => `C-${c}`)
    await tmux('send-keys', '-t', tmux_session, tmuxKey)
    return { ok: true }
  }

  async function rpcSendText({ tmux_session, text, enter, enter_delay_ms }) {
    checkSession(tmux_session)
    onArmBySession(tmux_session)
    const pty = terminalWatchPtys.get(tmux_session)?.alive
      ? terminalWatchPtys.get(tmux_session).pty
      : null
    if (pty) {
      if (text) pty.write(text)
      if (enter !== false) {
        const delay = Number(enter_delay_ms ?? 120)
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
        await tmux('send-keys', '-t', tmux_session, 'Enter')
      }
      return { ok: true, via: 'pty' }
    }
    if (text) await tmux('send-keys', '-t', tmux_session, '--', text)
    if (enter !== false) {
      const delay = Number(enter_delay_ms ?? 120)
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      await tmux('send-keys', '-t', tmux_session, 'Enter')
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

  async function rpcCapturePane({ tmux_session, lines, agent_id, visible }) {
    checkSession(tmux_session)
    const captureArgs = visible
      ? terminalVisibleCaptureArgs(tmux_session, { ansi: true })
      : terminalBackscrollCaptureArgs(tmux_session, lines, { ansi: true })
    const { stdout } = await execFileP('tmux',
      [...TMUX_ARGS, ...captureArgs],
      { timeout: 5000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    const prompt = detectPrompt(stdout)
    if (prompt.type === 'auto-accept') {
      const lastAction = promptCooldowns.get(tmux_session)
      if (!lastAction || Date.now() - lastAction >= 10_000) {
        promptCooldowns.set(tmux_session, Date.now())
        autoAcceptPrompt(tmux_session, prompt.reason, prompt.acceptKey)
        if (agent_id) sendMsg({ type: 'prompt-auto-accepted', agent_id, reason: prompt.reason, ts: new Date().toISOString() })
      }
    } else if (prompt.type === 'surface' && agent_id) {
      if (surfacedPrompts.get(tmux_session) !== prompt.reason) {
        surfacedPrompts.set(tmux_session, prompt.reason)
        sendMsg({ type: 'terminal_attention', agent_id, tmux_session, text: prompt.reason, reason: prompt.reason, snippet: prompt.snippet || null })
      }
    } else {
      surfacedPrompts.delete(tmux_session)
    }
    return { ok: true, pane: stdout }
  }

  async function capturePaneTail(tmux_session, lines = 50) {
    const cap = await execFileP('tmux',
      [...TMUX_ARGS, ...terminalBackscrollCaptureArgs(tmux_session, lines)],
      { timeout: 3000, encoding: 'utf8' })
    return cap.stdout
  }

  function paneIsWorking(pane) {
    const tail = pane.split('\n').slice(-thinkingScanLines).join('\n')
    return thinkingSpinnerRe.test(tail) || interruptHintRe.test(tail)
  }

  async function rpcInterrupt({ tmux_session }) {
    checkSession(tmux_session)
    try { await tmux('send-keys', '-t', tmux_session, 'Escape') } catch {}
    let stopped = false
    for (let i = 0; i < 3; i++) {
      await new Promise(r => setTimeout(r, 1200))
      let pane = ''
      try { pane = await capturePaneTail(tmux_session) } catch {}
      if (!paneIsWorking(pane)) { stopped = true; break }
      try { await tmux('send-keys', '-t', tmux_session, 'Escape') } catch {}
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

  async function rpcSoftInterrupt({ tmux_session, agent_id }) {
    checkSession(tmux_session)
    if (agent_id) onArmAgent(agent_id); else onArmBySession(tmux_session)
    let pane = ''
    try { pane = await capturePaneTail(tmux_session) } catch {}
    let lines = pane.split('\n').slice(-thinkingScanLines)
    if (!paneIsWorking(pane) || pendingQueuedIdx(lines) < 0) {
      return { ok: true, promoted: false, reason: 'nothing-queued' }
    }
    try { await tmux('send-keys', '-t', tmux_session, 'Escape') } catch {}
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 700))
      try { pane = await capturePaneTail(tmux_session) } catch {}
      lines = pane.split('\n').slice(-thinkingScanLines)
      if (pendingQueuedIdx(lines) < 0) return { ok: true, promoted: true }
    }
    return { ok: true, promoted: false, reason: 'timeout' }
  }

  async function rpcListSessions() {
    try {
      const { stdout } = await execFileP('tmux',
        [...TMUX_ARGS, 'list-sessions', '-F', '#{session_name}'],
        { timeout: 3000, encoding: 'utf8' })
      return { ok: true, sessions: stdout.trim().split('\n').filter(Boolean) }
    } catch (e) {
      if (/no server running|no sessions/i.test(e.stderr || '')) return { ok: true, sessions: [] }
      throw e
    }
  }

  async function rpcCheckAlive({ tmux_session }) {
    if (!tmux_session) return { alive: false }
    const cached = alivenessCache.get(tmux_session)
    if (cached !== undefined) return { alive: cached }
    try {
      const r = await rpcListSessions()
      const alive = (r.sessions || []).includes(tmux_session)
      alivenessCache.set(tmux_session, alive)
      return { alive }
    } catch {
      return { alive: true }
    }
  }

  async function rpcKillSession({ tmux_session, agent_id }) {
    if (!tmux_session) throw new Error('missing tmux_session')
    checkSession(tmux_session)
    await tmux('kill-session', '-t', tmux_session)
    if (agent_id) onEmitAgentStatus(agent_id, 'hibernating')
    alivenessCache.set(tmux_session, false)
    return { ok: true, tmux_session }
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
      sendMsg({ type: 'terminal_attention', agent_id: agentId, tmux_session: tmuxSession, text: result.reason, reason: result.reason, snippet: result.snippet || null })
    } else {
      state.lastPromptSurfaced = ''
    }
    if (state.recentOutput.includes("Here is Claude's plan") && state.recentOutput.includes('Would you like to')) {
      if (!hasPlanMode(agentId)) onPlanModeSeen(agentId)
    } else {
      onPlanModeGone(agentId)
    }
  }

  async function queryWindowSize(tmux_session) {
    try {
      const { stdout } = await tmux('display-message', '-p', '-t', tmux_session, '#{window_width} #{window_height}')
      const [w, h] = stdout.trim().split(/\s+/).map(n => parseInt(n, 10))
      if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) return { cols: w, rows: h }
    } catch {}
    return null
  }

  async function tmuxPaneIsLive(tmux_session) {
    try {
      const { stdout } = await tmux('display-message', '-p', '-t', tmux_session, '#{pane_dead}')
      return stdout.trim() === '0'
    } catch {
      return false
    }
  }

  async function rpcStartTerminalWatch({ tmux_session, agent_id }) {
    checkSession(tmux_session)
    {
      const existing = terminalWatchPtys.get(tmux_session)
      if (existing) return { ok: true, already: true, cols: existing.cols, rows: existing.rows }
    }

    try { await execFileP('tmux', [...TMUX_ARGS, 'set-option', '-t', tmux_session, 'status', 'off'], { timeout: 3000 }) } catch {}

    const PINNED_COLS = 120, PINNED_ROWS = 40
    try {
      await execFileP('tmux', [...TMUX_ARGS, 'set-option', '-t', tmux_session, 'window-size', 'manual'], { timeout: 3000 })
      await execFileP('tmux', [...TMUX_ARGS, 'resize-window', '-t', tmux_session, '-x', String(PINNED_COLS), '-y', String(PINNED_ROWS)], { timeout: 3000 })
    } catch (e) { log.warn(`terminal-watch: failed to pin window for ${tmux_session}: ${e?.message || e}`) }

    const size = await queryWindowSize(tmux_session) || { cols: PINNED_COLS, rows: PINNED_ROWS }
    const nodePty = await getPty()
    const pty = nodePty.spawn('tmux', [...TMUX_ARGS, 'attach-session', '-t', tmux_session], {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      env: { ...process.env, TERM: 'xterm-256color', TMUX: '', TMUX_PANE: '' },
    })

    const state = { pty, alive: true, recentOutput: '', lastPromptSurfaced: '', cols: size.cols, rows: size.rows, sizePoll: null }
    terminalWatchPtys.set(tmux_session, state)

    sendMsg({ type: 'terminal-size', agent_id, tmux_session, cols: size.cols, rows: size.rows })
    try {
      const { stdout } = await execFileP('tmux',
        [...TMUX_ARGS, ...terminalVisibleCaptureArgs(tmux_session)],
        { timeout: 3000, encoding: 'utf8' })
      const snapshot = trimTerminalSeedBlankRows(stdout).replace(/\n/g, '\r\n')
      if (snapshot.trim()) {
        sendMsg({
          type: 'terminal-data',
          agent_id,
          tmux_session,
          data: Buffer.from(snapshot).toString('base64'),
        })
        state.recentOutput = stripAnsi(snapshot).slice(-4000)
        detectPromptFromPty(agent_id, tmux_session, state)
      }
    } catch (e) {
      log.warn(`terminal-watch: initial capture failed for ${tmux_session}: ${e?.message || e}`)
    }

    state.sizePoll = setInterval(async () => {
      if (!state.alive) return
      const cur = await queryWindowSize(tmux_session)
      if (!cur || (cur.cols === state.cols && cur.rows === state.rows)) return
      state.cols = cur.cols
      state.rows = cur.rows
      try { state.pty.resize(Math.max(1, cur.cols), Math.max(1, cur.rows)) } catch {}
      sendMsg({ type: 'terminal-size', agent_id, tmux_session, cols: cur.cols, rows: cur.rows })
    }, TERMINAL_SIZE_POLL_MS)

    pty.onData((data) => {
      if (!state.alive) return
      sendMsg({
        type: 'terminal-data',
        agent_id,
        tmux_session,
        data: Buffer.from(data).toString('base64'),
      })
      state.recentOutput += stripAnsi(data)
      if (state.recentOutput.length > 8000) state.recentOutput = state.recentOutput.slice(-4000)
      detectPromptFromPty(agent_id, tmux_session, state)
    })

    pty.onExit(({ exitCode }) => {
      state.alive = false
      if (state.sizePoll) { clearInterval(state.sizePoll); state.sizePoll = null }
      terminalWatchPtys.delete(tmux_session)
      void (async () => {
        const decision = decideTerminalWatchExit({ paneLive: await tmuxPaneIsLive(tmux_session) })
        if (!decision.terminalDead) {
          log.warn(`terminal-watch exited while pane is still live: agent=${agent_id} session=${tmux_session} exitCode=${exitCode}; suppressing terminal-dead`)
          return
        }
        log.info(`terminal exited: agent=${agent_id} session=${tmux_session} exitCode=${exitCode}`)
        sendMsg({ type: 'terminal-dead', agent_id, tmux_session, exitCode })
      })()
    })

    return { ok: true, streaming: true, cols: size.cols, rows: size.rows }
  }

  function rpcStopTerminalWatch({ tmux_session }) {
    const state = terminalWatchPtys.get(tmux_session)
    if (!state) return { ok: true, already: true }
    state.alive = false
    if (state.sizePoll) { clearInterval(state.sizePoll); state.sizePoll = null }
    try { state.pty.kill() } catch {}
    terminalWatchPtys.delete(tmux_session)
    return { ok: true }
  }

  async function rpcTerminalResize({ tmux_session }) {
    checkSession(tmux_session)
    const state = terminalWatchPtys.get(tmux_session)
    if (!state || !state.alive) return { ok: false, reason: 'no active pty' }
    const size = await queryWindowSize(tmux_session)
    const target = size || { cols: state.cols, rows: state.rows }
    state.cols = target.cols
    state.rows = target.rows
    try {
      state.pty.resize(Math.max(1, target.cols), Math.max(1, target.rows))
    } catch (e) {
      log.warn(`terminal-watch: failed to resize watcher PTY for ${tmux_session}: ${e?.message || e}`)
    }
    return { ok: true, cols: target.cols, rows: target.rows }
  }

  function rpcTerminalInput({ tmux_session, data }) {
    checkSession(tmux_session)
    const state = terminalWatchPtys.get(tmux_session)
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
      try { s.pty.kill() } catch {}
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
