// activity-render.mjs — Standalone activity card renderer.
//
// Extracted from activity.mjs for use in tldraw FleetChatShape
// without module-global dependencies.
//
// Usage:
//   import { renderActivityGroup } from './activity-render.mjs'
//   const html = renderActivityGroup(group, ctx)
//
// ctx = {
//   agentLabel:      (id) => string,
//   getNickClass:    (id) => string,
//   getAgents:       () => agents[],
//   renderMarkdown:  (escapedHtml) => html,
//   highlightSyntax: (code, lang) => html,
//   langFromFilePath: (path) => string,
//   preambleMacros:  Record<string, string> — KaTeX macros from current doc
// }

import katex from 'katex'
import { agentNameHtml } from './chat-render.mjs'

// --- Pure helpers (copied from utils.mjs) ---

export function esc(s) {
  if (s == null) return ''
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function copySourceTemplate(text) {
  return `<template class="code-block-copy-source">${esc(text)}</template>`
}

// --- Constants ---

export const ACTIVITY_NOISE = new Set([
  'wait_for_task', 'my_task', 'task_list', 'register', 'register_manager',
  'task_check', 'unregister_manager', 'task_done', 'timer',
  'mcp__tlda__wait_for_task', 'mcp__tlda__my_task', 'mcp__tlda__task_list',
  'mcp__tlda__register', 'mcp__tlda__register_manager', 'mcp__tlda__task_check',
  'mcp__tlda__task_done', 'mcp__tlda__timer',
  'ToolSearch',
])

export const CHAT_TOOLS = new Set([
  'chat', 'delegate', 'mcp__tlda__chat', 'mcp__tlda__delegate',
])

// --- Pretty-print tool results ---

function renderPrettyResult(toolName, text, ctx, input, ts) {
  const tool = (toolName || '').toLowerCase()
  if (tool.includes('get_thread') || tool.includes('thread')) {
    return renderThreadResult(text, ctx)
  }
  if (tool.includes('search')) {
    return renderSearchResult(text, ctx)
  }
  if (tool.includes('screenshot')) {
    return renderScreenshotResult(text)
  }
  if (tool === 'schedulewakeup') {
    return renderScheduleResult(text, input, ts)
  }
  // Fallback: render as markdown
  const md = ctx.renderMarkdown ? ctx.renderMarkdown(text) : esc(text)
  return `<div class="tool-pretty-result">${md}</div>`
}

// Format remaining ms-until-fire as "in Xm Ys" / "in Ys" / "fired". Shared shape
// with the chat-shape ticker that re-ticks the card each second.
export function scheduleTimeLabel(fireAt) {
  const r = Math.ceil((fireAt - Date.now()) / 1000)
  if (r <= 0) return 'fired'
  const min = Math.floor(r / 60)
  const sec = r % 60
  return min > 0 ? `in ${min}m ${sec}s` : `in ${sec}s`
}

function renderScheduleResult(text, input, ts) {
  const timeMatch = text.match(/scheduled for ([\d:]+)\s*\(in (\d+)s\)/)
  const fireTime = timeMatch ? timeMatch[1] : ''
  const delaySec = timeMatch ? parseInt(timeMatch[2], 10) : 0
  // Absolute fire epoch = when the tool ran (the event timestamp) + the delay.
  // Anchoring on the event timestamp keeps it correct and date-aware across
  // re-renders; the clock-time string alone can't tell today from tomorrow.
  let fireAt = 0
  if (delaySec > 0) {
    // timestamps come through as epoch ms (number/numeric-string) or ISO.
    let base = Date.now()
    if (ts != null) {
      const n = typeof ts === 'number' ? ts
        : /^\d+$/.test(String(ts)) ? Number(ts)
        : Date.parse(ts)
      if (Number.isFinite(n)) base = n
    }
    fireAt = base + delaySec * 1000
  }
  const timeLabel = fireAt ? scheduleTimeLabel(fireAt) : 'scheduled'
  const reason = input?.reason || ''
  return `<div class="tool-pretty-result tool-pretty-schedule"${fireAt ? ` data-fire-at="${fireAt}"` : ''}>
    <span class="schedule-icon">⏱</span>
    <span class="schedule-time">${esc(timeLabel)}</span>
    ${fireTime ? `<span class="schedule-at">@ ${esc(fireTime)}</span>` : ''}
    ${reason ? `<span class="schedule-reason">— ${esc(reason)}</span>` : ''}
  </div>`
}

function renderScreenshotResult(text) {
  // Extract saved image path (injected by daemon as "image:/tmp/tlda-ss-*.png")
  const pathMatch = text.match(/image:(\/tmp\/[^\s\n]+\.png)/i)
  if (pathMatch) {
    const imgPath = pathMatch[1]
    const src = `/api/file?path=${encodeURIComponent(imgPath)}`
    const label = text.split('\n')[0].trim() || 'Screenshot'
    return `<div class="tool-pretty-result tool-pretty-screenshot">
      <div class="pretty-result-header">${esc(label)}</div>
      <img class="chat-image" src="${esc(src)}" alt="${esc(label)}" onerror="this.style.display='none'">
    </div>`
  }
  // Screenshot failed or no image data
  const label = text.trim() || 'screenshot failed'
  return `<div class="tool-pretty-result tool-pretty-screenshot"><div class="pretty-result-header" style="opacity:0.5">${esc(label)}</div></div>`
}

function renderThreadResult(text, ctx) {
  // Format: "[timestamp] from → to\nmessage\n\n---\n\n[timestamp] from → to\n..."
  // Parse the optional summary header before splitting messages. Leaving it in
  // the first chunk makes the first message miss the row parser and render raw.
  const headerLine = text.match(/^((?:Showing \d+ of \d+[^\n]*|⚠️[^\n]*|\d+ messages[^\n]*)(?:\n|$))+/)
  const headerText = headerLine ? headerLine[0].trim() : ''
  const bodyText = headerLine ? text.slice(headerLine[0].length).replace(/^\n+/, '') : text
  // Split on --- separators
  const msgs = bodyText.split(/\n\n---\n\n/)
  if (msgs.length <= 1) {
    return `<div class="tool-pretty-result">${ctx.renderMarkdown ? ctx.renderMarkdown(bodyText || text) : esc(bodyText || text)}</div>`
  }
  const THREAD_FRONT = 3
  const THREAD_TAIL = 5
  const THREAD_PREVIEW = THREAD_FRONT + THREAD_TAIL
  const hasMoreMsgs = msgs.length > THREAD_PREVIEW
  const renderMsg = (msg) => {
    const headerMatch = msg.match(/^\[([^\]]*)\]\s*(\S+)\s*→\s*(\S+)\n([\s\S]*)$/)
    if (!headerMatch) return `<div class="chat-line"><div class="pretty-msg-body">${ctx.renderMarkdown ? ctx.renderMarkdown(esc(msg)) : esc(msg)}</div></div>`
    const [, ts, from, to, body] = headerMatch
    const fromCls = ctx.getNickClass ? ctx.getNickClass(from) : 'chat-nick'
    const toCls = ctx.getNickClass ? ctx.getNickClass(to) : 'chat-nick'
    let shortTs = ts.replace(/^\d+\/\d+\/\d+,?\s*/, '')
    // Extract shadow version hash if present (format: "time @hash")
    let verHtml = ''
    const verMatch = shortTs.match(/\s*@([a-f0-9]{7})$/)
    if (verMatch) {
      shortTs = shortTs.replace(/\s*@[a-f0-9]{7}$/, '')
      verHtml = ` <span class="pretty-ver">@${verMatch[1]}</span>`
    }
    const bodyHtml = ctx.renderMarkdown ? ctx.renderMarkdown(esc(body.trim())) : esc(body.trim())
    const isFromUser = from === 'skip' || from === 'Skip'
    const userClass = isFromUser ? ' from-user' : ''
    return `<div class="chat-line${userClass}" data-msg-from="${esc(from)}">
      <span class="chat-ts">${esc(shortTs)}${verHtml}</span>
      <span class="chat-nick ${fromCls}">${agentNameHtml(from)}</span>
      <span class="chat-arrow">→</span>
      <span class="chat-nick ${toCls}">${agentNameHtml(to)}</span>
      <div class="pretty-msg-body">${bodyHtml}</div>
    </div>`
  }
  // Show first FRONT + gap marker + last TAIL, so both ends are visible.
  // This lets Skip see the time range of what was actually read.
  // The gap marker doubles as the expand button — clicking it reveals the hidden middle rows in place.
  let rows = ''
  const moreHtml = ''
  if (hasMoreMsgs) {
    const frontMsgs = msgs.slice(0, THREAD_FRONT)
    const tailMsgs = msgs.slice(-THREAD_TAIL)
    const hiddenCount = msgs.length - THREAD_PREVIEW
    const hiddenRows = msgs.slice(THREAD_FRONT, msgs.length - THREAD_TAIL).map(renderMsg).join('')
    const gapMarker = `<div class="pretty-expand-btn">… ${hiddenCount} messages …</div>`
      + `<div class="pretty-more-rows" style="display:none">${hiddenRows}</div>`
    rows = frontMsgs.map(renderMsg).join('') + gapMarker + tailMsgs.map(renderMsg).join('')
  } else {
    rows = msgs.map(renderMsg).join('')
  }
  const header = headerText ? `<div class="pretty-result-header">${esc(headerText)}</div>` : ''
  return `<div class="tool-pretty-result tool-pretty-thread">${header}${moreHtml}${rows}</div>`
}

