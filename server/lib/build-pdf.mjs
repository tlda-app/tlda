import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, extname, join } from 'node:path'
import { readProject, sourceDir, outputDir, readClientSourceManifest } from './project-store.mjs'
import { getBuildReporter } from './build-runner.mjs'
import { createDocumentManifest, writeDocumentManifest } from './document-manifest.mjs'

const execFile = promisify(execFileCb)

function decodeXml(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

export function parsePdfInfo(text) {
  const pages = Number(text.match(/^Pages:\s+(\d+)/m)?.[1])
  const size = text.match(/^Page size:\s+([\d.]+) x ([\d.]+) pts/m)
  if (!Number.isInteger(pages) || pages < 1) throw new Error('pdfinfo did not report a positive page count')
  if (!size) throw new Error('pdfinfo did not report a page size')
  return { pages, width: Number(size[1]), height: Number(size[2]) }
}

export function parsePdfTextGeometry(xml, pageNumber) {
  const page = xml.match(/<page\b[^>]*\bwidth="([\d.]+)"[^>]*\bheight="([\d.]+)"[^>]*>([\s\S]*?)<\/page>/i)
  if (!page) return { page: pageNumber, width: null, height: null, text: '', words: [] }
  const words = []
  for (const match of page[3].matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/gi)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([A-Za-z]+)="([^"]*)"/g)].map(item => [item[1], item[2]]))
    const text = decodeXml(match[2].replace(/<[^>]+>/g, '')).trim()
    if (!text) continue
    words.push({
      text,
      x: Number(attrs.xMin),
      y: Number(attrs.yMin),
      width: Number(attrs.xMax) - Number(attrs.xMin),
      height: Number(attrs.yMax) - Number(attrs.yMin),
    })
  }
  return {
    page: pageNumber,
    width: Number(page[1]),
    height: Number(page[2]),
    text: words.map(word => word.text).join(' '),
    words,
  }
}

