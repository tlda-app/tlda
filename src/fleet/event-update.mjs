export function eventUpdateFields(data) {
  const fields = {}
  if (Object.hasOwn(data || {}, 'text')) fields.text = data.text
  if (data?.metadata_patch && typeof data.metadata_patch === 'object') {
    fields.metadata = data.metadata_patch
    if (Object.hasOwn(data.metadata_patch, 'next_fire_at')) {
      fields._taskNextFireAt = data.metadata_patch.next_fire_at
    }
    if (Object.hasOwn(data.metadata_patch, 'approvedAt')) fields._promptResponse = 'approved'
    if (Object.hasOwn(data.metadata_patch, 'rejectedAt')) fields._promptResponse = 'rejected'
  }
  return fields
}

export function applyFleetEventUpdate(data, updateEventById) {
  const eventId = data?.id ?? data?.event_id
  if (eventId == null) return false
  updateEventById(eventId, eventUpdateFields(data))
  return true
}
