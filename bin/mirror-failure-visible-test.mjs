#!/usr/bin/env node
// A mirror failure must reach a surface a person can see.
//
// `lastMirrorFailure` is written by the mirror path and read by NOTHING — no route,
// no CLI, no client. So a project whose builds render fine while never
// checkpointing into a working copy looks healthy everywhere a human looks.
// minimax-linear and wildfire-plos went unmirrored from 2026-07-28, and
// synth-combined from 2026-07-10, with nobody noticing.
//
// The success path already clears `syncErrorJson` on the doc-version sentinel and
// `src/pills/SyncErrorPill.tsx` already renders it. The failure path just never
// set it, leaving the one surface built for this permanently empty.
//
// This is a source contract rather than a behavioural test: the mirror path is
// not exported, and refactoring it to be testable is a larger change than the
// fix. It is verified against the pre-fix tree, so it cannot pass vacuously.
//
// The path MOVED on 2026-08-18, from `finalizeBuildVersion` in build-runner to
// `mirrorAcceptedRevision` in the push route, when mirroring stopped being a
// build phase. The contract travelled with it deliberately: a surface built for
// this and left behind would be a control writing a value nobody reads, which
// is the failure this file exists to prevent.

import assert from 'assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(repo, 'server/routes/projects.mjs'), 'utf8')

// The catch block that handles a failed mirror, to the end of the function.
const start = source.indexOf('} catch (error) {', source.indexOf('async function mirrorAcceptedRevision'))
assert.ok(start > 0, 'mirror failure catch block not found — did the path move?')
const end = source.indexOf('[mirror]', start)
assert.ok(end > start, 'mirror failure log not found — did the path move?')
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

// A mirror failure must NOT reject the push. The revision is accepted and
// durable either way, and a machine that is asleep is not a reason to refuse
// somebody's writing — which is why the block that used to end in a throw no
// longer does. Guarding it here so nobody restores the throw while restoring
// the visibility.
assert.doesNotMatch(
  block, /\bthrow\b/,
  'a failed mirror must not throw: that would reject a push over a sleeping laptop',
)

// And the pill must still be the thing reading it.
const pill = readFileSync(join(repo, 'src/pills/SyncErrorPill.tsx'), 'utf8')
assert.match(pill, /syncErrorJson/, 'SyncErrorPill must still read syncErrorJson')

console.log('mirror failure visibility: ok')