// A search row's "source" field is "[tag] [tag] <names>" where <names> is either
// a single agent name or "from → to". Keep the bracket tags verbatim, but run the
// agent names through the HTML display primitive (base text + phase glyph).
function prettySearchSource(source) {
  const m = source.match(/^((?:\[[^\]]*\]\s*)+)(.*)$/)
  if (!m) return esc(source)
  const rest = m[2].trim()
  if (!rest) return esc(source)
  const names = rest.split(/\s*→\s*/).map(n => agentNameHtml(n.trim()))
    .join(' <span class="chat-arrow">→</span> ')
  return esc(m[1]) + names
}

function renderSearchResult(text, ctx) {
  // Format: "N results (X session, Y chat) — index: ...\n\nresult1\n\nresult2\n\n..."
  // Each result: "timestamp | [source] [role] agent | snippet"
  const parts = text.split('\n\n')
  if (parts.length <= 1) {
    return `<div class="tool-pretty-result">${esc(text)}</div>`
  }
  const header = parts[0]
  const results = parts.slice(1)
  const SEARCH_FRONT = 3
  const SEARCH_TAIL = 3
  const renderRow = (r, globalIdx) => {
    const pipeMatch = r.match(/^([^|]+)\|([^|]+)\|(.+)$/s)
    const stripe = globalIdx % 2 === 0 ? 'pretty-row-even' : 'pretty-row-odd'
    if (pipeMatch) {
      const ts = pipeMatch[1].trim()
      const source = pipeMatch[2].trim()
      const snippet = pipeMatch[3].trim()
      const highlightedSnippet = esc(snippet).replace(/\*\*([^*]+)\*\*/g, '<mark>$1</mark>')
      const tsShort = ts.replace(/^\d+\/\d+\/\d+,?\s*/, '')  // strip date, keep time
      return `<div class="pretty-search-row ${stripe}" draggable="true" data-ts="${esc(ts)}">
        <span class="pretty-search-ts" title="${esc(ts)}">${esc(tsShort)}</span>
        <span class="pretty-search-source">${prettySearchSource(source)}</span>
        <span class="pretty-search-snippet">${highlightedSnippet}</span>
      </div>`
    }
    const highlighted = esc(r).replace(/\*\*([^*]+)\*\*/g, '<mark>$1</mark>')
    return `<div class="pretty-search-row ${stripe}">${highlighted}</div>`
  }
  // Show first FRONT + gap marker + last TAIL so both ends are visible.
  // Lets Skip see the timestamp the agent ended at — if the agent stopped early,
  // the tail timestamps reveal the gap vs. the actual latest message.
  const hasMore = results.length > SEARCH_FRONT + SEARCH_TAIL
  let rows = ''
  if (hasMore) {
    const hiddenCount = results.length - SEARCH_FRONT - SEARCH_TAIL
    const tailStart = results.length - SEARCH_TAIL
    const hiddenRows = results.slice(SEARCH_FRONT, tailStart).map((r, i) => renderRow(r, i + SEARCH_FRONT)).join('')
    const gapMarker = `<div class="pretty-expand-btn">… ${hiddenCount} more …</div>`
      + `<div class="pretty-more-rows" style="display:none">${hiddenRows}</div>`
    rows = results.slice(0, SEARCH_FRONT).map((r, i) => renderRow(r, i)).join('')
      + gapMarker
      + results.slice(-SEARCH_TAIL).map((r, i) => renderRow(r, tailStart + i)).join('')
  } else {
    rows = results.map((r, i) => renderRow(r, i)).join('')
  }
  return `<div class="tool-pretty-result tool-pretty-search">
    <div class="pretty-result-header">${esc(header)}</div>
    ${rows}
  </div>`
}

