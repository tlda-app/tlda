import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../src/shapes/FleetAgentsShape.tsx', import.meta.url), 'utf8')
const hook = source.slice(source.indexOf('export function usePillDrag()'), source.indexOf('\nfunction FleetAgentsInner'))

test('the document coordinator, not the initiating React surface, owns an active pill drag', () => {
  assert.match(hook, /dragCoordinator\.claim\(/)
  assert.doesNotMatch(hook, /releaseRef/)
  assert.doesNotMatch(hook, /useEffect\(\(\) => \(\) =>/)
})
