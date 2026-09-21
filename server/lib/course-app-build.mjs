import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { deriveCourseBookSpec } from './course-book-spec.mjs'

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
 * Derive the course app's announcement inputs from the course's own
 * publication index.  A local qmd link resolves back to its qmd source when
 * that source exists; zip and other local links remain publication assets.
 * This spec carries announcement — assets, page links — never membership:
 * which documents and decks publish comes from `deriveCourseBookSpec`.
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
        if (source.endsWith('-slides.qmd')) addUnique(decks, source)
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
      if (source.endsWith('-slides.qmd')) {
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

function findOpenTag(html, tag, id, className) {
  const pattern = new RegExp(`<${tag}\\b[^>]*>`, 'gi')
  let match
  while ((match = pattern.exec(html))) {
    if (!new RegExp(`\\bid=["']${id}["']`, 'i').test(match[0])) continue
    if (className && !new RegExp(`\\bclass=["'][^"']*\\b${className}\\b[^"']*["']`, 'i').test(match[0])) continue
    return match
  }
  return null
}

function extractElement(html, tag, id, className) {
  const open = findOpenTag(html, tag, id, className)
  if (!open) return null
  const innerStart = open.index + open[0].length
  const bounds = new RegExp(`<${tag}\\b|</${tag}\\s*>`, 'gi')
  bounds.lastIndex = innerStart
  let depth = 1
  let bound
  while ((bound = bounds.exec(html))) {
    depth += bound[0][1] === '/' ? -1 : 1
    if (depth === 0) return { start: open.index, end: bounds.lastIndex, innerStart, innerEnd: bound.index }
  }
  return null
}

function scheduleDateKey(cellHtml) {
  const text = cellHtml
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;| /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text.replace(/,[^,]*$/, '').trim()
}

/**
 * A static href rebased to the app book root, plus the extension-insensitive
 * stem used to recognise a link the app row already carries in another form
 * (the TLDA row links a chapter's `.qmd` source; the static row links its
 * rendered `.html` page). External, absolute, and fragment targets are not
 * schedule links and return null.
 */
function rebaseScheduleHref(rawHref) {
  const clean = rawHref.trim().replace(/^\.\//, '').split(/[?#]/, 1)[0]
  const rebased = clean.startsWith('book/') ? clean.slice('book/'.length) : clean
  if (!rebased || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(rebased) || rebased.startsWith('/')) return null
  return { rebased, stem: rebased.replace(/\.[^./]*$/, '') }
}

function anchorsIn(cellHtml) {
  return [...cellHtml.matchAll(/<a\b[^>]*\bhref=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)]
}

/**
 * Augment the app index's existing `section#schedule` with the navigation the
 * static `div.row#schedule` carries, matched row-by-row on date. Only the
 * static schedule slice is read: its wrapper, head, chrome, and sibling
 * sections never enter the app tree. A static link the app row already
 * carries (same stem) is skipped; a static link whose member or asset is
 * declared present is appended as a link rebased to the app book root;
 * anything else degrades to bare text, never a 404 link. App-only rows
 * (later dates with no static counterpart) are untouched.
 */
export function mergeStaticScheduleLinks(appHtml, staticHtml, isDeclaredMember) {
  const unchanged = () => ({ html: appHtml, augmented: 0 })
  const staticBlock = extractElement(staticHtml, 'div', 'schedule', 'row')
  if (!staticBlock) return unchanged()
  const appSection = extractElement(appHtml, 'section', 'schedule', null)
  if (!appSection) return unchanged()
  const staticCells = new Map()
  for (const row of staticHtml.slice(staticBlock.innerStart, staticBlock.innerEnd).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cell[1])
    if (cells.length < 2) continue
    const key = scheduleDateKey(cells[0])
    if (!key) continue
    if (!staticCells.has(key)) staticCells.set(key, [])
    staticCells.get(key).push(cells[1])
  }
  if (!staticCells.size) return unchanged()
  let augmented = 0
  const sectionHtml = appHtml.slice(appSection.innerStart, appSection.innerEnd)
  const merged = sectionHtml.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (whole, inner) => {
    const cells = [...inner.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
    if (cells.length < 2) return whole
    const matches = staticCells.get(scheduleDateKey(cells[0][1]))
    if (!matches) return whole
    const have = new Set()
    for (const anchor of anchorsIn(cells[cells.length - 1][1])) {
      const parsed = rebaseScheduleHref(anchor[2])
      if (parsed) have.add(parsed.stem)
    }
    const additions = []
    for (const body of matches) {
      for (const anchor of anchorsIn(body)) {
        const parsed = rebaseScheduleHref(anchor[2])
        if (!parsed || have.has(parsed.stem)) continue
        have.add(parsed.stem)
        const text = anchor[3].replace(/<[^>]*>/g, '').trim()
        if (!text) continue
        additions.push(isDeclaredMember(parsed.rebased) ? ` <a href="${parsed.rebased}">${text}</a>` : ` ${text}`)
        augmented += 1
      }
    }
    if (!additions.length) return whole
    const bodyFull = cells[cells.length - 1][0]
    const patched = bodyFull.replace(/<\/td\s*>$/i, () => `${additions.join('')}</td>`)
    return whole.replace(bodyFull, () => patched)
  })
  return { html: appHtml.slice(0, appSection.innerStart) + merged + appHtml.slice(appSection.innerEnd), augmented }
}

/**
 * Merge the static schedule slice into the already-assembled app index. The
 * app index is the kept tree; the static index is read only for its
 * `div.row#schedule` navigation. When `indexFile` is not a generated static
 * index (the qmd/markdown path), there is nothing to merge. Missing members
 * degrade to text through the declared spec rather than becoming 404 links.
 */
function mergeAppIndexSchedule(outputDir, indexFile, spec) {
  const appIndexPath = join(outputDir, '_book', 'index.html')
  const staticIndex = resolve(indexFile)
  if (!existsSync(appIndexPath) || !existsSync(staticIndex) || staticIndex === appIndexPath) return { augmented: 0 }
  const declared = new Set([...spec.documents, ...spec.decks, ...spec.assets].flatMap(source => {
    const rendered = source.replace(/\.qmd$/i, '.html')
    const names = [source, rendered, `book/${rendered}`, `book/${source}`]
    if (source.endsWith('-slides.qmd')) names.push(`decks/${source.replace(/\.qmd$/i, '.html')}`)
    return names
  }))
  const { html, augmented } = mergeStaticScheduleLinks(
    readFileSync(appIndexPath, 'utf8'),
    readFileSync(staticIndex, 'utf8'),
    href => declared.has(href),
  )
  if (augmented) writeFileSync(appIndexPath, html)
  return { augmented }
}

/** Explicitly linked downloads are publication artifacts, not Quarto pages. */
export function copyCourseAppAssets(courseDir, outputDir, spec) {
  for (const rel of spec.assets) {
    const destination = join(outputDir, rel)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(courseDir, rel), destination)
  }
}