// --- Tool helpers ---

export function humanizeToolName(name) {
  let n = (name || '').replace(/^mcp__/, '').replace(/__/g, '/')
  const shorts = { 'tlda/chat': 'chat', 'tlda/delegate': 'delegate', 'tlda/task_done': 'done',
    'tlda/interrupt': 'interrupt', 'tlda/label_agent': 'label', 'tlda/respawn': 'respawn',
    'tlda/spawn': 'spawn', 'tlda/name_agent': 'name', 'tlda/search_logs': 'search_logs' }
  return shorts[n] || n
}

export function toolToCommand(name, input) {
  if (!name || !input) return ''
  const n = name.toLowerCase().replace(/^mcp__\w+__/, '')
  switch (n) {
    case 'bash': return input.command || ''
    case 'grep': {
      const parts = ['grep']
      if (input['-i']) parts.push('-i')
      if (input.multiline) parts.push('-P')
      if (input['-A']) parts.push(`-A ${input['-A']}`)
      if (input['-B']) parts.push(`-B ${input['-B']}`)
      if (input['-C'] || input.context) parts.push(`-C ${input['-C'] || input.context}`)
      if (input.output_mode === 'files_with_matches') parts.push('-l')
      else if (input.output_mode === 'count') parts.push('-c')
      else parts.push('-n')
      if (input.glob) parts.push(`--include='${input.glob}'`)
      if (input.type) parts.push(`--include='*.${input.type}'`)
      parts.push(`'${(input.pattern || '').replace(/'/g, "'\\''")}'`)
      parts.push(input.path || '.')
      if (input.head_limit) parts.push(`| head -${input.head_limit}`)
      return parts.join(' ')
    }
    case 'read': {
      if (input.offset && input.limit) {
        const end = input.offset + input.limit
        return `sed -n '${input.offset},${end}p' '${input.file_path}'`
      }
      return `cat -n '${input.file_path || ''}'`
    }
    case 'glob': return `find ${input.path || '.'} -name '${input.pattern || ''}'`
    default: return ''
  }
}

export function toolArgSummary(input, toolName) {
  if (!input) return ''
  const n = (toolName || '').toLowerCase()
  if (n === 'name') return `${input.agent} → ${input.friendly_name}`
  if (n === 'label') return `${input.agent}: ${(input.labels || []).join(', ')}`
  if (n === 'delegate') return `${input.agent}: ${input.description || ''}`
  if (n === 'interrupt') return `${input.agent}${input.message ? ' — ' + input.message : ''}`
  if (n === 'chat') return `→${input.to || 'manager'}: ${input.message || ''}`
  if (input.to) return input.to
  if (input.agent) return input.agent
  if (input.file_path) return input.file_path
  if (input.path) return input.path
  if (input.command) return input.command
  if (input.pattern) return input.pattern
  if (input.message) return input.message
  if (input.query) return input.query
  return ''
}

export function toolContentDetail(name, input) {
  if (!input) return ''
  const n = (name || '').toLowerCase()
  if (n === 'edit') {
    const ns = input.new_string || ''
    const os = input.old_string || ''
    if (ns && os) {
      const newLines = ns.split('\n').filter(l => l.trim())
      const snippet = newLines[0]?.trim() || ''
      const addCount = ns.split('\n').length
      const delCount = os.split('\n').length
      return snippet ? `+${addCount}/-${delCount}: ${snippet}` : `+${addCount}/-${delCount}`
    }
    return ''
  }
  if (n === 'write') {
    const content = input.content || ''
    const lines = content.split('\n')
    const firstLine = lines.find(l => l.trim())?.trim() || ''
    return firstLine ? `${lines.length} lines: ${firstLine}` : `${lines.length} lines`
  }
  if (n === 'read') {
    const fp = input.file_path || ''
    const offset = input.offset ? ` @${input.offset}` : ''
    const limit = input.limit ? ` (${input.limit} lines)` : ''
    return fp ? `${fp}${offset}${limit}` : ''
  }
  if (n === 'bash') return '' // command is in the arg line
  if (n === 'grep') {
    const pat = input.pattern || ''
    const path = input.path || ''
    return path ? `/${pat}/ in ${path}` : `/${pat}/`
  }
  if (n === 'glob') {
    const pat = input.pattern || ''
    const path = input.path || ''
    return path ? `${pat} in ${path}` : ''
  }
  if (n === 'agent') {
    return input.description || input.prompt || ''
  }
  return ''
}

