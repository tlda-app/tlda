import { diff } from 'node:util'

export function changedTextRegions(previous, next) {
  const beforeLines = String(previous ?? '').split('\n')
  const afterLines = String(next ?? '').split('\n')
  const regions = []
  let nextLine = 1
  let current = null

  for (const [kind, line] of diff(beforeLines, afterLines)) {
    if (kind === 0) {
      if (current?.lines.length) regions.push({ startLine: current.startLine, content: current.lines.join('\n') })
      current = null
      nextLine += 1
      continue
    }
    if (kind === -1) {
      current ||= { startLine: nextLine, lines: [] }
      current.lines.push(line)
      nextLine += 1
      continue
    }
    current ||= { startLine: nextLine, lines: [] }
  }

  if (current?.lines.length) regions.push({ startLine: current.startLine, content: current.lines.join('\n') })
  return regions
}
