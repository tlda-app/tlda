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

// --- Pure helpers (copied from utils.mjs) ---

export function esc(s) {
  if (s == null) return ''
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// --- Constants ---

export const ACTIVITY_NOISE = new Set([
  'wait_for_task', 'my_task', 'task_list', 'register', 'register_manager',
  'task_check', 'unregister_manager', 'task_done', 'timer',
  'mcp__fleet__wait_for_task', 'mcp__fleet__my_task', 'mcp__fleet__task_list',
  'mcp__fleet__register', 'mcp__fleet__register_manager', 'mcp__fleet__task_check',
  'mcp__fleet__task_done', 'mcp__fleet__timer',
  'ToolSearch',
])

export const CHAT_TOOLS = new Set([
  'chat', 'delegate', 'mcp__fleet__chat', 'mcp__fleet__delegate',
])

// --- Pretty-print tool results ---

function renderPrettyResult(toolName, text, ctx) {
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
  // Fallback: render as markdown
  const md = ctx.renderMarkdown ? ctx.renderMarkdown(text) : esc(text)
  return `<div class="tool-pretty-result">${md}</div>`
}

function renderScreenshotResult(text) {
  // Render a placeholder that the AnnotationViewer overlay will position over.
  // Height matches how images display in chat (~200px).
  const pageMatch = text.match(/page (\d+)/i)
  const label = pageMatch ? `📷 p.${pageMatch[1]}` : '📷'
  return `<div class="screenshot-placeholder" data-screenshot="true">
    <span class="screenshot-placeholder-label">${esc(label)}</span>
  </div>`
}

function renderThreadResult(text, ctx) {
  // Format: "[timestamp] from → to\nmessage\n\n---\n\n[timestamp] from → to\n..."
  // Split on --- separators
  const msgs = text.split(/\n\n---\n\n/)
  if (msgs.length <= 1) {
    return `<div class="tool-pretty-result">${esc(text)}</div>`
  }
  const THREAD_PREVIEW = 5
  const hasMoreMsgs = msgs.length > THREAD_PREVIEW
  const renderMsg = (msg) => {
    const headerMatch = msg.match(/^\[([^\]]*)\]\s*(\S+)\s*→\s*(\S+)\n([\s\S]*)$/)
    if (!headerMatch) return `<div class="pretty-thread-msg"><div class="pretty-msg-body">${esc(msg)}</div></div>`
    const [, ts, from, to, body] = headerMatch
    const fromCls = ctx.getNickClass ? ctx.getNickClass(from) : ''
    const toCls = ctx.getNickClass ? ctx.getNickClass(to) : ''
    const shortTs = ts.replace(/^\d+\/\d+\/\d+,?\s*/, '')
    const bodyHtml = ctx.renderMarkdown ? ctx.renderMarkdown(body.trim()) : esc(body.trim())
    return `<div class="pretty-thread-msg">
      <div class="pretty-msg-header"><span class="pretty-ts">${esc(shortTs)}</span> <span class="${fromCls}">${esc(from)}</span> <span class="pretty-arrow">→</span> <span class="${toCls}">${esc(to)}</span></div>
      <div class="pretty-msg-body">${bodyHtml}</div>
    </div>`
  }
  // Show last N messages by default (most recent are most relevant)
  const visibleMsgs = hasMoreMsgs ? msgs.slice(-THREAD_PREVIEW) : msgs
  const rows = visibleMsgs.map(renderMsg).join('')
  let moreHtml = ''
  if (hasMoreMsgs) {
    const hiddenRows = msgs.slice(0, msgs.length - THREAD_PREVIEW).map(renderMsg).join('')
    moreHtml = `<div class="pretty-expand-btn">${msgs.length - THREAD_PREVIEW} earlier — show all</div>`
      + `<div class="pretty-more-rows" style="display:none">${hiddenRows}</div>`
  }
  const headerLine = text.match(/^(⚠️[^\n]*\n)?(\d+ messages:)\n/)
  const header = headerLine ? `<div class="pretty-result-header">${esc(headerLine[0].trim())}</div>` : ''
  return `<div class="tool-pretty-result tool-pretty-thread">${header}${moreHtml}${rows}</div>`
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
  const PREVIEW_COUNT = 5
  const hasMore = results.length > PREVIEW_COUNT
  const rows = results.slice(0, PREVIEW_COUNT).map((r, i) => {
    // Parse "timestamp | [source] [role] agent | snippet" format
    const pipeMatch = r.match(/^([^|]+)\|([^|]+)\|(.+)$/s)
    const stripe = i % 2 === 0 ? 'pretty-row-even' : 'pretty-row-odd'
    if (pipeMatch) {
      const ts = pipeMatch[1].trim()
      const source = pipeMatch[2].trim()
      const snippet = pipeMatch[3].trim()
      const highlightedSnippet = esc(snippet).replace(/\*\*([^*]+)\*\*/g, '<mark>$1</mark>')
      const tsShort = ts.replace(/^\d+\/\d+\/\d+,?\s*/, '')  // strip date, keep time
      return `<div class="pretty-search-row ${stripe}" draggable="true" data-ts="${esc(ts)}">
        <span class="pretty-search-ts" title="${esc(ts)}">${esc(tsShort)}</span>
        <span class="pretty-search-source">${esc(source)}</span>
        <span class="pretty-search-snippet">${highlightedSnippet}</span>
      </div>`
    }
    // Fallback: unstructured result
    const highlighted = esc(r).replace(/\*\*([^*]+)\*\*/g, '<mark>$1</mark>')
    return `<div class="pretty-search-row ${stripe}">${highlighted}</div>`
  }).join('')
  // Render remaining rows hidden, with expand button
  let moreHtml = ''
  if (hasMore) {
    const hiddenRows = results.slice(PREVIEW_COUNT).map((r, i) => {
      const idx = i + PREVIEW_COUNT
      const pipeMatch = r.match(/^([^|]+)\|([^|]+)\|(.+)$/s)
      const stripe = idx % 2 === 0 ? 'pretty-row-even' : 'pretty-row-odd'
      if (pipeMatch) {
        const ts = pipeMatch[1].trim()
        const source = pipeMatch[2].trim()
        const snippet = pipeMatch[3].trim()
        const highlightedSnippet = esc(snippet).replace(/\*\*([^*]+)\*\*/g, '<mark>$1</mark>')
        const tsShort = ts.replace(/^\d+\/\d+\/\d+,?\s*/, '')
        return `<div class="pretty-search-row ${stripe}" draggable="true" data-ts="${esc(ts)}">
          <span class="pretty-search-ts" title="${esc(ts)}">${esc(tsShort)}</span>
          <span class="pretty-search-source">${esc(source)}</span>
          <span class="pretty-search-snippet">${highlightedSnippet}</span>
        </div>`
      }
      const highlighted = esc(r).replace(/\*\*([^*]+)\*\*/g, '<mark>$1</mark>')
      return `<div class="pretty-search-row ${stripe}">${highlighted}</div>`
    }).join('')
    moreHtml = `<div class="pretty-more-rows" style="display:none">${hiddenRows}</div>`
      + `<div class="pretty-expand-btn">${results.length - PREVIEW_COUNT} more — show all</div>`
  }
  return `<div class="tool-pretty-result tool-pretty-search">
    <div class="pretty-result-header">${esc(header)}</div>
    ${rows}
    ${moreHtml}
  </div>`
}

