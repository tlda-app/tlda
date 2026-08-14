import { readEditEvents } from './edit-events.mjs'
import { sourceLifecycleStore } from './project-store.mjs'

const MATH_ENVIRONMENTS = new Set([
  'displaymath', 'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*',
  'flalign', 'flalign*', 'gather', 'gather*', 'multline', 'multline*',
])

function visibleTex(line) {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== '%') continue
    let escapes = 0
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j -= 1) escapes += 1
    if (escapes % 2 === 0) return line.slice(0, i)
  }
  return line
}

export function mathBlocks(source) {
  const blocks = []
  const stack = []
  const lines = source.split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = visibleTex(raw)
    const tokens = [...line.matchAll(/\\begin\{([^}]+)\}|\\end\{([^}]+)\}|\\\[|\\\]|\$\$/g)]
    for (const match of tokens) {
      const lineNumber = index + 1
      if (MATH_ENVIRONMENTS.has(match[1])) {
        stack.push({ kind: 'environment', environment: match[1], start_line: lineNumber })
      } else if (MATH_ENVIRONMENTS.has(match[2])) {
        const position = stack.map(item => `${item.kind}:${item.environment}`).lastIndexOf(`environment:${match[2]}`)
        if (position >= 0) blocks.push({ ...stack.splice(position, 1)[0], end_line: lineNumber })
      } else {
        const delimiter = match[0]
        const closing = delimiter === '\\]' ? '\\[' : delimiter
        const position = stack.map(item => item.delimiter).lastIndexOf(closing)
        if (delimiter === '\\]' || position >= 0) {
          if (position >= 0) blocks.push({ ...stack.splice(position, 1)[0], end_line: lineNumber })
        } else {
          stack.push({ kind: 'delimiter', delimiter, start_line: lineNumber })
        }
      }
    }
  }
  return blocks
}

function enclosing(source, hunks, side) {
  const start = Math.min(...hunks.map(hunk => hunk[`${side}_start`]))
  const end = Math.max(...hunks.map(hunk => hunk[`${side}_start`] + Math.max(hunk[`${side}_lines`], 1) - 1))
  return mathBlocks(source)
    .filter(block => start >= block.start_line && end <= block.end_line)
    .sort((a, b) => (a.end_line - a.start_line) - (b.end_line - b.start_line))[0] || null
}

const slice = (source, block) => source.split('\n').slice(block.start_line - 1, block.end_line).join('\n')
const changed = (source, hunks, side) => source.split('\n').filter((_, index) => hunks.some(hunk => hunk[`${side}_lines`] > 0 && index >= hunk[`${side}_start`] - 1 && index < hunk[`${side}_start`] - 1 + hunk[`${side}_lines`])).join('\n')
const eventFor = (events, id) => events.find(event => event.attribution_basis?.operation_id === id || event.attribution_basis?.candidate_operation_ids?.includes(id))

export function createEditActivityProjector({ fleetStore, readEvents = readEditEvents, lifecycleFor = sourceLifecycleStore, onProjected = null } = {}) {
  return {
    async project(project = null) {
      for (const activity of await fleetStore.pendingEditActivities(project)) {
        const metadata = activity.metadata || {}
        const operationId = metadata.input?.edit_operation?.operation_id
        if (!metadata.project || !operationId) continue
        const payload = await readEvents(metadata.project)
        const event = eventFor(payload.events || payload, operationId)
        if (!event) continue
        const lifecycle = await lifecycleFor(metadata.project)
        const pairs = event.changed_files.map(file => ({
          file,
          before: lifecycle.readRevisionFile(event.previous_source_revision, file.path)?.toString(),
          after: lifecycle.readRevisionFile(event.after_source_revision, file.path)?.toString(),
        }))
        const samePath = pairs.find(candidate => candidate.before != null && candidate.after != null)
        const beforePair = samePath || pairs.find(candidate => candidate.before != null)
        const afterPair = samePath || pairs.find(candidate => candidate.after != null)
        if (!beforePair || !afterPair) continue
        const oldBlock = enclosing(beforePair.before, beforePair.file.hunks, 'old')
        const newBlock = enclosing(afterPair.after, afterPair.file.hunks, 'new')
        const compatible = oldBlock && newBlock && oldBlock.kind === newBlock.kind && oldBlock.environment === newBlock.environment && oldBlock.delimiter === newBlock.delimiter
        const canonical = {
          project: metadata.project,
          file: afterPair.file.path,
          before_file: beforePair.file.path,
          after_file: afterPair.file.path,
          before_revision: event.previous_source_revision,
          after_revision: event.after_source_revision,
          hunks: samePath ? samePath.file.hunks : [...beforePair.file.hunks, ...afterPair.file.hunks],
          ...(event.ambiguous ? { ambiguous: true, candidate_operation_ids: event.attribution_basis.candidate_operation_ids } : {}),
          ...(compatible ? {
            scope: {
              kind: newBlock.kind,
              ...(newBlock.environment ? { environment: newBlock.environment } : {}),
              ...(newBlock.delimiter ? { delimiter: newBlock.delimiter } : {}),
              old_start_line: oldBlock.start_line, old_end_line: oldBlock.end_line,
              new_start_line: newBlock.start_line, new_end_line: newBlock.end_line,
              old_source: slice(beforePair.before, oldBlock), new_source: slice(afterPair.after, newBlock),
            },
          } : { display: { old_source: changed(beforePair.before, beforePair.file.hunks, 'old'), new_source: changed(afterPair.after, afterPair.file.hunks, 'new') } }),
        }
        const patch = { input: { ...metadata.input, canonical_source: canonical } }
        await fleetStore.updateEventMetadata(activity.id, patch)
        await onProjected?.(activity.id, patch)
      }
    },
  }
}