// --- Rendering helpers (need ctx for highlightSyntax, langFromFilePath, preambleMacros) ---

// Render a block of .tex content with inline KaTeX. Handles:
//   - Blank lines → <br>
//   - Comment lines → shown as-is (dimmed)
//   - Structural commands (\begin, \end, \section, etc.) → <code>
//   - Display math $$...$$ or \[...\] → KaTeX display mode
//   - Other lines → inline $...$ segments rendered, rest as escaped text
function renderTexLines(content, macros) {
  return content.split('\n').map(line => {
    const trimmed = line.trim()
    if (!trimmed) return '<br>'
    if (trimmed.startsWith('%')) return `<span class="tex-comment">${esc(line)}</span>`
    if (/^\\(begin|end|documentclass|usepackage|chapter|section|subsection|paragraph|label|item|caption)\b/.test(trimmed)) {
      return `<code class="tex-struct">${esc(line)}</code>`
    }
    // Display math: $$...$$ or \[...\]
    const dispMatch = trimmed.match(/^\$\$([\s\S]*)\$\$$/) || trimmed.match(/^\\\[([\s\S]*)\\\]$/)
    if (dispMatch) {
      try { return katex.renderToString(dispMatch[1], { displayMode: true, throwOnError: false, macros }) }
      catch { return `<code>${esc(line)}</code>` }
    }
    // Inline math: split on $...$ segments, render each
    const parts = line.split(/(\$[^$\n]+\$)/)
    if (parts.length === 1) return esc(line) // no math
    return parts.map(p => {
      if (p.length > 2 && p.startsWith('$') && p.endsWith('$')) {
        try { return katex.renderToString(p.slice(1, -1), { displayMode: false, throwOnError: false, macros }) }
        catch { return esc(p) }
      }
      return esc(p)
    }).join('')
  }).join('<br>')
}

export function renderEditDiff(input, ctx, opts = {}) {
  if (!input?.old_string || !input?.new_string) return ''
  const { langFromFilePath, highlightSyntax } = ctx
  // propose_edit names its target `file`; the Edit tool uses `file_path`.
  const filePath = input.file_path || input.file || ''
  const uid = 'diff-' + Math.random().toString(36).slice(2, 8)
  const isTeX = filePath && /\.tex$/i.test(filePath)
  const lang = !isTeX ? langFromFilePath(filePath) : ''
  const renderSide = (str) => {
    if (!isTeX) {
      const escaped = esc(str)
      return `<pre><code>${lang ? highlightSyntax(escaped, lang) : escaped}</code></pre>`
    }
    return `<div class="diff-tex">${renderTexLines(str, ctx.preambleMacros || {})}</div>`
  }
  const lineCount = Math.max(
    (input.old_string.match(/\n/g) || []).length + 1,
    (input.new_string.match(/\n/g) || []).length + 1,
  )
  const h = ctx?.foldHeights?.diff ?? 0
  const shouldFold = h > 0 && lineCount > h
  const foldCls = shouldFold ? ' code-collapsed' : ''
  const foldStyle = shouldFold ? ` style="max-height:${(h * 1.4).toFixed(1)}em"` : ''
  const toggleHtml = shouldFold
    ? `<span class="code-block-toggle" onclick="(function(e){var w=e.closest('.code-block-wrap'),p=w.querySelector('.fold-body');if(p.classList.contains('code-collapsed')){p.classList.remove('code-collapsed');p.style.maxHeight='';e.textContent='collapse'}else{p.classList.add('code-collapsed');p.style.maxHeight='${(h * 1.4).toFixed(1)}em';e.textContent='${lineCount} lines — show all'}})(this)">${lineCount} lines — show all</span>`
    : ''
  const header = shouldFold
    ? `<div class="code-block-header"><span class="code-block-lang">diff</span>${toggleHtml}</div>`
    : ''
  // Location + scope header: which file (and line, when known), how many lines
  // change. For a propose, a "tentative" badge marks the edit as not-yet-applied.
  const addCount = opts.addCount ?? ((input.new_string.match(/\n/g) || []).length + 1)
  const delCount = opts.delCount ?? ((input.old_string.match(/\n/g) || []).length + 1)
  const base = filePath ? filePath.split('/').pop() : ''
  const locText = base ? `${base}${opts.line ? ':' + opts.line : ''}` : ''
  const tentativeBadge = opts.isPropose ? `<span class="edit-diff-badge edit-diff-tentative">tentative</span>` : ''
  const extraBadge = opts.badge ? `<span class="edit-diff-badge">${esc(opts.badge)}</span>` : ''
  const extraLocHtml = opts.extraLocHtml || ''
  const locHeader = (locText || tentativeBadge || extraBadge || extraLocHtml)
    ? `<div class="edit-diff-loc">${tentativeBadge}${extraBadge}${locText ? `<span class="edit-diff-path">${esc(locText)}</span>` : ''}<span class="edit-diff-stat">+${addCount} −${delCount}</span></div>${extraLocHtml}`
    : ''
  const propIdAttr = opts.proposalId ? ` data-proposal-id="${esc(opts.proposalId)}"` : ''
  const wrapCls = `code-block-wrap code-card edit-diff-wrap${opts.isPropose ? ' edit-diff-propose' : ''}${opts.fromUnified ? ' edit-unified-side-by-side-wrap' : ''}`
  return `<div class="${wrapCls}"${propIdAttr}>${locHeader}${header}
    <div class="edit-diff fold-body${isTeX ? ' tex-diff' : ''}${foldCls}" id="${uid}"${foldStyle}>
      <div class="diff-side diff-old"><div class="diff-label">−</div>${renderSide(input.old_string)}</div>
      <div class="diff-side diff-new"><div class="diff-label">+</div>${renderSide(input.new_string)}</div>
    </div>
  </div>`
}