// --- Tool helpers ---

export function humanizeToolName(name) {
  let n = (name || '').replace(/^mcp__/, '').replace(/__/g, '/')
  const shorts = { 'fleet/chat': 'chat', 'fleet/delegate': 'delegate', 'fleet/task_done': 'done',
    'fleet/interrupt': 'interrupt', 'fleet/label_agent': 'label', 'fleet/respawn': 'respawn',
    'fleet/spawn': 'spawn', 'fleet/name_agent': 'name', 'fleet/search_logs': 'search_logs' }
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

export function renderEditDiff(input, ctx) {
  if (!input?.old_string || !input?.new_string) return ''
  const { langFromFilePath, highlightSyntax } = ctx
  const uid = 'diff-' + Math.random().toString(36).slice(2, 8)
  const isTeX = input.file_path && /\.tex$/i.test(input.file_path)
  const lang = !isTeX ? langFromFilePath(input.file_path) : ''
  const renderSide = (str) => {
    if (!isTeX) {
      const escaped = esc(str)
      return `<pre><code>${lang ? highlightSyntax(escaped, lang) : escaped}</code></pre>`
    }
    const rendered = str.split('\n').map(line => {
      const trimmed = line.trim()
      if (/^\\(begin|end|label|item|section|subsection|usepackage|documentclass)\b/.test(trimmed)) return `<code>${esc(line)}</code>`
      if (/\\[a-zA-Z]/.test(trimmed) && !/^%/.test(trimmed)) {
        try {
          return katex.renderToString(trimmed, { displayMode: true, throwOnError: true, macros: ctx.preambleMacros || {} })
        } catch {
          return `<span class="diff-tex-raw">${esc(line)}</span>`
        }
      }
      return esc(line) || '&nbsp;'
    }).join('<br>')
    return `<div class="diff-tex">${rendered}</div>`
  }
  return `<div class="edit-diff${isTeX ? ' tex-diff' : ''}" id="${uid}">
    <div class="diff-side diff-old"><div class="diff-label">−</div>${renderSide(input.old_string)}</div>
    <div class="diff-side diff-new"><div class="diff-label">+</div>${renderSide(input.new_string)}</div>
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
    const shouldFold = lines.length > 10
    const foldClass = shouldFold ? ' code-collapsed' : ''
    const toggleHtml = shouldFold
      ? `<span class="code-block-toggle" onclick="(function(e){var w=e.closest('.code-block-wrap'),p=w.querySelector('pre');if(p.classList.contains('code-collapsed')){p.classList.remove('code-collapsed');e.textContent='collapse'}else{p.classList.add('code-collapsed');e.textContent='${lines.length} lines — show all'}})(this)">${lines.length} lines — show all</span>`
      : ''
    return `<div class="code-block-wrap code-card">
      <div class="code-block-header"><span class="code-block-lang">bash</span>${toggleHtml}<span class="code-block-copy" title="Copy">⎘</span></div>
      <pre class="${foldClass}"><code data-lang="bash" data-highlighted="1">${highlighted}</code></pre>
    </div>`
  }

  if (n === 'write' && input.content) {
    const content = input.content
    const lines = content.split('\n')
    if (lines.length < 2) return ''
    const lang = langFromFilePath(input.file_path)
    const escaped = esc(content)
    const shouldFold = lines.length > 10
    const highlighted = (!shouldFold && lang) ? highlightSyntax(escaped, lang) : escaped
    const foldClass = shouldFold ? ' code-collapsed' : ''
    const langLabel = lang || input.file_path?.split('.').pop() || ''
    const toggleHtml = shouldFold
      ? `<span class="code-block-toggle" onclick="(function(e){var w=e.closest('.code-block-wrap'),p=w.querySelector('pre'),c=p.querySelector('code');if(p.classList.contains('code-collapsed')){p.classList.remove('code-collapsed');e.textContent='collapse';if(c.dataset.lang&&!c.dataset.highlighted){c.innerHTML=window._highlightSyntax(c.textContent,c.dataset.lang);c.dataset.highlighted='1'}}else{p.classList.add('code-collapsed');e.textContent='${lines.length} lines — show all'}})(this)">${lines.length} lines — show all</span>`
      : ''
    return `<div class="code-block-wrap code-card">
      <div class="code-block-header">${langLabel ? `<span class="code-block-lang">${esc(langLabel)}</span>` : ''}${toggleHtml}<span class="code-block-copy" title="Copy">⎘</span></div>
      <pre class="${foldClass}"><code${lang ? ` data-lang="${esc(lang)}"` : ''}${!shouldFold && lang ? ' data-highlighted="1"' : ''}>${highlighted}</code></pre>
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
    if (prev && prev._key === key) {
      prev._count++
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
      const allLines = fullText.split('\n')
      const long = allLines.length > 12 || fullText.length > 800
      return fullText ? `<div class="activity-text-block${long ? ' scrollable' : ''}">${esc(fullText)}</div>` : ''
    }
    const deduped = dedupTools(seg.items)
    const toolLines = deduped.map(t => {
      const num = lineNum++
      const countHtml = t._count > 1 ? `<span class="tool-count">×${t._count}</span>` : ''
      let arg = t._toolArg ? esc(t._toolArg) : ''
      arg = arg.replace(/\{\{att:(\d+)\}\}/g, (_, idx) => `<span class="md-file-chip">att:${idx}</span>`)
      const detail = t._toolDetail ? `<div class="tool-detail">${esc(t._toolDetail)}</div>` : ''
      const isEdit = (t._toolName || '').toLowerCase() === 'edit' && t._toolInput?.old_string && t._toolInput?.new_string
      const hasDiff = isEdit ? ' has-diff' : ''
      const diffHtml = isEdit ? renderEditDiff(t._toolInput, ctx) : ''
      const codeCardHtml = renderCodeCard(t._toolName, t._toolInput, ctx)
      const cmd = toolToCommand(t._toolName, t._toolInput)
      const cmdAttr = cmd ? ` data-cmd="${esc(cmd)}"` : ''
      const copyBtn = cmd ? `<span class="tool-copy" title="Copy command">⎘</span>` : ''
      const showArg = arg && !codeCardHtml
      const prettyHtml = t._prettyResult
        ? renderPrettyResult(t._toolName, t._prettyResult, ctx)
        : ''
      return `<div class="tool-line${hasDiff}"${cmdAttr} data-line="${num}" data-tool-name="${esc(t._toolName || '')}" data-tool-arg="${esc(t._toolArg || '')}">`
        + `<span class="drag-handle" title="Drag tool call"></span>`
        + `<span class="tool-linenum">${num}</span>`
        + `${countHtml}`
        + `<span class="tool-name">${esc(t._toolName || '')}</span>`
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

  return `<div class="chat-activity-card will-fold" data-agent="${esc(m.from)}" data-ts="${esc(group[0].timestamp || '')}">
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
