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
import { normalizePrettyResult } from '../../shared/activity-pretty-result.mjs'
import { isFullyMarked } from '../../shared/terminal-system-markers.mjs'
import { log } from '../logger.ts'

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
  'wait_for_task', 'my_task', 'tasks', 'login', 'register', 'register_manager',
  'task_check', 'unregister_manager', 'task_done', 'timer',
  'mcp__tlda__wait_for_task', 'mcp__tlda__my_task', 'mcp__tlda__tasks',
  'mcp__tlda__login', 'mcp__tlda__register', 'mcp__tlda__register_manager', 'mcp__tlda__task_check',
  'mcp__tlda__task_done', 'mcp__tlda__timer',
  'ToolSearch',
])

export const CHAT_TOOLS = new Set([
  'chat', 'delegate', 'mcp__tlda__chat', 'mcp__tlda__delegate',
])

// --- Pretty-print tool results ---

const MARKDOWN_PRETTY_TOOLS = new Set([
  'inbox',
  'tlda/inbox',
  'mcp/tlda/inbox',
  'mcp__tlda__inbox',
])

function normalizedToolName(toolName) {
  return String(toolName || '').toLowerCase().replace(/^mcp__/, 'mcp/').replace(/__/g, '/')
}

const SEMANTIC_RANGE_KEYS = new Set([
  'since', 'after', 'before', 'until', 'page', 'page_size', 'pageSize', 'limit',
  'cursor', 'nextCursor', 'context', 'context_before', 'context_after',
])

function stableSemanticJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableSemanticJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableSemanticJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function semanticOperationKind(toolName) {
  const tool = normalizedToolName(toolName)
  if (tool.includes('thread')) return 'thread'
  if (tool.includes('search')) return 'search'
  return ''
}

export function semanticOperationDescriptor(toolName, input, arg, ts, caller = '') {
  const kind = semanticOperationKind(toolName)
  if (!kind) return null
  const rawInput = input && typeof input === 'object' ? input : {}
  const view = {}
  const inspected = {}
  for (const [key, value] of Object.entries(rawInput)) {
    if (key.startsWith('_semantic')) continue
    if (SEMANTIC_RANGE_KEYS.has(key)) inspected[key] = value
    else view[key] = value
  }
  const argText = String(arg || rawInput.query || rawInput.filter || '')
  const query = String(rawInput.query || rawInput.q || (kind === 'search' ? argText : '') || '')
  const filterExpression = String(rawInput.filter || rawInput.filterExpression || (kind === 'thread' ? argText : '') || '')
  const semanticIdentity = {
    kind,
    caller,
    query,
    filterExpression,
    agent: rawInput.agent || rawInput.from || rawInput.to || '',
    role: rawInput.role || '',
    type: rawInput.type || rawInput.eventType || '',
    types: rawInput.types || '',
    task_id: rawInput.task_id || rawInput.task || '',
    project: rawInput.project || rawInput.currentProject || '',
    view,
  }
  return {
    descriptorShape: 'SemanticChatOperationDescriptor',
    kind,
    // The query text remains the recorded call. `caller` is the lexical
    // environment in which the card must evaluate `me` when it is reopened.
    caller,
    tool: toolName || '',
    arg: argText,
    query,
    filterExpression,
    view,
    inspected,
    semanticKey: stableSemanticJson(semanticIdentity),
    generatedAt: ts || null,
  }
}

function semanticOperationKey(item) {
  return semanticOperationDescriptor(item?._toolName, item?._toolInput, item?._toolArg, item?.timestamp, item?.from)?.semanticKey || ''
}

function mergeSemanticInspected(host, item) {
  const pages = host._semanticInspectedPages || []
  const desc = semanticOperationDescriptor(item._toolName, item._toolInput, item._toolArg, item.timestamp, item.from)
  if (desc) pages.push(desc.inspected)
  host._semanticInspectedPages = pages
  host._toolInput = { ...(host._toolInput || {}), _semanticInspectedPages: pages }
  host._semanticMergedCount = (host._semanticMergedCount || 1) + 1
}

function mergePrettyResultOntoHost(host, item) {
  if (!item._prettyResult) return
  if (!host._prettyResult) host._prettyResult = item._prettyResult
}

