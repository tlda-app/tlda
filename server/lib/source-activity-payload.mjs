import { activeSourceEditors } from './source-edit-activity.mjs'

/**
 * Who is editing this source file, and who changed it last.
 *
 * Two callers build this: GET /:name/source-activity, which answers a viewer
 * that has just opened the file, and the broadcaster that pushes the same shape
 * when the editor set changes. They must agree -- a poll and a push that
 * disagree about the shape is a pill that flickers between two truths -- so the
 * shape is built once, here.
 */
export async function sourceActivityPayload(fleetStore, project, file) {
  const editorIds = activeSourceEditors(project, file)
  const editors = await Promise.all(editorIds.map(async id => {
    const agent = await fleetStore?.getAgent?.(id)
    return { id, name: agent?.friendly_name || id }
  }))
  // One indexed row, not the whole attribution history. This used to answer
  // with readEditEvents(name, { limit: Infinity }) -- a full synchronous read
  // and parse of an append-only JSONL, on the main thread, once a second. The
  // server's own lag profiler measured 809ms stalls in it, which is enough to
  // blow capture-pane and agent-wake deadlines and leave the fleet unreachable.
  const last = await fleetStore?.lastSourceFileChange?.(project, file) || null
  let lastChangedBy = last?.agentId || null
  if (lastChangedBy) {
    const agent = await fleetStore?.getAgent?.(lastChangedBy)
    lastChangedBy = agent?.friendly_name || lastChangedBy
  }
  return {
    file,
    editors,
    lastChangedAt: last?.timestamp ? Date.parse(last.timestamp) : null,
    lastChangedBy,
  }
}
