import { execFile } from 'child_process'
import { promisify } from 'util'
import { parseCodexLine, parseCodexRecord } from '../agent-runtime/codex-activity.mjs'
import { harnessKindForAgent } from '../agent-runtime/daemon-guards.mjs'
import { resolveTranscript } from '../agent-runtime/resolve-transcript.mjs'
import { extractActivityEvents, parseSessionLine, parseSessionRecord } from './activity-events.mjs'

const execFileP = promisify(execFile)

export function createHarnessRuntime({ tmuxArgs = [], log }) {
  const TMUX_ARGS = tmuxArgs || []

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
    const stored = agent?.metadata?.kind
    if (!agent?.tmux_session) return (stored && harnessAdapters[stored]) ? stored : 'claude'
    let paneOut = ''
    try {
      ;({ stdout: paneOut } = await execFileP('tmux',
        [...TMUX_ARGS, 'list-panes', '-t', agent.tmux_session, '-F', '#{pane_pid}'],
        { timeout: 3000, encoding: 'utf8' }))
    } catch { return (stored && harnessAdapters[stored]) ? stored : 'claude' }
    const panePids = paneOut.trim().split('\n').filter(Boolean)
    if (!panePids.length) return (stored && harnessAdapters[stored]) ? stored : 'claude'
    let psOut = ''
    try {
      ;({ stdout: psOut } = await execFileP('ps', ['-eo', 'pid,ppid,args'], { timeout: 5000, encoding: 'utf8' }))
    } catch { return (stored && harnessAdapters[stored]) ? stored : 'claude' }
    const childrenByPpid = new Map()
    const argsByPid = new Map()
    for (const line of psOut.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
      if (!m) continue
      const [, pid, ppid, args] = m
      if (!childrenByPpid.has(ppid)) childrenByPpid.set(ppid, [])
      childrenByPpid.get(ppid).push(pid)
      argsByPid.set(pid, args)
    }
    const stack = [...panePids]
    const seen = new Set()
    while (stack.length) {
      const pid = stack.pop()
      if (seen.has(pid)) continue
      seen.add(pid)
      const args = argsByPid.get(pid)
      if (args) {
        if (harnessAdapters.codex.processRe.test(args)) return 'codex'
        if (harnessAdapters.goose.processRe.test(args)) return 'goose'
        if (harnessAdapters.claude.processRe.test(args)) return 'claude'
      }
      for (const child of (childrenByPpid.get(pid) || [])) stack.push(child)
    }
    return (stored && harnessAdapters[stored]) ? stored : 'claude'
  }

  return {
    extractActivityEvents,
    findRuntimePidForAgent,
    harnessAdapters,
    harnessForAgent,
    resolveAgentKind,
  }
}
