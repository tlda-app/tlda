import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

// Images are page dependencies that Quarto already owns.  They are not
// publication entries: in particular, the real syllabus shows students the
// literal example `![](my-photo.png)`, which must not become a required file.
const MARKDOWN_LINK = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g
const HTML_LINK = /\bhref=["']([^"']+)["']/gi

function cleanTarget(raw) {
  const target = raw.trim().replace(/^<|>$/g, '').split(/[?#]/, 1)[0]
  if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) return null
  return decodeURIComponent(target)
}

function inside(root, path) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}

function sourceForRenderedTarget(courseDir, target) {
  if (!target.endsWith('.html')) return null
  const direct = target.replace(/\.html$/i, '.qmd')
  const candidates = [direct]
  if (target.endsWith('-solutions.html')) {
    candidates.unshift(target.replace(/-solutions\.html$/i, '.solutions.qmd'))
  }
  for (const candidate of candidates) {
    if (existsSync(join(courseDir, candidate))) return candidate
  }
  return null
}

function addUnique(values, value) {
  if (value && !values.includes(value)) values.push(value)
}

/**
 * Derive the app builder's internal specification from the course's own
 * publication index.  A local qmd link is a document root; a local rendered
 * html link resolves back to its qmd source when that source exists; zip and
 * other local links remain publication assets. Decks enter only through links
 * authored in the index. A nearby file with a matching name is not release
 * authority.
 */
export function deriveCourseAppSpec(courseDir, indexFile) {
  const root = resolve(courseDir)
  const indexPath = isAbsolute(indexFile) ? resolve(indexFile) : resolve(root, indexFile)
  const generatedHtml = indexPath.endsWith('.html') && !inside(root, indexPath)
  if (!existsSync(indexPath) || (!generatedHtml && !inside(root, indexPath))) {
    throw new Error(`course index is not an available publication input: ${indexFile}`)
  }
  const generatedRoot = ['index.qmd', 'index.md'].find(candidate => existsSync(join(root, candidate)))
  const indexRoot = generatedHtml ? generatedRoot : relative(root, indexPath).replace(/\\/g, '/')
  if (!indexRoot) throw new Error(`${root}: course checkout has no index.qmd or index.md`)
  const documents = [indexRoot]
  const decks = []
  const assets = []
  const links = []
  const text = readFileSync(indexPath, 'utf8')
  const matches = generatedHtml ? text.matchAll(HTML_LINK) : text.matchAll(MARKDOWN_LINK)
  for (const match of matches) {
    const cleaned = cleanTarget(match[1])
    if (!cleaned) continue
    if (generatedHtml) {
      const published = cleaned.replace(/^\.\//, '')
      if (!published.startsWith('book/')) continue
      const target = published.slice('book/'.length)
      if (target === 'index.html') continue
      const source = sourceForRenderedTarget(root, target)
      if (source) {
        links.push(target)
        if (source.startsWith('decks/') && source.endsWith('-slides.qmd')) addUnique(decks, source)
        else addUnique(documents, source)
      } else if (existsSync(join(root, target))) {
        links.push(target)
        addUnique(assets, target)
      } else {
        throw new Error(`${indexPath}: published link has no course input: ${published}`)
      }
      continue
    }
    const absolute = resolve(dirname(indexPath), cleaned)
    if (!inside(root, absolute)) throw new Error(`${indexRoot}: link escapes course checkout: ${cleaned}`)
    const target = relative(root, absolute).replace(/\\/g, '/')
    links.push(target)
    let source = target.endsWith('.qmd') ? target : sourceForRenderedTarget(root, target)
    if (source && existsSync(join(root, source))) {
      if (source.startsWith('decks/') && source.endsWith('-slides.qmd')) {
        addUnique(decks, source)
      } else {
        addUnique(documents, source)
      }
    } else if (existsSync(join(root, target))) {
      addUnique(assets, target)
    } else {
      throw new Error(`${indexRoot}: local publication link has no course input: ${target}`)
    }
  }
  return { version: 1, index: indexRoot, documents, decks, assets, links }
}

/** Explicitly linked downloads are publication artifacts, not Quarto pages. */
export function copyCourseAppAssets(courseDir, outputDir, spec) {
  for (const rel of spec.assets) {
    const destination = join(outputDir, rel)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(courseDir, rel), destination)
  }
}

/** Compile an already-built TLDA project into the released course app tree. */
export function assembleCourseAppSite(courseDir, indexFile, builtDir, outputDir) {
  const sourceRoot = resolve(courseDir)
  const builtRoot = resolve(builtDir)
  const outputRoot = resolve(outputDir)
  if (outputRoot === sourceRoot || outputRoot === builtRoot ||
      inside(outputRoot, sourceRoot) || inside(outputRoot, builtRoot) ||
      inside(sourceRoot, outputRoot) || inside(builtRoot, outputRoot)) {
    throw new Error('course app output must be separate from the course source and TLDA build')
  }
  const spec = deriveCourseAppSpec(courseDir, indexFile)
  const pageInfoPath = join(builtDir, 'page-info.json')
  if (!existsSync(pageInfoPath)) throw new Error(`built TLDA output has no page-info.json: ${builtDir}`)
  const allPages = JSON.parse(readFileSync(pageInfoPath, 'utf8'))
  const wantedSources = [...spec.documents, ...spec.decks]
  const bySource = new Map()
  for (const page of allPages) {
    const source = page?.source?.file
    if (source && !bySource.has(source)) bySource.set(source, page)
  }
  const missing = wantedSources.filter(source => !bySource.has(source))
  if (missing.length) throw new Error(`released course input is absent from the TLDA build: ${missing.join(', ')}`)
  const pages = wantedSources.map(source => bySource.get(source))

  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(dirname(outputDir), { recursive: true })
  cpSync(builtDir, outputDir, { recursive: true })
  const selectedFiles = new Set(pages.map(page => page.file))
  for (const page of allPages) {
    if (selectedFiles.has(page.file)) continue
    rmSync(join(outputDir, page.file), { force: true })
    const source = page?.source?.file
    if (source) rmSync(join(outputDir, source), { force: true })
    const support = join(outputDir, page.file.replace(/\.html$/i, '_files'))
    if (existsSync(support) && statSync(support).isDirectory()) rmSync(support, { recursive: true, force: true })
  }

  const oldIndexByFile = new Map(allPages.map((page, index) => [page.file, index + 1]))
  const newIndexByOld = new Map(pages.map((page, index) => [oldIndexByFile.get(page.file), index + 1]))
  const oldTocPath = join(builtDir, 'toc.json')
  const toc = existsSync(oldTocPath)
    ? JSON.parse(readFileSync(oldTocPath, 'utf8'))
      .filter(entry => newIndexByOld.has(entry.page))
      .map(entry => ({ ...entry, page: newIndexByOld.get(entry.page) }))
    : pages.map((page, index) => ({ title: page.title, level: page.variant === 'slides' ? 'section' : 'chapter', page: index + 1 }))
  writeFileSync(join(outputDir, 'page-info.json'), `${JSON.stringify(pages, null, 2)}\n`)
  writeFileSync(join(outputDir, 'toc.json'), `${JSON.stringify(toc, null, 2)}\n`)
  copyCourseAppAssets(courseDir, outputDir, spec)
  writeFileSync(join(outputDir, 'course-app-spec.json'), `${JSON.stringify(spec, null, 2)}\n`)
  return { spec, pages, toc }
}
