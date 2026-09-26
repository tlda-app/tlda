import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

import { chapterHeadingFor } from './chapter-heading.mjs'
import { injectBridge } from './html-injector.mjs'
import { injectPresentationSwitch } from './presentation-switch.mjs'

/**
 * Make the copy carry the app, pointed at this destination.
 *
 * Skip's design, 2026-09-20: *"which we'd like, idk patch in a a like 'build
 * step' so as to not fuck with teh source"* — the destination's configuration is
 * written into the copy at publish time, and it is the only difference between
 * a preview page and a live one.
 *
 * THE CONFIG IS RESOLVED, NOT ASSEMBLED. `shared/config.mjs` already turns a
 * deployment directory into a complete `{database, store, licenseKey}` and
 * throws on a partial one, so the destination is declared in exactly one place
 * and a publish cannot invent a half of it. The splice matches the server's own
 * (`server/unified-server.mjs`, the reader-shell route) so a statically served
 * page and a served one differ in when the tag was written, not in what it says.
 *
 * SOURCE MAPS DO NOT GO OUT. They are 32MB of the 49MB build and they are for
 * whoever is debugging the app, not for a course site.
 */
export async function patchStagedTreeForDestination({ staging, distDir, configDir, document = null }) {
  const previousConfigDir = process.env.TLDA_CONFIG_DIR
  const previousEnv = process.env.TLDA_ENV
  process.env.TLDA_CONFIG_DIR = resolve(configDir)
  // TLDA_ENV names an environment on the machine running this, and would pick
  // the operator's environment over the destination's own `environments.default`.
  delete process.env.TLDA_ENV
  let config
  try {
    const { resolveConfig } = await import(`../../shared/config.mjs?destination=${encodeURIComponent(configDir)}`)
    config = resolveConfig()
  } finally {
    if (previousConfigDir === undefined) delete process.env.TLDA_CONFIG_DIR
    else process.env.TLDA_CONFIG_DIR = previousConfigDir
    if (previousEnv !== undefined) process.env.TLDA_ENV = previousEnv
  }

  const shellSource = join(distDir, 'index.html')
  if (!existsSync(shellSource)) {
    throw new Error(`${distDir} holds no index.html, so there is no app to put in the copy — run the client build first`)
  }
  await cp(distDir, staging, {
    recursive: true,
    filter: source => !source.endsWith(`${sep}index.html`) && !source.endsWith('.map'),
  })

  const tag = `<script>window.__TLDA_CONFIG__=${JSON.stringify(config)}</script>`
  const raw = (await readFile(shellSource, 'utf8')).replace(/\s*<script>window\.__TLDA_CONFIG__=.*?<\/script>\s*/gs, '\n')
  const html = raw.includes('<script type="module"')
    ? raw.replace('<script type="module"', `${tag}\n    <script type="module"`)
    : raw.replace('</head>', `${tag}\n</head>`)
  await writeFile(join(staging, 'app.html'), html)

  // THE CANVAS PAGES GET THEIR BRIDGE WRITTEN IN, because a file server cannot
  // inject one per request and the server does. Same function, same arguments,
  // derived from the same page list -- `chapterHeadingFor` exists so this is
  // sharing rather than a second copy of the numbering rule.
  //
  // `basePath` is empty on purpose. The server passes `/docs/<name>/` so that a
  // `../figs/` reference resolves against the served URL; in a copy the pages
  // sit at the depth they were written for, so rewriting those references would
  // break the ones that currently work.
  //
  // `ownWorkUrl` is empty because it cannot be anything else: the server
  // computes it per person, per request. A published page therefore has no
  // "your work" link, which is a difference in what the page offers rather than
  // a detail of how it is built.
  if (config.pages === 'files') {
    const appRoot = join(staging, 'app')
    if (existsSync(appRoot)) {
      const pageInfo = JSON.parse(await readFile(join(staging, 'page-info.json'), 'utf8').catch(() => '[]'))
      for (const page of pageInfo) {
        const file = String(page?.file || '')
        if (!file.startsWith('app/') || !/\.html?$/i.test(file)) continue
        const path = join(staging, ...file.split('/'))
        if (!existsSync(path)) continue
        const heading = chapterHeadingFor(pageInfo, file)
        const source = await readFile(path, 'utf8')
        await writeFile(path, injectBridge(
          source,
          '',
          heading.chapterTitle,
          heading.isFirstPage,
          { prev: heading.navPrev, next: heading.navNext },
          '',
        ))

        const staticFile = file.replace(/^app\//, 'static/')
        const staticPath = join(staging, ...staticFile.split('/'))
        if (!existsSync(staticPath)) {
          throw new Error(
            `${staticFile} is missing from the staged copy, so the App switch link for ${file} has nowhere to go. ` +
            `A publish that silently dropped it would report success while shipping static pages with no way back to the app. Nothing was pushed.`,
          )
        }
        const staticHtml = await readFile(staticPath, 'utf8')
        const href = `/${file.split('/').map(encodeURIComponent).join('/')}`
        await writeFile(staticPath, injectPresentationSwitch(staticHtml, href, 'App'))
      }
    }
  }

  // A copy whose pages are files needs the list of them as a file too. The
  // server answers `/docs/manifest.json` by walking its projects directory;
  // there is nothing to walk here, so the publish writes what it already knows
  // about the one document it is publishing. One document, because the copy is
  // flat -- every page sits at the root, which is the URL a student's link
  // points at, so two documents in one copy would be two documents at one
  // address.
  if (config.pages === 'files') {
    if (!document?.name || !document?.record) {
      throw new Error(
        `${configDir} declares pages: files, so the copy needs a manifest naming the document it carries, and this publish was given none. ` +
        'Nothing was written.',
      )
    }
    // THE ENTRY IS THE WHOLE DOCUMENT RECORD, not a trimmed listing. On a server
    // the manifest lists documents and a second call fetches the one you opened;
    // a trimmed entry handed to the loader in its place is missing fields the
    // loader needs -- `targets` for a LaTeX document is the known one -- and the
    // failure is a broken layout rather than an error. A file server has no
    // second call to make, so the file carries what that call would have said.
    const { basePath: _derivedByTheClient, ...entry } = document.record
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify({ documents: { [document.name]: entry } }, null, 2)}\n`)
  }
  return { config, shell: 'app.html', manifest: config.pages === 'files' }
}

/**
 * Put a copy of what this box just built where this box serves previews.
 *
 * The whole transport problem disappears when the box that builds is the box
 * that serves: no inventory, no hashes, no fetch that a reader-shell route can
 * intercept. The output directory IS the artifact, on the same filesystem.
 *
 * WHAT A COPY IS, MINIMALLY: the build's own output at the root, plus the
 * application and one shell carrying this destination's config. The loader asks
 * for `document-manifest.json` and `page-info.json` at the base path, and the
 * build already wrote both at the output root, so nothing has to be assembled
 * or rewritten -- the paths inside them already say where their pages are.
 *
 * SWAPPED, NOT WRITTEN OVER. A copy assembled in place is served half-finished
 * for as long as it takes to assemble, and a build is not a moment.
 */
export async function assemblePreviewCopy({ outputDir, into, distDir, configDir, document }) {
  if (!existsSync(outputDir)) {
    throw new Error(`there is no build output at ${outputDir} to copy, so nothing was put in front of the preview`)
  }
  await rm(into, { recursive: true, force: true })
  await mkdir(dirname(into), { recursive: true })
  await cp(outputDir, into, { recursive: true })
  return patchStagedTreeForDestination({ staging: into, distDir, configDir, document })
}

/**
 * Put an assembled copy in front of whatever is serving it.
 *
 * SWAPPED, NOT WRITTEN OVER. A copy assembled in place is served
 * half-finished for as long as it takes to assemble, and a build is not a
 * moment. The same reason a transfer unpacks beside the served directory.
 */
export async function swapPreviewCopyIntoPlace({ incoming, staticDir, renameImpl = rename }) {
  const previous = `${staticDir}.previous`
  await rm(previous, { recursive: true, force: true })
  const hadStatic = existsSync(staticDir)
  if (hadStatic) await renameImpl(staticDir, previous)
  try {
    await renameImpl(incoming, staticDir)
  } catch (error) {
    if (hadStatic && existsSync(previous) && !existsSync(staticDir)) {
      try {
        await renameImpl(previous, staticDir)
      } catch (restoreError) {
        error.message = `${error.message}; restoring the previous preview failed: ${restoreError.message}`
      }
    }
    throw error
  }
  await rm(previous, { recursive: true, force: true })
  return staticDir
}

/**
 * Put a copy of what this box just built where this box serves previews.
 *
 * The same-box case, kept because it is the one a single-box deployment wants
 * and because it is what the remote case does either side of the wire.
 */
export async function copyBuildOutputToPreview({ outputDir, staticDir, distDir, configDir, document }) {
  const incoming = `${staticDir}.incoming`
  const patched = await assemblePreviewCopy({ outputDir, into: incoming, distDir, configDir, document })
  await swapPreviewCopyIntoPlace({ incoming, staticDir })
  return { staticDir, store: patched.config.store.ws, licensed: Boolean(patched.config.licenseKey) }
}

/**
 * Send an assembled copy to the host that serves it.
 *
 * It is copying files between two servers. The only reasons it is not `scp`
 * are that neither box runs an sshd and the server has no Fly credential, so
 * it goes the way this app already reaches its peers: a POST over Fly's
 * private network, the same route the build executor uses.
 *
 * THE RECEIVER REPORTS ITS MANIFEST FIRST. The request then contains the
 * complete new manifest and only the blobs whose hashes are absent or changed.
 * The receiver carries unchanged files forward in an incoming release, checks
 * every file and the manifest root, and swaps only that complete release.
 */
const PREVIEW_MANIFEST = '.tlda-preview-manifest.json'

async function listPreviewFiles(root, current = '') {
  if (!existsSync(root)) return []
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const name = current ? `${current}/${entry.name}` : entry.name
    if (name === PREVIEW_MANIFEST) continue
    if (entry.isDirectory()) files.push(...await listPreviewFiles(path, name))
    else if (entry.isFile() && !entry.isSymbolicLink()) {
      const bytes = await readFile(path)
      files.push({ path: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
  return files
}

export async function previewManifest(root) {
  const files = (await listPreviewFiles(root)).sort((a, b) => a.path.localeCompare(b.path))
  const rootSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex')
  return { version: 1, files, rootSha256 }
}

async function readRemoteManifest(url, secret, fetchImpl) {
  const response = await fetchImpl(`${url.replace(/\/$/, '')}/manifest`, {
    headers: { 'x-tlda-preview-copy': secret },
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`${url} refused the preview manifest with ${response.status}: ${body.slice(0, 300) || '(no body)'}`)
  try { return JSON.parse(body) } catch { throw new Error(`${url} returned an invalid preview manifest`) }
}

function tarArchive(from, archive, spawnImpl) {
  const tar = spawnImpl('tar', ['czf', archive, '-C', from, '.'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let said = ''
  return new Promise((resolve, reject) => {
    tar.stderr.on('data', chunk => { said += chunk })
    tar.on('error', reject)
    tar.on('close', code => code === 0
      ? resolve()
      : reject(new Error(`tar exited ${code} packing ${from}${said.trim() ? `: ${said.trim()}` : ''}`)))
  })
}

/** Send only blobs whose hashes differ from the receiver's current tree. */
export async function sendPreviewCopy({ from, url, secret, fetchImpl = fetch, spawnImpl = spawn }) {
  const manifest = await previewManifest(from)
  const previous = await readRemoteManifest(url, secret, fetchImpl)
  const previousFiles = new Map((Array.isArray(previous?.files) ? previous.files : []).map(file => [file.path, file.sha256]))
  const changed = manifest.files.filter(file => previousFiles.get(file.path) !== file.sha256).map(file => file.path)
  const payload = await mkdtemp(join(tmpdir(), 'tlda-preview-payload-'))
  try {
    await writeFile(join(payload, PREVIEW_MANIFEST), `${JSON.stringify(manifest)}\n`)
    for (const path of changed) {
      const target = join(payload, path)
      await mkdir(dirname(target), { recursive: true })
      await cp(join(from, path), target)
    }
    const archive = `${payload}.tgz`
    await tarArchive(payload, archive, spawnImpl)
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/gzip',
        'x-tlda-preview-copy': secret,
        'x-tlda-preview-copy-root': manifest.rootSha256,
      },
      body: createReadStream(archive),
      duplex: 'half',
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`${url} refused the preview copy with ${response.status}: ${body.slice(0, 300) || '(no body)'}`)
    return { files: changed.length, rootSha256: manifest.rootSha256, said: body.slice(0, 300) }
  } finally {
    await rm(payload, { recursive: true, force: true })
    await rm(`${payload}.tgz`, { force: true })
  }
}
