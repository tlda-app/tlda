import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const source = readFileSync(new URL('../src/shapes/FleetChatShape.tsx', import.meta.url), 'utf8')

test('main-canvas chat render is skipped only while HUD owns the visible copy', () => {
  assert.match(
    source,
    /function useMainCanvasChatHiddenByHud\(\)[\s\S]*const viewportId = useVisibilityViewportId\(\)[\s\S]*return !viewportId && hudOpen/,
    'the skip must apply to the main canvas only; HUD renders have a viewport id',
  )

  const componentAt = source.indexOf('const FleetChatComponent = memo(function FleetChatComponent')
  assert.ok(componentAt > 0, 'FleetChatComponent must own the HUD-open guard')
  const component = source.slice(componentAt, componentAt + 600)
  assert.match(component, /if \(hiddenByHud\) return null/, 'the hidden main-canvas copy must render nothing')
  assert.match(component, /return <FleetChatMounted shape=\{shape\} \/>/, 'visible copies must mount the normal chat body')

  const mountedAt = source.indexOf('function FleetChatMounted')
  assert.ok(mountedAt > 0, 'subscription-bearing chat body must be split into a child component')
  const mounted = source.slice(mountedAt, mountedAt + 500)
  assert.match(mounted, /useChatFilterSubscription\(shape\)/, 'chat subscription must live only in the mounted child')
  assert.match(mounted, /useUnreadRailSubscription\(shape\)/, 'unread rail subscription must live only in the mounted child')
})

test('HUD open/close remount keeps earlier history in the same chat buffer', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.localStorage = dom.window.localStorage
  window.__TLDA_CONFIG__ = {
    name: 'test',
    database: { http: 'http://localhost/fleet', ws: 'ws://localhost/fleet' },
    store: { http: 'http://localhost/store', ws: 'ws://localhost/store' },
    licenseKey: '',
  }

  const intervals = []
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = (fn, delay, ...args) => {
    const handle = realSetInterval(fn, delay, ...args)
    intervals.push(handle)
    return handle
  }

  try {
    const { applyFilterEvents, getFilteredFleetEvents } = await import('../src/fleet/fleet-data.ts')

    const filter = [[['agent', 'anchor-drift']]]
    const bufferKey = 'chat:test-hud-transition'
    const matchesFilter = () => true
    const read = () => getFilteredFleetEvents(filter, { matchesFilter, bufferKey }).map(event => event._dbId)

    assert.deepEqual(read(), [], 'first render creates the server-fed buffer empty')

    applyFilterEvents(bufferKey, [
      { id: 1, _dbId: 1, type: 'chat', from: 'a', timestamp: '2026-08-12T10:00:00.000Z', text: 'older 1' },
      { id: 2, _dbId: 2, type: 'chat', from: 'a', timestamp: '2026-08-12T10:01:00.000Z', text: 'older 2' },
    ])
    assert.deepEqual(read(), [1, 2], 'older pulled history is present before the render transition')

    // Opening or closing the HUD unmounts the render-side subscription and mounts
    // it again with the same filter and buffer key. The replacement first page is
    // merged into the existing server-fed buffer, not used to replace it.
    assert.deepEqual(read(), [1, 2], 'same-filter remount does not clear the buffer')
    applyFilterEvents(bufferKey, [
      { id: 3, _dbId: 3, type: 'chat', from: 'a', timestamp: '2026-08-12T10:02:00.000Z', text: 'newer 1' },
      { id: 4, _dbId: 4, type: 'chat', from: 'a', timestamp: '2026-08-12T10:03:00.000Z', text: 'newer 2' },
    ])

    assert.deepEqual(read(), [1, 2, 3, 4], 'earlier rows survive the same-buffer first-page refetch')
  } finally {
    globalThis.setInterval = realSetInterval
    for (const interval of intervals) clearInterval(interval)
  }
})
