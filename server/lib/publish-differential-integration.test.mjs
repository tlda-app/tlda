import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import express from 'express'

import { createDispatcherWithOptions } from './build-dispatch.mjs'
import { BuildQueueStore } from './build-queue-store.mjs'
import { assemblePreviewCopy, previewManifest, sendPreviewCopy } from './publish-copy.mjs'
import { closeProjectStore, createProject, initProjectStore, readProject, sourceLifecycleStore } from './project-store.mjs'
import { createPreviewCopyReceiver } from '../routes/preview-copy.mjs'

const repo = new URL('../..', import.meta.url).pathname
const configDir = join(repo, 'config/deployments/preview-store')
const distDir = join(repo, 'dist')

function outputTree(root, name, version, { deleted = false } = {}) {
  const project = join(root, `v${version}`, name)
  const output = join(project, 'output')
  const contentVersion = version === 3 ? 3 : 1
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'page.html'), `page ${contentVersion}`)
  writeFileSync(join(output, 'page-info.json'), '[]')
  writeFileSync(join(output, 'document-manifest.json'), JSON.stringify({ version: contentVersion, pages: [] }))
  if (!deleted) writeFileSync(join(output, 'obsolete.txt'), 'remove me')
  if (deleted) writeFileSync(join(output, 'added.txt'), 'new file')
  mkdirSync(join(project, 'source'), { recursive: true })
  writeFileSync(join(project, 'source', 'main.md'), `version ${version}`)
  return project
}

function deployPushSpy(root) {
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  const git = join(bin, 'git')
  writeFileSync(git, `#!/bin/sh
case "$*" in
  *push*|*receive-pack*|*pre-receive*) printf '%s\\n' "$*" >> "$TLDA_DEPLOY_SPY" ;;
esac
exec /usr/bin/git "$@"
`)
  chmodSync(git, 0o755)
  return { bin }
}

function publisherTransport(counters) {
  let handlers
  return {
    transport: {
      start(_job, nextHandlers) {
        handlers = nextHandlers
        return { cancel() {} }
      },
    },
    async publish(args) {
      counters.publishAttempts += 1
      const reply = await new Promise(resolve => handlers.onMessage(
        { t: 'rpc', id: counters.publishAttempts, m: 'publishBuildInstance', a: args },
        { send: resolve },
      ))
      if (reply.ok) counters.successfulPublishes += 1
      handlers.onMessage({ t: 'done', ok: reply.ok, error: reply.error })
      await handlers.onExit(reply.ok ? 0 : 1)
      return reply
    },
    counters,
  }
}

