import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defineHostedPanelApps,
  hostedPanelAppMap,
  hostedPanelDefaultProps,
  hostedPanelSizeMap,
} from '../src/wm/hosted-panel-registry'

test('hosted panel registry builds maps, sizes, and cloned default props', () => {
  const definitions = defineHostedPanelApps([
    { type: 'chat', defaultSize: { w: 400, h: 600 }, defaultProps: { filter: [] } },
    { type: 'source', defaultSize: { w: 560, h: 520 }, defaultProps: { file: '', line: 1 } },
  ] as const)

  const registry = hostedPanelAppMap(definitions)
  assert.equal(registry.get('chat')?.defaultSize.w, 400)
  assert.deepEqual(hostedPanelSizeMap(definitions), {
    chat: { w: 400, h: 600 },
    source: { w: 560, h: 520 },
  })

  const props = hostedPanelDefaultProps(registry, 'chat') as { filter: unknown[] }
  props.filter = ['mutated']
  assert.deepEqual(hostedPanelDefaultProps(registry, 'chat'), { filter: [] })
  assert.deepEqual(hostedPanelDefaultProps(registry, 'missing'), {})
})