function unifiedDiffToEditStrings(diff) {
  const oldLines = []
  const newLines = []
  let sawChange = false
  for (const rawLine of diff.split('\n')) {
    if (
      rawLine.startsWith('diff --git ') ||
      rawLine.startsWith('index ') ||
      rawLine.startsWith('--- ') ||
      rawLine.startsWith('+++ ') ||
      rawLine.startsWith('new file mode ') ||
      rawLine.startsWith('deleted file mode ') ||
      rawLine.startsWith('similarity index ') ||
      rawLine.startsWith('rename from ') ||
      rawLine.startsWith('rename to ') ||
      rawLine.startsWith('\\ No newline at end of file')
    ) continue
    if (rawLine.startsWith('@@')) {
      if (oldLines.length || newLines.length) {
        oldLines.push('')
        newLines.push('')
      }
      oldLines.push(rawLine)
      newLines.push(rawLine)
      continue
    }
    if (rawLine.startsWith('-')) {
      oldLines.push(rawLine.slice(1))
      sawChange = true
      continue
    }
    if (rawLine.startsWith('+')) {
      newLines.push(rawLine.slice(1))
      sawChange = true
      continue
    }
    const line = rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine
    oldLines.push(line)
    newLines.push(line)
  }
  if (!sawChange) return null
  return {
    old_string: oldLines.join('\n'),
    new_string: newLines.join('\n'),
  }
}

export function renderUnifiedEditDiff(input, ctx, opts = {}) {
  const diff = typeof input?.diff === 'string' ? input.diff : ''
  if (!diff.trim()) return ''
  const filePath = input.file_path || input.file || input.path || ''
  const base = filePath ? filePath.split('/').pop() : ''
  const op = input.op ? String(input.op) : ''
  const lines = diff.split('\n')
  const addCount = lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length
  const delCount = lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length
  const sideBySide = unifiedDiffToEditStrings(diff)
  if (sideBySide) {
    const moved = input.movedTo ? `<div class="edit-diff-loc"><span class="edit-diff-path">→ ${esc(input.movedTo)}</span></div>` : ''
    return renderEditDiff(
      { ...input, old_string: sideBySide.old_string, new_string: sideBySide.new_string },
      ctx,
      { ...opts, addCount, delCount, badge: op, fromUnified: true, extraLocHtml: moved },
    )
  }
  const lineCount = Math.max(lines.length, 1)
  const h = ctx?.foldHeights?.diff ?? 0
  const shouldFold = h > 0 && lineCount > h
  const foldCls = shouldFold ? ' code-collapsed' : ''
  const foldStyle = shouldFold ? ` style="max-height:${(h * 1.4).toFixed(1)}em"` : ''
  const toggleHtml = shouldFold
    ? `<span class="code-block-toggle" onclick="(function(e){var w=e.closest('.code-block-wrap'),p=w.querySelector('.fold-body');if(p.classList.contains('code-collapsed')){p.classList.remove('code-collapsed');p.style.maxHeight='';e.textContent='collapse'}else{p.classList.add('code-collapsed');p.style.maxHeight='${(h * 1.4).toFixed(1)}em';e.textContent='${lineCount} lines — show all'}})(this)">${lineCount} lines — show all</span>`
    : ''
  const body = lines.map(line => {
    let cls = 'diff-line'
    if (line.startsWith('@@')) cls += ' diff-hunk'
    else if (line.startsWith('+') && !line.startsWith('+++')) cls += ' diff-add'
    else if (line.startsWith('-') && !line.startsWith('---')) cls += ' diff-del'
    return `<span class="${cls}">${esc(line) || ' '}</span>`
  }).join('\n')
  const locHeader = (base || op)
    ? `<div class="edit-diff-loc">${op ? `<span class="edit-diff-badge">${esc(op)}</span>` : ''}${base ? `<span class="edit-diff-path">${esc(base)}</span>` : ''}<span class="edit-diff-stat">+${addCount} −${delCount}</span></div>`
    : ''
  const moved = input.movedTo ? `<div class="edit-diff-loc"><span class="edit-diff-path">→ ${esc(input.movedTo)}</span></div>` : ''
  return `<div class="code-block-wrap code-card edit-diff-wrap edit-unified-diff-wrap">${locHeader}${moved}
    <div class="code-block-header"><span class="code-block-lang">diff</span>${toggleHtml}<span class="code-block-copy" title="Copy">⎘</span></div>
    ${copySourceTemplate(diff)}<pre class="edit-unified-diff fold-body${foldCls}"${foldStyle}><code>${body}</code></pre>
  </div>`
}

