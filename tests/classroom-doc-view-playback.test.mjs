import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { classroomDocViewPlaybackSelection } from '../src/overlays/classroom-doc-view-playback-selection.ts'

const owner = { userId: 'student', deviceId: 'browser' }
const shape = (type, id, extra = {}) => ({
  id,
  type,
  index: id,
  isLocked: true,
  props: { userId: owner.userId, deviceId: owner.deviceId },
  ...extra,
})

test('classroom production route selects only the owned doc-view without mutating or reordering hidden fleet shapes', () => {
  const shapes = [
    shape('fleet-chat', 'chat'),
    shape('fleet-docview', 'docview'),
    shape('fleet-agents', 'agents'),
    shape('fleet-search', 'search'),
    shape('fleet-inbox', 'inbox'),
    shape('fleet-notifications', 'notifications'),
  ]
  const before = structuredClone(shapes)
  assert.deepEqual(classroomDocViewPlaybackSelection(shapes, { userId: owner.userId, deviceId: '' }, false), [])
  assert.deepEqual(classroomDocViewPlaybackSelection(shapes, owner).map(item => item.id), ['docview'])
  assert.deepEqual(shapes, before)

  const documentSource = readFileSync(new URL('../src/SvgDocument.tsx', import.meta.url), 'utf8')
  const routeSource = readFileSync(new URL('../src/overlays/ClassroomDocViewPlayback.tsx', import.meta.url), 'utf8')
  const routeCss = readFileSync(new URL('../src/overlays/ClassroomDocViewPlayback.css', import.meta.url), 'utf8')
  assert.match(documentSource, /IS_CLASSROOM && editorRef\.current && \(\s*<ClassroomDocViewPlayback/)
  assert.match(documentSource, /!IS_CLASSROOM && editorRef\.current && \(\s*<FleetHUD/)
  assert.match(routeSource, /whenDeviceReady\(\)\.then\(\(\) => \{ if \(!cancelled\) setDeviceReady\(true\) \}\)/)
  assert.doesNotMatch(routeSource, /FleetHUD|FleetIconPill|addEventListener|updateShape|updateShapes|_visTick/)
  assert.match(routeCss, /\.classroom-docview-playback \.clip-panel,\s*\.classroom-docview-playback \.clip-panel \* \{\s*pointer-events: none !important;/)
  assert.match(routeCss, /\.classroom-docview-playback \.fleet-docview,\s*\.classroom-docview-playback \.fleet-docview \* \{\s*pointer-events: auto !important;/)
})
