import test from 'node:test'
import assert from 'node:assert/strict'

import { formatReaperMarkdownReport } from '../bots/dev/reaper.mjs'

test('reaper markdown report includes machine pressure table', () => {
  const report = formatReaperMarkdownReport({
    pressure: 0.75,
    totalMem: 8 * 1024 * 1024 * 1024,
    freeMem: 2 * 1024 * 1024 * 1024,
    cpuPressure: 0.5,
    loadAverage: 4,
    cpuCount: 8,
    sweepCount: 12,
    vites: [{ hasClient: false }],
    browsers: [{ controllerAlive: false }],
    agentProcesses: [],
    agentProcessSkippedCount: 2,
  })

  assert.match(report, /### Machine Pressure/)
  assert.match(report, /\| Resource \| Pressure \| Detail \|/)
  assert.match(report, /\| Memory \| 75% \| 6\.0 GiB used \/ 8\.0 GiB total \|/)
  assert.match(report, /\| CPU \| 50% \| 1m load 4\.00 \/ 8 cores \|/)
  assert.match(report, /### Reaper Surface/)
})
