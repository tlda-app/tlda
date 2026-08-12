#!/usr/bin/env node
import assert from 'assert/strict'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

import {
  discoverStoryTestFiles,
  extractStoriesFromFile,
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
  renderStoriesMarkdown(editorStories).includes("${who}'s laptop — their push is in the room"),
  'template assertion messages should keep loop variables visible in the story catalogue',
)

console.log('literate story extractor test passed')
