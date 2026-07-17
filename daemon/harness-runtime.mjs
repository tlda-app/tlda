import { execFile } from 'child_process'
import { promisify } from 'util'
import { parseCodexLine, parseCodexRecord } from '../agent-runtime/codex-activity.mjs'
import { harnessKindForAgent } from '../agent-runtime/daemon-guards.mjs'
import { resolveTranscript } from '../agent-runtime/resolve-transcript.mjs'
import { extractActivityEvents, parseSessionLine, parseSessionRecord } from './activity-events.mjs'

const execFileP = promisify(execFile)

export function createHarnessRuntime({ tmuxArgs = [], log }) {
  const TMUX_ARGS = tmuxArgs || []
  const lifecycleByTuple = new Map()

  async function findRuntimePidForAgent(agent, kind) {
    const adapter = harnessAdapters[kind]
    if (!adapter) return null
    if (!agent?.tmux_session) return null
    let paneOut = ''
    try {
      ;({ stdout: paneOut } = await execFileP('tmux',
        [...TMUX_ARGS, 'list-panes', '-t', agent.tmux_session, '-F', '#{pane_pid}'],
        { timeout: 3000, encoding: 'utf8' }))
    } catch {
      return null
    }
    const panePids = paneOut.trim().split('\n').filter(Boolean)
    if (!panePids.length) return null

    let psOut = ''
    try {
      ;({ stdout: psOut } = await execFileP('ps', ['-eo', 'pid,ppid,args'],
        { timeout: 5000, encoding: 'utf8' }))
    } catch {
      return null
    }

    const childrenByPpid = new Map()
    const runtimePids = new Set()
    for (const line of psOut.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) continue
      const [, pid, ppid, args] = m
      if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, [])
      childrenByPpid.get(ppid).push(pid)
      if (adapter.processRe.test(args)) runtimePids.add(pid)
    }

    const stack = [...panePids]
    const seen = new Set()
    while (stack.length) {
      const pid = stack.pop()
      if (seen.has(pid)) continue
      seen.add(pid)
      if (runtimePids.has(pid)) return pid
      for (const child of (childrenByPpid.get(pid) || [])) stack.push(child)
    }
    return null
  }

  async function resolveCodexJsonl(agent) {
    const pid = await findRuntimePidForAgent(agent, 'codex')
    if (!pid) return null
    const launchTs = Date.parse(agent.registered_at || agent.last_seen || '') || 0
    return resolveTranscript({ pid, kind: 'codex', agent, launchTs })
  }

  const harnessAdapters = {
    claude: {
      kind: 'claude',
      processRe: /(?:^|\s|[/\\])claude(?:\.exe)?(?:\s|$)/,
      activity: {
        kind: 'claude',
        parseLine: parseSessionLine,
        parseRecord: parseSessionRecord,
        usesClaudeSessionIds: true,
        backfillSearch: true,
        terminalChat: true,
      },
    },
    codex: {
      kind: 'codex',
      processRe: /(?:^|\s|[/\\])codex(?:\.exe)?(?:\s|$)/,
      activity: {
        kind: 'codex',
        parseLine: parseCodexLine,
        parseRecord: parseCodexRecord,
        resolveJsonl: resolveCodexJsonl,
        usesClaudeSessionIds: false,
        backfillSearch: false,
        terminalChat: false,
      },
    },
    goose: {
      kind: 'goose',
      processRe: /(?:^|\s|[/\\])goose(?:\.exe)?(?:\s|$).*?\brun\b|\bgoose(?:\.exe)? run\b/,
      activity: {
        kind: 'goose',
        source: 'sqlite',
        usesClaudeSessionIds: false,
        backfillSearch: false,
        terminalChat: false,
      },
    },
  }

  function harnessForAgent(agent) {
    const kind = harnessKindForAgent(agent, log)
    const adapter = harnessAdapters[kind]
    if (!adapter) throw new Error(`unknown harness kind "${kind}" for ${agent?.friendly_name || agent?.id}`)
    return adapter
  }

  async function resolveAgentKind(agent) {
    return harnessForAgent(agent).kind
  }

  function lifecycleTuple(agent) {
    return [
      agent?.id || '',
      agent?.session_id || agent?.sessionId || '',
      agent?.tmux_session || agent?.tmuxSession || '',
    ].join('\u0000')
  }

  async function observeRuntimeLifecycle(agent, {
    machineId,
    envName,
    daemonKey,
    reason = 'runtime-scan',
    sendMsg,
  } = {}) {
    if (!agent?.id) return null
    const observedAt = new Date().toISOString()
    const tuple = lifecycleTuple(agent)
    const base = {
      type: 'agent-lifecycle',
      agent_id: agent.id,
      session_id: agent.session_id || agent.sessionId || null,
      tmux_session: agent.tmux_session || agent.tmuxSession || null,
      machine_id: machineId || agent.machine_id || null,
      env_name: envName || agent.env_name || null,
      daemon_key: daemonKey || agent.daemon_key || null,
      harness: null,
      state: 'unroutable',
      pid: null,
      previous_pid: lifecycleByTuple.get(tuple)?.pid || null,
      observed_at: observedAt,
      reason,
    }

    if (!base.session_id || !base.tmux_session || !base.machine_id || !base.env_name || !base.daemon_key) {
      const event = { ...base, reason: 'incomplete-seat-tuple' }
      lifecycleByTuple.set(tuple, { state: event.state, pid: null })
      sendMsg?.(event)
      return event
    }

    let harness
    try {
      harness = harnessForAgent(agent)
    } catch (e) {
      const event = { ...base, reason: e.message || 'unknown-harness' }
      lifecycleByTuple.set(tuple, { state: event.state, pid: null })
      sendMsg?.(event)
      return event
    }

    const pid = await findRuntimePidForAgent(agent, harness.kind)
    const previous = lifecycleByTuple.get(tuple) || null
    const event = {
      ...base,
      harness: harness.kind,
      pid: pid ? Number(pid) : null,
      previous_pid: previous?.pid || null,
      state: pid ? 'runtime-alive' : previous?.pid ? 'runtime-exited' : 'unroutable',
      reason: pid ? reason : previous?.pid ? 'runtime-pid-missing' : 'runtime-not-observed',
    }
    lifecycleByTuple.set(tuple, { state: event.state, pid: event.pid })
    sendMsg?.(event)
    return event
  }

  return {
    extractActivityEvents,
    findRuntimePidForAgent,
    harnessAdapters,
    harnessForAgent,
    observeRuntimeLifecycle,
    resolveAgentKind,
  }
}
