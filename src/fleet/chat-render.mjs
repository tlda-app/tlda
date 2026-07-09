// chat-render.mjs — Standalone chat line renderer.
//
// Extracted from chat.mjs for use in tldraw FleetChatShape
// without module-global dependencies.
//
// Usage:
//   import { renderChatLine } from './chat-render.mjs'
//   const html = renderChatLine(message, ctx)
//
// ctx = {
//   agentLabel:     (id) => string,
//   getNickClass:   (id) => string,
//   isHumanId:      (id) => boolean,
//   getAgents:      () => agents[],
//   getTasks:       () => tasks[],
//   tldaToken:      string | null,
//   renderMarkdown: (escapedHtml) => html,
// }

import { pretty_name_parts, pretty_name_plain_text } from '../../shared/pretty_name.mjs'
// --- Pure helpers (copied from utils.mjs) ---

export function esc(s) {
  if (s == null) return ''
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function decodeHtmlAttr(s = '') {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function stripTags(html = '') {
  return String(html).replace(/<[^>]*>/g, '').trim()
}

function markdownApiFileLink(href) {
  const raw = decodeHtmlAttr(href)
  const baseOrigin = globalThis.location?.origin || 'https://tlda.local'
  let url
  try {
    url = new URL(raw, baseOrigin)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol)) return null
  if (/^(?:https?:)?\/\//i.test(raw) && globalThis.location && url.origin !== baseOrigin) return null
  if (url.pathname !== '/api/file') return null
  const filePath = url.searchParams.get('path') || ''
  if (!/\.md$/i.test(filePath)) return null
  return { url: raw, path: filePath }
}

function chipifyMarkdownApiFileLinks(html) {
  return String(html).replace(/<a\b([^>]*)\bhref="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/gi, (match, before, href, after, labelHtml) => {
    const file = markdownApiFileLink(href)
    if (!file) return match
    const label = stripTags(labelHtml) || file.path.split('/').pop() || file.path
    return `<span class="ref-chip ref-chip-doc" data-path="${esc(file.path)}" data-url="${esc(file.url)}" draggable="true"><span class="ref-chip-doc-icon">📄</span>${esc(label)}</span>`
  })
}

// Backtick-wrapped URLs stay as <code> — they're literal text, not chips.
// (Previously this function converted them to <a> links, but that caused
// chipification of quoted URLs. Plain <code> is selectable and copyable.)
function linkifyCodeUrls(html) { return html }

export function timeShort(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
}

// A pending countdown's message carries a "— say "<bot> cancel" to stop" hint.
// Once the timer has fired that hint is moot, so strip it for the terminal line.
export function timerDoneLabel(s) {
  return String(s || '').replace(/\s*—\s*say\b[^]*$/i, '')
}

// --- Standalone att-token resolver ---
// Used by the unquote handler to render a rechat result (resolvedMessage +
// inlineAttachments) into HTML without the full chat-line wrapper — the immediate
// local feedback before the authoritative event-update broadcast re-renders the
// whole message. renderMarkdown is the same function passed via ctx to renderChatLine.
export function resolveInlineAttachments(text, inlineAttachments, renderMarkdown) {
  // Expand ![alt]({{att:N}}) → ![alt](URL) before renderMarkdown sees it
  let processed = text
  if (inlineAttachments?.length) {
    processed = processed.replace(/!\[([^\]]*)\]\(\{\{att:(\d+)\}\}\)/g, (match, alt, idx) => {
      const att = inlineAttachments[+idx]
      if (att?.url && /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(att.name || att.path || '')) {
        return `![${alt}](${att.url})`
      }
      return match
    })
  }
  let html = chipifyMarkdownApiFileLinks(renderMarkdown(esc(processed)))
  // Replace remaining {{att:N}} markers
  html = html.replace(/\{\{att:(\d+)\}\}/g, (_, idx) => {
    const att = inlineAttachments?.[+idx]
    if (att?.type === 'file') {
      const name = esc(att.name || att.path?.split('/').pop() || 'file')
      const filePath = esc(att.path || '')
      if (att.broken) return `<span class="att-upload-failed" title="Upload failed">⚠ ${filePath}</span>`
      const fileUrl = att.url ? esc(att.url) : ''
      const isImage = /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(att.name || att.path || '')
      if (isImage && fileUrl) return `<img class="chat-image" src="${fileUrl}" alt="${name}">`
      const ext = (att.path || att.name || '').split('.').pop()?.toLowerCase() || ''
      const icon = ext === 'pdf' ? '📕' : ext === 'md' ? '📄' : '📎'
      const urlAttr = fileUrl ? ` data-url="${fileUrl}"` : ''
      return `<span class="ref-chip ref-chip-doc" data-path="${filePath}"${urlAttr} draggable="true"><span class="ref-chip-doc-icon">${icon}</span>${name}</span>`
    }
    return `<span class="ref-chip"><span class="ref-chip-doc-icon">📎</span>att:${idx}</span>`
  })
  return html
}

// --- Main renderer ---

