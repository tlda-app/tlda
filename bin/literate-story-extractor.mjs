#!/usr/bin/env node
import { resolve } from 'path'
import { fileURLToPath } from 'url'

import {
  discoverStoryTestFiles,
  extractStoriesFromFile,
  LITERATE_STORY_LIMITS,
  renderStoriesMarkdown,
} from './lib/literate-story-extractor.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const files = process.argv.slice(2)
if (files.includes('--limits')) {
  console.log('# Literate Story Extractor Limits\n')
  for (const limit of LITERATE_STORY_LIMITS) console.log(`- ${limit}`)
  process.exit(0)
}
const storyFiles = files.length ? files.map(file => resolve(ROOT, file)) : discoverStoryTestFiles(ROOT)
const stories = storyFiles.flatMap(file => extractStoriesFromFile(file, ROOT))

console.log(renderStoriesMarkdown(stories))