function renderSemanticOperationResult(toolName, text, ctx, input, ts, arg = '', caller = '') {
  const kind = semanticOperationKind(toolName)
  const descriptor = semanticOperationDescriptor(toolName, input, arg, ts, caller)
  if (!descriptor) return null
  const json = esc(JSON.stringify(descriptor))
  const key = esc(descriptor.semanticKey)
  // A thread is drawn as the thread visualization and nothing else. Skip: "they
  // were supposed to render literally the same thing out of the database... so
  // they're not supposed to fucking have changed the UI." The search card's
  // shell -- its open/collapse button and its "inspected" line -- was never part
  // of that picture, so the mount point is bare and renderThreadRows draws the
  // card. The one control the picture lacked is the floating collapse the view
  // puts in the left gutter.
  if (kind === 'thread') {
    return `<div class="semantic-operation-body" data-semantic-key="${key}" data-semantic-operation="${json}"></div>`
  }
  // No expand control. A search card shows every result it has: the clipped
  // preview it used to expand FROM was deleted in 9496c3322, on Skip's
  // instruction that we were "over-truncating search results which are already
  // truncated for us" -- and the button outlived its mechanism by two days,
  // doing nothing but relabelling itself. Skip, 2026-08-19 05:37 EDT: "there are
  // four results. It shows the four results. If there's nothing to expand, don't
  // put a fucking expand button."
  //
  // The controls for there being MORE are inside the view and are each already
  // conditional on having something to reveal: the per-group "Show N more" when
  // a group exceeds its initial limit, and "More" when the server has another
  // page.
  return `<div class="semantic-chat-operation semantic-search-operation" data-semantic-key="${key}">
    <div class="semantic-operation-body" data-semantic-operation="${json}"></div>
  </div>`
}

function renderPrettyResult(toolName, text, ctx, input, ts, arg = '') {
  text = normalizePrettyResult(text)
  const tool = normalizedToolName(toolName)
  if (tool.includes('screenshot')) {
    return renderScreenshotResult(text)
  }
  if (tool === 'schedulewakeup') {
    return renderScheduleResult(text, input, ts)
  }
  if (MARKDOWN_PRETTY_TOOLS.has(tool)) {
    return renderMarkdownPrettyResult(toolName, text, ctx)
  }
  if (input?._unknownCodexToolKind) {
    recordUnknownCodexToolKind(input._unknownCodexToolKind)
    return renderMarkdownPrettyResult(toolName, text, ctx)
  }
  const md = ctx.renderMarkdown ? ctx.renderMarkdown(text) : esc(text)
  return `<div class="tool-pretty-result">${md}</div>`
}

const UNKNOWN_KIND_TELEMETRY_LIMIT = 32
const reportedUnknownCodexToolKinds = new Set()
let reportedUnknownCodexToolOverflow = false

function recordUnknownCodexToolKind(kind) {
  const name = String(kind || '').trim() || 'unknown'
  if (reportedUnknownCodexToolKinds.has(name)) return
  if (reportedUnknownCodexToolKinds.size >= UNKNOWN_KIND_TELEMETRY_LIMIT) {
    if (!reportedUnknownCodexToolOverflow) {
      reportedUnknownCodexToolOverflow = true
      log.metric('activity-render', 'unknown Codex tool kind limit reached', {
        unknownKindCount: reportedUnknownCodexToolKinds.size,
        limit: UNKNOWN_KIND_TELEMETRY_LIMIT,
      })
    }
    return
  }
  reportedUnknownCodexToolKinds.add(name)
  log.metric('activity-render', 'unknown Codex tool kind rendered', {
    kind: name,
    unknownKindCount: reportedUnknownCodexToolKinds.size,
    limit: UNKNOWN_KIND_TELEMETRY_LIMIT,
  })
}

