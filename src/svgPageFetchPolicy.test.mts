import { fetchDocumentSvgPages } from './svgPageFetchPolicy'

function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
}

for (const format of ['html', 'markdown', 'qmd', 'png', 'slides']) {
  let calls = 0
  const started = fetchDocumentSvgPages({}, { format }, () => { calls += 1 })
  equal(started, false, `${format} does not start SVG page fetch`)
  equal(calls, 0, `${format} never invokes SVG page fetch`)
}

for (const format of ['svg', 'latex']) {
  let calls = 0
  const started = fetchDocumentSvgPages({}, { format }, () => { calls += 1 })
  equal(started, true, `${format} starts SVG page fetch`)
  equal(calls, 1, `${format} invokes SVG page fetch once`)
}

console.log('SVG page fetch policy: PASS')
