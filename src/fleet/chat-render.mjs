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

// --- Pure helpers (copied from utils.mjs) ---

export function esc(s) {
  if (s == null) return ''
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
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

// --- Standalone att-token resolver ---
// Used by unquote Tier 2 to render a rechat result (resolvedMessage + inlineAttachments)
// into HTML without the full chat-line wrapper. renderMarkdown is the same function
// passed via ctx to renderChatLine.
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
  let html = renderMarkdown(esc(processed))
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

const PHASE_ICON_DAWN = '<svg width="10" height="10" viewBox="0 0 16 16" style="opacity:0.6;vertical-align:-1px;margin-right:2px"><line x1="0.5" y1="11" x2="15.5" y2="11" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/><path d="M9 11 a3 3 0 0 1 6 0" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="6" x2="12" y2="4" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/><line x1="15" y1="9" x2="16.5" y2="8" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/></svg>'
const PHASE_ICON_DUSK = '<svg width="10" height="10" viewBox="0 0 16 16" style="opacity:0.6;vertical-align:-1px;margin-right:2px"><line x1="0.5" y1="11" x2="15.5" y2="11" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/><path d="M1 11 a3 3 0 0 1 6 0" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/><line x1="4" y1="6" x2="4" y2="4" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="9" x2="-0.5" y2="8" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round"/></svg>'

function phaseIconHtml(agentId, getAgents) {
  if (!getAgents) return ''
  const agents = getAgents()
  const a = agents?.find(x => x.id === agentId)
  if (!a?.phase || a.phase === 'day') return ''
  return a.phase === 'dawn' ? PHASE_ICON_DAWN : a.phase === 'dusk' ? PHASE_ICON_DUSK : ''
}

export function renderChatLine(m, ctx) {
  const { agentLabel, getNickClass, isHumanId, getAgents, getTasks, tldaToken, renderMarkdown } = ctx

  // Timer countdown: live countdown for active timers
  if (m._timerCountdown) {
    const nick = agentLabel(m.from)
    const cls = getNickClass(m.from)
    const r = m._timerRemaining
    const mins = Math.floor(r / 60)
    const secs = r % 60
    const timeStr = mins > 0 ? `${mins}:${String(secs).padStart(2, '0')}` : `${secs}s`
    const msg = esc(m._timerMessage)
    return `<div class="chat-line chat-timer-countdown" data-msg-from="${esc(m.from || '')}" data-timer-until="${esc(m._timerUntil || '')}"><span class="chat-ts">${timeShort(m.timestamp)}</span> <span class="agent-nick ${cls}" data-agent-id="${esc(m.from)}">${esc(nick)}</span> <span class="timer-msg">\u23F1 ${timeStr} \u2192 ${msg}</span></div>`
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
  if ((m.text || '').includes('[Request interrupted by user]')) return ''

  // --- Terminal messages (from JSONL session logs) ---
  if (m._evType === 'terminal_user' || m._evType === 'terminal_assistant') {
    if ((m.text || '').includes('[Request interrupted by user]')) return ''
    if (/^[\s📬]*$/.test(m.text || '')) return ''
    if (m.from && m.from === m.to) return ''
    const nick = agentLabel(m.from)
    const fromCls = getNickClass(m.from)
    const ts = timeShort(m.timestamp)
    let rawText = (m.text || '').trim()
    if (rawText.length > 500) rawText = rawText.substring(0, 500) + '...'
    const text = linkifyCodeUrls(renderMarkdown(esc(rawText)))
    const msgAgo = m.timestamp ? (Date.now() - new Date(m.timestamp).getTime()) / 1000 : null
    const dimClass = msgAgo === null ? '' : msgAgo > 1800 ? 'chat-line-old' : msgAgo > 600 ? 'chat-line-mid' : 'chat-line-recent'
    const toNick = agentLabel(m.to)
    const toCls = getNickClass(m.to)
    const isFromUser = isHumanId(m.from)
    const fromPhaseIcon = phaseIconHtml(m.from, getAgents)
    const toPhaseIcon = phaseIconHtml(m.to, getAgents)
    const nickHtml = isFromUser
      ? `<span class="chat-nick"><span class="agent-nick ${fromCls}" data-agent-id="${esc(m.from)}">${esc(nick)}:</span></span>`
      : `<span class="chat-nick"><span class="agent-nick ${fromCls}" data-agent-id="${esc(m.from)}">${fromPhaseIcon}${esc(nick)}</span><span class="chat-arrow">&rarr;</span><span class="agent-nick ${toCls}" data-agent-id="${esc(m.to)}">${toPhaseIcon}${esc(toNick)}</span>:</span>`
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
  const nick = agentLabel(m.from)
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
  let text = m._raw ? esc(processedText) : linkifyCodeUrls(renderMarkdown(esc(processedText)))
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

  // Convert uploaded file links into chips — <a href="/api/files/name.ext">name.ext</a> → ref-chip
  // This handles files drag-dropped from Finder (uploaded, inserted as markdown links)
  text = text.replace(/<a\s[^>]*href="((?:https?:\/\/[^"]*)?\/api\/files\/([^"]+))"[^>]*>([^<]*)<\/a>/gi, (_match, url, fileName, label) => {
    const ext = fileName.split('.').pop()?.toLowerCase() || ''
    const isImage = /^(png|jpg|jpeg|gif|webp|svg)$/.test(ext)
    if (isImage) {
      return `<img class="chat-image" src="${url}" alt="${esc(label)}">`
    }
    const icon = ext === 'pdf' ? '📕' : ext === 'md' ? '📄' : '📎'
    return `<span class="ref-chip ref-chip-doc" data-url="${esc(url)}" draggable="true"><span class="ref-chip-doc-icon">${icon}</span>${esc(label)}</span>`
  })

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
    toHtml = m.cc.map(id => `<span class="agent-nick ${getNickClass(id)}" data-agent-id="${esc(id)}">${esc(agentLabel(id))}</span>`).join('<span class="cc-separator">,</span>')
  } else {
    const toNick = agentLabel(m.to)
    const toCls = getNickClass(m.to)
    toHtml = `<span class="agent-nick ${toCls}" data-agent-id="${esc(m.to)}">${esc(toNick)}</span>`
  }

  // Render attachments as interactive refs
  function renderAttachChip(a) {
    if (a.type === 'shared-doc') {
      const parts = (a.source || '').split(':')
      const docName = parts.slice(3).join(':') || parts[parts.length - 1] || 'doc'
      const filePath = a.path || ''
      // Extract title from explicit field or first heading in content
      let title = a.title || ''
      if (!title && a.text) {
        const m = a.text.match(/^#\s+(.+)$/m)
        if (m) title = m[1].trim()
      }
      if (!title) title = docName
      // Determine file type from path extension
      const ext = filePath.split('.').pop()?.toLowerCase() || ''
      const isImage = /^(png|jpg|jpeg|gif|svg|webp)$/.test(ext)
      // Image shared-docs: render inline at 75% width
      if (isImage && a.url) {
        return `<img class="chat-image chat-image-shared-doc" src="${esc(a.url)}" alt="${esc(title)}" title="${esc(title)}">`
      }
      const icon = isImage ? '🖼' : ext === 'pdf' ? '📕' : '📄'
      return `<span class="ref-chip ref-chip-doc" data-path="${esc(filePath)}" data-doc="${esc(docName)}" data-title="${esc(title)}" draggable="true"><span class="ref-chip-doc-icon">${icon}</span>${esc(title)}</span>`
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
    return `<div class="chat-line from-user" data-msg-ts="${esc(m.timestamp || '')}" data-msg-from="${esc(m.from || '')}" data-msg-id="${esc(String(m._dbId || ''))}"><span class="chat-ts">${ts}</span> <span class="chat-nick"><span class="agent-nick ${fromCls}" data-agent-id="${esc(m.from)}">${esc(nick)}:</span></span> ${displayText} <span class="chat-warning">\u26A0 not sent</span></div>`
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
  const nickHtml = isAmbient
    ? `<span class="chat-nick"><span class="agent-nick ${fromCls}" data-agent-id="${esc(m.from)}">${esc(nick)}</span>${planBadge}<span class="chat-arrow">${arrowHtml}</span>${toHtml}:</span>`
    : `<span class="chat-nick"><span class="agent-nick ${fromCls}" data-agent-id="${esc(m.from)}">${esc(nick)}</span>${planBadge}:</span>`
  // Long message: block display
  const rawLineCount = (m.text || '').split('\n').length
  const isLongMsg = rawLineCount > 20
  let bodyText = isLongMsg ? `<span class="message-body message-long">${displayText}</span>` : displayText
  let line
  if (isAmbient) {
    line = `<div class="${lineClass} ${dimClass}" data-msg-ts="${esc(m.timestamp || '')}" data-msg-from="${esc(m.from || '')}" data-msg-id="${esc(String(m._dbId || ''))}"><span class="chat-ts" draggable="true">${ts}</span> ${nickHtml} ${bodyText}${attachHtml}</div>`
  } else {
    line = `<div class="${lineClass} ${dimClass}" data-msg-ts="${esc(m.timestamp || '')}" data-msg-from="${esc(m.from || '')}" data-msg-id="${esc(String(m._dbId || ''))}"><span class="chat-ts" draggable="true">${ts}</span> ${nickHtml} ${bodyText}${receipt}${attachHtml}${retractBtn}</div>`
  }
  if (m._interrupt) {
    const age = Date.now() - new Date(m.timestamp).getTime()
    const cls = age < 10000 ? 'chat-interrupt-line fresh' : 'chat-interrupt-line'
    line += `<hr class="${cls}" data-ts="${m.timestamp}">`
  }
  return line
}
