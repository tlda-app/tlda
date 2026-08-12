#!/usr/bin/env node
import assert from 'assert/strict'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

import {
  discoverStoryTestFiles,
  extractStories,
  extractStoriesFromFile,
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
assert.throws(
  () => extractStories([
    '// ## Bad story',
    '// ### Bad step',
    'assert.equal(actual, expected, `the paper — has ${value}`)',
  ].join('\n'), 'bad-story-test.mjs'),
  /bad-story-test\.mjs:3: assertion message contains interpolation/,
  'interpolated assertion messages must fail before they enter the story catalogue',
)
assert.throws(
  () => extractStories([
    '// ## Missing state',
    '// ### Hidden helper',
    'await helperThatAssertsInternally()',
  ].join('\n'), 'hidden-helper-test.mjs'),
  /hidden-helper-test\.mjs:2: story step "Hidden helper" has no visible assertion messages/,
  'a step with only helper-internal assertions must not silently disappear',
)
assert.ok(
  LITERATE_STORY_LIMITS.some(limit => limit.includes('Assertions hidden inside helpers')),
  'converter-facing extractor limits must be documented where the tool exposes them',
)

console.log('literate story extractor test passed')
