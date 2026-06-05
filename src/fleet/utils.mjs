import katex from 'katex'
import 'katex/dist/katex.min.css'
import { getAgents, getAgent } from './fleet-data.mjs'
import { getActiveMacros } from '../katexMacros'
import { myTldaUrl } from './tldaUrl.mjs'
import { baseName } from '../../shared/lineage-name.mjs'
// Utility functions. Agent lookups read from fleet-data directly.

const _tldaToken = null // was from state.mjs (removed)

// --- Error reporting ---
// Posts errors to /api/error so the dashboard surfaces them.
// Debounced per source+message to avoid flooding.
const _errorSeen = new Map()
export function fleetError(source, message, extra) {
  const key = `${source}:${message}`
  const now = Date.now()
  if (_errorSeen.has(key) && now - _errorSeen.get(key) < 30000) return // dedup within 30s
  _errorSeen.set(key, now)
  const stack = new Error().stack?.split('\n').slice(2, 5).map(l => l.trim()).join(' <- ')
  fetch('/api/error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, message, stack, context: extra }),
  }).catch(() => {}) // fire-and-forget — don't recurse on failure
}

// --- HTML escaping ---
export function esc(s) {
  if (s == null) {
    fleetError('esc', 'received null/undefined', new Error().stack?.split('\n')[2]?.trim())
    return ''
  }
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

// Require a value — report error and return placeholder if missing
export function requireVal(val, name) {
  if (val == null) {
    fleetError('requireVal', `Missing required value: ${name}`, new Error().stack?.split('\n')[2]?.trim())
    return `[missing:${name}]`
  }
  return val
}

export function smoothScrollToBottom(el) { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }) }

// Single scroll contract for chat log. Call after any DOM mutation.
// opts.prependHeight: if content was prepended, the height delta to adjust by
export function commitScroll(log, container, opts) {
  if (!log) return
  if (opts?.prependHeight) {
    // Content prepended (load-more, DB history) — keep viewport stable
    log.scrollTop = log.scrollHeight - opts.prependHeight + (opts.prevScroll || 0)
  } else if (container._autoScroll !== false) {
    // Cancel any in-progress smooth scroll, then snap to bottom.
    // Smooth scroll animations can override instant scrollTop assignments,
    // causing a ~3-line gap when content grows during the animation.
    log.scrollTo({ top: log.scrollHeight, behavior: 'instant' })
    requestAnimationFrame(() => { log.scrollTo({ top: log.scrollHeight, behavior: 'instant' }) })
  }
  // else: user is reading history, don't touch scroll
}

