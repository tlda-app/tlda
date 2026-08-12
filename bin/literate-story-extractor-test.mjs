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
const file = resolve(ROOT, 'bin/collaborators-on-one-project-test.mjs')

assert.ok(
  discoverStoryTestFiles(ROOT).includes(file),
  'the converted collaborator test was not discovered as a literate story source',
)

const stories = extractStoriesFromFile(file, ROOT)
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

console.log('literate story extractor test passed')