export function renderCodeCard(toolName, input, ctx) {
  if (!input) return ''
  const { langFromFilePath, highlightSyntax } = ctx
  const n = (toolName || '').toLowerCase()

  if (n === 'bash' && input.command) {
    const cmd = input.command
    const lines = cmd.split('\n')
    if (lines.length < 3 && cmd.length < 120) return ''
    const escaped = esc(cmd)
    const highlighted = highlightSyntax(escaped, 'bash')
    const h = ctx?.foldHeights?.bash ?? 10
    const shouldFold = h > 0 && lines.length > h
    const foldClass = shouldFold ? ' code-collapsed' : ''
    const foldStyle = shouldFold ? ` style="max-height:${(h * 1.4).toFixed(1)}em"` : ''
    const toggleHtml = shouldFold
      ? `<span class="code-block-toggle" onclick="(function(e){var w=e.closest('.code-block-wrap'),p=w.querySelector('pre');if(p.classList.contains('code-collapsed')){p.classList.remove('code-collapsed');p.style.maxHeight='';e.textContent='collapse'}else{p.classList.add('code-collapsed');p.style.maxHeight='${(h * 1.4).toFixed(1)}em';e.textContent='${lines.length} lines — show all'}})(this)">${lines.length} lines — show all</span>`
      : ''
    return `<div class="code-block-wrap code-card">
      <div class="code-block-header"><span class="code-block-lang">bash</span>${toggleHtml}<span class="code-block-copy" title="Copy">⎘</span></div>
      ${copySourceTemplate(cmd)}<pre class="${foldClass}"${foldStyle}><code data-lang="bash" data-highlighted="1">${highlighted}</code></pre>
    </div>`
  }

  if (n === 'write' && input.content) {
    const content = input.content
    const lines = content.split('\n')
    if (lines.length < 2) return ''
    const filePath = input.file_path || ''
    const isMd = /\.md$/i.test(filePath)
    const isTex = /\.tex$/i.test(filePath)
    const lang = langFromFilePath(filePath)
    const escaped = esc(content)
    if (isTex) {
      const h = ctx?.foldHeights?.write ?? 10
      const shouldFold = h > 0 && lines.length > h
      const foldStyle = shouldFold ? ` style="max-height:${(h * 1.4).toFixed(1)}em"` : ''
      const name = filePath.split('/').pop() || 'file.tex'
      const uid = 'tex-write-' + Math.random().toString(36).slice(2, 8)
      const toggleHtml = shouldFold
        ? `<span class="code-block-toggle" onclick="(function(e){var w=e.closest('.code-block-wrap'),p=w.querySelector('.diff-tex');if(p.classList.contains('code-collapsed')){p.classList.remove('code-collapsed');p.style.maxHeight='';e.textContent='collapse'}else{p.classList.add('code-collapsed');p.style.maxHeight='${(h * 1.4).toFixed(1)}em';e.textContent='${lines.length} lines — show all'}})(this)">${lines.length} lines — show all</span>`
        : ''
      const rendered = renderTexLines(content, ctx.preambleMacros || {})
      return `<div class="code-block-wrap code-card" id="${uid}">
        <div class="code-block-header"><span class="code-block-lang">tex</span><span class="tex-filename">${esc(name)}</span>${toggleHtml}<span class="code-block-copy" title="Copy">⎘</span></div>
        ${copySourceTemplate(content)}<div class="diff-tex fold-body${shouldFold ? ' code-collapsed' : ''}"${foldStyle}>${rendered}</div>
      </div>`
    }
    if (isMd) {
      // Markdown writes are monitoring content (a written file), so they're foldable
      // per the md fold-height pref. Default pref is 0 (never fold). Render with
      // markdown+KaTeX so LaTeX in scratch files is readable.
      const isScratch = /\/scratch\//.test(filePath)
      const name = filePath.split('/').pop() || 'file.md'
      const chipClass = isScratch ? 'md-file-card scratch-card' : 'md-file-card'
      const h = ctx?.foldHeights?.md ?? 0
      const shouldFold = h > 0 && lines.length > h
      const maxH = shouldFold ? `max-height:${(h * 1.4).toFixed(1)}em;` : ''
      const foldStyle = shouldFold ? ` style="${maxH}"` : ''
      const toggleHtml = shouldFold
        ? `<span class="code-block-toggle" onclick="(function(e){var w=e.closest('.code-block-wrap'),p=w.querySelector('.fold-body');if(p.classList.contains('code-collapsed')){p.classList.remove('code-collapsed');p.style.maxHeight='';e.textContent='collapse'}else{p.classList.add('code-collapsed');p.style.maxHeight='${(h * 1.4).toFixed(1)}em';e.textContent='${lines.length} lines — show all'}})(this)">${lines.length} lines — show all</span>`
        : ''
      const foldCls = shouldFold ? ' code-collapsed' : ''
      const body = ctx.renderMarkdown
        ? `<div class="pretty-msg-body md-write-body fold-body${foldCls}"${foldStyle}>${ctx.renderMarkdown(esc(content))}</div>`
        : `<pre class="fold-body${foldCls}" style="${maxH}white-space:pre-wrap;word-break:break-word"><code>${escaped}</code></pre>`
      return `<div class="code-block-wrap code-card">
      <div class="code-block-header"><span class="${chipClass}" data-path="${esc(filePath)}" draggable="true"><span class="md-file-chip">${esc(name)}</span></span>${toggleHtml}<span class="code-block-copy" title="Copy">⎘</span></div>
      ${copySourceTemplate(content)}${body}
    </div>`
    }
    const h = ctx?.foldHeights?.write ?? 10
    const shouldFold = h > 0 && lines.length > h
    const highlighted = (!shouldFold && lang) ? highlightSyntax(escaped, lang) : escaped
    const foldClass = shouldFold ? ' code-collapsed' : ''
    const foldStyle = shouldFold ? ` style="max-height:${(h * 1.4).toFixed(1)}em"` : ''
    const langLabel = lang || filePath.split('.').pop() || ''
    const toggleHtml = shouldFold
      ? `<span class="code-block-toggle" onclick="(function(e){var w=e.closest('.code-block-wrap'),p=w.querySelector('pre'),c=p.querySelector('code');if(p.classList.contains('code-collapsed')){p.classList.remove('code-collapsed');p.style.maxHeight='';e.textContent='collapse';if(c.dataset.lang&&!c.dataset.highlighted){c.innerHTML=window._highlightSyntax(c.textContent,c.dataset.lang);c.dataset.highlighted='1'}}else{p.classList.add('code-collapsed');p.style.maxHeight='${(h * 1.4).toFixed(1)}em';e.textContent='${lines.length} lines — show all'}})(this)">${lines.length} lines — show all</span>`
      : ''
    return `<div class="code-block-wrap code-card">
      <div class="code-block-header">${langLabel ? `<span class="code-block-lang">${esc(langLabel)}</span>` : ''}${toggleHtml}<span class="code-block-copy" title="Copy">⎘</span></div>
      ${copySourceTemplate(content)}<pre class="${foldClass}"${foldStyle}><code${lang ? ` data-lang="${esc(lang)}"` : ''}${!shouldFold && lang ? ' data-highlighted="1"' : ''}>${highlighted}</code></pre>
    </div>`
  }

  return ''
}

