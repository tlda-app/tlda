/**
 * Who edited each build of an interval.
 *
 * Separated from the route because this is the part with a wrong answer
 * available. Everything else the bridge does is a read: the range comes from
 * `git log`, the activity rows come from one indexed query. This is the only
 * step that decides something, and what it decides is an attribution — which
 * is the one thing the whole feature exists to tell somebody.
 *
 * Neither repository records an author. A shadow commit says `Build at
 * <time>`, the daemon's revision commit says `tlda project revision`, and the
 * git author is whoever the machine is configured as. So the only record of
 * who edited a file is the activity event the daemon stamps with the project
 * and the project-relative path, and joining it to a build is a judgement
 * about time and files rather than a lookup.
 */

/**
 * Attribute edits to builds.
 *
 * @param builds  oldest first, each `{ hash, timestamp, files }`
 * @param edits   oldest first, each `{ agentId, taskId, file, timestampMs }`
 * @returns the same builds, each with `editors: [{ agentId, taskId, files }]`
 *
 * An edit belongs to the first build that happened at or after it AND changed
 * the same file. Time alone would credit an edit to a build that did not
 * contain it, which is a confident wrong answer; the file test is what makes
 * this a claim about this build rather than about this minute.
 *
 * An edit no build has claimed stays pending rather than being consumed by the
 * build it failed to match. A file edited at 10:00 and first built at 10:20
 * has builds in between that did not touch it, and dropping it at the first of
 * those would lose the only author the system has.
 *
 * Edits are grouped per build by agent and task, so one agent's four files in
 * one task read as one editor rather than four.
 */
export function attributeEditsToBuilds(builds, edits) {
  const pending = []
  let cursor = 0
  return builds.map(build => {
    while (cursor < edits.length && edits[cursor].timestampMs <= build.timestamp) {
      pending.push(edits[cursor])
      cursor += 1
    }

    const changed = new Set(build.files || [])
    const editors = new Map()
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      if (!changed.has(pending[i].file)) continue
      const { agentId, taskId, file } = pending.splice(i, 1)[0]
      const key = `${agentId}:${taskId || ''}`
      const existing = editors.get(key)
      if (existing) existing.files.add(file)
      else editors.set(key, { agentId, taskId: taskId || null, files: new Set([file]) })
    }

    return {
      ...build,
      editors: [...editors.values()].map(editor => ({ ...editor, files: [...editor.files] })),
    }
  })
}

/**
 * Turn stored activity rows into the edits above.
 *
 * `metadata` arrives as the JSON text the store holds. A row without a
 * `sourceFile` is not an edit to a project file -- the skill-dismiss activity
 * is the other thing of this type and it names a file nobody edited -- so it
 * contributes nothing rather than an unattributable guess.
 */
export function editsFromActivity(rows) {
  const edits = []
  for (const row of rows || []) {
    let metadata = row.metadata
    if (typeof metadata === 'string') {
      try { metadata = JSON.parse(metadata) } catch { metadata = null }
    }
    const file = metadata?.sourceFile
    if (!file) continue
    edits.push({
      agentId: row.from ?? row.from_id ?? null,
      taskId: row.task_id || null,
      file,
      timestampMs: new Date(row.timestamp).getTime(),
    })
  }
  return edits
}
