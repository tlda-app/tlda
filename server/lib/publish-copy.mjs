import { existsSync } from 'node:fs'
import { cp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { chapterHeadingFor } from './chapter-heading.mjs'
import { injectBridge } from './html-injector.mjs'

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
