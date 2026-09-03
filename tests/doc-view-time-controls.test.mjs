import test from 'node:test'
import assert from 'node:assert/strict'

// `isClassroomSurface()` reads `window.location.search`, so the surface is a
// value this test sets rather than a fact about where it runs. Set before the
// module is imported, because the import chain reads it at call time and a
// half-set global would make the first assertion depend on import order.
function onSurface(search) {
  globalThis.window = { location: { search } }
}
onSurface('')

const {
  defaultTimeControlsMode,
  formatTimecode,
  parseRecordingRef,
  recordingRef,
  timeControlsMode,
} = await import('../src/recording/timeControls.ts')

// The requirement these come from, as corrected: the doc-view is ALWAYS
// spacetime-capable, and only the visibility of the time controls has three
// states — `off`, `auto-hide`, `pinned`. Classroom defaults pinned; elsewhere
// off. There is no separate spacetime-mode toggle.

test('the surface picks the default, and never overrides an explicit choice', () => {
  // This is `RecordingsButton`'s old `IS_CLASSROOM` gate, moved — it used to
  // decide whether a way in to playback was rendered at all.
  onSurface('?course=qtm285')
  assert.equal(defaultTimeControlsMode(), 'pinned', 'classroom: on screen, for discoverability')

  onSurface('')
  assert.equal(defaultTimeControlsMode(), 'off', 'elsewhere: quiet until asked for')

  // What THIS asserts, exactly: the resolver returns a stored value unchanged
  // on either surface, so the surface only supplies the answer when nobody has
  // chosen. That is one half of "default, not gate".
  //
  // It is NOT reachability, and an earlier version of this comment claimed it
  // was. Whether a reader can PRODUCE a stored value lives in
  // `cycleTimeControls` and in the header button being rendered
  // unconditionally, neither of which this file touches — so if the gate grew
  // back as `{IS_CLASSROOM && <button …>}` every assertion here would still
  // pass. That case needs the rendered control, and it is on the browser list.
  assert.equal(timeControlsMode('off'), 'off')
  onSurface('?course=qtm285')
  assert.equal(timeControlsMode('off'), 'off', 'a stored `off` survives on a classroom surface')
  onSurface('')
  assert.equal(timeControlsMode('pinned'), 'pinned', 'a stored `pinned` survives off a classroom surface')
})

test('an unset control falls to the surface default, and stays unset', () => {
  // The shape stores '' rather than the resolved mode on purpose: baking the
  // answer in at creation would freeze a classroom's default onto a shape that
  // later opens somewhere else.
  onSurface('?course=qtm285')
  assert.equal(timeControlsMode(''), 'pinned')
  assert.equal(timeControlsMode(undefined), 'pinned')

  onSurface('')
  assert.equal(timeControlsMode(''), 'off')
  assert.equal(timeControlsMode(undefined), 'off')
})

test('a value that is not one of the three states is not honoured', () => {
  onSurface('')
  // Including the one somebody would plausibly write for "on".
  for (const junk of ['on', 'true', 'visible', 'auto', 'PINNED']) {
    assert.equal(timeControlsMode(junk), 'off', `${junk} is not a state`)
  }
  // And the three real ones survive exactly.
  for (const mode of ['off', 'auto-hide', 'pinned']) {
    assert.equal(timeControlsMode(mode), mode)
  }
})

test('a recording reference round-trips, and says whether it is a private draft', () => {
  // The shape stores one string. A draft and a published recording can share an
  // id, so the prefix is what tells the fetch which endpoint to use — get it
  // wrong and a student is served an instructor's unpublished capture.
  assert.deepEqual(parseRecordingRef('lecture-1'), { id: 'lecture-1', privateDraft: false })
  assert.deepEqual(parseRecordingRef('draft:lecture-1'), { id: 'lecture-1', privateDraft: true })

  assert.equal(recordingRef('lecture-1', false), 'lecture-1')
  assert.equal(recordingRef('lecture-1', true), 'draft:lecture-1')
  assert.equal(recordingRef('lecture-1', undefined), 'lecture-1', 'absent is not draft')

  for (const [id, draft] of [['a', false], ['a', true], ['draft-notes', false]]) {
    assert.deepEqual(
      parseRecordingRef(recordingRef(id, draft)),
      { id, privateDraft: draft },
      `${id} / ${draft} survives the round trip`,
    )
  }
})

test('no recording selected is distinguishable from a recording called nothing', () => {
  // The doc-view shows the live document when this is null. An empty string is
  // what the shape holds before anyone picks, so it must not parse to an id.
  assert.equal(parseRecordingRef(undefined), null)
  assert.equal(parseRecordingRef(''), null)
})

test('the timecode is minutes and seconds, and never negative', () => {
  assert.equal(formatTimecode(0), '0:00')
  assert.equal(formatTimecode(9_000), '0:09')
  assert.equal(formatTimecode(61_000), '1:01')
  assert.equal(formatTimecode(3_600_000), '60:00')
  // The scrubber can hand back a negative on a seek to before the start; that
  // shows as 0:00 rather than as -1:-1.
  assert.equal(formatTimecode(-5_000), '0:00')
})
