import { execFile } from 'child_process'
import { promisify } from 'util'
import { parseCodexLine, parseCodexRecord } from '../agent-runtime/codex-activity.mjs'
import { harnessKindForAgent } from '../agent-runtime/daemon-guards.mjs'
import { extractActivityEvents, parseSessionLine, parseSessionRecord } from './activity-events.mjs'

export function createHarnessRuntime({
  tmuxArgs = [],
  log,
  execFileImpl = execFile,
} = {}) {
  const TMUX_ARGS = tmuxArgs || []
  const execFileP = promisify(execFileImpl)

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
        usesClaudeSessionIds: false,
        backfillSearch: true,
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
    bot: {
      kind: 'bot',
      processRe: /(?:^|\s|[/\\])node(?:\.exe)?(?:\s|$).*?(?:[/\\]bots[/\\].*\.mjs|[/\\][^/\\\s]*(?:-|_)bot\.mjs\b)/,
      activity: {
        kind: 'bot',
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

  return {
    extractActivityEvents,
    findRuntimePidForAgent,
    harnessAdapters,
    harnessForAgent,
    resolveAgentKind,
  }
}