const PRETTY_GLYPH_DAY = '<svg width="10" height="10" viewBox="0 0 16 16" style="opacity:0.6;vertical-align:-1px;margin-right:2px"><circle cx="8" cy="8" r="3" stroke="currentColor" fill="none" stroke-width="1.5"/><line x1="8" y1="1" x2="8" y2="2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="8" y1="13.5" x2="8" y2="15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="8" x2="2.5" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="13.5" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
const PRETTY_GLYPH_DUSK = '<svg width="10" height="10" viewBox="0 0 16 16" style="opacity:0.6;vertical-align:-1px;margin-right:2px"><line x1="0.5" y1="11" x2="15.5" y2="11" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/><path d="M1 11 a3 3 0 0 1 6 0" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/><line x1="4" y1="6" x2="4" y2="4" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="9" x2="-0.5" y2="8" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/></svg>'
const PRETTY_GLYPH_NIGHT = '<svg width="10" height="10" viewBox="0 0 16 16" style="opacity:0.6;vertical-align:-1px;margin-right:2px"><path d="M12 3 a5.5 5.5 0 1 0 0 11 a4.3 4.3 0 0 1 0 -11 Z" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linejoin="round"/></svg>'
const PRETTY_GLYPH_ZOMBIE = '<svg width="10" height="10" viewBox="0 0 16 16" style="opacity:0.6;vertical-align:-1px;margin-right:2px"><path d="M3.5 7.6 a4.5 4.5 0 0 1 9 0 v1.6 a1.5 1.5 0 0 1 -1.5 1.5 v1.3 h-1 v-1.3 h-1 v1.3 h-1 v-1.3 h-1 v1.3 h-1 v-1.3 a1.5 1.5 0 0 1 -1.5 -1.5 Z" stroke="currentColor" fill="none" stroke-width="1.2" stroke-linejoin="round"/><circle cx="6" cy="7.4" r="1.05" fill="currentColor"/><circle cx="10" cy="7.4" r="1.05" fill="currentColor"/></svg>'

function glyphHtml(part) {
  const id = typeof part === 'string' ? part : part?.id
  if (id === 'day') return PRETTY_GLYPH_DAY
  if (id === 'dusk') return PRETTY_GLYPH_DUSK
  if (id === 'night') return PRETTY_GLYPH_NIGHT
  if (id === 'zombie') return PRETTY_GLYPH_ZOMBIE
  const plainGlyph = typeof part === 'string' ? '' : (part?.glyph || '')
  return plainGlyph ? `<span class="pretty-glyph">${esc(plainGlyph)}</span>` : ''
}

function leadingPrettyGlyphHtml(agentId, getAgents) {
  if (!getAgents) return ''
  const agents = getAgents()
  const a = agents?.find(x => x.id === agentId)
  const part = pretty_name_parts(a?.pretty_name ?? a?.friendly_name).find(p => typeof p !== 'string')
  return part ? glyphHtml(part) : ''
}

function prettyNameTextOnly(pretty_name, friendlyName = '') {
  const text = pretty_name_parts(pretty_name ?? friendlyName)
    .filter(part => typeof part === 'string')
    .join(' ')
    .trim()
  return text || friendlyName
}

function agentNameTextOnly(agentId, getAgents, plainName = '') {
  const agents = getAgents?.()
  const a = agents?.find(x => x.id === agentId)
  return a ? prettyNameTextOnly(a.pretty_name, a.friendly_name) : plainName
}

// HTML pretty_name primitive. Rendered output is display-only and must never be
// fed back into behavior.
export function agentNameHtml(pretty_name, friendlyName = '') {
  const parts = pretty_name_parts(pretty_name ?? friendlyName)
  return parts
    .map(part => typeof part === 'string' ? esc(part) : glyphHtml(part))
    .join('')
}