function renderMarkdownPrettyResult(toolName, text, ctx) {
  const lines = String(text || '').split('\n')
  const h = ctx?.foldHeights?.toolMarkdown ?? 12
  const shouldFold = h > 0 && lines.length > h
  const maxH = shouldFold ? `max-height:${(h * 1.4).toFixed(1)}em;` : ''
  const foldStyle = shouldFold ? ` style="${maxH}"` : ''
  const foldCls = shouldFold ? ' code-collapsed' : ''
  const toggleHtml = shouldFold
    ? `<span class="code-block-toggle" onclick="(function(e){var w=e.closest('.code-block-wrap'),p=w.querySelector('.fold-body');if(p.classList.contains('code-collapsed')){p.classList.remove('code-collapsed');p.style.maxHeight='';e.textContent='collapse'}else{p.classList.add('code-collapsed');p.style.maxHeight='${(h * 1.4).toFixed(1)}em';e.textContent='${lines.length} lines — show all'}})(this)">${lines.length} lines — show all</span>`
    : ''
  const md = ctx.renderMarkdown ? ctx.renderMarkdown(esc(text)) : esc(text)
  return `<div class="tool-pretty-result tool-pretty-markdown code-block-wrap">
    <div class="code-block-header"><span class="code-block-lang">${esc(humanizeToolName(toolName))}</span>${toggleHtml}</div>
    <div class="pretty-msg-body fold-body${foldCls}"${foldStyle}>${md}</div>
  </div>`
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

// The range view, in rows. Skip settled the unit after seeing five and three on
// screen: "it can't be five messages, it's gotta be like three, two", and "not
// the message scale, like, the thing scale" -- one row is one thing, message or
// activity entry. Overridable per user; these are the defaults.
const THREAD_FRONT = 3
const THREAD_TAIL = 2

function threadCounts(ctx) {
  const front = Number(ctx?.threadRange?.front)
  const tail = Number(ctx?.threadRange?.tail)
  return {
    front: Number.isFinite(front) && front >= 0 ? front : THREAD_FRONT,
    tail: Number.isFinite(tail) && tail >= 0 ? tail : THREAD_TAIL,
  }
}

// One thread row. `msg` is an ordinary message ({ timestamp, from, to, body }),
// a tool-activity event ({ timestamp, activity }) whose `activity` is a
// renderActivityGroup item, or an unparsed blob ({ raw }).
function renderThreadMsg(msg, ctx) {
  if (msg.activity) {
    return `<div class="pretty-thread-activity">${renderActivityGroup([msg.activity], ctx)}</div>`
  }
  if (msg.raw != null) {
    const rawText = String(msg.raw)
    return `<div class="chat-line"><div class="pretty-msg-body">${ctx.renderMarkdown ? ctx.renderMarkdown(esc(rawText)) : esc(rawText)}</div></div>`
  }
  const from = String(msg.from ?? '')
  const to = String(msg.to ?? '')
  const fromCls = ctx.getNickClass ? ctx.getNickClass(from) : 'chat-nick'
  const toCls = ctx.getNickClass ? ctx.getNickClass(to) : 'chat-nick'
  let shortTs = String(msg.timestamp ?? '').replace(/^\d+\/\d+\/\d+,?\s*/, '')
  // Extract shadow version hash if present (format: "time @hash")
  let verHtml = ''
  const verMatch = shortTs.match(/\s*@([a-f0-9]{7})$/)
  if (verMatch) {
    shortTs = shortTs.replace(/\s*@[a-f0-9]{7}$/, '')
    verHtml = ` <span class="pretty-ver">@${verMatch[1]}</span>`
  }
  const body = String(msg.body ?? '').trim()
  const bodyHtml = ctx.renderMarkdown ? ctx.renderMarkdown(esc(body)) : esc(body)
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

// The thread visualization: first FRONT + gap marker + last TAIL, so both ends
// are visible and Skip can see the time range of what was actually read. The
// gap marker doubles as the expand button, and every hidden row is already
// here — the caller holds the messages the thread call returned, so expanding
// reveals the middle instead of another ellipsis.
export function renderThreadRows(msgs, ctx, headerText = '') {
  const list = Array.isArray(msgs) ? msgs : []
  const header = headerText ? `<div class="pretty-result-header">${esc(headerText)}</div>` : ''
  const { front, tail } = threadCounts(ctx)
  let rows
  if (list.length > front + tail) {
    const hiddenCount = list.length - front - tail
    const hiddenRows = list.slice(front, list.length - tail).map(m => renderThreadMsg(m, ctx)).join('')
    rows = list.slice(0, front).map(m => renderThreadMsg(m, ctx)).join('')
      + `<div class="pretty-expand-btn" data-fold-id="thread-middle">… ${hiddenCount} messages …</div>`
      + `<div class="pretty-more-rows" data-fold-id="thread-middle" style="display:none">${hiddenRows}</div>`
      + (tail ? list.slice(-tail).map(m => renderThreadMsg(m, ctx)).join('') : '')
  } else {
    rows = list.map(m => renderThreadMsg(m, ctx)).join('')
  }
  // The card has no height bound of its own. Skip, after seeing one: "there's no
  // fucking expand button, and you click it and just, like, I don't know what
  // the fuck. It's literally click to expand to something you can expand. And
  // the fucking first expand is invisible... just let me see the fucking
  // [thread]." So the card is the picture and nothing else: front rows, the gap
  // marker, tail rows. The marker is the one expand and it is visible where the
  // picture puts it, in the middle.
  return `<div class="tool-pretty-result tool-pretty-thread">${header}${rows}</div>`
}

// --- Tool helpers ---

export function humanizeToolName(name) {
  let n = (name || '').replace(/^mcp__/, '').replace(/__/g, '/')
  const shorts = { 'tlda/chat': 'chat', 'tlda/delegate': 'delegate', 'tlda/task_done': 'done',
    'tlda/interrupt': 'interrupt', 'tlda/label_agent': 'label', 'tlda/respawn': 'respawn',
    'tlda/spawn': 'spawn', 'tlda/name_agent': 'name', 'tlda/search': 'search' }
  return shorts[n] || n
}

// The call, written the way a call is written: the function, then its arguments
// in the order the call made them. Values are clipped so one long string
// argument (a Write's content, a Bash heredoc) can't push the arguments after it
// off the row — every argument stays named even when its value elides. The caps
// are set above what the row carried before this (one unclipped value), so no
// call reads shorter than it used to.
const CALL_ARG_VALUE_MAX = 80
const CALL_ARGS_MAX = 240

function callArgValue(value) {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > CALL_ARG_VALUE_MAX ? `${oneLine.slice(0, CALL_ARG_VALUE_MAX - 1)}…` : oneLine
}

export function toolCallArgs(input, fallbackArg = '') {
  // `_semantic*` keys are stamped onto _toolInput by the dedup merge, not by the
  // agent — they were never part of the call.
  const entries = input && typeof input === 'object'
    ? Object.entries(input).filter(([key]) => !key.startsWith('_semantic') && key !== '_unknownCodexToolKind')
    : []
  if (!entries.length) return fallbackArg ? callArgValue(fallbackArg) : ''
  let out = ''
  for (const [key, value] of entries) {
    const part = `${key}: ${callArgValue(value)}`
    if (out && out.length + 2 + part.length > CALL_ARGS_MAX) { out += ', …'; break }
    out = out ? `${out}, ${part}` : part
  }
  return out
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
//   - Display math $$...$$ or \[...\], including multiline blocks → KaTeX display mode
//   - Other lines → inline $...$ segments rendered, rest as escaped text
export function renderTexLines(content, macros) {
  const rendered = []
  const lines = content.split('\n')
  let display = null

  const renderDisplay = (tex, fallbackLines) => {
    try { return katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false, macros }) }
    catch { return fallbackLines.map(line => esc(line)).join('<br>') }
  }

  const renderLine = (line) => {
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
  }

  for (const line of lines) {
    if (display) {
      const closeIndex = line.indexOf(display.close)
      display.raw.push(line)
      if (closeIndex >= 0) {
        display.tex.push(line.slice(0, closeIndex))
        rendered.push(renderDisplay(display.tex.join('\n'), display.raw))
        const rest = line.slice(closeIndex + display.close.length)
        display = null
        if (rest.trim()) rendered.push(renderLine(rest))
      } else {
        display.tex.push(line)
      }
      continue
    }

    const trimmed = line.trim()
    const bracketOpen = line.indexOf('\\[')
    const dollarOpen = line.indexOf('$$')
    const hasBracketOpen = bracketOpen >= 0 && (dollarOpen < 0 || bracketOpen < dollarOpen)
    const open = hasBracketOpen
      ? { start: '\\[', close: '\\]', index: bracketOpen }
      : dollarOpen >= 0 ? { start: '$$', close: '$$', index: dollarOpen } : null

    if (!open || (trimmed.startsWith('%')) || (/^\\(begin|end|documentclass|usepackage|chapter|section|subsection|paragraph|label|item|caption)\b/.test(trimmed))) {
      rendered.push(renderLine(line))
      continue
    }

    const before = line.slice(0, open.index)
    if (before.trim()) rendered.push(renderLine(before))
    const texStart = open.index + open.start.length
    const closeIndex = line.indexOf(open.close, texStart)
    if (closeIndex >= 0) {
      rendered.push(renderDisplay(line.slice(texStart, closeIndex), [line]))
      const rest = line.slice(closeIndex + open.close.length)
      if (rest.trim()) rendered.push(renderLine(rest))
      continue
    }

    display = {
      close: open.close,
      tex: [line.slice(texStart)],
      raw: [line],
    }
  }

  if (display) rendered.push(...display.raw.map(line => esc(line)))
  return rendered.join('<br>')
}

export function renderEditDiff(input, ctx, opts = {}) {
  if (typeof input?.old_string !== 'string' || typeof input?.new_string !== 'string') return ''
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
    if (input.canonical_source?.scope) {
      const tex = str.replace(/^\s*\\begin\{[^}]+\}\s*/, '').replace(/\s*\\end\{[^}]+\}\s*$/, '')
      return `<div class="diff-tex">${katex.renderToString(tex, { displayMode: true, throwOnError: false, macros: ctx.preambleMacros || {} })}</div>`
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
  const revisions = input.canonical_source?.before_revision && input.canonical_source?.after_revision
    ? `<span class="edit-diff-revisions" data-before-revision="${esc(input.canonical_source.before_revision)}" data-after-revision="${esc(input.canonical_source.after_revision)}"></span>` : ''
  const locHeader = (locText || tentativeBadge || extraBadge || extraLocHtml)
    ? `<div class="edit-diff-loc">${tentativeBadge}${extraBadge}${locText ? `<span class="edit-diff-path">${esc(locText)}</span>` : ''}<span class="edit-diff-stat">+${addCount} −${delCount}</span></div>${revisions}${extraLocHtml}`
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

  if (n === 'code' && input.code) {
    const code = String(input.code).trim()
    const highlighted = highlightSyntax(esc(code), 'javascript')
    return `<div class="code-block-wrap code-card">
      <div class="code-block-header"><span class="code-block-lang">javascript</span><span class="code-block-copy" title="Copy">⎘</span></div>
      ${copySourceTemplate(code)}<pre><code data-lang="javascript" data-highlighted="1">${highlighted}</code></pre>
    </div>`
  }

  if (n === 'bash' && input.command) {
    const cmd = input.command
    const lines = cmd.split('\n')
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
    const semanticKey = semanticOperationKey(t)
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
      const host = result.find(r => (semanticKey ? r._semanticKey === semanticKey : r._key === key) && !r._prettyResult)
      if (host) { mergePrettyResultOntoHost(host, t); host._count++; if (semanticKey) mergeSemanticInspected(host, t); continue }
    }
    if (semanticKey) {
      const host = result.find(r => r._semanticKey === semanticKey)
      if (host) {
        host._count++
        mergeSemanticInspected(host, t)
        mergePrettyResultOntoHost(host, t)
        continue
      }
    }
    if (prev && prev._key === key) {
      prev._count++
      // Merge prettyResult from follow-up event (e.g. _prettyResult events arriving after the tool_use)
      mergePrettyResultOntoHost(prev, t)
    } else {
      result.push({ ...t, _key: key, _semanticKey: semanticKey, _count: 1 })
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

  // The collapsed card's row, same call the tool lines carry. Note this row does
  // not currently draw: its CSS is `:not(.collapsed)`, and nothing in this client
  // puts `collapsed` on an activity card — the class has been CSS-only since
  // activity cards landed. The visible top row is the tool line below.
  let headerSummary = ''
  if (lastTool) {
    const extra = tools.length > 1 ? ` <span class="activity-more">(+${tools.length - 1} more)</span>` : ''
    headerSummary = `${esc(lastTool._toolName)}: ${esc(toolCallArgs(lastTool._toolInput, lastTool._toolArg))}${extra}`
  } else if (lastText && lastText._text) {
    headerSummary = esc(lastText._text.split('\n')[0])
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
      if (isFullyMarked(fullText)) return ''
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
      // The top row of a tool call card is the call. It used to be the daemon's
      // `arg` — one value off a first-hit chain (`file_path || command || pattern
      // || …`) with its parameter name dropped, so a Read lost its offset and
      // limit and a thread(), whose parameters that chain names none of, drew as
      // the bare word `mcp__tlda__thread`. Skip: "them fucking saying in their
      // fucking top row, like, what the fucking call was. Function, arguments,
      // etcetera."
      // `_mergedArgs` means dedupTools folded several reads into this row and
      // rewrote `_toolArg` to their basenames; `_toolInput` is only the first
      // one's, so the merged list is the truthful call there.
      let arg = t._mergedArgs ? esc(t._toolArg || '') : esc(toolCallArgs(t._toolInput, t._toolArg))
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
      const canonicalDisplay=t._toolInput?.canonical_source?.scope||t._toolInput?.canonical_source?.display
      const canonicalEdit=['edit','write','multiedit'].includes(tnLower)&&canonicalDisplay
      const renderInput=canonicalEdit?{...t._toolInput,file_path:t._toolInput.canonical_source.file,old_string:canonicalDisplay.old_source||'',new_string:canonicalDisplay.new_source||''}:t._toolInput
      const isEdit = ((tnLower === 'edit' || isPropose) && t._toolInput?.old_string && t._toolInput?.new_string)||canonicalEdit
      const isUnifiedEdit = tnLower === 'edit' && typeof t._toolInput?.diff === 'string' && t._toolInput.diff.trim()
      const hasDiff = (isEdit || isUnifiedEdit) ? ' has-diff' : ''
      // The propose result text ("**Proposal proposal-1** …") carries the id the
      // matching apply_proposal references; stamp it on the card so the apply
      // line's hover can find this card in the DOM by `data-proposal-id`.
      const proposalId = isPropose
        ? (String(t._prettyResult || '').match(/proposal-[\w-]+/)?.[0] || '')
        : ''
      const diffHtml = isEdit
        ? renderEditDiff(renderInput, ctx, { isPropose, proposalId, badge:renderInput?.canonical_source?.ambiguous?'ambiguous':'' })
        : (isUnifiedEdit ? renderUnifiedEditDiff(t._toolInput, ctx) : '')
      const codeCardHtml = renderCodeCard(t._toolName, t._toolInput, ctx)
      const cmd = toolToCommand(t._toolName, t._toolInput)
      const cmdAttr = cmd ? ` data-cmd="${esc(cmd)}"` : ''
      const copyBtn = cmd ? `<span class="tool-copy" title="Copy command">⎘</span>` : ''
      const showArg = arg && !codeCardHtml
      // For a propose_edit the diff card already shows the change; its result text
      // ("**Proposal proposal-N**…") is only consumed to extract the id above, so
      // don't also render it as a raw result block under the card.
      // A semantic operation renders from the call, not from the transcript the
      // agent was handed: the descriptor carries the arguments, so the view
      // re-reads the messages out of the database and nothing is truncated in
      // transit.
      const semanticKind = semanticOperationKind(t._toolName)
      const prettyHtml = semanticKind
        ? renderSemanticOperationResult(t._toolName, '', ctx, t._toolInput, t.timestamp, t._toolArg, t.from)
        : (t._prettyResult && !isPropose)
          ? renderPrettyResult(t._toolName, t._prettyResult, ctx, t._toolInput, t.timestamp, t._toolArg)
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

  const latency = m._activityLatency || {}
  const latencyAttrs = [
    ['data-jsonl-ts', latency.jsonlTs || group[0].timestamp || ''],
    ['data-daemon-received-at-ms', latency.daemonReceivedAtMs],
    ['data-daemon-sent-at-ms', latency.daemonSentAtMs],
    ['data-server-received-at-ms', latency.serverReceivedAtMs],
    ['data-server-broadcast-queued-at-ms', latency.serverBroadcastQueuedAtMs],
    ['data-browser-received-at-ms', latency.browserReceivedAtMs],
    ['data-browser-render-queued-at-ms', latency.browserRenderQueuedAtMs],
  ]
    .filter(([, value]) => value != null && value !== '')
    .map(([name, value]) => ` ${name}="${esc(String(value))}"`)
    .join('')
  return `<div class="chat-activity-card will-fold" data-agent="${esc(m.from)}" data-ts="${esc(group[0].timestamp || '')}" data-msg-id="${esc(String(m._dbId || ''))}"${latencyAttrs}>
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
