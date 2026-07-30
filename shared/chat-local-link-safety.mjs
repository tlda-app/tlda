function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function decodeHtmlAttr(s = '') {
  return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"')
}

function fileChip(path, label = '') {
  const cleanPath = decodeHtmlAttr(path)
  const name = label || cleanPath.split('/').pop() || cleanPath
  const isScratch = /(?:^|\/)scratch\//.test(cleanPath)
  const cls = isScratch ? 'md-file-card scratch-card' : 'md-file-card'
  const drag = isScratch ? ' draggable="true"' : ''
  return `<span class="${cls}" data-path="${esc(cleanPath)}"${drag}><span class="md-file-chip">${esc(name)}</span><span class="md-file-body"></span></span>`
}

export function rewriteBareLocalPaths(html = '') {
  let inCode = 0
  let inAnchor = 0
  return String(html).replace(/((?:<[^>]*>)|(?:[^<]+))/g, (segment) => {
    if (segment.startsWith('<')) {
      if (/^<(code|pre)\b/i.test(segment)) inCode++
      else if (/^<\/(code|pre)>/i.test(segment)) inCode = Math.max(0, inCode - 1)
      if (/^<a\b/i.test(segment)) inAnchor++
      else if (/^<\/a>/i.test(segment)) inAnchor = Math.max(0, inAnchor - 1)
      return segment
    }
    if (inCode > 0 || inAnchor > 0) return segment
    segment = segment.replace(/\/Users\/\w+\/([\w/._-]+)/g, (fullPath, rel) => {
      if (fullPath.endsWith('.md')) return fileChip(fullPath, rel.split('/').pop())
      if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(fullPath)) {
        const name = rel.split('/').pop()
        return `<img class="chat-image" src="/api/file?path=${encodeURIComponent(fullPath)}" alt="${esc(name)}" style="max-width:300px;max-height:200px;border-radius:4px;cursor:zoom-in;display:block;margin:4px 0" onerror="this.style.display='none'">`
      }
      return `<span class="file-path" title="${esc(fullPath)}" style="cursor:pointer;text-decoration:underline dotted">~/${esc(rel)}</span>`
    })
    const absoluteMarkdownChips = []
    segment = segment.replace(/(^|\s)(\/(?!\/|Users\/)[\w/._-]+\.(?:md|markdown))(?=\s|$|[)\].,;!?])/gi, (_, before, fullPath) => {
      const index = absoluteMarkdownChips.push(fileChip(fullPath, fullPath.split('/').pop())) - 1
      return `${before}\u0000absolute-markdown-chip-${index}\u0000`
    })
    segment = segment.replace(/(?<![/"'>\w])(?:(?:[\w.-]+\/)+[\w.-]+\.md)/g, (relPath) => {
      return fileChip(relPath, relPath.split('/').pop())
    })
    segment = segment.replace(/\u0000absolute-markdown-chip-(\d+)\u0000/g, (_, index) => absoluteMarkdownChips[Number(index)])
    return segment
  })
}
