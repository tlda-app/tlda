#!/usr/bin/env node

import assert from 'assert/strict'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  diffSourceHashes,
  isSourceFilePath,
  normalizeSourceManifest,
  sourceFilesFromApiResponse,
} from '../shared/source-manifest.mjs'
import {
  createProject,
  beginProjectSourceTransaction,
  closeProjectStore,
  hashSourceFiles,
  initProjectStore,
  projectDir,
  readClientSourceManifest,
  readProject,
  readSourceFile,
  sourceLifecycleStore,
  sourceDir,
  updateProject,
  updateClientSourceManifest,
} from '../server/lib/project-store.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'
import { recoverProjectSourceTransactions, resumeOverleafPollers, syncOverleaf } from '../server/lib/overleaf-sync.mjs'
import { pushMcpSourceFiles } from '../mcp-server/source-push-orchestration.mjs'

function md5(value) {
  return createHash('md5').update(value).digest('hex')
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function bootstrapAuthority(name, manifest) {
  const result = sourceLifecycleStore(name).bootstrap({
    expectedRevision: null,
    sourceManifest: manifest,
    files: manifest.map(filePath => ({ path: filePath, content: readSourceFile(name, filePath) })),
  })
  assert.equal(result.ok, true)
  return result.authority.currentRevision
}

async function snapshotProject(name) {
  const dir = sourceDir(name)
  const files = {}
  function walk(current, prefix = '') {
    if (!fs.existsSync(current)) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full, rel)
      else files[rel] = fs.readFileSync(full).toString('base64')
    }
  }
  walk(dir)
  const projectFiles = {}
  function walkProject(current, prefix = '') {
    if (!fs.existsSync(current)) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (rel === '.source-transactions' || rel === 'overleaf-clone/.git') continue
      if (rel === '.source-lifecycle/revisions' || rel === '.source-lifecycle/evidence') continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walkProject(full, rel)
      else projectFiles[rel] = fs.readFileSync(full).toString('base64')
    }
  }
  walkProject(projectDir(name))
  return {
    project: readProject(name),
    files,
    projectFiles,
    manifest: await readClientSourceManifest(name),
  }
}

async function assertSnapshotEqual(name, before) {
  assert.deepEqual(await snapshotProject(name), before)
}

function assertProjectJsonHasNoClientManifest(name) {
  assert.equal(
    Object.prototype.hasOwnProperty.call(readProject(name), 'clientSourceManifest'),
    false,
    `${name} project.json must not store clientSourceManifest`,
  )
}

function assertProjectFilesDbPragmas(root) {
  const db = new Database(path.join(root, '..', 'data', 'project-files.sqlite'), { readonly: true })
  try {
    assert.equal(db.pragma('auto_vacuum', { simple: true }), 2, 'project-files DB must use INCREMENTAL auto_vacuum')
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal', 'project-files DB must use WAL')
    assert.equal(db.pragma('synchronous', { simple: true }), 1, 'project-files DB must use NORMAL synchronous mode')
    assert.equal(db.pragma('wal_autocheckpoint', { simple: true }), 1000, 'project-files DB must keep default WAL checkpoint target')
  } finally {
    db.close()
  }
  const projectStore = fs.readFileSync(path.join(process.cwd(), 'server/lib/project-files-store.worker.mjs'), 'utf8')
  assert.match(projectStore, /journal_size_limit = 67108864/, 'project-files DB connection must cap retained journal size')
}

function git(args, cwd, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim()
}

async function setupOverleafProject(root, name) {
  const remote = path.join(root, `${name}.git`)
  const seed = path.join(root, `${name}-seed`)
  fs.mkdirSync(seed, { recursive: true })
  git(['init'], seed)
  git(['config', 'user.email', 'test@example.invalid'], seed)
  git(['config', 'user.name', 'test'], seed)
  write(path.join(seed, 'main.tex'), 'old main\n')
  write(path.join(seed, 'notes.tex'), 'old notes\n')
  git(['add', 'main.tex', 'notes.tex'], seed)
  git(['commit', '-m', 'seed'], seed)
  git(['init', '--bare', remote], root)
  git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/master'], root)
  git(['remote', 'add', 'origin', remote], seed)
  git(['push', '-u', 'origin', 'HEAD:master'], seed)

  createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
  updateProject(name, { pages: 1, buildStatus: 'success', overleafRemote: remote, autoSync: true })
  write(path.join(sourceDir(name), 'main.tex'), 'old main\n')
  write(path.join(sourceDir(name), 'notes.tex'), 'old notes\n')
  await updateClientSourceManifest(name, ['main.tex', 'notes.tex'])
  const expectedRevision = bootstrapAuthority(name, ['main.tex', 'notes.tex'])

  const clone = path.join(projectDir(name), 'overleaf-clone')
  git(['clone', remote, clone], root)
  git(['config', 'user.email', 'test@example.invalid'], clone)
  git(['config', 'user.name', 'test'], clone)
  git(['config', 'tlda.testCredential', 'credential-must-not-leak'], clone)
  return { remote, expectedRevision }
}

function remoteFile(remote, filePath) {
  return git(['--git-dir', remote, 'show', `master:${filePath}`], process.cwd())
}

function remoteHasFile(remote, filePath) {
  try {
    remoteFile(remote, filePath)
    return true
  } catch {
    return false
  }
}

function snapshotRemote(remote) {
  const head = git(['--git-dir', remote, 'rev-parse', 'refs/heads/master'], process.cwd())
  const paths = git(['--git-dir', remote, 'ls-tree', '-r', '--name-only', head], process.cwd())
    .split('\n').filter(Boolean)
  return {
    head,
    files: Object.fromEntries(paths.map(filePath => [
      filePath,
      execFileSync('git', ['--git-dir', remote, 'show', `${head}:${filePath}`]).toString('base64'),
    ])),
  }
}