// --- Deduplication ---

export function dedupTools(toolItems) {
  const editedFiles = new Set()
  for (const t of toolItems) {
    if ((t._toolName || '').toLowerCase() === 'edit' && t._toolArg) editedFiles.add(t._toolArg)
  }

  const result = []
  for (let i = 0; i < toolItems.length; i++) {
    const t = toolItems[i]
    const key = (t._toolName || '') + ':' + (t._toolArg || '')
    const prev = result.length ? result[result.length - 1] : null
    const name = (t._toolName || '').toLowerCase()
    if (name === 'read' && editedFiles.has(t._toolArg)) continue
    if (name === 'read' && prev && (prev._toolName || '').toLowerCase() === 'read' && prev._toolArg !== t._toolArg) {
      if (!prev._mergedArgs) prev._mergedArgs = [prev._toolArg]
      prev._mergedArgs.push(t._toolArg)
      prev._toolArg = prev._mergedArgs.map(a => (a || '').split('/').pop()).join(', ')
      prev._count++
      continue
    }
    // A pretty-print result can arrive as a SEPARATE follow-up event after its
    // tool_use (e.g. propose_edit's result lands a batch later, with an unrelated
    // tool call in between). It carries the same tool+arg as the original, so
    // without folding it in here we'd render a duplicate card and only the
    // follow-up would carry the result. Merge onto the first matching tool item
    // regardless of adjacency, then drop the follow-up.
    if (t._prettyResult) {
      const host = result.find(r => r._key === key && !r._prettyResult)
      if (host) { host._prettyResult = t._prettyResult; host._count++; continue }
    }
    if (prev && prev._key === key) {
      prev._count++
      // Merge prettyResult from follow-up event (e.g. _prettyResult events arriving after the tool_use)
      if (!prev._prettyResult && t._prettyResult) prev._prettyResult = t._prettyResult
    } else {
      result.push({ ...t, _key: key, _count: 1 })
    }
  }
  return result
}

// --- Main renderer ---