export function timeShort(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// --- Identity ---
export function isHumanId(id) {
  const a = (getAgents() || []).find(a => a.id === id)
  return !!(a?.human)
}

export function humanIdSet() {
  const s = new Set()
  for (const a of (getAgents() || [])) {
    if (a.human) s.add(a.id)
  }
  return s
}

// --- Agent display ---
export function agentLabel(id) {
  const a = getAgent(id)
  if (a) return baseName(a.friendly_name) || a.id
  if (id == null) { fleetError('agentLabel', 'null agent id'); return '[unknown]' }
  return typeof id === 'string' ? id : String(id)
}

export function isActive(a) {
  return a.last_seen && (Date.now() - new Date(a.last_seen).getTime()) < 600000
}

// --- Nick colors (stable per-agent) ---
const nickColors = ['nick-agent-0','nick-agent-1','nick-agent-2','nick-agent-3','nick-agent-4','nick-agent-5']
const nickMap = new Map()
let nickIdx = 0

export function getNickClass(id) {
  if (isHumanId(id)) return 'nick-human'
  if (id === 'keepalive') return 'nick-keepalive'
  if (!nickMap.has(id)) {
    nickMap.set(id, nickColors[nickIdx % nickColors.length])
    nickIdx++
  }
  return nickMap.get(id)
}

// --- Shared agent pill renderer ---
// Returns HTML for a consistent, draggable agent name pill.
// Used in agents panel, tasks table, chat messages.
export function renderAgentPill(agentId, opts = {}) {
  const name = agentLabel(agentId)
  const cls = getNickClass(agentId)
  const agent = getAgent(agentId)
  const dead = agent && !isActive(agent) && !agent.compacting
  const respawnHtml = dead && !opts.noRespawn
    ? ` <span class="agent-respawn-btn" data-agent-id="${esc(agentId)}" title="Respawn agent">↻</span>`
    : ''
  return `<span class="agent-pill ${cls}" data-agent-id="${esc(agentId)}" data-agent-label="${esc(name)}"${dead ? ' data-dead="1"' : ''}>${esc(name)}${respawnHtml}</span>`
}

// --- Agent/label matching ---
export function agentMatchesDnf(dnf, agent) {
  if (!dnf || dnf.length === 0) return true
  const labels = [...(agent.labels || [])]
  if (agent.status === 'awake') labels.push('awake')
  else if (agent.status === 'hibernating') labels.push('hibernating')
  if (agent.friendly_name) labels.push(agent.friendly_name)
  if (agent.id) labels.push(agent.id)
  // Terms are [role, label] tuples or plain strings
  return dnf.some(andGroup => andGroup.every(term => {
    const label = Array.isArray(term) ? term[1] : term
    return labels.includes(label)
  }))
}

export function dnfMatches(dnf, agentLabels) {
  if (!dnf || dnf.length === 0) return true
  return dnf.some(andGroup => andGroup.every(term => {
    const label = Array.isArray(term) ? term[1] : term
    return agentLabels.includes(label)
  }))
}

// --- Label colors (hash-based) ---
const LABEL_COLORS = ['#9370db','#7ab8a0','#c8b060','#7a9ec8','#c8956a','#6aafb0','#b87a95','#8bc87a']
const LABEL_COLOR_CLASSES = ['filter-chip-purple', 'filter-chip-green', 'filter-chip-yellow', 'filter-chip-blue', 'filter-chip-orange', 'filter-chip-cyan', 'filter-chip-pink', 'filter-chip-lime']

export function labelColor(name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0
  return LABEL_COLORS[Math.abs(h) % LABEL_COLORS.length]
}

export function labelColorClass(name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0
  return LABEL_COLOR_CLASSES[Math.abs(h) % LABEL_COLOR_CLASSES.length]
}

// --- Syntax highlighting ---
export function detectLang(hint, code) {
  if (hint) {
    const h = hint.toLowerCase()
    if (['js','javascript','jsx','ts','typescript','tsx','mjs','cjs'].includes(h)) return 'js'
    if (['json','jsonl'].includes(h)) return 'json'
    if (['bash','sh','shell','zsh'].includes(h)) return 'bash'
    if (['css','scss','less'].includes(h)) return 'css'
    if (['html','htm','xml','svg'].includes(h)) return 'html'
    if (['py','python'].includes(h)) return 'py'
    if (['r'].includes(h)) return 'r'
    return h
  }
  if (/^\s*\{[\s\S]*\}\s*$/.test(code) || /^\s*\[[\s\S]*\]\s*$/.test(code)) return 'json'
  if (/(?:function\s|const\s|let\s|var\s|=>\s*\{|import\s|export\s|require\()/.test(code)) return 'js'
  if (/(?:\$\(|apt |npm |pip |curl |wget |chmod |mkdir |cd |echo |grep )/.test(code)) return 'bash'
  if (/(?:def\s|import\s.*:$|print\(|class\s.*:$)/.test(code)) return 'py'
  return ''
}

export function highlightSyntax(code, lang) {
  const tokens = []

  function scan(re, cls, groupIdx) {
    const gi = groupIdx || 0
    re.lastIndex = 0
    let m
    while ((m = re.exec(code)) !== null) {
      const text = gi ? (m[gi] || m[0]) : m[0]
      const offset = gi ? m[0].indexOf(m[gi]) : 0
      const start = m.index + (offset >= 0 ? offset : 0)
      tokens.push({ start, end: start + text.length, cls })
    }
  }

  if (lang === 'json') {
    scan(/("(?:[^"\\]|\\.)*")\s*:/g, 'sh-key', 1)
    scan(/:\s*("(?:[^"\\]|\\.)*")/g, 'sh-string', 1)
    scan(/\b(true|false|null)\b/g, 'sh-bool')
    scan(/\b(\d+\.?\d*)\b/g, 'sh-number')
  } else if (lang === 'bash') {
    scan(/(#.*)$/gm, 'sh-comment')
    scan(/("(?:[^"\\]|\\.)*"|'[^']*')/g, 'sh-string')
    scan(/\b(if|then|else|elif|fi|for|do|done|while|case|esac|in|function|return|exit|local|export|source|eval)\b/g, 'sh-keyword')
    scan(/\b(echo|cd|ls|rm|cp|mv|mkdir|cat|grep|sed|awk|find|curl|wget|chmod|chown|git|npm|yarn|pip|python|node|make|tar|gzip|ssh|scp)\b/g, 'sh-builtin')
    scan(/(\$\w+|\$\{[^}]+\})/g, 'sh-property')
  } else if (lang === 'css') {
    scan(/(\/\*[\s\S]*?\*\/)/g, 'sh-comment')
    scan(/([.#][\w-]+)(?=\s*[{,])/g, 'sh-tag')
    scan(/([\w-]+)(?=\s*:)/g, 'sh-property')
  } else if (lang === 'html') {
    scan(/(<!--[\s\S]*?-->)/g, 'sh-comment')
    scan(/(&lt;\/?)([\w-]+)/g, 'sh-tag', 2)
    scan(/([\w-]+)(?==)/g, 'sh-attr')
    scan(/=("(?:[^"\\]|\\.)*"|'[^']*')/g, 'sh-string', 1)
  } else {
    scan(/(\/\/.*$)/gm, 'sh-comment')
    scan(/(\/\*[\s\S]*?\*\/)/g, 'sh-comment')
    if (lang === 'py' || lang === 'r') scan(/(#.*$)/gm, 'sh-comment')
    scan(/(`(?:[^`\\]|\\.)*`)/g, 'sh-string')
    scan(/("(?:[^"\\]|\\.)*")/g, 'sh-string')
    scan(/('(?:[^'\\]|\\.)*')/g, 'sh-string')
    scan(/\b(const|let|var|function|class|return|if|else|for|while|do|switch|case|break|continue|new|this|typeof|instanceof|import|export|from|default|async|await|try|catch|finally|throw|yield|of|in|delete|void|extends|super|static|get|set|def|lambda|with|as|elif|pass|raise|except|print)\b/g, 'sh-keyword')
    scan(/\b(true|false|null|undefined|NaN|Infinity|None|True|False|self)\b/g, 'sh-bool')
    scan(/\b(\d+\.?\d*(?:e[+-]?\d+)?)\b/gi, 'sh-number')
    scan(/\b([\w$]+)(?=\s*\()/g, 'sh-function')
    scan(/(=&gt;|=>)/g, 'sh-operator')
  }

  if (tokens.length === 0) return code

  tokens.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))

  const kept = []
  let maxEnd = 0
  for (const t of tokens) {
    if (t.start >= maxEnd) {
      kept.push(t)
      maxEnd = t.end
    }
  }

  let result = ''
  let pos = 0
  for (const t of kept) {
    if (t.start > pos) result += code.slice(pos, t.start)
    result += '<span class="' + t.cls + '">' + code.slice(t.start, t.end) + '</span>'
    pos = t.end
  }
  if (pos < code.length) result += code.slice(pos)
  return result
}
// Expose for lazy code block highlighting in renderMarkdown
window._highlightSyntax = highlightSyntax

export function langFromFilePath(path) {
  if (!path) return ''
  const ext = path.split('.').pop().toLowerCase()
  return detectLang(ext, '')
}

// --- Minimal markdown for single lines (shared doc content) ---
export function renderMarkdownLine(line) {
  let h = esc(line)
  h = h.replace(/^(#{1,6})\s+(.+)$/, (_, hashes, text) =>
    `<strong class="text-bright">${text}</strong>`)
  h = h.replace(/``([^`]+)``/g, '<code>$1</code>')
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  h = h.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
  h = h.replace(/^(\s*)[•\-\*]\s/, '$1• ')
  return h
}

// --- Full markdown renderer (marked + DOMPurify with fleet extensions) ---
export function renderMarkdown(html, extraMacros) {
  // Input arrives esc()'d — unescape back to raw markdown for marked
  let text = html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')

  // Strip system metadata tags that shouldn't render as HTML
  text = text.replace(/<(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)[^>]*>[\s\S]*?<\/(?:task-notification|system-reminder|local-command-caveat|command-name|command-message|command-args|local-command-stdout)>/g, '')

  // Placeholder system: extract content that marked/DOMPurify shouldn't touch
  const placeholders = []
  const ph = (content, block = false) => {
    const id = placeholders.length
    placeholders.push(content)
    // Block placeholders get newlines so marked doesn't wrap in <p>
    return block ? `\n\nFLEETPH${id}FLEET\n\n` : `FLEETPH${id}FLEET`
  }

  // --- Pre-pass: extract before marked ---

  // Code blocks with syntax highlighting + folding (our custom rendering)
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, langHint, code) => {
    code = code.replace(/^\n|\n$/g, '')
    const lang = detectLang(langHint, code)
    const lineCount = code.split('\n').length
    const shouldFold = lineCount > 10
    const highlighted = (!shouldFold && lang) ? highlightSyntax(code, lang) : esc(code)
    const langLabel = (lang || langHint)

    const header = `<div class="code-block-header"><span class="drag-handle" title="Drag"></span>`
      + (langLabel ? `<span class="code-block-lang">${esc(langLabel)}</span>` : '')
      + (shouldFold ? `<span class="code-block-toggle" onclick="(function(e){var w=e.closest('.code-block-wrap'),p=w.querySelector('pre'),c=p.querySelector('code'),t=e;if(p.classList.contains('code-collapsed')){p.classList.remove('code-collapsed');t.textContent='collapse';if(c.dataset.lang&&!c.dataset.highlighted){c.innerHTML=window._highlightSyntax(c.textContent,c.dataset.lang);c.dataset.highlighted='1'}}else{p.classList.add('code-collapsed');t.textContent='${lineCount} lines — show all'}})(this)">${lineCount} lines — show all</span>` : '')
      + `<span class="code-block-copy" title="Copy">⎘</span>`
      + `</div>`

    const dataAttrs = shouldFold && lang ? ` data-lang="${esc(lang)}"` : ''
    return ph(`<div class="code-block-wrap">${header}<pre${shouldFold ? ' class="code-collapsed"' : ''}><code${dataAttrs}>${highlighted}</code></pre></div>`, true)
  })

  // KaTeX macros — always start from getActiveMacros() (which includes defaultMacros),
  // then merge project-specific extraMacros on top so they can override but defaults
  // (like \griesz) are always available regardless of which doc is loaded.
  const preambleMacros = { ...getActiveMacros(), ...(extraMacros || {}) }
  // throwOnError: true so unparseable LaTeX falls through to the catch and
  // renders as raw escaped text. With throwOnError: false KaTeX returns its
  // own giant error-HTML structure, which we don't want dumped into chat.
  const katexOpts = (displayMode) => ({ displayMode, throwOnError: true, strict: false, macros: { ...preambleMacros } })

  // Display math: $$...$$
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, tex) => {
    let rendered
    try {
      rendered = katex.renderToString(tex.trim(), katexOpts(true))
    } catch {}
    return ph(rendered || `<div class="math-display">${esc(tex)}</div>`, true)
  })

  // Inline math: $...$
  text = text.replace(/(?<![\\$\w])\$([^$\n]+?)\$(?![\\$\w\d])/g, (_, tex) => {
    let rendered
    try {
      rendered = katex.renderToString(tex.trim(), katexOpts(false))
    } catch {}
    return ph(rendered || `<span class="math-inline">${esc(tex)}</span>`)
  })

  // Fleet-specific syntax: extract before marked mangles brackets
  // [file:/path/to/doc.md]
  text = text.replace(/\[file:(\/[\w/._-]+\.md)\]/g, (_, filePath) => {
    const name = filePath.split('/').pop()
    const isScratch = /\/scratch\//.test(filePath)
    const cls = isScratch ? 'md-file-card scratch-card' : 'md-file-card'
    const drag = isScratch ? ' draggable="true"' : ''
    return ph(`<span class="${cls}" data-path="${esc(filePath)}"${drag}><span class="md-file-chip">${esc(name)}</span><span class="md-file-body"></span></span>`)
  })
  // [tlda] snippet (from source)
  text = text.replace(/\[tlda\]\s*(.*?)\s*\(from ([^)]+)\)/g, (_, snippet, source) => {
    const m = source.match(/^tlda:([^/]+)\/?(.*)/);
    const project = m ? m[1] : '';
    const shapeId = m ? m[2] : '';
    const openUrl = project
      ? `${myTldaUrl()}/?doc=${encodeURIComponent(project)}${shapeId ? '&focus=' + encodeURIComponent(shapeId) : ''}`
      : '';
    return ph(`<div class="tlda-embed">
      <div class="tlda-embed-source">${esc(source)}</div>
      <div class="tlda-embed-body">
        <div class="tlda-embed-text">${esc(snippet)}</div>
        ${openUrl ? `<a href="${openUrl}" target="_blank" class="tlda-embed-link" title="Open in tlda">open &rarr;</a>` : ''}
      </div>
    </div>`, true)
  })
  // [doc:shareId] meta — render as compact chip, click to expand card
  const docsExpanded = localStorage.getItem('fleet-docs-expanded') === '1'
  text = text.replace(/\[doc:([^\]]+)\]\s*([^\n]+)/g, (_, shareId, meta) => {
    const docId = `doc-${shareId}`
    const bodyDisplay = docsExpanded ? '' : 'display:none'
    const toggleChar = docsExpanded ? '▼' : '▶'
    return ph(`<div class="shared-doc doc-chip" data-share-id="${esc(shareId)}" draggable="true">
      <div class="shared-doc-header">
        <span class="shared-doc-toggle">${toggleChar}</span>
        <span class="shared-doc-name">${esc(meta.trim())}</span>
        <span class="drag-handle" title="Drag to chat">⠿</span>
      </div>
      <div class="shared-doc-body doc-chip-body" id="${esc(docId)}" style="${bodyDisplay}"></div>
    </div>`, true)
  })

  // Bare image file paths → <img> tags (before marked mangles them)
  // Matches absolute paths (/... or ~/...) ending in image extensions
  // Handles: bare paths, backtick-wrapped paths, paths at end of line
  text = text.replace(/(^|\n|\s|`)((?:\/|~\/)[^\s<>"'`]+\.(?:png|jpg|jpeg|gif|svg|webp))`?(?=\s|$|[)\].,;!?`])/gim, (_, before, imgPath) => {
    const src = `/api/file?path=${encodeURIComponent(imgPath)}`
    // Strip backtick from before if present (it's part of the match group)
    const prefix = before === '`' ? '' : before
    return prefix + ph(`<img class="chat-image" src="${src}" alt="${esc(imgPath.split('/').pop())}" loading="lazy">`, true)
  })

  // --- Run marked ---
  let result
  if (typeof window !== 'undefined' && window.marked) {
    result = window.marked.parse(text, { breaks: true })
    // Unwrap single <p> — marked wraps everything in <p> tags, which are block-level
    // and break inline chat layout. Strip if the result is just one paragraph.
    const trimmed = result.trim()
    if (trimmed.startsWith('<p>') && trimmed.endsWith('</p>') && trimmed.indexOf('<p>', 1) === -1) {
      result = trimmed.slice(3, -4)
    }
  } else {
    // Fallback: basic escaping (shouldn't happen in browser with CDN loaded)
    result = esc(text).replace(/\n/g, '<br>')
  }

  // --- Sanitize with DOMPurify ---
  if (typeof window !== 'undefined' && window.DOMPurify) {
    result = window.DOMPurify.sanitize(result, {
      ADD_TAGS: ['span', 'div', 'img'],
      ADD_ATTR: ['class', 'data-path', 'data-share-id', 'data-indent', 'data-file',
        'data-line', 'data-tlda-src', 'data-tlda-id', 'data-lang', 'data-highlighted',
        'draggable', 'title', 'target', 'style'],
      ALLOW_DATA_ATTR: true,
    })
  }

  // --- Restore placeholders ---
  // Block-level: marked wraps in <p>, unwrap
  result = result.replace(/<p>FLEETPH(\d+)FLEET<\/p>/g, (_, i) => placeholders[+i])
  // Inline or any remaining
  result = result.replace(/FLEETPH(\d+)FLEET/g, (_, i) => placeholders[+i])

  // --- Post-pass: fleet-specific transforms on rendered HTML ---

  // Add .md-table class to marked's tables
  result = result.replace(/<table>/g, '<table class="md-table">')

  // Add chat-image class to images and rewrite local file paths to /api/file URLs
  result = result.replace(/<img(?! class="chat-image") /g, '<img class="chat-image" ')
  result = result.replace(/<img([^>]*)src="(\/(?!api\/)[^"]+\.(png|jpg|jpeg|gif|svg|webp))"/gi, (_, pre, imgPath, ext) => {
    return `<img${pre}src="/api/file?path=${encodeURIComponent(imgPath)}"`
  })

  // Make links open in new tab (skip links that already have target)
  result = result.replace(/<a(?![^>]*target=)([^>]*href=")/g, '<a target="_blank"$1')

  // File paths: shorten absolute paths + render relative .md paths as scratch cards
  // Backtick-quoted content (<code> spans) is verbatim — never chipify it.
  // Prose paths (unquoted text) are handled: absolute paths shortened, relative .md paths chipped.
  // Second pass: absolute and relative paths in text (skip inside HTML tags and code/pre)
  let _inCode2 = 0
  result = result.replace(/((?:<[^>]*>)|(?:[^<]+))/g, (segment) => {
    if (segment.startsWith('<')) {
      if (/^<(code|pre)\b/i.test(segment)) _inCode2++
      else if (/^<\/(code|pre)>/i.test(segment)) _inCode2 = Math.max(0, _inCode2 - 1)
      return segment
    }
    if (_inCode2 > 0) return segment
    // Absolute paths
    segment = segment.replace(/\/Users\/\w+\/([\w/._-]+)/g, (fullPath, rel) => {
      if (fullPath.endsWith('.md')) {
        const name = rel.split('/').pop()
        const isScratch = /\/scratch\//.test(fullPath)
        const cls = isScratch ? 'md-file-card scratch-card' : 'md-file-card'
        const drag = isScratch ? ' draggable="true"' : ''
        return `<span class="${cls}" data-path="${fullPath}"${drag}><span class="md-file-chip">${name}</span><span class="md-file-body"></span></span>`
      }
      if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(fullPath)) {
        const name = rel.split('/').pop()
        return `<img class="chat-image" src="/api/file?path=${encodeURIComponent(fullPath)}" alt="${name}" style="max-width:300px;max-height:200px;border-radius:4px;cursor:zoom-in;display:block;margin:4px 0" onerror="this.style.display='none'">`
      }
      return `<span class="file-path" title="${fullPath}" style="cursor:pointer;text-decoration:underline dotted">~/${rel}</span>`
    })
    // Relative paths ending in .md (word-boundary anchored, not already in a tag)
    segment = segment.replace(/(?<![/"'>\w])(?:(?:[\w.-]+\/)+[\w.-]+\.md)/g, (relPath) => {
      const name = relPath.split('/').pop()
      const isScratch = /scratch\//.test(relPath)
      const cls = isScratch ? 'md-file-card scratch-card' : 'md-file-card'
      const drag = isScratch ? ' draggable="true"' : ''
      return `<span class="${cls}" data-path="${relPath}"${drag}><span class="md-file-chip">${name}</span><span class="md-file-body"></span></span>`
    })
    return segment
  })

  // File:line references (skip inside tags)
  result = result.replace(/((?:<[^>]*>)|(?:[^<]+))/g, (segment) => {
    if (segment.startsWith('<')) return segment
    return segment.replace(/(?<![/"'])(\b[\w.-]+\.(md|txt|mjs|js|ts|py|r|tex)):(\d+)\b/gi, (m, file, ext, line) => {
      return `<span class="file-line-ref" data-file="${esc(file)}" data-line="${line}" title="${esc(file)}:${line}">${esc(file)}:${line}</span>`
    })
  })

  // Linkify bare URLs not already inside <a> tags
  // Backtick-quoted URLs (<code>https://...</code>) are intentionally left as code spans.
  // Bare URLs in text (not inside tags, not already linked)
  let _inTag = false
  result = result.replace(/((?:<[^>]*>)|(?:[^<]+))/g, (segment) => {
    if (segment.startsWith('<')) {
      _inTag = /^<a\b/i.test(segment)
      if (/^<\/a>/i.test(segment)) _inTag = false
      return segment
    }
    if (_inTag) return segment
    return segment.replace(/\bhttps?:\/\/[^\s<>"')\]]+/g, url => {
      return `<a href="${esc(url)}" target="_blank" class="chat-link">${esc(url)}</a>`
    })
  })

  return result
}

// --- Panel state persistence ---
export function savePanelState(panelId, key, value) {
  try {
    const all = JSON.parse(localStorage.getItem('fleet-panel-state') ?? '{}')
    if (!all[panelId]) all[panelId] = {}
    all[panelId][key] = value
    localStorage.setItem('fleet-panel-state', JSON.stringify(all))
  } catch {}
}

export function loadPanelState(panelId, key) {
  try {
    const all = JSON.parse(localStorage.getItem('fleet-panel-state') ?? '{}')
    return all[panelId]?.[key] ?? null
  } catch { return null }
}

// Read from localStorage with typed default (no string literal fallback)
export function readStorage(key, defaultVal) {
  const raw = localStorage.getItem(key)
  if (raw == null) return defaultVal
  try { return JSON.parse(raw) } catch { return defaultVal }
}

export function readStorageRaw(key, defaultVal) {
  const raw = localStorage.getItem(key)
  return raw != null ? raw : defaultVal
}