test('the publisher path has durable differential and no-deploy counterfactuals', async () => {
  assert.ok(existsSync(join(distDir, 'index.html')), 'run the client build before this integration test')
  const projectRoot = mkdtempSync(join(tmpdir(), 'tlda-publisher-integration-project-'))
  const instanceRoot = mkdtempSync(join(tmpdir(), 'tlda-publisher-integration-instances-'))
  const hostRoot = mkdtempSync(join(tmpdir(), 'tlda-publisher-integration-host-'))
  const staticDir = join(hostRoot, 'site')
  const spyRoot = mkdtempSync(join(tmpdir(), 'tlda-publisher-integration-spy-'))
  const deploySpy = join(spyRoot, 'deploy-pushes.log')
  const oldPath = process.env.PATH
  const oldEnv = { ...process.env }
  const name = 'course'
  const receiverLog = []
  let previewRequests = 0
  const app = express()
  app.use((req, _res, next) => {
    if (req.path === '/api/preview-copy' || req.path === '/api/preview-copy/manifest') previewRequests += 1
    next()
  })
  app.use(createPreviewCopyReceiver({
    staticDir,
    secret: 'shhh',
    isPeer: () => true,
    log: { log: line => receiverLog.push(line), warn: line => receiverLog.push(`WARN ${line}`) },
  }))
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const host = `http://127.0.0.1:${server.address().port}`

  try {
    const spy = deployPushSpy(spyRoot)
    Object.assign(process.env, {
      PATH: `${spy.bin}:${oldPath}`,
      TLDA_DEPLOY_SPY: deploySpy,
      TLDA_PREVIEW_PROJECT: name,
      TLDA_PREVIEW_DESTINATION: configDir,
      TLDA_PREVIEW_HOST: host,
      TLDA_PREVIEW_COPY_SECRET: 'shhh',
      TLDA_STATIC_DIR: staticDir,
    })
    await initProjectStore(projectRoot)
    createProject({ name, mainFile: 'main.md', format: 'markdown' })
    const lifecycle = await sourceLifecycleStore(name, { context: { referencedRoots: ['main.md'] } })
    const git = await lifecycle.gitRepository()
    const dispatcher = publisherTransport({ publishAttempts: 0, successfulPublishes: 0 })
    const queue = createDispatcherWithOptions(dispatcher.transport, { store: new BuildQueueStore(':memory:') })
    const document = { name, record: await readProject(name) }

    async function publish(version, parent, options = {}) {
      const revision = await git.acceptRevision({ project: name, parent, files: [{ path: 'main.md', content: `version ${version}` }], message: `version ${version}` })
      const project = options.missingOutput ? join(instanceRoot, `v${version}`, name) : outputTree(instanceRoot, name, version, options)
      if (options.missingOutput) {
        mkdirSync(join(project, 'source'), { recursive: true })
        writeFileSync(join(project, 'source', 'main.md'), `version ${version}`)
      }
      await queue.admitBuild(name, { revision, daemonId: 'integration', branch: 'main' })
      return { revision, project, reply: await dispatcher.publish([name, revision, version, project, [], null]) }
    }

    const first = await publish(1)
    assert.equal(first.reply.ok, true)
    const firstSource = join(mkdtempSync(join(tmpdir(), 'tlda-publisher-integration-stage-')), 'staging')
    await assemblePreviewCopy({ outputDir: join(first.project, 'output'), into: firstSource, distDir, configDir, document })
    assert.deepEqual(await previewManifest(staticDir), await previewManifest(firstSource), 'accepted revision serves the exact assembled source tree')
    assert.match(receiverLog.at(-1), /6 transferred/)
    assert.equal(readFileSync(join(staticDir, 'obsolete.txt'), 'utf8'), 'remove me')

    const second = await publish(2, first.revision)
    assert.equal(second.reply.ok, true)
    const secondSource = join(mkdtempSync(join(tmpdir(), 'tlda-publisher-integration-stage-')), 'staging')
    await assemblePreviewCopy({ outputDir: join(second.project, 'output'), into: secondSource, distDir, configDir, document })
    assert.deepEqual(await previewManifest(staticDir), await previewManifest(secondSource), 'unchanged revision keeps the exact tree')
    assert.match(receiverLog.at(-1), /0 transferred/)
    assert.equal(existsSync(deploySpy) ? readFileSync(deploySpy, 'utf8').trim() : '', '', 'an accepted course revision must not update an app/deploy ref')
    assert.equal(dispatcher.counters.publishAttempts, 2)
    assert.equal(previewRequests, 4, 'each successful publisher invocation asks for a manifest and sends one copy')

    const third = await publish(3, second.revision, { deleted: true })
    assert.equal(third.reply.ok, true)
    const thirdSource = join(mkdtempSync(join(tmpdir(), 'tlda-publisher-integration-stage-')), 'staging')
    await assemblePreviewCopy({ outputDir: join(third.project, 'output'), into: thirdSource, distDir, configDir, document })
    assert.deepEqual(await previewManifest(staticDir), await previewManifest(thirdSource), 'changed/add/delete revision serves the exact tree')
    assert.equal(existsSync(join(staticDir, 'obsolete.txt')), false)
    assert.equal(readFileSync(join(staticDir, 'added.txt'), 'utf8'), 'new file')
    assert.match(receiverLog.at(-1), /3 transferred/)
    assert.equal(dispatcher.counters.publishAttempts, 3)
    assert.equal(previewRequests, 6)

    const beforeCorrupt = await previewManifest(staticDir)
    await assert.rejects(
      () => sendPreviewCopy({
        from: thirdSource,
        url: `${host}/api/preview-copy`,
        secret: 'shhh',
        fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...init.headers, 'x-tlda-preview-copy-root': 'f'.repeat(64) } }),
      }),
      /400.*not ffffffffffff/s,
    )
    assert.deepEqual(await previewManifest(staticDir), beforeCorrupt, 'corrupt transfer does not switch the served tree')

    const interrupted = new Readable({ read() { this.push(Buffer.from('partial archive')); this.destroy(new Error('interrupted')) } })
    await assert.rejects(
      () => fetch(`${host}/api/preview-copy`, { method: 'POST', headers: { 'content-type': 'application/gzip', 'x-tlda-preview-copy': 'shhh' }, body: interrupted, duplex: 'half' }),
      /interrupted|fetch failed/s,
    )
    assert.deepEqual(await previewManifest(staticDir), beforeCorrupt, 'interrupted transfer does not switch the served tree')

    const beforeFailedRenderRequests = previewRequests
    const failed = await publish(4, third.revision, { missingOutput: true })
    assert.equal(failed.reply.ok, false)
    assert.match(failed.reply.error, /no output to publish/)
    assert.equal(await git.head(name), third.revision, 'failed render does not advance the published head')
    assert.equal(previewRequests, beforeFailedRenderRequests, 'failed render does not invoke preview delivery')
    assert.equal(dispatcher.counters.successfulPublishes, 3, 'failed render does not count as a successful publish')
  } finally {
    process.env.PATH = oldPath
    for (const key of Object.keys(process.env)) {
      if (!(key in oldEnv)) delete process.env[key]
    }
    Object.assign(process.env, oldEnv)
    await new Promise(resolve => server.close(resolve))
    await closeProjectStore()
    await rm(projectRoot, { recursive: true, force: true })
    await rm(instanceRoot, { recursive: true, force: true })
    await rm(hostRoot, { recursive: true, force: true })
    await rm(spyRoot, { recursive: true, force: true })
  }
})