export function renderActivityGroup(group, ctx) {
  const { agentLabel, getNickClass, getAgents } = ctx
  const m = group[group.length - 1]
  const nick = agentLabel(m.from)
  const fromCls = getNickClass(m.from)
  const agent = getAgents().find(a => a.id === m.from)
  const ctxPct = m._ctxPct ?? agent?.context_pct
  const ctxHtml = ctxPct != null ? `<span class="activity-ctx">${ctxPct}%</span>` : ''

  const tools = group.filter(t => t._toolName)
  const lastTool = tools.length ? tools[tools.length - 1] : null
  const texts = group.filter(t => t._isText)
  const lastText = texts.length ? texts[texts.length - 1] : null

  let headerSummary = ''
  if (lastText && lastText._text) {
    headerSummary = esc(lastText._text.split('\n')[0])
  } else if (lastTool) {
    const extra = tools.length > 1 ? ` <span class="activity-more">(+${tools.length - 1} more)</span>` : ''
    headerSummary = `${esc(lastTool._toolName)}: ${esc(lastTool._toolArg || '')}${extra}`
  }

  const badge = `<span class="activity-badge">`
    + `<span class="activity-agent ${fromCls}">${esc(nick)}</span> `
    + (group.length > 1 ? `<span class="activity-count">${group.length}</span> ` : '')
    + `<span class="activity-signal"></span>`
    + ctxHtml
    + `</span>`

  const segments = []
  let currentTools = []
  for (const t of group) {
    if (t._isText) {
      if (currentTools.length) { segments.push({ type: 'tools', items: currentTools }); currentTools = [] }
      segments.push({ type: 'text', item: t })
    } else {
      currentTools.push(t)
    }
  }
  if (currentTools.length) segments.push({ type: 'tools', items: currentTools })

  let lineNum = 1
  const detailHtml = segments.map(seg => {
    if (seg.type === 'text') {
      const t = seg.item
      const fullText = (t._text || '')
        .replace(/<(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)[^>]*>[\s\S]*?<\/(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)>/g, '')
        .trim()
      if (fullText.includes('[Request interrupted by user]')) {
        return `<div class="activity-status-badge interrupt-badge">⏸ interrupted</div>`
      }
      if (fullText.startsWith('📬')) return ''
      // Render what the agent actually SAID/thought as markdown (code fences,
      // lists, math) — same renderer as every other rich block in this file —
      // instead of raw escaped text. This is the agent-terminal rendering Skip
      // relies on when an agent dumps code/thinking instead of chatting.
      // KEEP the fixed-height `scrollable` cap on long blocks: removing it let a
      // single block balloon to ~26000px, whose massive reflow destabilized the
      // chat scroll. Long blocks scroll within their own box; markdown still
      // renders. renderMarkdown expects esc()'d input.
      const allLines = fullText.split('\n')
      const long = allLines.length > 12 || fullText.length > 800
      const body = ctx.renderMarkdown ? ctx.renderMarkdown(esc(fullText)) : esc(fullText)
      return fullText ? `<div class="activity-text-block${long ? ' scrollable' : ''}"><div class="pretty-msg-body">${body}</div></div>` : ''
    }
    const deduped = dedupTools(seg.items)
    const toolLines = deduped.map(t => {
      const num = lineNum++
      // apply_proposal: don't redraw the whole diff (the propose card already
      // showed it). A compact "✓ edit applied" line + a reference to the
      // proposal keeps chat light; hover the reference to see what landed.
      if ((t._toolName || '').toLowerCase().endsWith('apply_proposal')) {
        const pid = t._toolInput?.id || ''
        return `<div class="tool-line tool-apply-line" data-line="${num}" data-tool-name="${esc(t._toolName || '')}">`
          + `<span class="tool-linenum">${num}</span>`
          + `<span class="apply-check">✓</span>`
          + `<span class="apply-text">edit applied</span>`
          + (pid ? `<span class="apply-ref" data-token="«${esc(pid)}#proposal:${esc(pid)}»">${esc(pid)}</span>` : '')
          + `</div>`
      }
      const countHtml = t._count > 1 ? `<span class="tool-count">×${t._count}</span>` : ''
      const toolNameRaw = t._toolName || ''
      const isSkill = toolNameRaw === 'Skill'
      let arg = t._toolArg ? esc(t._toolArg) : ''
      arg = arg.replace(/\{\{att:(\d+)\}\}/g, (_, idx) => `<span class="md-file-chip">att:${idx}</span>`)
      let displayName = toolNameRaw
      let detail = t._toolDetail ? `<div class="tool-detail">${esc(t._toolDetail)}</div>` : ''
      // Skill tool: render as an ordinary tool card — surface *which* skill is
      // running as the argument (no special icon or color).
      if (isSkill) {
        const skillName = t._toolInput?.skill || ''
        const skillArgs = t._toolInput?.args || ''
        arg = skillName ? esc(skillName) : arg
        detail = skillArgs ? `<div class="tool-detail">${esc(skillArgs)}</div>` : ''
      }
      const tnLower = (t._toolName || '').toLowerCase()
      // A propose_edit carries the same {old_string,new_string} triple as Edit,
      // so it renders as the same diff card — flagged tentative (not yet applied).
      const isPropose = tnLower.endsWith('propose_edit') && t._toolInput?.old_string && t._toolInput?.new_string
      const isEdit = (tnLower === 'edit' || isPropose) && t._toolInput?.old_string && t._toolInput?.new_string
      const isUnifiedEdit = tnLower === 'edit' && typeof t._toolInput?.diff === 'string' && t._toolInput.diff.trim()
      const hasDiff = (isEdit || isUnifiedEdit) ? ' has-diff' : ''
      // The propose result text ("**Proposal proposal-1** …") carries the id the
      // matching apply_proposal references; stamp it on the card so the apply
      // line's hover can find this card in the DOM by `data-proposal-id`.
      const proposalId = isPropose
        ? (String(t._prettyResult || '').match(/proposal-[\w-]+/)?.[0] || '')
        : ''
      const diffHtml = isEdit
        ? renderEditDiff(t._toolInput, ctx, { isPropose, proposalId })
        : (isUnifiedEdit ? renderUnifiedEditDiff(t._toolInput, ctx) : '')
      const codeCardHtml = renderCodeCard(t._toolName, t._toolInput, ctx)
      const cmd = toolToCommand(t._toolName, t._toolInput)
      const cmdAttr = cmd ? ` data-cmd="${esc(cmd)}"` : ''
      const copyBtn = cmd ? `<span class="tool-copy" title="Copy command">⎘</span>` : ''
      const showArg = arg && !codeCardHtml
      // For a propose_edit the diff card already shows the change; its result text
      // ("**Proposal proposal-N**…") is only consumed to extract the id above, so
      // don't also render it as a raw result block under the card.
      const prettyHtml = (t._prettyResult && !isPropose)
        ? renderPrettyResult(t._toolName, t._prettyResult, ctx, t._toolInput, t.timestamp)
        : ''
      return `<div class="tool-line${hasDiff}"${cmdAttr} data-line="${num}" data-tool-name="${esc(t._toolName || '')}" data-tool-arg="${esc(t._toolArg || '')}">`
        + `<span class="drag-handle" title="Drag tool call"></span>`
        + `<span class="tool-linenum">${num}</span>`
        + `${countHtml}`
        + `<span class="tool-name">${esc(displayName)}</span>`
        + (showArg ? `<span class="tool-sep">:</span> <span class="tool-arg">${arg}</span>` : '')
        + detail
        + copyBtn
        + `</div>`
        + diffHtml
        + codeCardHtml
        + prettyHtml
    }).join('')
    const cardId = 'tr-' + Math.random().toString(36).slice(2, 8)
    return `<div class="tool-run-card" data-card-id="${cardId}">
      <div class="tool-run-body">${toolLines}</div>
    </div>`
  }).join('')

  return `<div class="chat-activity-card will-fold" data-agent="${esc(m.from)}" data-ts="${esc(group[0].timestamp || '')}" data-msg-id="${esc(String(m._dbId || ''))}">
    <div class="drag-handle" title="Drag"></div>
    <div class="activity-header">
      <span class="activity-agent ${fromCls}">${esc(nick)}</span>
      <span class="activity-last-tool">${headerSummary}</span>
      ${group.length > 1 ? `<span class="activity-count">${group.length}</span>` : ''}
      <span class="activity-signal"></span>
      ${ctxHtml}
    </div>
    <div class="activity-detail">${badge}<div class="activity-detail-inner">${detailHtml}</div></div>
  </div>`
}