/** Compile an already-built TLDA project into the published course app tree. */
export function assembleCourseAppSite(courseDir, indexFile, builtDir, outputDir, suppliedSpec = null) {
  const sourceRoot = resolve(courseDir)
  const builtRoot = resolve(builtDir)
  const outputRoot = resolve(outputDir)
  if (outputRoot === sourceRoot || outputRoot === builtRoot ||
      inside(outputRoot, sourceRoot) || inside(outputRoot, builtRoot) ||
      inside(sourceRoot, outputRoot) || inside(builtRoot, outputRoot)) {
    throw new Error('course app output must be separate from the course source and TLDA build')
  }
  const pageInfoPath = join(builtDir, 'page-info.json')
  if (!existsSync(pageInfoPath)) throw new Error(`built TLDA output has no page-info.json: ${builtDir}`)
  const allPages = JSON.parse(readFileSync(pageInfoPath, 'utf8'))
  // One declared source can generate several pages (a master homework's
  // `output-file:` solutions render shares its master's source.file), so the
  // index is source → every page from that source, never source → one page.
  const pagesBySource = new Map()
  for (const page of allPages) {
    const source = page?.source?.file
    if (!source) continue
    if (!pagesBySource.has(source)) pagesBySource.set(source, [])
    pagesBySource.get(source).push(page)
  }
  const membership = deriveCourseBookSpec(courseDir)
  const announcementSpec = deriveCourseAppSpec(courseDir, indexFile)
  const membershipSources = new Set([...membership.documents, ...membership.decks])
  const membershipPages = values => values.flatMap(source =>
    membershipSources.has(source) && pagesBySource.has(source) ? pagesBySource.get(source) : [])
  const renderedSourcePages = values => suppliedSpec
    ? values.flatMap(source => pagesBySource.has(source) ? pagesBySource.get(source) : [])
    : []
  const spec = {
    ...announcementSpec,
    documents: [...new Set([...membershipPages(membership.documents), ...(suppliedSpec ? renderedSourcePages(suppliedSpec.documents) : [])].map(page => page.source.file))],
    decks: [...new Set([...membershipPages(membership.decks), ...(suppliedSpec ? renderedSourcePages(suppliedSpec.decks) : [])].map(page => page.source.file))],
    assets: suppliedSpec
      ? [...new Set([...announcementSpec.assets, ...suppliedSpec.assets])]
      : announcementSpec.assets,
    links: suppliedSpec
      ? [...new Set([...announcementSpec.links, ...suppliedSpec.links])]
      : announcementSpec.links,
  }
  const wantedSources = [...spec.documents, ...spec.decks]
  const missing = wantedSources.filter(source => !pagesBySource.has(source))
  if (missing.length) throw new Error(`declared course input is absent from the TLDA build: ${missing.join(', ')}`)
  const pages = wantedSources.flatMap(source => pagesBySource.get(source))

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
  mergeAppIndexSchedule(outputDir, indexFile, spec)
  writeFileSync(join(outputDir, 'course-app-spec.json'), `${JSON.stringify(spec, null, 2)}\n`)
  return { spec, pages, toc }
}
