#!/usr/bin/env node
import { resolve } from 'path'
import { fileURLToPath } from 'url'

import {
  discoverStoryTestFiles,
  extractStoriesFromFile,
  renderStoriesMarkdown,
} from './lib/literate-story-extractor.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const files = process.argv.slice(2)
const storyFiles = files.length ? files.map(file => resolve(ROOT, file)) : discoverStoryTestFiles(ROOT)
const stories = storyFiles.flatMap(file => extractStoriesFromFile(file, ROOT))

console.log(renderStoriesMarkdown(stories))
