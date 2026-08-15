import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'

const htmlPageSource = fs.readFileSync(new URL('../src/shapes/HtmlPageShape.tsx', import.meta.url), 'utf8')
const injectorSource = fs.readFileSync(new URL('../server/lib/html-injector.mjs', import.meta.url), 'utf8')

test('iframe touch gestures stay on the parent performance timeline', () => {
  const replay = `
    import { GestureInterpreter } from '@tldraw/editor'
    const interpreter = new GestureInterpreter({ minMotion: 0.1, decideRatio: 1.1, stealRatio: 1.1, deflateWithin: 2, deflateMs: 260 })
    const update = (left, right, time) => interpreter.update([{ id: 1, x: left, y: 0 }, { id: 2, x: right, y: 0 }], time)
    update(0, 100, 100000); update(-10, 110, 100016); update(-16, 116, 100032)
    update(34, 166, 100048); update(84, 216, 100064); update(50, 250, 100080); update(30, 270, 100096)
    process.stdout.write(String(update(29, 271, 100).scale)); process.exit(0)
  `
  const crossRealmClockReset = Number(execFileSync(process.execPath, ['--input-type=module', '-e', replay], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  }))
  assert.ok(
    crossRealmClockReset > 1_000_000,
    'an iframe-relative clock reset must reproduce the runaway deflation step',
  )
  assert.match(
    htmlPageSource,
    /interpreter\.update\(pts, performance\.now\(\)\)/,
    'the parent-owned interpreter must use the parent performance timeline',
  )
  assert.doesNotMatch(
    injectorSource,
    /\bt:\s*e\.timeStamp/,
    'the iframe bridge must not advertise its unrelated performance timeline',
  )
})
