export const INBOX_STATUSES = ['available', 'busy', 'dnd']
export const INBOX_VIEWS = ['default', 'review', 'monitoring', 'current-task', 'all']
export const MESSAGE_PRIORITIES = ['normal', 'important', 'urgent']
export const DELIVERY_CHANNELS = ['channel', 'tmux']
export const DEFAULT_SUBSCRIPTION_BATCH_MS = 5 * 60 * 1000

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

// A bare number is rejected rather than assumed. `batch(15)` used to mean
// fifteen MINUTES, so an agent that meant seconds got a window sixty times too
// long and nothing said so — and the failure is invisible, because a batch that
// arrives late looks exactly like a batch that has not arrived yet. Skip asked
// for a live transcript subscription at `batch(15s)` on 7/31 and named the
// error himself: "15 what?"
export function batchUnitMissing(policy) {
  const match = String(policy || '').trim().match(/^batch\((.+)\)$/i)
  if (!match) return null
  const spec = match[1].trim().toLowerCase()
  const bare = spec.match(/^(\d+(?:\.\d+)?)$/)
  return bare ? bare[1] : null
}

export function parseBatchWindowMs(policy, { defaultMs = DEFAULT_SUBSCRIPTION_BATCH_MS } = {}) {
  const match = String(policy || '').trim().match(/^batch\((.+)\)$/i)
  if (!match) return null
  const spec = match[1].trim().toLowerCase()
  if (!spec) return null
  if (spec === 'default') return defaultMs
  const duration = spec.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/)
  if (!duration) return null
  const value = Number(duration[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const unit = duration[2]
  const scale = unit === 'ms' ? 1
    : ['s', 'sec', 'secs', 'second', 'seconds'].includes(unit) ? 1000
      : ['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit) ? 60 * 60 * 1000
        : 60 * 1000
  const ms = Math.round(value * scale)
  return Number.isFinite(ms) && ms > 0 ? ms : null
}

export function decideSubscriptionDelivery({ policy, priority, now = Date.now() } = {}) {
  const p = String(policy || 'immediate').trim()
  if (normalizeMessagePriority(priority) === 'urgent') {
    return { delivery: 'notified', wokeRecipient: 'yes', notifyBy: null }
  }
  if (p === 'immediate') return { delivery: 'notified', wokeRecipient: 'yes', notifyBy: null }
  if (p === 'hold') return { delivery: 'queued', wokeRecipient: 'no', notifyBy: null }
  const batchWindowMs = parseBatchWindowMs(p)
  if (batchWindowMs != null) {
    return { delivery: 'batched', wokeRecipient: 'not_yet', notifyBy: new Date(now + batchWindowMs).toISOString() }
  }
  return null
}

export function formatAttentionReceipt({ recipientLabel, status, tag, priority, delivery, notifyBy, notificationPolicy }) {
  const label = notificationPolicy
    ? `${recipientLabel || 'recipient'} [${notificationPolicy}]`
    : `${recipientLabel || 'recipient'} [${normalizeInboxStatus(status)}${tag ? ` (${tag})` : ''}]`
  const p = normalizeMessagePriority(priority)
  // "Notified" was a completed-action verb for something that has not happened.
  // Everything this function is given is pre-delivery: `delivery` is the policy
  // decision from decideSubscriptionDelivery, `status` is the recipient's inbox
  // state, and the channel is their *configured* preference. The server's own
  // trace at this moment says `status: 'stored'`. Nothing here is evidence the
  // message reached anyone, and on 2026-08-08 an agent was told
  // "Notified skip [available]" for a message Skip never received. The other
  // branches below already say Queued/Batched/Held and were never the problem.
  if (delivery === 'notified') return `Notify queued for ${label}${p === 'normal' ? '' : ` as ${p}`}.`
  if (delivery === 'batched') {
    const when = notifyBy ? ` This will be delivered by ${new Date(notifyBy).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''
    return `Batched for ${label}.${when}\nSay "this is urgent" if it should interrupt now.`
  }
  if (notificationPolicy === 'hold') {
    return `Held for ${label}. It did not wake them.\nSay "this is urgent" if it should interrupt now.`
  }
  if (normalizeInboxStatus(status) === 'dnd') {
    return `Queued for ${label}. It did not wake them.\nSay "this is urgent" if it should interrupt.`
  }
  return `Queued for ${label}. It did not wake them.\nSay "this is important" if it should interrupt.`
}
