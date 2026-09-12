#!/usr/bin/env node
/**
 * Project promotion crosses a real wire.
 *
 * WHY THIS EXISTS SEPARATELY from server/lib/project-promotion.test.mjs: that
 * suite is thorough about the stream FORMAT — truncation, corruption,
 * traversal, duplicates, size overruns, symlinks, backpressure, activation
 * races. It calls `writeProjectPromotionStream` and
 * `importProjectPromotionStream` from ONE process over an in-memory stream. So
 * it proves the sender and it proves the receiver, and says nothing about
 * whether they are connected — which is the only part that can be missing, and
 * the part nothing had ever exercised. `POST /api/projects/:name/promote` has
 * no caller anywhere in the tree, so neither route, the bearer check, the
 * cross-environment URL resolution, nor the HTTP transport had ever run.
 *
 * So: TWO processes, TWO projects roots, TWO config directories, the REAL
 * express router from server/routes/projects.mjs on both sides, and a REAL TLS
 * socket between them. The destination resolves the source by environment NAME
 * through its own daemon.yaml, exactly as `pic` resolves `pic-preview`.
 * Nothing on either side is stubbed.
 *
 * The last story is a DELIBERATE RED that passes by failing: promoting a
 * second revision of a project the destination already has is refused.
 * `importProjectPromotionStream` opens with an `existsSync` guard and has no
 * update path, so promotion can create a project and can never republish one.
 * That story asserts the refusal rather than hiding it — when the importer
 * learns to republish, this story is the one that changes.
 *
 * Run: node bin/promotion-crosses-the-wire-test.mjs
 */

import assert from 'node:assert'
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createHttpsServer } from 'node:https'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// This file's own path, not a hardcoded name: the destination child and the
// CA re-exec both relaunch THIS file, so a copy of it must run its own code —
// which is what makes the go-red counterfactual possible without editing the
// real test.
const SELF = fileURLToPath(import.meta.url)

// The shared secret both boxes carry as `fly secrets set
// TLDA_PROMOTION_EXPORT_TOKEN`. The source refuses the export without it and
// the destination cannot ask without it, so it is set in both processes — and
// deliberately NOT in this driver's own environment, which never calls either
// route directly.
const EXPORT_TOKEN = 'wire-test-export-token'

// The environment name the destination knows the source by. This is the real
// shape: `config/deployments/pic/daemon.yaml` declares a `pic-preview`
// environment whose store is substituted from TLDA_PROMOTION_SOURCE_URL, and a
// caller names that environment rather than a URL.
const SOURCE_ENV = 'pic-preview'
const DEST_ENV = 'pic'
const PROJECT = 'a-throwaway-course'

// mkcert's development certificate, already installed for local https. Used so
// the source can be an `https:` origin without disabling TLS verification:
// `validatePromotionSourceOrigin` accepts any https origin and accepts an
// `http:` one only on a `*.internal` hostname, which does not resolve here.
const TLS_CERT = join(homedir(), '.config', 'tlda', 'localhost+2.pem')
const TLS_KEY = join(homedir(), '.config', 'tlda', 'localhost+2-key.pem')
const CA_ROOT = join(homedir(), 'Library', 'Application Support', 'mkcert', 'rootCA.pem')

function writeDaemonYaml(configDir, { active, values }) {
  mkdirSync(configDir, { recursive: true })
  const entries = Object.entries(values)
    .map(([name, url]) => `    ${name}:\n      database: ${url}\n      store: ${url}\n      licenseKey: ""`)
    .join('\n')
  writeFileSync(join(configDir, 'daemon.yaml'), `machineId: wire-test\nenvironments:\n  default: ${active}\n  values:\n${entries}\n`)
}

/**
 * Build a project on disk in the state promotion requires: one accepted
 * revision that is the project's head, admitted, with a terminal successful
 * build phase, plus the `output/` tree and `build.log` that promotion carries.
 */
async function buildPromotableProject(projectRoot, { body, page }) {
  mkdirSync(join(projectRoot, 'output'), { recursive: true })
  writeFileSync(join(projectRoot, 'project.json'), JSON.stringify({
    name: PROJECT, title: 'A Throwaway Course', format: 'html', pages: 1,
  }))
  writeFileSync(join(projectRoot, 'output', 'index.html'), page)
  writeFileSync(join(projectRoot, 'build.log'), 'built by the wire test\n')
  const { createSourceLifecycleStore } = await import('../server/lib/source-lifecycle.mjs')
  const lifecycle = createSourceLifecycleStore({ root: join(projectRoot, '.source-lifecycle'), project: PROJECT })
  const git = await lifecycle.gitRepository()
  const revision = await git.acceptRevision({ project: PROJECT, files: [{ path: 'index.qmd', content: body }] })
  await git.advanceHead(PROJECT, revision, null)
  lifecycle.recordRevisionAdmission(PROJECT, revision, 1)
  lifecycle.recordRevisionPhase(PROJECT, revision, 'build', 'built', { ok: true })
  return revision
}

