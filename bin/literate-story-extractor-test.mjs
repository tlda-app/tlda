#!/usr/bin/env node
import assert from 'assert/strict'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

import {
  discoverStoryTestFiles,
  extractStories,
  extractStoriesFromFile,
  invalidStoryLines,
  LITERATE_STORY_LIMITS,
  renderStoriesMarkdown,
} from './lib/literate-story-extractor.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const daemonFile = resolve(ROOT, 'bin/collaborators-on-one-project-test.mjs')
const editorFile = resolve(ROOT, 'bin/collaborators-and-an-editor-test.mjs')
const discovered = discoverStoryTestFiles(ROOT)

assert.ok(
  discovered.includes(daemonFile),
  'the converted collaborator test was not discovered as a literate story source',
)
assert.ok(
  discovered.includes(editorFile),
  'the converted live-editor test was not discovered as a literate story source',
)

const stories = extractStoriesFromFile(daemonFile, ROOT)
const story = stories.find(item => item.title === 'Alice and Bob edit different files')
assert.ok(story, 'the converted collaborator story was not extracted')
assert.deepEqual(
  story.steps.map(step => step.title),
  ['Everyone arrives', 'Alice saves', 'Bob saves'],
)
assert.ok(
  renderStoriesMarkdown([story]).includes("Alice's laptop — r2, clean"),
  'assertion messages must become story state lines',
)

const editorStories = extractStoriesFromFile(editorFile, ROOT)
assert.deepEqual(
  editorStories.map(item => item.title),
  [
    'Two daemons push while Carol edits',
    'A reading group pushes while Carol edits',
    'Two people have the same file open',
    'The room checkpoints on its own clock',
  ],
)
assert.ok(
  renderStoriesMarkdown(editorStories).includes("each reader's laptop — their push is in the room"),
  'parameterized stories should use reader-facing state lines rather than source interpolation',
)
// Two rules, and neither may take the catalogue down. The tool went dark twice
// for a single unusual entry, and a reader getting nothing is worse than a
// reader seeing one line marked unprintable. So both are reported in place and
// enforced by invalidStoryLines, rather than by refusing to render.
//
// The second of these was red on main before this change: the throw it expected
// stopped existing when a step with no visible assertions became legitimate —
// an ACTION step, "the server dies before the checkpoint", whose consequences
// belong to the step after it. The rule it was protecting is still real, so it
// is asserted here in the form the design actually takes.

const withBadLine = extractStories([
  '// ## Bad story',
  '// ### Bad step',
  'assert.equal(actual, expected, `the paper — has ${value}`)',
].join('\n'), 'bad-story-test.mjs')
assert.equal(withBadLine.length, 1,
  'the catalogue — still renders the story; otherwise one bad message takes every story down with it')
const invalid = invalidStoryLines(withBadLine)
assert.equal(invalid.length, 1,
  'the interpolated line — is reported as invalid, so an author is still told')
assert.match(invalid[0].text, /interpolation in bad-story-test\.mjs:3/,
  'the report — names the file and line, so it is fixable without hunting')

const hiddenHelper = extractStories([
  '// ## Missing state',
  '// ### Hidden helper',
  'await helperThatAssertsInternally()',
].join('\n'), 'hidden-helper-test.mjs')
assert.equal(hiddenHelper.length, 1,
  'the step — still appears in the catalogue; a story missing from the list looks exactly like a story nobody wrote')
assert.deepEqual(hiddenHelper[0].steps[0].states, [],
  'the step — shows no state under it, which is what a reader sees when the assertions are hidden in a helper')
assert.ok(
  LITERATE_STORY_LIMITS.some(limit => limit.includes('Assertions hidden inside helpers')),
  'converter-facing extractor limits must be documented where the tool exposes them',
)

console.log('literate story extractor test passed')