function advanceRemote(root, remote, { resetTo = null } = {}) {
  if (resetTo) git(['--git-dir', remote, 'update-ref', 'refs/heads/master', resetTo], root)
  const checkout = path.join(root, `third-party-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  git(['clone', remote, checkout], root)
  git(['config', 'user.email', 'third-party@example.invalid'], checkout)
  git(['config', 'user.name', 'third party'], checkout)
  write(path.join(checkout, 'third-party.tex'), 'third party work\n')
  git(['add', 'third-party.tex'], checkout)
  git(['commit', '-m', 'third party advance'], checkout)
  git(['push', 'origin', 'HEAD:master'], checkout)
}

function assertPushSuppliersCarryManifest() {
  const checks = [
    ['cli/tlda.mjs', line => line.includes('/push') && line.includes('files')],
    ['cli/lib/watcher.mjs', line => line.includes('/push')],
    ['daemon/source-sync.mjs', line => line.includes("type: 'source-change'")],
    ['server/unified-server.mjs', line => line.includes('processProjectPush(project')],
    ['server/lib/overleaf-sync.mjs', line => line.includes('processProjectPush(name')],
    ['mcp-server/fleet-tools.mjs', line => line.includes('/push')],
    ['mcp-server/source-push-orchestration.mjs', line => line.includes('/push')],
    ['mcp-server/index.mjs', line => line.includes('/push')],
    ['src/panels/TocTab.tsx', line => line.includes('/push')],
    ['src/shapes/FleetPillShape.tsx', line => line.includes('/push')],
    ['src/shapes/MathNoteShape.tsx', line => line.includes('/push')],
  ]
  for (const [file, isSupplierLine] of checks) {
    const lines = fs.readFileSync(path.join(process.cwd(), file), 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!isSupplierLine(lines[i])) continue
      const snippet = lines.slice(i, i + 16).join('\n')
      if (snippet.includes('files: []') && snippet.includes('members')) continue
      assert.match(snippet, /sourceManifest/, `${file} file-push supplier missing sourceManifest:\n${snippet}`)
      if (lines[i].includes('/push')) {
        assert.match(snippet, /expectedRevision/, `${file} source-mutation supplier missing expectedRevision:\n${snippet}`)
      }
    }
  }
}

function assertDaemonBootstrapSeparatesOwnershipFromBytePayload() {
  const source = fs.readFileSync(path.join(process.cwd(), 'daemon/source-sync.mjs'), 'utf8')
  const start = source.indexOf('function pushWatchedFiles')
  const end = source.indexOf('const _pendingSourceProjects', start)
  assert.ok(start >= 0 && end > start, 'pushWatchedFiles not found')
  const fn = source.slice(start, end)
  assert.match(fn, /let uploadPaths = new Set\(\)/, 'daemon bootstrap must compute the byte-bearing upload inventory')
  assert.match(fn, /sourceManifest = collectSourceManifest\([\s\S]*uploadPaths[\s\S]*authorityManifest/, 'daemon sourceManifest must preserve inherited ownership around the upload inventory')
  assert.match(fn, /for \(const rel of normalizeSourceManifest\(\[\.\.\.uploadPaths\]/, 'daemon files must contain only byte-bearing upload paths')
  assert.doesNotMatch(fn, /for \(const rel of sourceManifest\)/, 'daemon must not resend every inherited ownership path as a file body')
  assert.doesNotMatch(fn, /new Set\(\[\.\.\.watchSet,[\s\S]*mainFile/, 'daemon markdown manifest must not derive from watchSet + mainFile')
}

function assertPutRequiresCallerManifest() {
  const routeSource = fs.readFileSync(path.join(process.cwd(), 'server/routes/projects.mjs'), 'utf8')
  const routeStart = routeSource.indexOf("router.put('/:name/source/:file'")
  const routeEnd = routeSource.indexOf("router.post('/:name/synctex-path'", routeStart)
  assert.ok(routeStart >= 0 && routeEnd > routeStart, 'source PUT route not found')
  const putRoute = routeSource.slice(routeStart, routeEnd)
  assert.match(putRoute, /sourceManifest:\s*req\.body\?\.sourceManifest/, 'source PUT route must use caller-supplied manifest')
  assert.doesNotMatch(putRoute, /readClientSourceManifest|\.\.\.new Set/, 'source PUT route must not synthesize ownership from server state')

  const callerSource = fs.readFileSync(path.join(process.cwd(), 'src/shapes/FleetSourceEditorShape.tsx'), 'utf8')
  const writeStart = callerSource.indexOf('const writeSourceFile = async')
  const writeEnd = callerSource.indexOf('const trackedAnchorStatusText', writeStart)
  assert.ok(writeStart >= 0 && writeEnd > writeStart, 'fleet source editor writeSourceFile not found')
  const writeSource = callerSource.slice(writeStart, writeEnd)
  assert.match(writeSource, /sourceManifest/, 'fleet source editor PUT caller must send sourceManifest')
  assert.match(writeSource, /expectedRevision/, 'fleet source editor PUT caller must send expectedRevision')
  assert.doesNotMatch(writeSource, /\/source-authority/, 'fleet source editor must not refresh authority immediately before overwriting a loaded buffer')
  assert.match(writeSource, /loadSourceFiles\(\)/, 'fleet source editor PUT caller must base manifest on current client inventory')
  assert.match(callerSource, /X-TLDA-Source-Revision/, 'fleet source editor load must retain the revision served with its source bytes')
  assert.match(writeSource, /expectedRevision,\s*\n/, 'fleet source editor PUT must send the caller buffer revision')
}

function assertMcpCallersCarryManifest() {
  const reportDocPost = fs.readFileSync(path.join(process.cwd(), 'mcp-server/report-doc-post.mjs'), 'utf8')
  assert.match(reportDocPost, /sourceManifest:\s*normalizeSourceManifest\(\[mainFile\]/, 'MCP report sharing must send sourceManifest')
  const index = fs.readFileSync(path.join(process.cwd(), 'mcp-server/index.mjs'), 'utf8')
  const pushStart = index.indexOf("if (name === 'push')")
  const pushEnd = index.indexOf('// Shadow-branch commit', pushStart)
  assert.ok(pushStart >= 0 && pushEnd > pushStart, 'MCP push handler not found')
  const pushHandler = index.slice(pushStart, pushEnd)
  assert.match(pushHandler, /pushMcpSourceFiles\(\{ project, files, session: process\.env\.CLAUDE_SESSION, serverFetch \}\)/, 'MCP push handler must use tested source push orchestration')
  assert.doesNotMatch(pushHandler, /catch\s*\{[^}]*\}/, 'MCP push must fail closed if current authored inventory cannot be read')
}

async function assertMcpPushOrchestrationBehavior() {
  const current = sourceFilesFromApiResponse({ files: ['main.tex', 'notes.tex'] })
  const pushed = ['main.tex', 'extra.tex']
  assert.deepEqual(
    normalizeSourceManifest([...current, ...pushed], { format: 'svg', mainFile: 'main.tex' }),
    ['extra.tex', 'main.tex', 'notes.tex'],
  )
  assert.throws(() => sourceFilesFromApiResponse(['main.tex']), /files array/)
  assert.throws(() => sourceFilesFromApiResponse({ files: 'main.tex' }), /files array/)
  assert.throws(() => sourceFilesFromApiResponse({ files: ['main.tex', 1] }), /files array/)

  const files = [
    { path: 'main.tex', content: 'new main\n' },
    { path: 'extra.tex', content: 'extra\n' },
  ]
  const calls = []
  await pushMcpSourceFiles({
    project: 'mcp-project',
    files,
    session: 'session-1',
    serverFetch: async (urlPath, options) => {
      calls.push({ urlPath, options })
      if (urlPath === '/api/projects/mcp-project') return { format: 'svg', mainFile: 'main.tex' }
      if (urlPath === '/api/projects/mcp-project/files') return { files: ['main.tex', 'notes.tex'] }
      if (urlPath === '/api/projects/mcp-project/source-authority') return { currentRevision: 'revision-1' }
      if (urlPath === '/api/projects/mcp-project/push') return { ok: true }
      throw new Error(`unexpected fetch ${urlPath}`)
    },
  })
  assert.deepEqual(calls.map(call => call.urlPath), [
    '/api/projects/mcp-project',
    '/api/projects/mcp-project/files',
    '/api/projects/mcp-project/source-authority',
    '/api/projects/mcp-project/push',
  ])
  const pushBody = JSON.parse(calls[3].options.body)
  assert.deepEqual(pushBody.files, files)
  assert.deepEqual(pushBody.sourceManifest, ['extra.tex', 'main.tex', 'notes.tex'])
  assert.equal(pushBody.session, 'session-1')
  assert.equal(pushBody.expectedRevision, 'revision-1')

  for (const filesResponse of [
    Promise.reject(new Error('files failed')),
    { files: 'main.tex' },
    { files: ['main.tex', 1] },
  ]) {
    const failedCalls = []
    await assert.rejects(
      () => pushMcpSourceFiles({
        project: 'mcp-project',
        files,
        session: 'session-1',
        serverFetch: async (urlPath, options) => {
          failedCalls.push({ urlPath, options })
          if (urlPath === '/api/projects/mcp-project') return { format: 'svg', mainFile: 'main.tex' }
          if (urlPath === '/api/projects/mcp-project/files') return filesResponse
          if (urlPath === '/api/projects/mcp-project/source-authority') return { currentRevision: 'revision-1' }
          if (urlPath === '/api/projects/mcp-project/push') return { ok: true }
          throw new Error(`unexpected fetch ${urlPath}`)
        },
      }),
      /files failed|files array/,
    )
    assert.equal(failedCalls.some(call => call.urlPath === '/api/projects/mcp-project/push'), false)
  }
}

function assertInitCreatesOnlyRequestedMainFile() {
  const source = fs.readFileSync(path.join(process.cwd(), 'cli/tlda.mjs'), 'utf8')
  const initStart = source.indexOf('async function cmdInit')
  const initEnd = source.indexOf('// Fleet-daemon control:', initStart)
  assert.ok(initStart >= 0 && initEnd > initStart, 'cmdInit not found')
  const initSource = source.slice(initStart, initEnd)
  assert.match(initSource, /writeFileSync\(join\(targetDir,\s*mainFile\)/, 'project init must create the requested main file')
  assert.doesNotMatch(initSource, /writeFileSync\(join\(targetDir,\s*['"]README\.md['"]/, 'project init must not seed README.md')
  assert.doesNotMatch(initSource, /git',\s*\['add',\s*mainFile,\s*['"]README\.md['"]/, 'project init must not commit README.md')
  assert.match(initSource, /sourceManifestForFiles\(files,\s*\{\s*format:\s*'svg',\s*mainFile\s*\}\)/, 'LaTeX init must declare the requested main file')
  assert.match(initSource, /sourceManifestForFiles\(files,\s*\{\s*format:\s*'markdown',\s*mainFile\s*\}\)/, 'Markdown init must declare the requested main file')
  assert.match(initSource, /sourceManifestForFiles\(files,\s*\{\s*format:\s*'html',\s*mainFile\s*\}\)/, 'HTML init must declare the requested main file')
}

async function main() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-source-manifest-'))
    await initProjectStore(root)
    assertProjectFilesDbPragmas(root)
  try {
    assert.equal(isSourceFilePath('main.synctex.gz', { mainFile: 'main.tex' }), false)
    assert.equal(isSourceFilePath('main.run.xml', { mainFile: 'main.tex' }), false)
    assert.equal(isSourceFilePath('main.fdb_latexmk', { mainFile: 'main.tex' }), false)
    assertPushSuppliersCarryManifest()
    assertDaemonBootstrapSeparatesOwnershipFromBytePayload()
    assertPutRequiresCallerManifest()
    assertMcpCallersCarryManifest()
    await assertMcpPushOrchestrationBehavior()
    assertInitCreatesOnlyRequestedMainFile()

    createProject({ name: 'latex-project', title: 'Latex', mainFile: 'main.tex', format: 'svg' })
    updateProject('latex-project', { pages: 1, buildStatus: 'success' })
    assert.deepEqual(fs.readdirSync(sourceDir('latex-project')), [], 'Project creation must not invent source files')
    write(path.join(sourceDir('latex-project'), 'README.md'), '# legacy unowned file\n')
    write(path.join(sourceDir('latex-project'), 'main.synctex.gz'), 'generated\n')
    assert.deepEqual(await hashSourceFiles('latex-project'), {})

    let result = await processProjectPush('latex-project', {
      expectedRevision: null,
      files: [{ path: 'main.tex', content: 'hello\n' }],
      sourceManifest: ['main.tex'],
    })
    assert.equal(result.ok, true)
    let expectedRevision = result.sourceRevision
    assert.deepEqual(await readClientSourceManifest('latex-project'), ['main.tex'])
    assertProjectJsonHasNoClientManifest('latex-project')
    assert.deepEqual(Object.keys(await hashSourceFiles('latex-project')).sort(), ['main.tex'])
    updateProject('latex-project', {
      members: ['original-member'],
      sourceDir: '/tmp/original-source',
      session: 'original-session',
      sessionAt: 42,
      lastEditedBy: 'original-editor',
      lastEditedByAt: 43,
    })
    assertProjectJsonHasNoClientManifest('latex-project')

    const legacyDir = path.join(root, 'legacy-json')
    fs.mkdirSync(path.join(legacyDir, 'source'), { recursive: true })
    fs.mkdirSync(path.join(legacyDir, 'output'), { recursive: true })
    write(path.join(legacyDir, 'source', 'main.tex'), 'legacy main\n')
    write(path.join(legacyDir, 'source', 'notes.tex'), 'legacy notes\n')
    fs.writeFileSync(path.join(legacyDir, 'project.json'), JSON.stringify({
      name: 'legacy-json',
      title: 'Legacy JSON',
      mainFile: 'main.tex',
      format: 'svg',
      pages: 1,
      buildStatus: 'success',
      clientSourceManifest: ['notes.tex', 'main.tex'],
    }, null, 2))
    await initProjectStore(root)
    assert.deepEqual(await readClientSourceManifest('legacy-json'), ['main.tex', 'notes.tex'])
    assertProjectJsonHasNoClientManifest('legacy-json')
    assert.deepEqual(Object.keys(await hashSourceFiles('legacy-json')).sort(), ['main.tex', 'notes.tex'])

    let beforeRejected = await snapshotProject('latex-project')
    result = await processProjectPush('latex-project', {
      expectedRevision,
      files: [{ path: 'notes.tex', content: 'notes\n' }],
      sourceDir: '/tmp/should-not-stick',
      session: 'bad-session',
      sessionAt: 123,
      editedBy: 'bad-editor',
      members: ['should-not-stick'],
    })
    assert.equal(result.status, 400)
    await assertSnapshotEqual('latex-project', beforeRejected)

    beforeRejected = await snapshotProject('latex-project')
    result = await processProjectPush('latex-project', {
      files: [{ path: 'notes.tex', content: 'notes\n' }],
      sourceManifest: ['main.tex'],
      sourceDir: '/tmp/should-not-stick',
      session: 'bad-session',
      sessionAt: 123,
      editedBy: 'bad-editor',
      members: ['should-not-stick'],
    })
    assert.equal(result.status, 400)
    await assertSnapshotEqual('latex-project', beforeRejected)

    beforeRejected = await snapshotProject('latex-project')
    result = await processProjectPush('latex-project', {
      files: [{ path: 'notes.tex', content: 'notes\n' }],
      sourceManifest: ['notes.tex'],
      sourceDir: '/tmp/should-not-stick',
      session: 'bad-session',
      sessionAt: 123,
      editedBy: 'bad-editor',
      members: ['should-not-stick'],
    })
    assert.equal(result.status, 400)
    assert.match(result.error, /missing surviving authored file/)
    await assertSnapshotEqual('latex-project', beforeRejected)

    beforeRejected = await snapshotProject('latex-project')
    result = await processProjectPush('latex-project', {
      files: [{ path: 'main.tex', content: 'edited through PUT\n' }],
      sourceManifest: ['notes.tex'],
      editedBy: 'put-editor',
      members: ['should-not-stick'],
    })
    assert.equal(result.status, 400)
    await assertSnapshotEqual('latex-project', beforeRejected)

    beforeRejected = await snapshotProject('latex-project')
    result = await processProjectPush('latex-project', {
      files: [],
      sourceManifest: ['../escape.tex'],
      sourceDir: '/tmp/should-not-stick',
      session: 'bad-session',
      sessionAt: 123,
      editedBy: 'bad-editor',
      members: ['should-not-stick'],
    })
    assert.equal(result.status, 400)
    await assertSnapshotEqual('latex-project', beforeRejected)

    beforeRejected = await snapshotProject('latex-project')
    result = await processProjectPush('latex-project', {
      files: [{ path: 'main.tex', content: 'mixed escape\n' }],
      sourceManifest: ['main.tex', '../escape.tex'],
      sourceDir: '/tmp/should-not-stick',
      session: 'bad-session',
      sessionAt: 123,
      editedBy: 'bad-editor',
      members: ['should-not-stick'],
    })
    assert.equal(result.status, 400)
    await assertSnapshotEqual('latex-project', beforeRejected)

    beforeRejected = await snapshotProject('latex-project')
    result = await processProjectPush('latex-project', {
      files: [],
      sourceManifest: ['main.tex', 'missing.tex'],
      sourceDir: '/tmp/should-not-stick',
      session: 'bad-session',
      sessionAt: 123,
      editedBy: 'bad-editor',
      members: ['should-not-stick'],
    })
    assert.equal(result.status, 400)
    assert.match(result.error, /nonexistent authored file/)
    await assertSnapshotEqual('latex-project', beforeRejected)

    beforeRejected = await snapshotProject('latex-project')
    result = await processProjectPush('latex-project', {
      files: [],
      deletedFiles: ['main.tex'],
      sourceManifest: ['main.tex'],
      sourceDir: '/tmp/should-not-stick',
      session: 'bad-session',
      sessionAt: 123,
      editedBy: 'bad-editor',
      members: ['should-not-stick'],
    })
    assert.equal(result.status, 400)
    await assertSnapshotEqual('latex-project', beforeRejected)

    result = await processProjectPush('latex-project', {
      expectedRevision,
      files: [{ path: 'notes.tex', content: 'notes\n' }],
      deletedFiles: ['main.tex'],
      sourceManifest: ['notes.tex'],
    })
    assert.equal(result.ok, true)
    expectedRevision = result.sourceRevision
    assert.equal(readSourceFile('latex-project', 'main.tex'), null)
    assert.equal(readSourceFile('latex-project', 'notes.tex'), 'notes\n')
    assert.deepEqual(await readClientSourceManifest('latex-project'), ['notes.tex'])
    assertProjectJsonHasNoClientManifest('latex-project')

    result = await processProjectPush('latex-project', {
      expectedRevision,
      files: [{ path: 'main.tex', content: 'hello again\n' }],
      deletedFiles: ['notes.tex'],
      sourceManifest: ['main.tex'],
    })
    assert.equal(result.ok, true)
    expectedRevision = result.sourceRevision
    assert.equal(readSourceFile('latex-project', 'notes.tex'), null)
    assert.deepEqual(await readClientSourceManifest('latex-project'), ['main.tex'])
    assertProjectJsonHasNoClientManifest('latex-project')

    for (const [failAt, body] of [
      ['write:2', {
        files: [
          { path: 'main.tex', content: 'first write\n' },
          { path: 'extra.tex', content: 'second write\n' },
        ],
        sourceManifest: ['extra.tex', 'main.tex'],
      }],
      ['delete:1', {
        files: [], deletedFiles: ['main.tex'], sourceManifest: [],
      }],
      ['manifest', {
        files: [{ path: 'main.tex', content: 'manifest failure\n' }],
        sourceManifest: ['main.tex'],
      }],
    ]) {
      beforeRejected = await snapshotProject('latex-project')
      result = await processProjectPush('latex-project', { expectedRevision, ...body }, { failAt })
      assert.equal(result.status, 409)
      await assertSnapshotEqual('latex-project', beforeRejected)
    }

    result = await processProjectPush('latex-project', {
      expectedRevision,
      files: [],
      deletedFiles: ['README.md', 'main.synctex.gz'],
      sourceManifest: ['main.tex'],
    })
    assert.equal(result.ok, true)
    assert.equal(fs.existsSync(path.join(sourceDir('latex-project'), 'README.md')), true)
    assert.equal(fs.existsSync(path.join(sourceDir('latex-project'), 'main.synctex.gz')), true)
    assert.deepEqual(await readClientSourceManifest('latex-project'), ['main.tex'])

    result = await processProjectPush('latex-project', {
      files: [],
      sourceManifest: ['main.tex'],
    })
    assert.equal(result.ok, true)
    assert.deepEqual(await readClientSourceManifest('latex-project'), ['main.tex'])

    createProject({ name: 'overleaf-fail', title: 'Overleaf Fail', mainFile: 'main.tex', format: 'svg' })
    updateProject('overleaf-fail', {
      pages: 1,
      buildStatus: 'success',
      overleafRemote: 'https://example.invalid/repo.git',
      autoSync: true,
      members: ['original-member'],
      sourceDir: '/tmp/original-source',
      session: 'original-session',
      sessionAt: 42,
      lastEditedBy: 'original-editor',
      lastEditedByAt: 43,
    })
    write(path.join(sourceDir('overleaf-fail'), 'main.tex'), 'old main\n')
    write(path.join(sourceDir('overleaf-fail'), 'notes.tex'), 'old notes\n')
    await updateClientSourceManifest('overleaf-fail', ['main.tex', 'notes.tex'])
    const overleafFailRevision = bootstrapAuthority('overleaf-fail', ['main.tex', 'notes.tex'])

    const originalConsoleError = console.error
    console.error = (...args) => {
      if (String(args[0] || '').includes('[overleaf-fail] Git sync failed:')) return
      originalConsoleError(...args)
    }
    for (const body of [
      {
        files: [{ path: 'main.tex', content: 'new main\n' }],
        sourceManifest: ['main.tex', 'notes.tex'],
      },
      {
        files: [],
        deletedFiles: ['notes.tex'],
        sourceManifest: ['main.tex'],
      },
      {
        files: [{ path: 'main.tex', content: 'new main\n' }, { path: 'extra.tex', content: 'extra\n' }],
        deletedFiles: ['notes.tex'],
        sourceManifest: ['extra.tex', 'main.tex'],
      },
      {
        files: [{ path: 'extra.tex', content: 'extra\n' }],
        sourceManifest: ['extra.tex', 'main.tex', 'notes.tex'],
      },
    ]) {
      beforeRejected = await snapshotProject('overleaf-fail')
      result = await processProjectPush('overleaf-fail', {
        expectedRevision: overleafFailRevision,
        ...body,
        sourceDir: '/tmp/should-not-stick',
        session: 'bad-session',
        sessionAt: 123,
        editedBy: 'bad-editor',
        members: ['should-not-stick'],
      })
      assert.equal(result.status, 409)
      await assertSnapshotEqual('overleaf-fail', beforeRejected)
      assert.equal(fs.existsSync(path.join(projectDir('overleaf-fail'), 'source.stamp')), false)
    }
    console.error = originalConsoleError

    let positive = await setupOverleafProject(root, 'overleaf-write')
    result = await processProjectPush('overleaf-write', {
      expectedRevision: positive.expectedRevision,
      files: [{ path: 'main.tex', content: 'remote new main\n' }],
      sourceManifest: ['main.tex', 'notes.tex'],
    })
    assert.equal(result.status, 200)
    assert.equal(remoteFile(positive.remote, 'main.tex'), 'remote new main')
    assert.equal(remoteFile(positive.remote, 'notes.tex'), 'old notes')
    const successRecoveryRoot = path.join(projectDir('overleaf-write'), '.source-transactions')
    assert.equal(fs.existsSync(successRecoveryRoot) && fs.readdirSync(successRecoveryRoot).length > 0, false,
      'successful publish must immediately remove its snapshot and journal')

    positive = await setupOverleafProject(root, 'overleaf-crash-after-publish')
    result = await processProjectPush('overleaf-crash-after-publish', {
      expectedRevision: positive.expectedRevision,
      files: [{ path: 'main.tex', content: 'published before simulated crash\n' }],
      sourceManifest: ['main.tex', 'notes.tex'],
    }, { simulateCrashAfterPublish: true })
    assert.equal(result.simulatedCrash, true)
    const crashRecoveryRoot = path.join(projectDir('overleaf-crash-after-publish'), '.source-transactions', result.recovery.id)
    assert.equal(fs.existsSync(crashRecoveryRoot), true)
    assert.equal(
      fs.readdirSync(crashRecoveryRoot, { recursive: true })
        .filter(entry => fs.statSync(path.join(crashRecoveryRoot, entry)).isFile())
        .some(entry => fs.readFileSync(path.join(crashRecoveryRoot, entry)).includes('credential-must-not-leak')),
      false,
    )
    advanceRemote(root, positive.remote)
    await initProjectStore(root)
    assert.deepEqual(await recoverProjectSourceTransactions('overleaf-crash-after-publish'), [
      { id: result.recovery.id, state: 'committed-cleaned' },
    ], 'recovery must accept a later legitimate commit descending from the published head')
    assert.equal(fs.existsSync(crashRecoveryRoot), false)

    positive = await setupOverleafProject(root, 'overleaf-delete')
    result = await processProjectPush('overleaf-delete', {
      expectedRevision: positive.expectedRevision,
      files: [],
      deletedFiles: ['notes.tex'],
      sourceManifest: ['main.tex'],
    })
    assert.equal(result.status, 200)
    assert.equal(remoteFile(positive.remote, 'main.tex'), 'old main')
    assert.equal(remoteHasFile(positive.remote, 'notes.tex'), false)

    positive = await setupOverleafProject(root, 'overleaf-mixed')
    result = await processProjectPush('overleaf-mixed', {
      expectedRevision: positive.expectedRevision,
      files: [{ path: 'main.tex', content: 'remote mixed main\n' }, { path: 'extra.tex', content: 'remote extra\n' }],
      deletedFiles: ['notes.tex'],
      sourceManifest: ['extra.tex', 'main.tex'],
    })
    assert.equal(result.status, 200)
    assert.equal(remoteFile(positive.remote, 'main.tex'), 'remote mixed main')
    assert.equal(remoteFile(positive.remote, 'extra.tex'), 'remote extra')
    assert.equal(remoteHasFile(positive.remote, 'notes.tex'), false)

    positive = await setupOverleafProject(root, 'overleaf-after-remote')
    beforeRejected = await snapshotProject('overleaf-after-remote')
    const beforeRemote = snapshotRemote(positive.remote)
    result = await processProjectPush('overleaf-after-remote', {
      expectedRevision: positive.expectedRevision,
      files: [
        { path: 'main.tex', content: 'must roll back locally and remotely\n' },
        { path: 'extra.tex', content: 'must not survive\n' },
      ],
      deletedFiles: ['notes.tex'],
      sourceManifest: ['extra.tex', 'main.tex'],
    }, { failAt: 'after-remote' })
    assert.equal(result.status, 409)
    await assertSnapshotEqual('overleaf-after-remote', beforeRejected)
    assert.deepEqual(snapshotRemote(positive.remote), beforeRemote)

    positive = await setupOverleafProject(root, 'overleaf-compensation-race')
    const priorRemoteHead = snapshotRemote(positive.remote).head
    result = await processProjectPush('overleaf-compensation-race', {
      expectedRevision: positive.expectedRevision,
      files: [{ path: 'main.tex', content: 'locally committed before remote race\n' }],
      sourceManifest: ['main.tex', 'notes.tex'],
    }, {
      afterRemotePublished: async () => {
        advanceRemote(root, positive.remote, { resetTo: priorRemoteHead })
        throw new Error('Injected failure after third-party remote advance')
      },
    })
    assert.equal(result.status, 409)
    assert.equal(result.recoveryRequired, true)
    assert.equal(readSourceFile('overleaf-compensation-race', 'main.tex'), 'locally committed before remote race\n')
    assert.deepEqual(await readClientSourceManifest('overleaf-compensation-race'), ['main.tex', 'notes.tex'])
    assert.equal(remoteFile(positive.remote, 'main.tex'), 'old main')
    assert.equal(remoteFile(positive.remote, 'third-party.tex'), 'third party work')
    assert.deepEqual(Object.keys(result.recovery).sort(), ['id', 'state'])
    assert.equal(result.recovery.state, 'publish-pending')
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const recoveryRoot = path.join(projectDir('overleaf-compensation-race'), '.source-transactions', result.recovery.id)
    const journal = JSON.parse(fs.readFileSync(path.join(recoveryRoot, 'recovery.json'), 'utf8'))
    assert.equal(journal.state, 'publish-pending')
    assert.equal(journal.previousRemoteHead, priorRemoteHead)
    assert.equal(journal.proposedRemoteHead, readProject('overleaf-compensation-race').overleafHead)
    assert.equal(fs.existsSync(path.join(recoveryRoot, 'overleaf-worktree', '.git')), false)
    assert.equal(
      fs.readdirSync(recoveryRoot, { recursive: true })
        .filter(entry => fs.statSync(path.join(recoveryRoot, entry)).isFile())
        .some(entry => fs.readFileSync(path.join(recoveryRoot, entry)).includes('credential-must-not-leak')),
      false,
    )
    await initProjectStore(root)
    const rebootRecovery = await recoverProjectSourceTransactions('overleaf-compensation-race')
    assert.equal(rebootRecovery.length, 1)
    assert.equal(rebootRecovery[0].id, result.recovery.id)
    assert.equal(rebootRecovery[0].state, 'recovery-required')
    assert.deepEqual(Object.keys(rebootRecovery[0]).sort(), ['id', 'state'],
      'external recovery status must never expose remote commit heads or internal reasons')
    assert.equal(fs.existsSync(recoveryRoot), true, 'unresolved recovery must survive restart cleanup')

    createProject({ name: 'journal-crash', title: 'Journal crash', mainFile: 'main.tex', format: 'svg' })
    updateProject('journal-crash', { pages: 1, buildStatus: 'success' })
    write(path.join(sourceDir('journal-crash'), 'main.tex'), 'unchanged\n')
    await updateClientSourceManifest('journal-crash', ['main.tex'])
    const journalCrashRevision = bootstrapAuthority('journal-crash', ['main.tex'])
    beforeRejected = await snapshotProject('journal-crash')
    result = await processProjectPush('journal-crash', {
      expectedRevision: journalCrashRevision,
      files: [{ path: 'main.tex', content: 'must not write\n' }],
      sourceManifest: ['main.tex'],
    }, { failAt: 'journal-write' })
    assert.equal(result.status, 409)
    await assertSnapshotEqual('journal-crash', beforeRejected)
    await initProjectStore(root)
    assert.equal((await recoverProjectSourceTransactions('journal-crash'))[0].state, 'incomplete-journal-cleaned')

    createProject({ name: 'snapshot-ready-crash', title: 'Snapshot ready crash', mainFile: 'main.tex', format: 'svg' })
    updateProject('snapshot-ready-crash', { pages: 1, buildStatus: 'success' })
    write(path.join(sourceDir('snapshot-ready-crash'), 'main.tex'), 'unchanged\n')
    await updateClientSourceManifest('snapshot-ready-crash', ['main.tex'])
    const snapshotReadyRevision = bootstrapAuthority('snapshot-ready-crash', ['main.tex'])
    beforeRejected = await snapshotProject('snapshot-ready-crash')
    const durabilitySteps = []
    result = await processProjectPush('snapshot-ready-crash', {
      expectedRevision: snapshotReadyRevision,
      files: [{ path: 'main.tex', content: 'must not write\n' }],
      sourceManifest: ['main.tex'],
    }, {
      simulateCrashAfterJournal: true,
      durabilityProbe: label => durabilitySteps.push(label),
    })
    assert.equal(result.simulatedCrash, true)
    assert.equal(result.recovery.state, 'snapshot-ready')
    await assertSnapshotEqual('snapshot-ready-crash', beforeRejected)
    assert.equal(durabilitySteps.includes('snapshot-file'), true)
    assert.equal(durabilitySteps.includes('snapshot-directory'), true)
    assert.equal(durabilitySteps.includes('journal-temp-file'), true)
    assert.equal(durabilitySteps.includes('journal-file'), true)
    assert.equal(durabilitySteps.includes('journal-directory'), true)
    assert.equal(durabilitySteps.filter(step => step === 'transaction-parent-directory').length >= 2, true)
    assert.equal(durabilitySteps.filter(step => step === 'project-directory').length >= 2, true)
    assert.equal(durabilitySteps.lastIndexOf('snapshot-directory') < durabilitySteps.indexOf('journal-temp-file'), true)
    assert.equal(durabilitySteps.indexOf('journal-temp-file') < durabilitySteps.indexOf('journal-file'), true)
    assert.equal(durabilitySteps.indexOf('journal-file') < durabilitySteps.indexOf('journal-directory'), true)
    assert.equal(durabilitySteps.indexOf('journal-directory') < durabilitySteps.lastIndexOf('project-directory'), true)
    await initProjectStore(root)
    assert.deepEqual(await recoverProjectSourceTransactions('snapshot-ready-crash'), [
      { id: result.recovery.id, state: 'snapshot-rolled-back-cleaned' },
    ], 'startup recovery must clean a durable pre-mutation snapshot for a non-Overleaf project')
    await assertSnapshotEqual('snapshot-ready-crash', beforeRejected)

    createProject({ name: 'manifest-row-recovery', title: 'Manifest row recovery', mainFile: 'main.tex', format: 'svg' })
    updateProject('manifest-row-recovery', { pages: 1, buildStatus: 'success' })
    write(path.join(sourceDir('manifest-row-recovery'), 'main.tex'), 'original\n')
    await updateClientSourceManifest('manifest-row-recovery', ['main.tex'])
    beforeRejected = await snapshotProject('manifest-row-recovery')
    const manifestTransaction = await beginProjectSourceTransaction('manifest-row-recovery')
    write(path.join(sourceDir('manifest-row-recovery'), 'notes.tex'), 'crashed write\n')
    await updateClientSourceManifest('manifest-row-recovery', ['notes.tex'])
    assert.deepEqual(await readClientSourceManifest('manifest-row-recovery'), ['notes.tex'])
    await initProjectStore(root)
    assert.deepEqual(await recoverProjectSourceTransactions('manifest-row-recovery'), [
      { id: manifestTransaction.identity().id, state: 'snapshot-rolled-back-cleaned' },
    ], 'startup recovery must restore manifest table rows from the source transaction snapshot')
    await assertSnapshotEqual('manifest-row-recovery', beforeRejected)

    positive = await setupOverleafProject(root, 'clone-restore-fail')
    beforeRejected = await snapshotProject('clone-restore-fail')
    result = await processProjectPush('clone-restore-fail', {
      expectedRevision: positive.expectedRevision,
      files: [{ path: 'main.tex', content: 'must roll back despite clone restore failure\n' }],
      sourceManifest: ['main.tex', 'notes.tex'],
    }, { failAt: 'clone-restore' })
    assert.equal(result.status, 409)
    assert.match(result.rollbackFailures.join('\n'), /clone restore failed/)
    await assertSnapshotEqual('clone-restore-fail', beforeRejected)

    positive = await setupOverleafProject(root, 'poll-push-serialization')
    const order = []
    let releasePoll
    let pollEntered
    const pollEnteredPromise = new Promise(resolve => { pollEntered = resolve })
    const pollGate = new Promise(resolve => { releasePoll = resolve })
    const poll = syncOverleaf('poll-push-serialization', {
      testHooks: { afterLock: async () => { order.push('poll-enter'); pollEntered(); await pollGate; order.push('poll-exit') } },
    })
    await pollEnteredPromise
    const push = processProjectPush('poll-push-serialization', {
      expectedRevision: positive.expectedRevision,
      files: [{ path: 'main.tex', content: 'serialized push\n' }],
      sourceManifest: ['main.tex', 'notes.tex'],
    }, { afterLock: async () => { order.push('push-enter') } })
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.deepEqual(order, ['poll-enter'])
    releasePoll()
    await Promise.all([poll, push])
    assert.deepEqual(order, ['poll-enter', 'poll-exit', 'push-enter'])

    positive = await setupOverleafProject(root, 'poll-retry')
    advanceRemote(root, positive.remote)
    const retryHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.join(projectDir('poll-retry'), 'overleaf-clone'), encoding: 'utf8',
    }).trim()
    await assert.rejects(syncOverleaf('poll-retry', {
      testHooks: { processProjectPush: async () => ({ status: 409, ok: false, error: 'injected transaction rejection' }) },
    }), /injected transaction rejection/)
    assert.equal(readProject('poll-retry').overleafSyncStatus, 'error')
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.join(projectDir('poll-retry'), 'overleaf-clone'), encoding: 'utf8',
    }).trim(), retryHead, 'failed poll must reset the clone so the same remote HEAD is retried')
    result = await syncOverleaf('poll-retry')
    assert.equal(result.changed > 0, true)
    assert.equal(readProject('poll-retry').overleafSyncStatus, 'ok')
    assert.equal(readSourceFile('poll-retry', 'third-party.tex'), 'third party work\n')

    await setupOverleafProject(root, 'resume-failure-first')
    await setupOverleafProject(root, 'resume-success-later')
    const resumedProjects = []
    const resumed = await resumeOverleafPollers(
      () => [readProject('resume-failure-first'), readProject('resume-success-later')],
      {
        recover: async name => {
          if (name === 'resume-failure-first') throw new Error('injected recovery failure')
          return []
        },
        start: name => resumedProjects.push(name),
      },
    )
    assert.equal(resumed, 1)
    assert.deepEqual(resumedProjects, ['resume-success-later'])
    assert.equal(readProject('resume-failure-first').overleafSyncStatus, 'error')

    assert.equal(isSourceFilePath('README.md', { format: 'markdown', mainFile: 'README.md' }), true)
    createProject({ name: 'markdown-readme', title: 'Markdown', mainFile: 'README.md', format: 'svg' })
    updateProject('markdown-readme', { pages: 1, buildStatus: 'success' })
    result = await processProjectPush('markdown-readme', {
      expectedRevision: null,
      files: [{ path: 'README.md', content: '# authored\n' }],
      sourceManifest: ['README.md'],
    })
    assert.equal(result.ok, true)
    const markdownRevision = result.sourceRevision
    assert.deepEqual(await readClientSourceManifest('markdown-readme'), ['README.md'])
    assert.equal(readSourceFile('markdown-readme', 'README.md'), '# authored\n')

    result = await processProjectPush('markdown-readme', {
      expectedRevision: markdownRevision,
      files: [],
      deletedFiles: ['README.md'],
      sourceManifest: [],
    })
    assert.equal(result.ok, true)
    assert.equal(readSourceFile('markdown-readme', 'README.md'), null)
    assert.deepEqual(await readClientSourceManifest('markdown-readme'), [])

    createProject({ name: 'zero-first', title: 'Zero', mainFile: 'main.tex', format: 'svg' })
    updateProject('zero-first', { pages: 1, buildStatus: 'success' })
    write(path.join(sourceDir('zero-first'), 'main.tex'), 'already here\n')
    await updateClientSourceManifest('zero-first', ['main.tex'])
    result = await processProjectPush('zero-first', {
      files: [],
      sourceManifest: ['main.tex'],
    })
    assert.equal(result.ok, true)
    assert.deepEqual(await readClientSourceManifest('zero-first'), ['main.tex'])
    assert.deepEqual(Object.keys(await hashSourceFiles('zero-first')), ['main.tex'])

    createProject({ name: 'failed', title: 'Failed', mainFile: 'main.tex', format: 'svg' })
    updateProject('failed', { pages: 1, buildStatus: 'success' })
    await updateClientSourceManifest('failed', ['main.tex'])
    write(path.join(sourceDir('failed'), 'main.tex'), 'kept\n')
    beforeRejected = await snapshotProject('failed')
    result = await processProjectPush('failed', {
      files: [{ path: '../escape.tex', content: 'bad\n' }],
      sourceManifest: ['main.tex', 'other.tex'],
      sourceDir: '/tmp/should-not-stick',
      session: 'bad-session',
      sessionAt: 123,
      editedBy: 'bad-editor',
      members: ['should-not-stick'],
    })
    assert.equal(result.status, 400)
    assert.equal(result.ok, false)
    await assertSnapshotEqual('failed', beforeRejected)

    beforeRejected = await snapshotProject('failed')
    result = await processProjectPush('failed', {
      files: [{ path: '../escape.tex', content: 'bad\n' }],
      sourceManifest: ['../escape.tex'],
      sourceDir: '/tmp/should-not-stick',
      session: 'bad-session',
      sessionAt: 123,
      editedBy: 'bad-editor',
      members: ['should-not-stick'],
    })
    assert.equal(result.status, 400)
    await assertSnapshotEqual('failed', beforeRejected)

    createProject({ name: 'book-project', title: 'Book', format: 'book', members: ['original-book-member'] })
    beforeRejected = await snapshotProject('book-project')
    result = await processProjectPush('book-project', {
      files: [{ path: 'chapter.tex', content: 'chapter\n' }],
      members: ['should-not-stick'],
    })
    assert.equal(result.status, 400)
    await assertSnapshotEqual('book-project', beforeRejected)

    result = await processProjectPush('book-project', {
      files: [],
      members: ['accepted-book-member'],
    })
    assert.equal(result.status, 200)
    assert.deepEqual(readProject('book-project').members, ['accepted-book-member'])

    const localHashes = { 'main.tex': md5('delivered\n') }
    createProject({ name: 'summary', title: 'Summary', mainFile: 'main.tex', format: 'svg' })
    updateProject('summary', { pages: 1, buildStatus: 'success' })
    write(path.join(sourceDir('summary'), 'main.tex'), 'delivered\n')
    await updateClientSourceManifest('summary', ['main.tex'])
    assert.deepEqual(diffSourceHashes(localHashes, await hashSourceFiles('summary')), {
      changedPaths: [],
      deletedFiles: [],
    })

    assert.deepEqual(normalizeSourceManifest(['README.md'], readProject('markdown-readme')), ['README.md'])
    assert.deepEqual(normalizeSourceManifest(['README.md'], readProject('latex-project')), [])

    console.log('PASS source manifest contract')
  } finally {
    await closeProjectStore()
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
