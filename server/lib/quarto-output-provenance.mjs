import { JSDOM } from 'jsdom'
import { parse as parseYaml } from 'yaml'

function frontmatterEcho(source) {
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(source)
  if (!match) return true
  try {
    return parseYaml(match[1])?.execute?.echo !== false
  } catch {
    return true
  }
}

function headerEcho(header, fallback) {
  const match = /(?:^|[\s,])echo\s*[:=]\s*(false|true)(?:[\s,]|$)/i.exec(header)
  return match ? match[1].toLowerCase() !== 'false' : fallback
}

export function executableChunks(source) {
  const chunks = []
  const lines = String(source).split(/\r?\n/)
  const defaultEcho = frontmatterEcho(source)
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})\{([^}]*)\}\s*$/.exec(lines[i])
    if (!open) continue
    const engine = open[3].trim().split(/[\s,]/, 1)[0]
    if (!engine || engine.startsWith('.')) continue
    const marker = open[2][0]
    const width = open[2].length
    const body = []
    const startLine = i + 1
    for (i += 1; i < lines.length; i++) {
      const close = new RegExp(`^\\s*${marker === '`' ? '`' : '~'}{${width},}\\s*$`).exec(lines[i])
      if (close) break
      body.push(lines[i])
    }
    let echo = headerEcho(open[3], defaultEcho)
    let label = open[3].trim().split(/[\s,]+/)[1] || ''
    for (const line of body) {
      const option = /^\s*#\|\s*echo\s*:\s*(false|true)\s*$/i.exec(line)
      if (option) echo = option[1].toLowerCase() !== 'false'
      const labelOption = /^\s*#\|\s*label\s*:\s*(\S+)\s*$/i.exec(line)
      if (labelOption) label = labelOption[1]
    }
    chunks.push({
      echo,
      label: label || `unnamed-chunk-${chunks.length + 1}`,
      source: body.join('\n'),
      sourceLine: startLine + 1,
    })
  }
  return chunks
}

function figureLabel(cell) {
  const figureId = cell.querySelector('figure[id]')?.id
  if (figureId) return figureId
  const src = cell.querySelector('.cell-output-display img[src]')?.getAttribute('src') || ''
  const file = src.split(/[?#]/, 1)[0].split('/').pop() || ''
  return file.replace(/-\d+\.[^.]+$/, '')
}

export function injectQuartoOutputProvenance(html, source, sourceFile) {
  const chunks = executableChunks(source)
  if (!chunks.some(chunk => !chunk.echo)) return html

  const dom = new JSDOM(html)
  const { document } = dom.window
  const hiddenByLabel = new Map(chunks.filter(chunk => !chunk.echo).map(chunk => [chunk.label, chunk]))
  const cells = [...document.querySelectorAll('.cell')]
  let changed = false
  for (const cell of cells) {
    const chunk = hiddenByLabel.get(figureLabel(cell))
    if (!chunk || cell.querySelector('.cell-code, .tlda-output-source')) continue
    if (!cell.querySelector('.cell-output-display figure, .cell-output-display img, .cell-output-display svg')) continue

    const details = document.createElement('details')
    details.className = 'tlda-output-source'
    details.dataset.sourceFile = sourceFile
    details.dataset.sourceLine = String(chunk.sourceLine)
    const summary = document.createElement('summary')
    summary.textContent = 'Show plotting code'
    const pre = document.createElement('pre')
    pre.className = 'sourceCode'
    const code = document.createElement('code')
    code.textContent = chunk.source
    pre.append(code)
    details.append(summary, pre)
    cell.append(details)
    changed = true
  }
  return changed ? dom.serialize() : html
}
