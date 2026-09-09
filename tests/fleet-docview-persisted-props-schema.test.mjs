import assert from 'node:assert/strict'
import test from 'node:test'
import { T } from '@tldraw/validate'
import { fleetDocviewProps } from '../shared/shapes/fleet-panel-schema.mjs'

const baseProps = {
  w: 300,
  h: 250,
  label: '',
  page: 0,
  yTop: 0,
  yBottom: 0,
  title: '',
  sources: '["ref"]',
}

for (const [name, value] of [['timeControls', 'full'], ['recordingId', 'recording-1']]) {
  test(`fleet docview schema accepts persisted ${name}`, () => {
    const props = { ...baseProps, [name]: value }
    assert.deepEqual(T.object(fleetDocviewProps).validate(props), props)
  })
}
