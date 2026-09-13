// The pane -> pid walk, which four call sites had a copy of: claude.mjs and
// muse.mjs in their `resolveLiveSessionIdentity`, and `runtimeStateFromProcessList`
// twice -- once down from the pane pids, once down from a matched runtime
// looking for its MCP child.
//
// ONLY the walk is here. What each caller does after finding a pid is its own
// and stays where it is: claude and muse require EXACTLY ONE owned runtime and
// then resolve a transcript, while `runtimeStateFromProcessList` takes the
// first match, scrapes FLEET_DAEMON_KEY/FLEET_ID/TLDA_ENV out of argv, and
// distinguishes `probed` from `runtime: false`. Those are four different
// questions asked of one traversal.
//
// TRAVERSAL ORDER IS PART OF THE CONTRACT. `runtimeStateFromProcessList`
// returns the FIRST match rather than requiring uniqueness, so which pid comes
// first decides its answer. The stack is LIFO and children are pushed as a
// group, exactly as all four copies did; do not "tidy" this into a queue.

// `ps -eo pid,ppid,args` rows. The line is trimmed before matching, so `args`
// carries no trailing whitespace -- the one difference from the copy in
// tmux.mjs, which anchored with `^\s*` and left it on. Every consumer regex
// ends `(?:\s|$)` or splits on whitespace, so the two are equivalent in effect;
// the claude/muse spelling won because three of the four copies used it.
export function parseProcessTree(psText) {
  const children = new Map()
  const argsByPid = new Map()
  for (const line of String(psText || '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const [, pid, ppid, args] = match
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
    argsByPid.set(pid, args)
  }
  return { children, argsByPid }
}

// Every pid at or under `roots`, in the order the copies visited them. Cycles
// and repeated parents are visited once.
export function walkSubtree(roots, children) {
  const stack = [...roots]
  const seen = new Set()
  const visited = []
  while (stack.length) {
    const pid = stack.pop()
    if (seen.has(pid)) continue
    seen.add(pid)
    visited.push(pid)
    stack.push(...(children.get(pid) || []))
  }
  return visited
}

// claude.mjs and muse.mjs both want this and both want it to be strict:
// two owned runtimes under one pane means the pane is not evidence about which
// session belongs to this agent, so the answer is nothing rather than a guess.
export function soleOwnedRuntime(panePids, psText, matches) {
  const { children, argsByPid } = parseProcessTree(psText)
  const owned = walkSubtree(panePids, children).filter(pid => matches(argsByPid.get(pid) || ''))
  return owned.length === 1 ? { pid: owned[0], args: argsByPid.get(owned[0]) || '' } : null
}
