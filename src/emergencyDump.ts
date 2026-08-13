/**
 * Emergency dump — get content out of a client that cannot sync.
 *
 * An unsynced edit lives in the tldraw store in memory and nowhere else: the app
 * calls `useSync` with no `persistenceKey`, so there is no IndexedDB copy and a
 * refresh loses it. When sync is down, the only routes out used to be a screenshot
 * or selecting the text by hand.
 *
 * Nothing here touches the network. It reads the in-memory store and writes a file,
 * so it works exactly when everything else does not.
 */

import type { Editor, TLShape } from 'tldraw'
import { getShapeText } from './panels/helpers'

function shapeTitle(shape: TLShape): string {
  const props = shape.props as Record<string, unknown>
  const done = props.done === true ? ' — done' : ''
  return `${shape.type} at (${Math.round(shape.x)}, ${Math.round(shape.y)})${done}`
}

/** Every note, then every other shape carrying text, then the whole store as JSON. */
export function buildEmergencyDump(editor: Editor, documentName: string): string {
  const stamp = new Date().toISOString()
  const pageName = new Map<string, string>()
  for (const page of editor.getPages()) pageName.set(page.id, page.name)

  const shapes = editor.store.allRecords()
    .filter((r): r is TLShape => (r as TLShape).typeName === 'shape')

  const notes: TLShape[] = []
  const otherText: TLShape[] = []
  for (const shape of shapes) {
    if (!getShapeText(shape).trim()) continue
    const type = shape.type as string
    if (type === 'math-note' || type === 'note') notes.push(shape)
    else otherText.push(shape)
  }

  const section = (heading: string, list: TLShape[]) => {
    if (list.length === 0) return `## ${heading}\n\nNone.\n`
    const body = list.map(shape => {
      const page = pageName.get(shape.parentId as string) || String(shape.parentId)
      return `### ${page} — ${shapeTitle(shape)}\n\n${getShapeText(shape)}\n`
    }).join('\n')
    return `## ${heading} (${list.length})\n\n${body}`
  }

  return [
    `# ${documentName} — emergency dump`,
    '',
    `Written ${stamp} from the browser's in-memory store. Not from the server —`,
    'nothing here has necessarily been synced.',
    '',
    section('Notes', notes),
    '',
    section('Other text on the canvas', otherText),
    '',
    '## Whole store',
    '',
    'Everything above and everything else, verbatim, for recovering by machine.',
    '',
    '```json',
    JSON.stringify(editor.store.getStoreSnapshot(), null, 2),
    '```',
    '',
  ].join('\n')
}

/** Build the dump and hand it to the browser as a download. */
export function downloadEmergencyDump(editor: Editor, documentName: string): string {
  const text = buildEmergencyDump(editor, documentName)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safeName = documentName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'document'
  const filename = `${safeName}-${stamp}.md`

  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Safari needs the URL to outlive the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return filename
}