async function pageSize(pdfPath, pageNumber) {
  const { stdout } = await execFile('pdfinfo', ['-f', String(pageNumber), '-l', String(pageNumber), pdfPath], { encoding: 'utf8' })
  const match = stdout.match(new RegExp(`^Page\\s+${pageNumber}\\s+size:\\s+([\\d.]+) x ([\\d.]+) pts`, 'm'))
    || stdout.match(/^Page size:\s+([\d.]+) x ([\d.]+) pts/m)
  if (!match) throw new Error(`pdfinfo did not report dimensions for page ${pageNumber}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

export async function extractPdfArtifacts({ pdfPath, outDir, target, project, outputPdf = basename(pdfPath) }) {
  mkdirSync(outDir, { recursive: true })
  const destinationPdf = join(outDir, outputPdf)
  if (pdfPath !== destinationPdf) cpSync(pdfPath, destinationPdf)
  const { stdout: infoText } = await execFile('pdfinfo', [pdfPath], { encoding: 'utf8' })
  const info = parsePdfInfo(infoText)
  const pages = []

  for (let pageNumber = 1; pageNumber <= info.pages; pageNumber++) {
    const size = pageNumber === 1 ? { width: info.width, height: info.height } : await pageSize(pdfPath, pageNumber)
    const svgFile = `${target}-page-${pageNumber}.svg`
    await execFile('pdftocairo', ['-svg', '-f', String(pageNumber), '-l', String(pageNumber), pdfPath, join(outDir, svgFile)], {
      maxBuffer: 50 * 1024 * 1024,
    })
    const { stdout: bboxXml } = await execFile('pdftotext', ['-f', String(pageNumber), '-l', String(pageNumber), '-bbox-layout', pdfPath, '-'], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
    })
    const geometry = parsePdfTextGeometry(bboxXml, pageNumber)
    const geometryFile = `${target}-page-${pageNumber}-text.json`
    writeFileSync(join(outDir, geometryFile), `${JSON.stringify(geometry)}\n`)
    pages.push({ file: svgFile, width: size.width, height: size.height, textGeometry: geometryFile })
  }

  const manifest = createDocumentManifest({
    ...project,
  }, pages, { assets: [outputPdf], sourceMapping: 'none', view: {
    kind: 'svg-pages', capabilities: { presentation: false, sourceMapping: false, searchableText: true },
  } })
  return manifest
}

export async function buildPdfDocument(name, addLog = console.log) {
  const project = await readProject(name)
  const mainFile = String(project?.mainFile || '').replace(/\\/g, '/').replace(/^\.?\/+/, '')
  if (!mainFile || extname(mainFile).toLowerCase() !== '.pdf') throw new Error('A PDF project requires a .pdf mainFile')

  const srcDir = sourceDir(name)
  const outDir = outputDir(name)
  const pdfPath = join(srcDir, mainFile)
  if (!existsSync(pdfPath)) throw new Error(`Main PDF "${mainFile}" not found in source`)
  const target = basename(mainFile, extname(mainFile))
  const manifest = await extractPdfArtifacts({
    pdfPath, outDir, target,
    project: { ...project, sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged', mainFile },
    outputPdf: basename(mainFile),
  })
  const pages = manifest.pages

  // Publish the manifest, because a PDF that is not described is not readable.
  //
  // `createDocumentManifest` above only builds the object; something has to put
  // it on disk. On the RC branch that is `buildDocument()`, the single
  // completion boundary — which is not ported yet, deliberately, because
  // swapping the build worker's dispatch block for it is what silently deletes
  // the four behaviours `main` grew after the branch (render relevance, the
  // skip disposition, version finalization, the `not_required` result).
  //
  // So the builder publishes its own manifest for now. Measured before adding
  // this: the build completed, wrote its pages and its text geometry, and left
  // no `document-manifest.json` at all — so it looked entirely healthy while
  // `view.kind`, which is the client's whole contract for this document, lived
  // in a file nobody had written.
  //
  // This moves to `buildDocument()` when that boundary lands, and this call goes
  // with it rather than being left behind as a second writer.
  writeDocumentManifest(outDir, manifest)

  const files = (await readClientSourceManifest(name)).filter(rel => existsSync(join(srcDir, rel))).sort()
  writeFileSync(join(outDir, 'relevant-files.json'), `${JSON.stringify({ generated_at: new Date().toISOString(), files }, null, 2)}\n`)

  // Report the pages and targets onto the project record, the way
  // build-markdown does. Without this the build succeeds, the manifest is
  // served correctly, and the VIEWER still cannot draw it: the client's SVG
  // path builds its layout from `config.targets`, and
  // `createSvgDocumentLayout` throws outright when there are none rather than
  // inventing a name — "the page filename is keyed on the tex base, which is
  // not derivable from the project name."
  //
  // Measured on the RC server before adding this: buildStatus `success`, a
  // four-page manifest served with correct geometry, and `pages: 0`,
  // `targets: null` on the project. A document that builds and cannot be
  // opened.
  //
  // `targets` carries the same shape the LaTeX finalizer writes, because it
  // feeds the same client code — the base name is what page filenames are
  // keyed on, and for a PDF that is the PDF's own name.
  //
  // Belongs in `buildDocument()` with the manifest publish when that boundary
  // is ported; both move together.
  // Page SIZES deliberately do not go here. They live in the manifest, which
  // already records width and height per page and is already served, so putting
  // them on `targets` as well would be a second encoding of one fact — the
  // thing this RC exists to remove.
  //
  // It was tried, and it broke the build: adding `pageSizes` to this array made
  // every PDF build fail at `git rev-parse HEAD` in the shadow repo, while a
  // markdown control on the same server kept succeeding. Bisected to this one
  // field. I did not chase why the coupling exists, because the field should
  // not have been here in the first place.
  const targets = [{
    texBase: target,
    mainFile,
    pages: pages.length,
  }]
  await getBuildReporter().updateProject(name, {
    buildStatus: 'success',
    pages: pages.length,
    targets,
    lastBuild: new Date().toISOString(),
  })

  addLog(`[pdf] ${name}: extracted ${pages.length} page${pages.length === 1 ? '' : 's'}`)
  return { manifest, targets }
}
