import test from 'node:test'
import assert from 'node:assert/strict'
import { toCpuprofile, type ProfilerTrace } from '../src/selfProfiler'

// One hand-computable trace, so every expectation below is a number worked out
// on paper rather than whatever the implementation happened to return.
//
//   stack 0 = a
//   stack 1 = a > b   (leaf b)
//
//   t=0   stack 0
//   t=10  stack 1
//   t=20  stack 1
//   t=30  (no stack — the thread was idle)
//   t=40  stack 0
//   t=50  stack 1
const trace: ProfilerTrace = {
  resources: ['https://example.invalid/assets/app.js'],
  frames: [
    { name: 'a', resourceId: 0, line: 1, column: 1 },
    { name: 'b', resourceId: 0, line: 2, column: 1 },
  ],
  stacks: [{ frameId: 0 }, { frameId: 1, parentId: 0 }],
  samples: [
    { timestamp: 0, stackId: 0 },
    { timestamp: 10, stackId: 1 },
    { timestamp: 20, stackId: 1 },
    { timestamp: 30 },
    { timestamp: 40, stackId: 0 },
    { timestamp: 50, stackId: 1 },
  ],
}

type Cpuprofile = {
  nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }>
  samples: number[]
  timeDeltas: number[]
  startTime: number
  endTime: number
}

test('every sample survives the conversion, with non-negative deltas', () => {
  const p = toCpuprofile(trace) as Cpuprofile
  assert.equal(p.samples.length, trace.samples.length)
  assert.equal(p.timeDeltas.length, trace.samples.length)
  assert.equal(p.timeDeltas.every(d => d >= 0), true)
})

test('timestamps are converted to microseconds', () => {
  const p = toCpuprofile(trace) as Cpuprofile
  // The trace spans 50ms.
  assert.equal(p.endTime - p.startTime, 50_000)
  // 10ms between the first two samples.
  assert.equal(p.timeDeltas[1], 10_000)
})

test('an idle sample maps to the root node instead of being dropped', () => {
  // The counterfactual: if idle samples were discarded, this profile would be
  // one sample shorter and a quiet tab would read as a busy one. That property
  // is what told us the server's stalls were off-CPU, so it must survive here.
  const p = toCpuprofile(trace) as Cpuprofile
  assert.equal(p.samples[3], 1)
  assert.equal(p.samples.length, 6)
})

test('every sample names a node that exists', () => {
  const p = toCpuprofile(trace) as Cpuprofile
  const ids = new Set(p.nodes.map(n => n.id))
  for (const sample of p.samples) assert.equal(ids.has(sample), true)
})

test('parent/child links follow the trace stack table', () => {
  const p = toCpuprofile(trace) as Cpuprofile
  const byName = new Map(p.nodes.map(n => [n.callFrame.functionName, n]))
  const a = byName.get('a')!
  const b = byName.get('b')!
  assert.equal(a.children?.includes(b.id), true)
  // b is a leaf here, so it must not have acquired children.
  assert.equal(b.children, undefined)
})

test('call frames carry the script url and a zero-based line, as .cpuprofile expects', () => {
  const p = toCpuprofile(trace) as Cpuprofile
  const a = p.nodes.find(n => n.callFrame.functionName === 'a')!
  assert.equal(a.callFrame.url, 'https://example.invalid/assets/app.js')
  // The trace reports line 1; `.cpuprofile` lineNumber is 0-based.
  assert.equal(a.callFrame.lineNumber, 0)
})

test('an empty trace converts to an empty profile rather than throwing', () => {
  const p = toCpuprofile({ resources: [], frames: [], stacks: [], samples: [] }) as Cpuprofile
  assert.deepEqual(p.samples, [])
  assert.deepEqual(p.timeDeltas, [])
  // The root still exists, so the output is a valid profile.
  assert.equal(p.nodes.length, 1)
  assert.equal(p.nodes[0].id, 1)
})
