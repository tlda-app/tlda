// Convert a JS Self-Profiling trace to the `.cpuprofile` shape.
//
// Shared because both ends need it: the browser's `cpuprofiles()` hands profiles
// straight to speedscope from the page, and the server converts uploaded windows
// before writing them to disk.
//
// It runs on the SERVER for uploads rather than in the tab. Measured over 40
// real captured traces, converting and serializing costs a median 2.8ms and up
// to 61ms of synchronous main-thread time, and a converted window reaches 657KB
// against roughly a third of that for the raw trace. On the page that is a long
// task caused by the instrument, in the busy windows the instrument exists to
// explain, so the tab sends the raw trace and the server pays the cost.
//
// `.cpuprofile` is the whole analysis path, and deliberately the only one: it is
// what speedscope, profview and Chrome DevTools already open, so nothing here
// has to grow a ranker or a viewer.

/**
 * @param {{resources: string[], frames: object[], stacks: object[], samples: object[]}} trace
 * @returns {object} the `.cpuprofile` shape
 */
export function toCpuprofile(trace) {
  // `.cpuprofile` node ids are 1-based and every node needs a callFrame. The
  // stack table maps across one-for-one, with an added root carrying the samples
  // that have no stack.
  const ROOT_ID = 1
  const nodes = [{
    id: ROOT_ID,
    callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 },
  }]

  const childrenOf = new Map([[ROOT_ID, new Set()]])
  trace.stacks.forEach((entry, index) => {
    const id = index + 2 // 1 is the root
    const frame = trace.frames[entry.frameId]
    const url = frame?.resourceId != null ? trace.resources[frame.resourceId] || '' : ''
    nodes.push({
      id,
      callFrame: {
        functionName: frame?.name || '(anonymous)',
        scriptId: String(frame?.resourceId ?? 0),
        url,
        lineNumber: (frame?.line ?? 1) - 1,
        columnNumber: (frame?.column ?? 1) - 1,
      },
    })
    const parent = entry.parentId != null ? entry.parentId + 2 : ROOT_ID
    if (!childrenOf.has(parent)) childrenOf.set(parent, new Set())
    childrenOf.get(parent).add(id)
  })

  for (const node of nodes) {
    const kids = childrenOf.get(node.id)
    if (kids && kids.size) node.children = [...kids]
  }

  // `.cpuprofile` timestamps are microseconds; self-profiling gives milliseconds.
  const samples = trace.samples.map(s => (s.stackId != null ? s.stackId + 2 : ROOT_ID))
  const timeDeltas = trace.samples.map((s, i) =>
    i === 0 ? 0 : Math.max(0, Math.round((s.timestamp - trace.samples[i - 1].timestamp) * 1000)))
  const startTime = Math.round((trace.samples[0]?.timestamp ?? 0) * 1000)
  const endTime = Math.round((trace.samples[trace.samples.length - 1]?.timestamp ?? 0) * 1000)

  return { nodes, startTime, endTime, samples, timeDeltas }
}
