import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { assembleCourseAppSite } from './course-app-build.mjs'

const ROOT_REDIRECT = '<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0; url=/static/">\n<link rel="canonical" href="/static/">\n'

function pathsOverlap(a, b) {
  const left = `${resolve(a)}/`
  const right = `${resolve(b)}/`
  return left.startsWith(right) || right.startsWith(left)
}

function moveAppBook(appDir, app) {
  const oldBook = join(appDir, '_book')
  const newBook = join(appDir, 'book')
  if (!existsSync(oldBook)) throw new Error('app compiler produced no _book directory')
  renameSync(oldBook, newBook)
  for (const asset of app.spec.assets) {
    const source = join(appDir, asset)
    const destination = join(newBook, asset)
    if (!existsSync(source)) continue
    mkdirSync(dirname(destination), { recursive: true })
    renameSync(source, destination)
  }
  app.pages = app.pages.map(page => ({ ...page, file: page.file.replace(/^_book\//, 'book/') }))
  writeFileSync(join(appDir, 'page-info.json'), `${JSON.stringify(app.pages, null, 2)}\n`)
}

function pruneStatic(staticDir, renderedDir, app) {
  const allPages = JSON.parse(readFileSync(join(renderedDir, 'page-info.json'), 'utf8'))
  const selected = new Set(app.pages.map(page => page.file))
  for (const page of allPages) {
    const file = page.file.replace(/^_book\//, 'book/')
    if (selected.has(file)) continue
    rmSync(join(staticDir, file), { force: true })
    rmSync(join(staticDir, file.replace(/\.html$/i, '_files')), { recursive: true, force: true })
    if (page?.source?.file) rmSync(join(staticDir, 'book', page.source.file), { force: true })
  }
}

function unwrapLinksToMissingFiles(root, files) {
  const anchor = /<a\b[^>]*\bhref=(['"])([^'"]+)\1[^>]*>([\s\S]*?)<\/a>/gi
  const link = /<link\b[^>]*\bhref=(['"])([^'"]+)\1[^>]*>/gi
  for (const file of files) {
    const path = join(root, file)
    if (!existsSync(path)) continue
    const html = readFileSync(path, 'utf8')
    const pointsToMissingFile = rawHref => {
      const href = rawHref.split(/[?#]/, 1)[0]
      if (!href || href.startsWith('/') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return false
      let decoded
      try {
        decoded = decodeURIComponent(href)
      } catch {
        return false
      }
      const target = resolve(dirname(path), decoded)
      return pathsOverlap(root, target) && !existsSync(target)
    }
    const cleaned = html
      .replace(anchor, (whole, _quote, rawHref, contents) => pointsToMissingFile(rawHref) ? contents : whole)
      .replace(link, (whole, _quote, rawHref) => pointsToMissingFile(rawHref) ? '' : whole)
    if (cleaned !== html) writeFileSync(path, cleaned)
  }
}

export async function assembleCoursePublication(courseDir, indexFile, renderedDir, outputDir, assembleStatic) {
  if (typeof assembleStatic !== 'function') throw new Error('course publication requires the existing static compiler')
  const root = resolve(outputDir)
  if (pathsOverlap(root, courseDir) || pathsOverlap(root, renderedDir)) {
    throw new Error('publication output must be separate from the course source and shared render')
  }
  const staticDir = join(root, 'static')
  const appDir = join(root, 'app')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })

  await assembleStatic({ courseDir, renderedDir, outputDir: staticDir })
  if (!existsSync(join(staticDir, 'index.html'))) {
    throw new Error('static compiler produced no index.html')
  }
  const app = assembleCourseAppSite(courseDir, join(staticDir, 'index.html'), renderedDir, appDir)
  moveAppBook(appDir, app)
  pruneStatic(staticDir, renderedDir, app)
  const pageFiles = app.pages.map(page => page.file)
  unwrapLinksToMissingFiles(staticDir, ['index.html', ...pageFiles])
  unwrapLinksToMissingFiles(appDir, pageFiles)
  writeFileSync(join(staticDir, 'page-info.json'), `${JSON.stringify(app.pages, null, 2)}\n`)
  writeFileSync(join(staticDir, 'toc.json'), readFileSync(join(appDir, 'toc.json')))
  writeFileSync(join(root, 'index.html'), ROOT_REDIRECT)
  return { app, staticDir, appDir }
}

export async function buildCoursePublication({ courseDir, indexFile, outputDir, render, assembleStatic }) {
  if (typeof render !== 'function') throw new Error('buildCoursePublication requires one render function')
  const outputParent = dirname(resolve(outputDir))
  mkdirSync(outputParent, { recursive: true })
  const renderedDir = mkdtempSync(join(outputParent, '.course-render-'))
  try {
    await render(renderedDir)
    if (!existsSync(join(renderedDir, 'page-info.json'))) {
      throw new Error('the shared Quarto/TLDA render produced no page-info.json')
    }
    return await assembleCoursePublication(courseDir, indexFile, renderedDir, outputDir, assembleStatic)
  } finally {
    rmSync(renderedDir, { recursive: true, force: true })
  }
}

export function publicationMetadata(outputDir) {
  return {
    app: JSON.parse(readFileSync(join(outputDir, 'app/page-info.json'), 'utf8')),
    static: JSON.parse(readFileSync(join(outputDir, 'static/page-info.json'), 'utf8')),
  }
}
