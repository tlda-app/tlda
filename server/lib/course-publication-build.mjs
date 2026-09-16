import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { assembleCourseAppSite } from './course-app-build.mjs'

const ROOT_REDIRECT = '<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0; url=/static/">\n<link rel="canonical" href="/static/">\n'

function staticLanding(pageInfo) {
  const first = pageInfo[0]?.file
  if (!first) throw new Error('released course has no static landing page')
  return `<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0; url=${first}">\n<link rel="canonical" href="${first}">\n`
}

function pathsOverlap(a, b) {
  const left = `${resolve(a)}/`
  const right = `${resolve(b)}/`
  return left.startsWith(right) || right.startsWith(left)
}

export function assembleCoursePublication(courseDir, indexFile, renderedDir, outputDir) {
  const root = resolve(outputDir)
  if (pathsOverlap(root, courseDir) || pathsOverlap(root, renderedDir)) {
    throw new Error('publication output must be separate from the course source and shared render')
  }
  const staticDir = join(root, 'static')
  const appDir = join(root, 'app')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })

  const app = assembleCourseAppSite(courseDir, indexFile, renderedDir, appDir)
  cpSync(appDir, staticDir, { recursive: true })
  // The static representation opens the same rendered Quarto page directly;
  // the app representation consumes page-info.json on the TLDA canvas.
  writeFileSync(join(staticDir, 'index.html'), staticLanding(app.pages))
  writeFileSync(join(root, 'index.html'), ROOT_REDIRECT)
  return { app, staticDir, appDir }
}

export async function buildCoursePublication({ courseDir, indexFile, outputDir, render }) {
  if (typeof render !== 'function') throw new Error('buildCoursePublication requires one render function')
  const outputParent = dirname(resolve(outputDir))
  mkdirSync(outputParent, { recursive: true })
  const renderedDir = mkdtempSync(join(outputParent, '.course-render-'))
  try {
    await render(renderedDir)
    if (!existsSync(join(renderedDir, 'page-info.json'))) {
      throw new Error('the shared Quarto/TLDA render produced no page-info.json')
    }
    return assembleCoursePublication(courseDir, indexFile, renderedDir, outputDir)
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