/**
 * Advance the SAME project to a second accepted, built revision — what week
 * two looks like on the source box.
 *
 * This has to be the same project rather than a second one: promotion asks for
 * a revision and `acceptedIdentity` refuses anything that is not the project's
 * currently accepted revision. A second revision parked in a different
 * directory is refused for that reason instead, which is a different story and
 * never reaches the guard this test is about.
 */
async function advancePromotableProject(projectRoot, previous, { body, page }) {
  const { createSourceLifecycleStore } = await import('../server/lib/source-lifecycle.mjs')
  const lifecycle = createSourceLifecycleStore({ root: join(projectRoot, '.source-lifecycle'), project: PROJECT })
  const git = await lifecycle.gitRepository()
  const revision = await git.acceptRevision({ project: PROJECT, files: [{ path: 'index.qmd', content: body }] })
  await git.advanceHead(PROJECT, revision, previous)
  lifecycle.recordRevisionAdmission(PROJECT, revision, 2)
  lifecycle.recordRevisionPhase(PROJECT, revision, 'build', 'built', { ok: true })
  writeFileSync(join(projectRoot, 'output', 'index.html'), page)
  return revision
}

// ---------------------------------------------------------------------------
// The DESTINATION, run as a child process.
//
// It is a separate process for a reason that is not ceremony: the projects
// directory and the config directory are both process-wide module state
// (`initProjectStore`, and `TLDA_CONFIG_DIR` read once at import). One process
// cannot be two boxes with two projects roots, so a single-process version of
// this test would have had both sides reading the same directory — which is
// the in-memory shortcut it exists to avoid.
// ---------------------------------------------------------------------------
if (process.argv[2] === '--destination') {
  const projectsDir = process.argv[3]
  const express = (await import('express')).default
  const { initProjectStore } = await import('../server/lib/project-store.mjs')
  await initProjectStore(projectsDir)
  const projectRoutes = (await import('../server/routes/projects.mjs')).default
  const app = express()
  app.use(express.json())
  app.use('/api/projects', projectRoutes)
  const server = app.listen(0, '127.0.0.1', () => {
    process.stdout.write(`READY ${server.address().port}\n`)
  })
  process.on('SIGTERM', () => process.exit(0))
} else {
  // -------------------------------------------------------------------------
  // The driver, which is also the SOURCE.
  // -------------------------------------------------------------------------
  for (const path of [TLS_CERT, TLS_KEY, CA_ROOT]) {
    if (!existsSync(path)) {
      console.error(`this test needs the local mkcert development certificate: ${path} is missing`)
      console.error('create it with `mkcert -install && mkcert localhost 127.0.0.1 ::1` in ~/.config/tlda')
      process.exit(2)
    }
  }

  // `NODE_EXTRA_CA_CERTS` is read once at startup, so it cannot be set from
  // inside the process that needs it. The driver makes its own requests to the
  // source (the two 401 stories), so it needs the CA as much as the
  // destination does — hence a single re-exec rather than a special case for
  // the driver's own calls. `NODE_TLS_REJECT_UNAUTHORIZED` is cleared in the
  // same breath: this box's agent shells set it to 0, and inheriting that
  // would make every TLS story here pass with verification turned off.
  if (process.env.NODE_EXTRA_CA_CERTS !== CA_ROOT || process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    const env = { ...process.env, NODE_EXTRA_CA_CERTS: CA_ROOT }
    delete env.NODE_TLS_REJECT_UNAUTHORIZED
    const relaunch = spawn(process.execPath, [SELF, ...process.argv.slice(2)], { env, stdio: 'inherit' })
    relaunch.on('exit', code => process.exit(code ?? 1))
  } else {

  const root = mkdtempSync(join(tmpdir(), 'tlda-promotion-wire-'))
  const sourceProjects = join(root, 'source', 'projects')
  const sourceConfig = join(root, 'source', 'config')
  const destProjects = join(root, 'destination', 'projects')
  const destConfig = join(root, 'destination', 'config')
  mkdirSync(destProjects, { recursive: true })

  let failures = 0
  function ok(name, cond, detail = '') {
    if (cond) { console.log(`  ok  ${name}`); return }
    failures++
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`)
  }

  let child = null
  let sourceServer = null
  try {
    // The source's own config. Its active environment NAME travels in the
    // promotion header as `sourceEnvironment` (the export route reads
    // `getActiveEnvName()`), and the destination checks it against what the
    // caller asked for — so this name has to be the one the caller names.
    process.env.TLDA_CONFIG_DIR = sourceConfig
    process.env.TLDA_PROMOTION_EXPORT_TOKEN = EXPORT_TOKEN
    // `resolveStrictEnvironmentAuthority` prefers TLDA_ENV over the file's
    // `default`, so an agent shell carrying TLDA_ENV=testing made the source
    // resolve an environment its own config had never heard of — and the
    // failure surfaced on the DESTINATION as `trusted source refused
    // promotion`, which reads like a wire fault and is not one. Pin it.
    process.env.TLDA_ENV = SOURCE_ENV
    // This box's agent shells carry NODE_TLS_REJECT_UNAUTHORIZED=0. Left in
    // place, the promotion fetch would have succeeded because verification was
    // OFF, and the run would have proved nothing about the certificate path
    // this test claims to use. Removed from the driver and from the child.
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    writeDaemonYaml(sourceConfig, { active: SOURCE_ENV, values: { [SOURCE_ENV]: 'https://localhost:1' } })

    const revision = await buildPromotableProject(join(sourceProjects, PROJECT), {
      body: '# A Throwaway Course\n', page: '<h1>A Throwaway Course</h1>\n',
    })

    const express = (await import('express')).default
    const { initProjectStore } = await import('../server/lib/project-store.mjs')
    await initProjectStore(sourceProjects)
    const projectRoutes = (await import('../server/routes/projects.mjs')).default
    const sourceApp = express()
    sourceApp.use(express.json())
    sourceApp.use('/api/projects', projectRoutes)
    sourceServer = createHttpsServer(
      { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) },
      sourceApp,
    )
    await new Promise(res => sourceServer.listen(0, '127.0.0.1', res))
    const sourceOrigin = `https://localhost:${sourceServer.address().port}`
    // Rewritten now that the port is known. `loadDaemonYaml` reads the file on
    // every call and caches nothing, so this is picked up by the next resolve.
    writeDaemonYaml(sourceConfig, { active: SOURCE_ENV, values: { [SOURCE_ENV]: sourceOrigin } })

    // The destination's config: its own environment, plus the source declared
    // by name. This is the whole of what `pic` knows about `pic-preview`.
    writeDaemonYaml(destConfig, {
      active: DEST_ENV,
      values: { [DEST_ENV]: 'http://127.0.0.1:1', [SOURCE_ENV]: sourceOrigin },
    })

    child = spawn(process.execPath, [SELF, '--destination', destProjects], {
      env: {
        ...process.env,
        TLDA_CONFIG_DIR: destConfig,
        TLDA_ENV: DEST_ENV,
        TLDA_PROMOTION_EXPORT_TOKEN: EXPORT_TOKEN,
        // Read at startup, which is why the destination has to be a child we
        // spawn rather than this process: it is what lets the real fetch trust
        // the real certificate instead of turning verification off.
        NODE_EXTRA_CA_CERTS: CA_ROOT,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let childErr = ''
    child.stderr.on('data', d => { childErr += d })
    const destPort = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`destination never came up:\n${childErr}`)), 30000)
      let out = ''
      child.stdout.on('data', d => {
        out += d
        const match = /READY (\d+)/.exec(out)
        if (match) { clearTimeout(timer); res(Number(match[1])) }
      })
      child.on('exit', code => { clearTimeout(timer); rej(new Error(`destination exited ${code}:\n${childErr}`)) })
    })
    const destOrigin = `http://127.0.0.1:${destPort}`

    async function promote(body) {
      const response = await fetch(`${destOrigin}/api/projects/${PROJECT}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json().catch(() => ({})) }
    }

    console.log('\nthe destination has nothing before anyone asks')
    ok('no project directory on the destination',
      !existsSync(join(destProjects, PROJECT)),
      readdirSync(destProjects).join(', '))

    console.log('\nan unauthorized export is refused at the source, over the wire')
    const unauthorized = await fetch(`${sourceOrigin}/api/projects/${PROJECT}/promotion-export/${revision}`)
    ok('the export route answers 401 without the bearer token', unauthorized.status === 401, String(unauthorized.status))
    const wrongToken = await fetch(`${sourceOrigin}/api/projects/${PROJECT}/promotion-export/${revision}`, {
      headers: { authorization: 'Bearer not-the-shared-secret' },
    })
    ok('and 401 with the wrong one', wrongToken.status === 401, String(wrongToken.status))

    console.log('\nan exact revision is required')
    const symbolic = await promote({ sourceEnvironment: SOURCE_ENV, revision: 'HEAD' })
    ok('a symbolic revision is refused', symbolic.status === 409, JSON.stringify(symbolic.body))
    const unknownEnv = await promote({ sourceEnvironment: 'no-such-environment', revision })
    ok('an undeclared source environment is refused', unknownEnv.status === 409, JSON.stringify(unknownEnv.body))
    ok('and neither attempt left anything behind',
      !existsSync(join(destProjects, PROJECT)),
      readdirSync(destProjects).join(', '))

    console.log('\nthe content reaches the destination')
    const promoted = await promote({ sourceEnvironment: SOURCE_ENV, revision })
    ok('the destination reports it promoted', promoted.status === 201, `${promoted.status} ${JSON.stringify(promoted.body)}`)
    ok('it names the revision it promoted', promoted.body.revision === revision, JSON.stringify(promoted.body))

    ok('the rendered output is on the destination',
      existsSync(join(destProjects, PROJECT, 'output', 'index.html')),
      existsSync(join(destProjects, PROJECT)) ? readdirSync(join(destProjects, PROJECT)).join(', ') : '(no project)')
    ok('and it is byte-identical to the source render',
      existsSync(join(destProjects, PROJECT, 'output', 'index.html')) &&
        readFileSync(join(destProjects, PROJECT, 'output', 'index.html'), 'utf8') === '<h1>A Throwaway Course</h1>\n')
    ok('the build log travelled too',
      existsSync(join(destProjects, PROJECT, 'build.log')) &&
        readFileSync(join(destProjects, PROJECT, 'build.log'), 'utf8') === 'built by the wire test\n')

    console.log('\nthe source history travelled, not just the render')
    const destGitDir = join(destProjects, PROJECT, '.source-lifecycle', 'git')
    const destHead = existsSync(destGitDir)
      ? execFileSync('git', [`--git-dir=${destGitDir}`, 'rev-parse', `refs/tlda/source/${PROJECT}^{commit}`], { encoding: 'utf8' }).trim()
      : '(no git dir)'
    ok('the destination holds the same source commit', destHead === revision, `${destHead} vs ${revision}`)
    ok('the destination records the promoted revision\'s lifecycle',
      existsSync(join(destProjects, PROJECT, '.source-lifecycle', 'operations.json')) &&
        !!JSON.parse(readFileSync(join(destProjects, PROJECT, '.source-lifecycle', 'operations.json'), 'utf8'))
          .revisionLifecycle?.[revision])

    console.log('\nno staging directory is left behind')
    ok('the destination projects root holds only the project',
      readdirSync(destProjects).join(',') === PROJECT,
      readdirSync(destProjects).join(', '))

    // ---------------------------------------------------------------------
    // The deliberate red. This story passes by asserting a refusal, and the
    // refusal is the defect: a second revision cannot be published.
    // ---------------------------------------------------------------------
    console.log('\nAND HERE IS WHERE PUBLISHING STOPS: a second revision cannot be promoted')
    const second = await advancePromotableProject(join(sourceProjects, PROJECT), revision, {
      body: '# A Throwaway Course, week two\n', page: '<h1>Week two</h1>\n',
    })
    ok('the source accepted a second revision of the same project', second !== revision, `${second} vs ${revision}`)
    const exportable = await fetch(`${sourceOrigin}/api/projects/${PROJECT}/promotion-export/${second}`, {
      headers: { authorization: `Bearer ${EXPORT_TOKEN}` },
    })
    ok('and the source will happily export it — the source side is fine',
      exportable.ok, String(exportable.status))
    await exportable.body?.cancel().catch(() => {})
    const republish = await promote({ sourceEnvironment: SOURCE_ENV, revision: second })
    ok('the destination refuses it',
      republish.status === 409, `${republish.status} ${JSON.stringify(republish.body)}`)
    ok('and says the project already exists — not that the revision is wrong',
      /already exists/.test(republish.body?.error || ''), JSON.stringify(republish.body))
    const stillServed = join(destProjects, PROJECT, 'output', 'index.html')
    ok('the students still have week one',
      existsSync(stillServed) && readFileSync(stillServed, 'utf8') === '<h1>A Throwaway Course</h1>\n',
      existsSync(stillServed) ? readFileSync(stillServed, 'utf8') : '(no render on the destination)')
    console.log('       ^ the refusal above is the reason publishing has no interface:')
    console.log('         a caller for this endpoint works once per project and 409s forever after.')

    console.log(failures ? `\n${failures} failure(s)\n` : '\nall stories hold\n')
  } finally {
    child?.kill('SIGTERM')
    await new Promise(res => sourceServer ? sourceServer.close(res) : res())
    const { closeProjectStore } = await import('../server/lib/project-store.mjs')
    await closeProjectStore().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
  process.exit(failures ? 1 : 0)
  }
}
