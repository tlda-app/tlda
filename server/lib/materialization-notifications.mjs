export function formatMaterializationFailureNotification({ eventId, failures }) {
  const rows = (failures || []).map(({ attachment = {}, record = {} }, index) => ({
    name: attachment.name || record.title || `attachment ${attachment.id ?? index}`,
    reason: record.error || 'unknown error',
  }))
  if (rows.length === 0) return null
  if (rows.length === 1) {
    return `Attachment materialization failed for message ${eventId}: ${rows[0].name}\n${rows[0].reason}`
  }
  const reasons = new Set(rows.map(row => row.reason))
  const header = `${rows.length} attachments failed to materialize for message ${eventId}:`
  if (reasons.size === 1) {
    return `${header}\n${rows.map(row => `- ${row.name}`).join('\n')}\n\nReason: ${rows[0].reason}`
  }
  return `${header}\n${rows.map(row => `- ${row.name} — ${row.reason}`).join('\n')}`
}