export function renderChatLine(m, ctx) {
  const { agentLabel, getNickClass, isHumanId, getAgents, getTasks, tldaToken, renderMarkdown } = ctx

  // Name provenance: the nick a HISTORICAL message shows is the name its sender
  // held AT send time. The server stamps `fromName`/`toName` (the period name,
  // possibly null = nameless then) onto history events; live messages aren't
  // stamped, so they fall back to the current name (which is correct for "now").
  // `*NameNow` is set when the agent has since rotated → drives a hover tooltip
  // so the reader can see the current name + reach the agent by its stable id.
  const periodNick = (id, stamped) => stamped != null
    ? stamped
    : agentNameTextOnly(id, getAgents, agentLabel(id))
  const nowTitle = (id, nowName) => nowName != null
    ? ` title="now: ${esc(nowName)} · ${esc(id || '')}"` : ''

  // Timer countdown: live countdown for active timers. Remaining is computed
  // from data-timer-until at render time and re-ticked each second by the
  // chat-shape DOM ticker, so the number actually counts down.
  if (m._timerCountdown) {
    const nick = agentLabel(m.from)
    const cls = getNickClass(m.from)
    const r = Math.max(0, Math.ceil((new Date(m._timerUntil) - Date.now()) / 1000))
    const mins = Math.floor(r / 60)
    const secs = r % 60
    const timeStr = mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}s`
    const msg = esc(m._timerMessage)
    return `<div class="chat-line chat-timer-countdown" data-msg-from="${esc(m.from || '')}" data-timer-until="${esc(m._timerUntil || '')}"><span class="chat-ts">${timeShort(m.timestamp)}</span> <span class="agent-nick ${cls}" data-agent-id="${esc(m.from)}">${esc(nick)}</span> <span class="timer-msg">\u23F1 ${timeStr} \u2192 ${msg}</span></div>`
  }
  // Timer cancelled in its grace window \u2014 struck, terminal.
  if (m._timerCancelled) {
    const nick = agentLabel(m.from)
    const cls = getNickClass(m.from)
    const msg = esc(timerDoneLabel(m._timerMessage))
    return `<div class="chat-line chat-timer-cancelled" data-msg-from="${esc(m.from || '')}"><span class="chat-ts">${timeShort(m.timestamp)}</span> <span class="agent-nick ${cls}" data-agent-id="${esc(m.from)}">${esc(nick)}</span> <span class="timer-msg">\uD83D\uDEAB ${msg} \u2014 cancelled</span></div>`
  }
  // Timer fired \u2014 terminal, but stays in the log so the countdown's outcome
  // remains visible. A timer is a chat event: it counts to zero and then sits
  // there showing it fired, rather than vanishing. The "say <bot> cancel" hint
  // is stripped since it's moot once the action has run.
  if (m._timerFired) {
    const nick = agentLabel(m.from)
    const cls = getNickClass(m.from)
    const msg = esc(timerDoneLabel(m._timerMessage))
    return `<div class="chat-line chat-timer-fired" data-msg-from="${esc(m.from || '')}"><span class="chat-ts">${timeShort(m.timestamp)}</span> <span class="agent-nick ${cls}" data-agent-id="${esc(m.from)}">${esc(nick)}</span> <span class="timer-msg">\u2705 ${msg}</span></div>`
  }
  // Compacting indicator
  if (m._compacting) {
    const nick = agentLabel(m.from)
    const cls = getNickClass(m.from)
    const ts = timeShort(m.timestamp)
    return `<div class="chat-line compacting"><span class="chat-ts">${ts}</span> <span class="agent-nick ${cls}" data-agent-id="${esc(m.from)}">${esc(nick)}</span> compacting...</div>`
  }
  // Unreachable indicator
  if (m._unreachable) {
    const nick = agentLabel(m.from)
    const cls = getNickClass(m.from)
    const ts = timeShort(m.timestamp)
    return `<div class="chat-line unreachable"><span class="chat-ts">${ts}</span> <span class="agent-nick ${cls}" data-agent-id="${esc(m.from)}">${esc(nick)}</span> unreachable</div>`
  }
  // Chat break markers: skip
  if (m._chatBreak) return ''
  // Timer-fired messages
  if (m._timer) {
    const nick = agentLabel(m.from)
    const cls = getNickClass(m.from)
    const ts = timeShort(m.timestamp)
    const msg = esc((m.text || '').replace(/^⏰\s*/, ''))
    return `<div class="chat-line chat-timer-msg"><span class="chat-ts">${ts}</span> <span class="agent-nick ${cls}" data-agent-id="${esc(m.from)}">${esc(nick)}</span> <span class="timer-msg">\u23F1 ${msg}</span></div>`
  }

  // System notices — brief activity events, no routing
  if (m._evType === 'system_notice') {
    const ts = timeShort(m.timestamp)
    return `<div class="chat-line system-notice" data-msg-ts="${esc(m.timestamp || '')}"><span class="chat-ts">${ts}</span> ${esc(m.text || '')}</div>`
  }

  // Kick messages and channel notifications — infrastructure noise, filter from chat UI
  if ((m.text || '').startsWith('📬')) return ''
  if ((m.text || '').startsWith('<channel')) return ''
  if ((m.text || '').includes('[Request interrupted by user')) return ''

  // --- Terminal messages (from JSONL session logs) ---
  if (m._evType === 'terminal_user' || m._evType === 'terminal_assistant') {
    if ((m.text || '').includes('[Request interrupted by user')) return ''
    if (/^[\s📬]*$/.test(m.text || '')) return ''
    if (m.from && m.from === m.to) return ''
    const nick = periodNick(m.from, m.fromName)
    const fromCls = getNickClass(m.from)
    const ts = timeShort(m.timestamp)
    let rawText = (m.text || '').trim()
    if (rawText.length > 500) rawText = rawText.substring(0, 500) + '...'
    const text = linkifyCodeUrls(renderMarkdown(esc(rawText)))
    const msgAgo = m.timestamp ? (Date.now() - new Date(m.timestamp).getTime()) / 1000 : null
    const dimClass = msgAgo === null ? '' : msgAgo > 1800 ? 'chat-line-old' : msgAgo > 600 ? 'chat-line-mid' : 'chat-line-recent'
    const toNick = periodNick(m.to, m.toName)
    const toCls = getNickClass(m.to)
    const isFromUser = isHumanId(m.from)
    const fromPrettyGlyph = leadingPrettyGlyphHtml(m.from, getAgents)
    const toPrettyGlyph = leadingPrettyGlyphHtml(m.to, getAgents)
    const nickHtml = isFromUser
      ? `<span class="chat-nick"><span class="agent-nick ${fromCls}" data-agent-id="${esc(m.from)}"${nowTitle(m.from, m.fromNameNow)}>${esc(nick)}:</span></span>`
      : `<span class="chat-nick"><span class="agent-nick ${fromCls}" data-agent-id="${esc(m.from)}"${nowTitle(m.from, m.fromNameNow)}>${fromPrettyGlyph}${esc(nick)}</span><span class="chat-arrow">&rarr;</span><span class="agent-nick ${toCls}" data-agent-id="${esc(m.to)}"${nowTitle(m.to, m.toNameNow)}>${toPrettyGlyph}${esc(toNick)}</span>:</span>`
    return `<div class="chat-line terminal-msg ${dimClass}${isFromUser ? ' from-user' : ''}" data-msg-ts="${esc(m.timestamp || '')}" data-msg-from="${esc(m.from || '')}" data-msg-id="${esc(String(m._dbId || ''))}"><span class="chat-ts" draggable="true">${ts}</span> <span class="terminal-badge">term</span> ${nickHtml} ${text}</div>`
  }

  // --- Plan mode approval card ---
  if (m._evType === 'plan_approval') {
    const ts = timeShort(m.timestamp)
    const label = esc(m._agentLabel || agentLabel(m.from))
    const agentCls = getNickClass(m.from)
    const agentId = esc(m._agentId || m.from || '')
    const planText = (m._planText || '').trim()
    const planSnippet = planText.length > 800 ? '\u2026' + planText.slice(-800) : planText
    const planHtml = planSnippet
      ? `<pre class="plan-approval-plan">${esc(planSnippet)}</pre>`
      : ''
    return `<div class="chat-line plan-approval-card" data-agent-id="${agentId}" data-msg-ts="${esc(m.timestamp || '')}" data-msg-from="${esc(m.from || '')}">
      <span class="chat-ts">${ts}</span>
      <div class="lifecycle-card lc-plan-approval">
        <div class="lc-header"><span class="lc-icon">\uD83D\uDCCB</span> <span class="lc-title">Ready to proceed</span> <span class="lc-routing"><span class="${agentCls}">${label}</span> wants to start implementation</span></div>
        ${planHtml}
        <div class="plan-approval-hint">Reply <strong>yes</strong> / <strong>no</strong> in chat, or use buttons above</div>
      </div></div>`
  }

  // --- Terminal attention card (permission prompt auto-pop) ---
  if (m._evType === 'terminal_attention') {
    const ts = timeShort(m.timestamp)
    const label = esc(m._agentLabel || agentLabel(m.from))
    const reason = esc(m._reason || 'needs attention')
    const agentCls = getNickClass(m.from)
    const isPermission = (m._reason || '').includes('permission')
    const promptResponse = m._promptResponse || ''
    const responseCls = promptResponse === 'approved' ? ' lc-responded lc-approved' : promptResponse === 'rejected' ? ' lc-responded lc-rejected' : ''
    const evId = esc(String(m._dbId || ''))
    const actionBtns = isPermission
      ? `<span class="lc-actions"><button class="lc-approve-btn" data-agent-id="${esc(m.from)}" data-event-id="${evId}" title="Approve (y)">\u2713</button><button class="lc-deny-btn" data-agent-id="${esc(m.from)}" data-event-id="${evId}" title="Deny (n)">\u2717</button></span>`
      : ''
    const cardCls = isPermission ? 'lc-permission-card' : 'lc-terminal-card'
    const snippet = m._snippet ? `<div class="lc-prompt-body"><pre>${esc(m._snippet)}</pre></div>` : ''
    return `<div class="chat-line" data-msg-id="${esc(String(m._dbId || ''))}"><span class="chat-ts">${ts}</span>
      <div class="lifecycle-card lc-attention ${cardCls}${responseCls}" data-lc-type="attention" data-agent-id="${esc(m.from)}">
        <div class="lc-header"><span class="lc-icon">\u26A0</span> <span class="lc-title">${reason}</span> <span class="lc-chain"></span> <span class="lc-routing"><span class="agent-nick ${agentCls}" data-agent-id="${esc(m.from)}">${label}</span></span>${actionBtns}</div>${snippet}
      </div></div>`
  }

  // --- Terminal card (voluntary pop from agent) ---
  // Same UI shape as terminal_attention; only the trigger differs.
  if (m._evType === 'terminal_card') {
    const ts = timeShort(m.timestamp)
    const label = esc(m._agentLabel || agentLabel(m.from))
    const reason = esc(m._reason || 'requested attention')
    const agentCls = getNickClass(m.from)
    return `<div class="chat-line"><span class="chat-ts">${ts}</span>
      <div class="lifecycle-card lc-attention lc-terminal-card" data-lc-type="attention" data-agent-id="${esc(m.from)}">
        <div class="lc-header"><span class="lc-icon">\u26A0</span> <span class="lc-title">${reason}</span> <span class="lc-chain"></span> <span class="lc-routing"><span class="agent-nick ${agentCls}" data-agent-id="${esc(m.from)}">${label}</span></span></div>
      </div></div>`
  }

  // --- Task lifecycle cards ---
  if (m._evType === 'delegate') {
    const ts = timeShort(m.timestamp)
    const fromLabel = m._fromLabel || agentLabel(m.from)
    const toLabel = m._toLabel || agentLabel(m.to)
    const fromCls = getNickClass(m.from)
    const toCls = getNickClass(m.to)
    const desc = esc(m._description || m.text || '')
    const taskId = m._taskId || ''
    const criteria = m._criteria || []
    const criteriaHtml = criteria.length > 0
      ? `<div class="lc-criteria">${criteria.map(c => `<div class="lc-criterion">\u2610 ${esc(c)}</div>`).join('')}</div>`
      : ''
    // Show the full delegation message so the user can see what was actually asked
    const message = m._message || ''
    const messageHtml = message
      ? `<div class="lc-message">${linkifyCodeUrls(renderMarkdown(message))}</div>`
      : ''
    return `<div class="chat-line" data-msg-ts="${esc(m.timestamp || '')}" data-msg-from="${esc(m.from || '')}" data-msg-id="${esc(String(m._dbId || ''))}"><span class="chat-ts" draggable="true">${ts}</span>
      <div class="lifecycle-card lc-delegate" data-task-id="${esc(taskId)}" data-lc-type="delegate">
        <div class="drag-handle" title="Drag"></div>
        <div class="lc-header"><span class="lc-icon">\u25B6</span> <span class="lc-title">${desc}</span> <span class="lc-chain"></span> <span class="lc-routing"><span class="agent-nick ${fromCls}" data-agent-id="${esc(m.from)}">${esc(fromLabel)}</span> <span class="lc-arrow">\u2192</span> <span class="agent-nick ${toCls}" data-agent-id="${esc(m.to)}">${esc(toLabel)}</span></span></div>
        ${messageHtml}
        ${criteriaHtml}
      </div></div>`
  }
  if (m._evType === 'task_done') {
    const ts = timeShort(m.timestamp)
    const agentId = m._agent || m.from
    const agentName = agentLabel(agentId)
    const agentCls = getNickClass(agentId)
    const desc = esc(m._description || '')
    const taskId = m._taskId || ''
    return `<div class="chat-line" data-msg-ts="${esc(m.timestamp || '')}" data-msg-from="${esc(m.from || '')}" data-msg-id="${esc(String(m._dbId || ''))}"><span class="chat-ts" draggable="true">${ts}</span>
      <div class="lifecycle-card lc-done" data-task-id="${esc(taskId)}" data-lc-type="done">
        <div class="drag-handle" title="Drag"></div>
        <div class="lc-header"><span class="lc-icon">\u2713</span> <span class="lc-title">${desc}</span> <span class="lc-chain"></span> <span class="lc-routing"><span class="agent-nick ${agentCls}" data-agent-id="${esc(agentId)}">${esc(agentName)}</span></span></div>
      </div></div>`
  }
  if (/^\*\*Task bounced back:\*\*/.test(m.text || '')) {
    const ts = timeShort(m.timestamp)
    const fromLabel = agentLabel(m.from)
    const toLabel = agentLabel(m.to)
    const fromCls = getNickClass(m.from)
    const toCls = getNickClass(m.to)
    const feedback = (m.text || '').replace(/^\*\*Task bounced back:\*\*\s*/, '')
    return `<div class="chat-line" data-msg-ts="${esc(m.timestamp || '')}" data-msg-from="${esc(m.from || '')}" data-msg-id="${esc(String(m._dbId || ''))}"><span class="chat-ts" draggable="true">${ts}</span>
      <div class="lifecycle-card lc-bounced" data-lc-type="bounced">
        <div class="lc-header"><span class="lc-icon">\u21A9</span> <span class="lc-title">${esc(feedback)}</span> <span class="lc-chain"></span> <span class="lc-routing"><span class="agent-nick ${fromCls}" data-agent-id="${esc(m.from)}">${esc(fromLabel)}</span> <span class="lc-arrow">\u2192</span> <span class="agent-nick ${toCls}" data-agent-id="${esc(m.to)}">${esc(toLabel)}</span></span></div>
      </div></div>`
  }

  // --- Regular chat messages ---
  const nick = periodNick(m.from, m.fromName)
  const fromCls = getNickClass(m.from)
  const ts = timeShort(m.timestamp)
  // Strip system metadata before rendering
  let rawText = (m.text || '')
  let taskNotification = null
  const taskMatch = rawText.match(/<task-notification[^>]*>([\s\S]*?)<\/task-notification>/)
  if (taskMatch) {
    const taskXml = taskMatch[1]
    // DOMParser may not exist outside browser — use regex fallback
    let description, from, to
    if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser()
      const xmlDoc = parser.parseFromString(taskXml, 'text/xml')
      description = xmlDoc.getElementsByTagName('description')[0]?.textContent
      from = xmlDoc.getElementsByTagName('from')[0]?.textContent
      to = xmlDoc.getElementsByTagName('to')[0]?.textContent
    } else {
      description = taskXml.match(/<description>([\s\S]*?)<\/description>/)?.[1]
      from = taskXml.match(/<from>([\s\S]*?)<\/from>/)?.[1]
      to = taskXml.match(/<to>([\s\S]*?)<\/to>/)?.[1]
    }
    if (description) {
      taskNotification = { description: esc(description), from: esc(from), to: esc(to) }
    }
    rawText = rawText.replace(/<task-notification[^>]*>[\s\S]*?<\/task-notification>/g, '').trim()
  }
  // Pre-process: resolve image attachments in markdown image syntax before renderMarkdown.
  // ![alt]({{att:N}}) → ![alt](URL) so marked renders a real <img src="URL"> that DOMPurify accepts.
  // Without this, DOMPurify strips the invalid {{att:N}} src, leaving a broken image icon.
  let processedText = rawText
  if (m._inlineAttachments?.length) {
    processedText = processedText.replace(/!\[([^\]]*)\]\(\{\{att:(\d+)\}\}\)/g, (match, alt, idx) => {
      const att = m._inlineAttachments[+idx]
      if (att?.url && /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(att.name || att.path || '')) {
        return `![${alt}](${att.url})`
      }
      return match
    })
  }
  let text = m._raw ? esc(processedText) : linkifyCodeUrls(chipifyMarkdownApiFileLinks(renderMarkdown(esc(processedText))))
  // Replace «bullet:ID» tokens with card HTML using metadata
  if (m._bullets?.length) {
    text = text.replace(/«bullet:([\w-]+)»/g, (_match, id) => {
      const b = m._bullets.find(x => x.id === id)
      if (!b) return _match
      const btext = (b.text || '').replace(/^\s*[-*]\s+/, '').trim()
      const bodyHtml = renderMarkdown(esc(btext))
      const tupleStr = JSON.stringify(b.tuplePath || [])
      const shapeId = esc(b.noteShapeId || '')
      const tupleE = esc(tupleStr)
      return `<span class="bullet-card" data-shape-id="${shapeId}" data-bullet-tuple="${tupleE}"><span class="bullet-card-header"><span class="bullet-card-source">•<span class="bullet-card-depth">${tupleE}</span></span><span class="bullet-card-go" data-shape-id="${shapeId}" data-bullet-tuple="${tupleE}">→</span></span><span class="bullet-card-body">${bodyHtml}</span></span>`
    })
  }
  if (taskNotification) {
    text = `<div class="task-notification">
      <div class="task-notification-header">Task Notification</div>
      <div class="task-notification-body">
        <div class="task-notification-description">${taskNotification.description}</div>
        <div class="task-notification-from">From: ${taskNotification.from}</div>
        <div class="task-notification-to">To: ${taskNotification.to}</div>
      </div>
    </div>` + text
  }

  // Replace remaining {{att:N}} markers (standalone, not in markdown image syntax)
  text = text.replace(/\{\{att:(\d+)\}\}/g, (_, idx) => {
    const att = m._inlineAttachments?.[+idx]
    if (att?.type === 'file') {
      const name = esc(att.name || att.path?.split('/').pop() || 'file')
      const filePath = esc(att.path || '')
      if (att.broken) return `<span class="att-upload-failed" title="Upload failed">⚠ ${filePath}</span>`
      const fileUrl = att.url ? esc(att.url) : ''
      const isImage = /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(att.name || att.path || '')
      if (isImage && fileUrl) {
        return `<img class="chat-image" src="${fileUrl}" alt="${name}">`
      }
      const ext = (att.path || att.name || '').split('.').pop()?.toLowerCase() || ''
      const icon = ext === 'pdf' ? '📕' : ext === 'md' ? '📄' : '📎'
      const urlAttr = fileUrl ? ` data-url="${fileUrl}"` : ''
      return `<span class="ref-chip ref-chip-doc" data-path="${filePath}"${urlAttr} draggable="true"><span class="ref-chip-doc-icon">${icon}</span>${name}</span>`
    }
    return `<span class="ref-chip"><span class="ref-chip-doc-icon">📎</span>att:${idx}</span>`
  })
  const sender = (getAgents()).find(a => a.id === m.from)
  const msgAgo = m.timestamp ? (Date.now() - new Date(m.timestamp).getTime()) / 1000 : null
  const dimClass = msgAgo === null ? '' : msgAgo > 1800 ? 'chat-line-old' : msgAgo > 600 ? 'chat-line-mid' : 'chat-line-recent'
  const isFromUser = isHumanId(m.from)
  const isAmbient = !isFromUser && !isHumanId(m.to) && !isHumanId(m.from)
  const receipt = isFromUser
    ? (m.read
        ? '<span class="chat-receipt chat-read" title="read">☑</span>'
        : '<span class="chat-receipt chat-delivered" title="delivered">☐</span>')
    : ''
  // Multi-target: show all cc recipients
  let toHtml
  if (m.cc && m.cc.length > 1) {
    toHtml = m.cc.map(id => `<span class="agent-nick ${getNickClass(id)}" data-agent-id="${esc(id)}">${leadingPrettyGlyphHtml(id, getAgents)}${esc(agentNameTextOnly(id, getAgents, agentLabel(id)))}</span>`).join('<span class="cc-separator">,</span>')
  } else {
    const toNick = periodNick(m.to, m.toName)
    const toCls = getNickClass(m.to)
    toHtml = `<span class="agent-nick ${toCls}" data-agent-id="${esc(m.to)}"${nowTitle(m.to, m.toNameNow)}>${leadingPrettyGlyphHtml(m.to, getAgents)}${esc(toNick)}</span>`
  }

  // Render attachments as interactive refs
  function renderAttachChip(a) {
    if (a.type === 'shared-doc') {
      const rawTarget = String(a.url || a.path || '').trim()
      if (!rawTarget) return ''
      const fileUrl = /^(?:https?:\/\/|\/api\/)/i.test(rawTarget)
        ? rawTarget
        : `/api/file?path=${encodeURIComponent(rawTarget)}`
      const label = a.title || a.name || rawTarget.split('/').pop() || rawTarget
      const ext = (rawTarget || label).split('.').pop()?.toLowerCase() || ''
      const icon = ext === 'pdf' ? '📕' : ext === 'md' ? '📄' : '📎'
      const pathAttr = a.path ? ` data-path="${esc(a.path)}"` : ''
      const titleAttr = label ? ` data-title="${esc(label)}"` : ''
      return `<span class="ref-chip ref-chip-doc"${pathAttr} data-url="${esc(fileUrl)}"${titleAttr} draggable="true"><span class="ref-chip-doc-icon">${icon}</span>${esc(label)}</span>`
    }
    const agentId = (a.source || '').split(':')[1] || ''
    const agentName = agentId ? agentLabel(agentId) : ''
    const cardId = (a.source || '').split(':')[2] || ''
    const toolCount = (a.snippet || '').split('\n').filter(Boolean).length
    const chipTs = a.timestamp ? timeShort(a.timestamp) : ''
    const chipLabel = [agentName, `${toolCount} tool${toolCount !== 1 ? 's' : ''}`, chipTs].filter(Boolean).join(' \u00b7 ')
    const chipText = a.text || a.snippet || ''
    const previewHtml = chipText.split('\n').filter(Boolean).map(line => {
      const lm = line.match(/^(\d+)\s*(?:(×\d+)\s+)?(\S+?)(?::\s*(.*))?$/)
      if (lm) {
        return `<div class="tool-line"><span class="tool-linenum">${esc(lm[1])}</span>${lm[2] ? `<span class="tool-count">${esc(lm[2])}</span>` : ''}<span class="tool-name">${esc(lm[3])}</span>${lm[4] ? `<span class="tool-sep">:</span> <span class="tool-arg">${esc(lm[4])}</span>` : ''}</div>`
      }
      return `<div class="tool-call-line">${esc(line)}</div>`
    }).join('')
    return `<span class="tool-ref" data-card-id="${esc(cardId)}" data-source="${esc(a.source || '')}"><span class="tool-ref-type">${esc(a.type || 'ref')}</span> ${esc(chipLabel)}<span class="tool-ref-preview">${previewHtml}</span></span>`
  }

  // Pull attachments from metadata if not at top level
  if (!m.attachments && m.metadata?.attachments) m.attachments = m.metadata.attachments
  let attachHtml = ''
  if (m.attachments && m.attachments.length) {
    attachHtml = m.attachments.map(renderAttachChip).join(' ')
    attachHtml = ' ' + attachHtml
  }
  // Strip flattened attachment text and auto-generate chips from legacy messages
  const msgRawText = m.text || ''
  const hasAttachBlock = /\[[\w-]+\] [\s\S]+?\(from .+?\)/.test(msgRawText)
  let displayText = text
  if (hasAttachBlock) {
    const cleaned = msgRawText.replace(/\n?\n?\[[\w-]+\] [\s\S]+?\(from .+?\)/g, '').trim()
    displayText = linkifyCodeUrls(renderMarkdown(esc(cleaned)))
    if (!m.attachments || !m.attachments.length) {
      m.attachments = [...msgRawText.matchAll(/\[([\w-]+)\] ([\s\S]+?)\(from (.+?)\)/g)]
        .map(mx => ({ type: mx[1], snippet: mx[2].trim(), source: mx[3].trim() }))
      attachHtml = m.attachments.map(renderAttachChip).join(' ')
      attachHtml = ' ' + attachHtml
    }
  }
  // Failed local messages
  if (m._failed) {
    const tempId = esc(m._tempId || '')
    return `<div class="chat-line from-user" data-msg-ts="${esc(m.timestamp || '')}" data-msg-from="${esc(m.from || '')}" data-msg-id="${esc(String(m._dbId || ''))}"><span class="chat-ts">${ts}</span> <span class="chat-nick"><span class="agent-nick ${fromCls}" data-agent-id="${esc(m.from)}">${esc(nick)}:</span></span> ${displayText} <span class="chat-warning">\u26A0 not sent</span> <button class="chat-resend-btn" data-resend-to="${esc(m.to || '')}" data-resend-text="${esc(m.text || '')}" data-resend-tempid="${tempId}" title="Resend">\u21BB</button><button class="chat-dismiss-failed-btn" data-dismiss-tempid="${tempId}" title="Dismiss failed message" aria-label="Dismiss failed message">&times;</button></div>`
  }
  // Voicemail
  if (m._voicemail) {
    const vmColor = m._voicemailReason === 'unreachable' ? 'var(--red, #e55)' : 'var(--orange)'
    const vmLabel = m._voicemailReason || 'queued'
    return `<div class="chat-line from-user chat-queued chat-voicemail" data-vm-color="${vmColor}" data-msg-ts="${esc(m.timestamp || '')}" data-msg-from="${esc(m.from || '')}" data-msg-id="${esc(String(m._dbId || ''))}"><span class="chat-ts">${ts}</span> <span class="chat-nick"><span class="agent-nick ${fromCls}" data-agent-id="${esc(m.from)}">${esc(nick)}:</span></span> ${displayText} <span class="chat-voicemail-label">${vmLabel}</span></div>`
  }
  // Retracted messages
  if (m._retracted) {
    return `<div class="chat-line from-user chat-retracted"><span class="chat-ts">${ts}</span> <span class="chat-nick"><span class="agent-nick ${fromCls}" data-agent-id="${esc(m.from)}">${esc(nick)}:</span></span> ${displayText}</div>`
  }
  // Retract button for recent user messages
  const msgAge = Date.now() - new Date(m.timestamp).getTime()
  const retractBtn = isFromUser && msgAge < 300000
    ? `<span class="chat-retract" data-ts="${esc(m.timestamp)}" title="Retract">\u232B</span>`
    : ''
  // Queued: message from human to a currently-thinking agent, sent after thinking started
  const thinkingAgents = ctx.thinkingAgents
  const targetThinkingSince = thinkingAgents?.get?.(m.to)
  const msgTs = m.timestamp ? new Date(m.timestamp).getTime() : 0
  const isQueued = isFromUser && targetThinkingSince && msgTs >= targetThinkingSince
  const lineClass = `chat-line${isFromUser ? ' from-user' : ''}${isAmbient ? ' ambient' : ''}${isQueued ? ' chat-queued' : ''}`
  // Delegation arrows
  const activeTasks = getTasks().filter(t => t.status !== 'done')
  const isDelegator = activeTasks.some(t => t.delegated_by === m.from && t.agent === m.to)
  const isDelegatee = activeTasks.some(t => t.delegated_by === m.to && t.agent === m.from)
  const arrowHtml = isDelegator ? '&#8600;' : isDelegatee ? '&#8599;' : '&rarr;'
  const planMode = sender?.metadata?.inPlanMode || sender?.metadata?.permission_mode === 'plan'
  const planModeType = sender?.metadata?.planModeType
  const planEmoji = planModeType === 'outline' ? '📝' : '📅'
  const planTitle = planModeType === 'outline' ? 'outline mode' : 'plan mode'
  const planBadge = planMode ? `<span class="plan-mode-badge plan-badge-click" data-agent-id="${esc(m.from)}" title="Click to exit ${planTitle}">${planEmoji}</span>` : ''
  const fromPrettyGlyph = leadingPrettyGlyphHtml(m.from, getAgents)
  const fromTitle = nowTitle(m.from, m.fromNameNow)
  const nickHtml = isAmbient
    ? `<span class="chat-nick"><span class="agent-nick ${fromCls}" data-agent-id="${esc(m.from)}"${fromTitle}>${fromPrettyGlyph}${esc(nick)}</span>${planBadge}<span class="chat-arrow">${arrowHtml}</span>${toHtml}:</span>`
    : `<span class="chat-nick"><span class="agent-nick ${fromCls}" data-agent-id="${esc(m.from)}"${fromTitle}>${fromPrettyGlyph}${esc(nick)}</span>${planBadge}:</span>`
  // Long message: block display
  const rawLineCount = (m.text || '').split('\n').length
  const isLongMsg = rawLineCount > 20
  let bodyText = `<span class="message-body${isLongMsg ? ' message-long' : ''}">${displayText}</span>`
  // Provenance chip: a message body baked from a file section (chat/amend with
  // file+section) carries metadata.source = { file, section }. Show a subtle
  // "from <file> §<section>" chip so the reader can see/open the source. Reuses
  // the existing ref-chip styling — no new visual language.
  let sourceChipHtml = ''
  const _src = m.metadata?.source
  if (_src && _src.file) {
    const _fileName = esc(String(_src.file).split('/').pop() || _src.file)
    const _section = _src.section ? esc(String(_src.section)) : ''
    const _sectionHtml = _section ? `<span class="src-chip-section">§${_section}</span>` : ''
    const _title = `from ${esc(String(_src.file))}${_section ? ' §' + _section : ''}`
    const _sectionAttr = _section ? ` data-section="${_section}"` : ''
    sourceChipHtml = ` <span class="ref-chip ref-chip-doc src-chip" data-path="${esc(String(_src.file))}"${_sectionAttr} title="${_title}" draggable="true"><span class="ref-chip-doc-icon">📄</span>${_fileName}${_sectionHtml}</span>`
  }
  // Amend version stepper (V{n} ◀▶) — present only on a message that's been
  // amended (folded by FleetChatShape, which sets m._amendStepper).
  const amendStepper = m._amendStepper || ''
  let line
  if (isAmbient) {
    line = `<div class="${lineClass} ${dimClass}" data-msg-ts="${esc(m.timestamp || '')}" data-msg-from="${esc(m.from || '')}" data-msg-id="${esc(String(m._dbId || ''))}"><span class="chat-ts" draggable="true">${ts}</span> ${nickHtml} ${bodyText}${sourceChipHtml}${amendStepper}${attachHtml}</div>`
  } else {
    line = `<div class="${lineClass} ${dimClass}" data-msg-ts="${esc(m.timestamp || '')}" data-msg-from="${esc(m.from || '')}" data-msg-id="${esc(String(m._dbId || ''))}"><span class="chat-ts" draggable="true">${ts}</span> ${nickHtml} ${bodyText}${sourceChipHtml}${amendStepper}${receipt}${attachHtml}${retractBtn}</div>`
  }
  if (m._interrupt) {
    const age = Date.now() - new Date(m.timestamp).getTime()
    const cls = age < 10000 ? 'chat-interrupt-line fresh' : 'chat-interrupt-line'
    line += `<hr class="${cls}" data-ts="${m.timestamp}">`
  }
  return line
}
