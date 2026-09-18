import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { qmdDeckRenderRoots, quartoBookRoots } from './incremental-qmd-build.mjs'

/**
 * Derive the book's membership from its authored declarations: every chapter
 * `_quarto.yml` declares, plus every deck the slides profile declares. The
 * index page decides announcement only — whether a title is a link or plain
 * text. It never decides whether a declared document is built.
 */
export function deriveCourseBookSpec(courseDir) {
  const root = resolve(courseDir)
  const documents = quartoBookRoots(root)
  if (!documents.includes('index.qmd') && existsSync(join(root, 'index.qmd'))) {
    documents.unshift('index.qmd')
  }
  const decks = qmdDeckRenderRoots(root)
  return { version: 1, documents, decks }
}

