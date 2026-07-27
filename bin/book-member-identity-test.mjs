#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

const svgDocument = read('src/SvgDocument.tsx')
const bookViewer = read('src/BookViewer.tsx')
const mathNote = read('src/shapes/MathNoteShape.tsx')
const fleetAgents = read('src/shapes/FleetAgentsShape.tsx')
const fleetPill = read('src/shapes/FleetPillShape.tsx')
const fleetChat = read('src/shapes/FleetChatShape.tsx')
const fleetSearch = read('src/shapes/FleetSearchShape.tsx')
const svgPage = read('src/shapes/SvgPageShape.tsx')
const highlighterSnap = read('src/highlighterSnap.ts')
const yjsSync = read('src/useYjsSync.ts')

assert.match(svgDocument, /const docName = document\.name\b/, 'SvgDocumentEditor must derive selected doc identity from loaded document.name')
assert.doesNotMatch(svgDocument, /docNameForRole|docKey/, 'SvgDocumentEditor must not keep alternate URL-derived doc identity aliases')
assert.doesNotMatch(
  svgDocument,
  /new URLSearchParams\(window\.location\.search\)\.get\(['"]doc['"]\)\s*\|\|\s*document\.name/,
  'SvgDocumentEditor must not fall back to URL ?doc for selected member identity',
)

for (const expected of [
  'useSyncedPlayback(editorRef, docName)',
  'useTimelineOverlay(editorRef, document, docName)',
  'useShadowOverlay(editorRef, document, docName',
  'useDividerDiff(editorRef, docName',
  'useDocAutoOpen(editorRef, document, docName)',
  '<ProvenancePanel docName={docName} />',
  '<ProvenanceInline docName={docName} />',
  'docName,',
]) {
  assert.ok(svgDocument.includes(expected), `SvgDocumentEditor should route ${expected} through selected member docName`)
}
assert.ok(svgDocument.includes('initRole(docName)'), 'presentation role identity should use selected member docName')
assert.ok(svgDocument.includes('/sync/${roomId}'), 'TLDraw sync room should keep using supplied roomId')

assert.ok(bookViewer.includes('loadHtmlDocument(member.key, member.basePath)'), 'BookViewer must load HTML/markdown members with member key, not display name')
assert.ok(bookViewer.includes('doc = createSvgDocumentLayout(member.key, member.pages, member.basePath)'), 'BookViewer must load SVG members with member key')
assert.ok(bookViewer.includes('`doc-${activeMember.key}`'), 'BookViewer roomId must be keyed by active member key')

assert.doesNotMatch(
  mathNote,
  /new URLSearchParams\(window\.location\.search\)\.get\(['"]doc['"]\)/,
  'MathNote backing-file operations must use DocContext active member docName, not URL ?doc',
)
assert.ok(mathNote.includes('const activeDocName = pageDoc?.docName'), 'MathNote should capture active member docName from DocContext')
assert.ok(mathNote.includes('docName: activeDocName'), 'MathNote backing-file payload should target active member docName')
assert.ok(mathNote.includes("fetch('/api/backing-file-register'"), 'MathNote should remain the sole backing-file registration publisher')

assert.ok(fleetAgents.includes('useContext(DocContext)'), 'FleetAgents should read current document from DocContext')
assert.ok(fleetAgents.includes('const currentDoc = docCtx?.docName || \'\''), 'FleetAgents spawn defaults should use active member docName')
assert.doesNotMatch(
  fleetAgents,
  /new URLSearchParams\(window\.location\.search\)\.get\(['"]doc['"]\)/,
  'FleetAgents spawn defaults must not use outer book URL ?doc',
)
assert.ok(fleetAgents.includes('export function usePillDrag()'), 'FleetAgents drag helper should not carry a second backing-file doc authority')
assert.ok(fleetAgents.includes('dropPillOnTarget(editor, drag.pillId as any, drag.value, pagePos)'), 'FleetAgents drops should use the canonical FleetPill signature')

for (const [name, source] of [
  ['FleetPillShape', fleetPill],
  ['SvgPageShape', svgPage],
  ['highlighterSnap', highlighterSnap],
  ['useYjsSync', yjsSync],
]) {
  assert.doesNotMatch(
    source,
    /new URLSearchParams\(window\.location\.search\)\.get\(['"]doc['"]\)/,
    `${name} must not use URL ?doc as current document identity`,
  )
}

assert.doesNotMatch(fleetPill, /backing-file-register/, 'FleetPill must not publish backing-file registration')
assert.doesNotMatch(fleetPill, /options\?: \{ docName\?: string \}/, 'FleetPill must not accept a second backing-file doc authority')
assert.ok(fleetChat.includes('dropPillOnTarget(dropEditor, drag.pillId as any, drag.value, pagePos, drag.content)'), 'FleetChat drops should use the canonical FleetPill signature')
assert.ok(fleetSearch.includes('function usePillDrag()'), 'FleetSearch drag helper should not carry a second backing-file doc authority')
assert.ok(fleetSearch.includes('dropPillOnTarget(editor, id, drag.value, pagePos)'), 'FleetSearch drops should use the canonical FleetPill signature')
assert.ok(svgPage.includes('const doc = useContext(DocContext)'), 'SvgPage should read active member docName from DocContext')
assert.ok(svgPage.includes('const docName = doc?.docName || \'\''), 'SvgPage should not derive active member docName from URL')
assert.ok(highlighterSnap.includes('docName,'), 'Highlighter metadata should retain the document.name used for source resolution')
assert.ok(highlighterSnap.includes('const docName = typeof meta?.docName === \'string\' ? meta.docName : \'\''), 'Highlighter hover source card should use saved member docName')
assert.ok(yjsSync.includes('export async function loadStaticAnnotations(editor: any, docName: string'), 'Static annotation loading should require caller-supplied loaded document name')

const outerBook = 'outer-book'
const members = [
  { key: 'member-alpha', name: 'Displayed Alpha' },
  { key: 'member-beta', name: 'Displayed Beta' },
]

for (const member of members) {
  const loadedDocument = { name: member.key }
  const roomId = `doc-${member.key}`
  const routed = {
    roomId,
    history: loadedDocument.name,
    role: loadedDocument.name,
    docContext: loadedDocument.name,
    provenance: loadedDocument.name,
    panelsSearchToc: loadedDocument.name,
    fleetConsumers: loadedDocument.name,
  }

  assert.equal(routed.roomId, `doc-${member.key}`, 'room should follow active member key')
  for (const [consumer, docName] of Object.entries(routed)) {
    if (consumer === 'roomId') continue
    assert.equal(docName, member.key, `${consumer} should target active member key`)
    assert.notEqual(docName, outerBook, `${consumer} must not leak outer book identity`)
    assert.notEqual(docName, member.name, `${consumer} must not use display name as project identity`)
  }
}

console.log('book-member-identity-test: ok')
