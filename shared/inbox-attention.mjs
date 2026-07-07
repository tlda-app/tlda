export const INBOX_STATUSES = ['available', 'busy', 'dnd']
export const INBOX_VIEWS = ['default', 'review', 'monitoring', 'current-task', 'all']
export const MESSAGE_PRIORITIES = ['normal', 'important', 'urgent']
export const DELIVERY_CHANNELS = ['channel', 'tmux']

const PRIORITY_LEVEL = {
  normal: 1,
  important: 2,
  urgent: 3,
}

const STATUS_THRESHOLD = {
  available: 'normal',
  busy: 'important',
  dnd: 'urgent',
}

export function normalizeInboxStatus(status) {
  const s = String(status || 'available').trim().toLowerCase()
  return INBOX_STATUSES.includes(s) ? s : 'available'
}

export function validateInboxStatus(status) {
  const s = String(status || '').trim().toLowerCase()
  return INBOX_STATUSES.includes(s) ? s : null
}

export function normalizeInboxView(view) {
  const v = String(view || 'default').trim().toLowerCase()
  return INBOX_VIEWS.includes(v) ? v : 'default'
}

export function validateInboxView(view) {
  const v = String(view || '').trim().toLowerCase()
  return INBOX_VIEWS.includes(v) ? v : null
}

export function normalizeMessagePriority(priority) {
  const p = String(priority || 'normal').trim().toLowerCase()
  return MESSAGE_PRIORITIES.includes(p) ? p : 'normal'
}

export function normalizeDeliveryChannel(channel) {
  const c = String(channel || 'channel').trim().toLowerCase()
  return DELIVERY_CHANNELS.includes(c) ? c : 'channel'
}

export function validateDeliveryChannel(channel) {
  const c = String(channel || '').trim().toLowerCase()
  return DELIVERY_CHANNELS.includes(c) ? c : null
}

export function parsePriorityPhrase(text) {
  const s = String(text || '').toLowerCase()
  if (/\bthis\s+is\s+urgent\b/.test(s)) return 'urgent'
  if (/\bthis\s+is\s+important\b/.test(s)) return 'important'
  return null
}

export function thresholdForStatus(status) {
  return STATUS_THRESHOLD[normalizeInboxStatus(status)]
}

export function priorityMeetsStatus(priority, status) {
  return PRIORITY_LEVEL[normalizeMessagePriority(priority)] >= PRIORITY_LEVEL[thresholdForStatus(status)]
}

export function decideInboxDelivery({ status, priority, now = Date.now(), batchWindowMs = 2 * 60 * 1000 } = {}) {
  const s = normalizeInboxStatus(status)
  const p = normalizeMessagePriority(priority)
  if (priorityMeetsStatus(p, s)) {
    return { delivery: 'notified', wokeRecipient: 'yes', notifyBy: null }
  }
  if (s === 'busy') {
    return { delivery: 'batched', wokeRecipient: 'not_yet', notifyBy: new Date(now + batchWindowMs).toISOString() }
  }
  return { delivery: 'queued', wokeRecipient: 'no', notifyBy: null }
}

export function shouldWakeBatchedMessage({ status, unreadPending }) {
  return normalizeInboxStatus(status) === 'busy' && unreadPending === true
}

export function formatAttentionReceipt({ recipientLabel, status, tag, priority, delivery, notifyBy }) {
  const label = `${recipientLabel || 'recipient'} [${normalizeInboxStatus(status)}${tag ? ` (${tag})` : ''}]`
  const p = normalizeMessagePriority(priority)
  if (delivery === 'notified') return `Notified ${label}${p === 'normal' ? '' : ` as ${p}`}.`
  if (delivery === 'batched') {
    const when = notifyBy ? ` This will be delivered by ${new Date(notifyBy).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''
    return `Batched for ${label}.${when}\nSay "this is important" if it should interrupt.`
  }
  if (normalizeInboxStatus(status) === 'dnd') {
    return `Queued for ${label}. It did not wake them.\nSay "this is urgent" if it should interrupt.`
  }
  return `Queued for ${label}. It did not wake them.\nSay "this is important" if it should interrupt.`
}
