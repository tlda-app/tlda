import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

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
        if (!existsSync(staticPath)) continue
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
 * Put the canvas half in the copy without fetching it, because it cannot be
 * fetched.
 *
 * `/docs/<project>/app/<path>.html` is the reader-shell route: it answers with
 * the application, not the file. Measured 2026-09-21 — 2,104 bytes returned for
 * a 91,033-byte page, hash `e6a1313c` against a recorded `711108fc`. So every
 * `.html` under `app/` is unfetchable by construction, and a publish that tries
 * fails its own hash check, which is what it should do.
 *
 * It does not need fetching. The two halves are the same bytes: across
 * `qtm285-book`'s published tree, 526 files appear in both and 526 are
 * byte-identical, none differ. The halves are two ways of SERVING one render,
 * not two renders.
 *
 * THAT IS CHECKED PER FILE RATHER THAN BELIEVED. The inventory carries a hash
 * for each, so a page whose twins disagree is a page this cannot honestly
 * produce, and it refuses rather than shipping the wrong bytes under a name
 * that claims otherwise.
 */
export function canvasPagesFromTheirStaticTwins(files) {
  const staticByPath = new Map()
  for (const file of files) {
    if (file.path.startsWith('static/')) staticByPath.set(file.path.slice('static/'.length), file)
  }
  const derive = []
  const disagree = []
  const fetchable = []
  for (const file of files) {
    if (!file.path.startsWith('app/')) {
      fetchable.push(file)
      continue
    }
    const twin = staticByPath.get(file.path.slice('app/'.length))
    // A twin with the same hash is the same bytes, so copying it is not an
    // optimisation with a risk attached -- it is the identical file, and it
    // arrived hash-checked. This is most of the canvas half: 526 of 529 on
    // qtm285-book, which halves what crosses the wire.
    if (twin && twin.sha256 === file.sha256) { derive.push({ from: twin.path, to: file.path }); continue }
    // No twin, or a twin that differs. Anything but HTML can still be fetched:
    // the reader-shell route lets a non-.html path fall through to the file
    // handler. HTML cannot, so a page that is genuinely its own thing is one
    // this cannot produce, and it says so instead of shipping the shell.
    if (!/\.html?$/i.test(file.path)) { fetchable.push(file); continue }
    disagree.push({
      path: file.path,
      why: twin ? `its static twin is ${twin.sha256.slice(0, 12)} and this is ${file.sha256.slice(0, 12)}` : 'there is no file of that name in the static half',
    })
  }
  return { fetchable, derive, disagree }
}

/**
 * Put the derived canvas files in place, after the fetched ones have landed.
 *
 * `layout` is the same one the staging used, so `from` is looked up where the
 * staging actually put it rather than where the inventory named it — the copy
 * hoists the static half to its root, and a path that ignored that would copy
 * from nowhere.
 */
export async function placeDerivedCanvasFiles({ staging, derive, layout = path => path }) {
  for (const { from, to } of derive) {
    const source = join(staging, ...layout(from).split('/'))
    const target = join(staging, ...layout(to).split('/'))
    if (!existsSync(source)) {
      throw new Error(`the canvas copy of ${to} was to come from ${from}, which is not in the staged tree; nothing was pushed`)
    }
    await mkdir(dirname(target), { recursive: true })
    await cp(source, target)
  }
  return derive.length
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
export async function swapPreviewCopyIntoPlace({ incoming, staticDir }) {
  const previous = `${staticDir}.previous`
  await rm(previous, { recursive: true, force: true })
  if (existsSync(staticDir)) await rename(staticDir, previous)
  await rename(incoming, staticDir)
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
 * ONE ARCHIVE, ONE REQUEST, AND ITS DIGEST IN A HEADER. The per-file checks
 * that a fetched publish needs do not apply here — nothing was fetched, the
 * bytes came off this box's own disk — so the only thing that can go wrong is
 * the wire, and one digest answers that.
 */
export async function sendPreviewCopy({ from, url, secret, fetchImpl = fetch, spawnImpl = spawn }) {
  const archive = await new Promise((resolve, reject) => {
    const tar = spawnImpl('tar', ['czf', '-', '-C', from, '.'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []
    let said = ''
    tar.stdout.on('data', chunk => chunks.push(chunk))
    tar.stderr.on('data', chunk => { said += chunk })
    tar.on('error', reject)
    tar.on('close', code => code === 0
      ? resolve(Buffer.concat(chunks))
      : reject(new Error(`tar exited ${code} packing ${from}${said.trim() ? `: ${said.trim()}` : ''}`)))
  })
  const digest = createHash('sha256').update(archive).digest('hex')
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/gzip',
      'x-tlda-preview-copy': secret,
      'x-tlda-preview-copy-sha256': digest,
    },
    body: archive,
  })
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`${url} refused the preview copy with ${response.status}: ${body.slice(0, 300) || '(no body)'}`)
  }
  return { bytes: archive.length, digest, said: body.slice(0, 300) }
}
