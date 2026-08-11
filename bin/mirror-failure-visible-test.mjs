#!/usr/bin/env node
// A mirror failure must reach a surface a person can see.
//
// `lastMirrorFailure` is written by build-runner and read by NOTHING — no route,
// no CLI, no client. So a project whose builds render fine while never
// checkpointing into a working copy looks healthy everywhere a human looks.
// minimax-linear and wildfire-plos went unmirrored from 2026-07-28, and
// synth-combined from 2026-07-10, with nobody noticing.
//
// The success path already clears `syncErrorJson` on the doc-version sentinel and
// `src/pills/SyncErrorPill.tsx` already renders it. The failure path just never
// set it, leaving the one surface built for this permanently empty.
//
// This is a source contract rather than a behavioural test: finalizeBuildVersion
// is not exported, and refactoring it to be testable is a larger change than the
// fix. It is verified against the pre-fix tree, so it cannot pass vacuously.

import assert from 'assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(repo, 'server/lib/build-runner.mjs'), 'utf8')

// The catch block that handles a failed mirror, up to the throw that fails the build.
const start = source.indexOf('} catch (mirrorErr) {')
assert.ok(start > 0, 'mirror failure catch block not found — did the path move?')
const end = source.indexOf('working-copy checkpoint failed for', start)
assert.ok(end > start, 'mirror failure throw not found — did the message change?')
const block = source.slice(start, end)

assert.match(
  block, /lastMirrorFailure/,
  'the failure must still be recorded on the project',
)
assert.match(
  block, /writeSentinel\(/,
  'a mirror failure must write the doc-version sentinel, or no surface learns of it',
)
assert.match(
  block, /syncErrorJson/,
  'the sentinel write must set syncErrorJson — the field SyncErrorPill reads',
)

// It must be a real payload, not an empty string: the success path writes '' to
// CLEAR the pill, so writing '' here would silently say "everything is fine".
const syncErrorWrite = block.slice(block.indexOf('syncErrorJson'))
assert.doesNotMatch(
  syncErrorWrite.slice(0, 40), /syncErrorJson:\s*''/,
  'the failure path must not clear syncErrorJson — that is the success path',
)
assert.match(
  block, /kind:\s*'sync-error'/,
  "the payload must carry kind: 'sync-error', which is what SyncErrorPill renders",
)

// And the pill must still be the thing reading it.
const pill = readFileSync(join(repo, 'src/pills/SyncErrorPill.tsx'), 'utf8')
assert.match(pill, /syncErrorJson/, 'SyncErrorPill must still read syncErrorJson')

console.log('mirror failure visibility: ok')
