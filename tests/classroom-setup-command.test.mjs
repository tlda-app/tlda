import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { generateQtm285ClassroomFixture } from './helpers/qtm285-fixture.mjs'
import { daemonLifecycleSocketPath } from '../shared/daemon-socket-path.mjs'

function runCli(args, { cwd = process.cwd(), env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(cwd, 'cli/tlda.mjs'), ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

function classroomServer() {
  const requests = []
  const projects = new Map()
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) : null
      requests.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization })
      res.setHeader('content-type', 'application/json')
      if (req.url?.includes('/source-room/files')) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: 'source-room snapshot path must not be used by classroom setup' }))
      } else if (req.method === 'POST' && req.url === '/api/projects') {
        projects.set(body.name, body)
        res.statusCode = 201
        res.end(JSON.stringify({ name: body.name, title: body.title, mainFile: body.mainFile, format: body.format }))
      } else if (req.method === 'GET' && req.url?.startsWith('/api/projects/')) {
        const name = decodeURIComponent(req.url.split('/').pop())
        const project = projects.get(name)
        if (!project) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'Project not found' }))
        } else {
          res.end(JSON.stringify({ name: project.name, title: project.title, mainFile: project.mainFile, format: project.format }))
        }
      } else if (req.method === 'POST' && req.url === '/api/classroom/courses') {
        res.end(JSON.stringify({ id: body.id, title: body.title }))
      } else if (req.method === 'POST' && req.url === '/api/classroom/courses/qtm285/assignments') {
        res.end(JSON.stringify({ id: body.id, title: body.title, dueAt: body.dueAt, sourceDocKey: body.sourceDocKey, handoutFilter: body.handoutFilter, solutionFilter: body.solutionFilter, solutionsDocKey: body.solutionsDocKey, solutionsVersion: body.solutionsVersion }))
      } else if (req.method === 'PUT' && req.url === '/api/classroom/assignments/hw1/template') {
        res.end(JSON.stringify({ id: 'hw1', templateDocKey: body.templateDocKey, templateVersion: 'handout-rev' }))
      } else {
        res.statusCode = 404
        res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }))
      }
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      requests,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(done => server.close(done)),
    }))
  })
}

function daemonServer(configDir, envName = 'testing') {
  const calls = []
  const socketPath = daemonLifecycleSocketPath(configDir, envName)
  fs.mkdirSync(dirname(socketPath), { recursive: true })
  fs.rmSync(socketPath, { force: true })
  const server = net.createServer(socket => {
    let raw = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => { raw += chunk })
    socket.on('end', () => {
      const message = JSON.parse(raw)
      calls.push(message)
      socket.end(JSON.stringify({
        ok: true,
        result: {
          alreadyLinked: false,
          sourceDir: message.params?.sourceDir,
          submission: { revision: 'git-rev' },
        },
      }) + '\n')
    })
  })
  return new Promise(resolve => {
    server.listen(socketPath, () => resolve({
      calls,
      socketPath,
      close: () => new Promise(done => server.close(() => {
        fs.rmSync(socketPath, { force: true })
        done()
      })),
    }))
  })
}

test('classroom setup posts course, assignment, and frozen handout through existing API routes', async () => {
  const fixture = await classroomServer()
  const sourceRoot = fs.mkdtempSync(join(os.tmpdir(), 'tlda-qtm285-setup-source-'))
  const configDir = fs.mkdtempSync(join(os.tmpdir(), 'tlda-classroom-config-'))
  fs.writeFileSync(join(configDir, 'daemon.yaml'), `environments:
  default: testing
  values:
    testing:
      database: ${fixture.url}
      store: ${fixture.url}
      licenseKey: ""
`)
  const daemon = await daemonServer(configDir)
  try {
    generateQtm285ClassroomFixture({ outDir: sourceRoot })
    const result = await runCli([
      '--env', 'testing',
      'classroom', 'setup',
      '--server', fixture.url,
      '--token', 'rw-token',
      '--course', 'qtm285',
      '--course-title', 'QTM 285',
      '--assignment', 'hw1',
      '--assignment-title', 'Homework 1',
      '--due', '2026-09-01T20:00:00Z',
      '--homework-root', sourceRoot,
      '--homework', 'homework/week0-homework.qmd',
      '--project-prefix', 'hw1',
      '--solutions-version', 'solutions-rev',
    ], { env: { TLDA_CONFIG_DIR: configDir, TLDA_ENV: 'testing' } })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /Classroom setup complete/)
    assert.match(result.stdout, /Handout frozen: hw1-handout@handout-rev/)
    assert.match(result.stdout, /Source: hw1-source/)
    assert.match(result.stdout, /Generated from: homework\/week0-homework\.qmd/)
    assert.match(result.stdout, /Filters: handout=bin\/make-handout\.py; solution=homework\/solution-callout\.lua/)
    assert.match(result.stdout, /Solutions: hw1-solutions@solutions-rev/)
    assert.match(result.stdout, /Registration: \?workspace=classroom-register&course=qtm285/)
    assert.doesNotMatch(result.stdout, /name=/)
    assert.deepEqual(fixture.requests.map(req => `${req.method} ${req.url}`), [
      'POST /api/projects',
      'GET /api/projects/hw1-source',
      'POST /api/projects',
      'GET /api/projects/hw1-handout',
      'POST /api/projects',
      'GET /api/projects/hw1-solutions',
      'POST /api/classroom/courses',
      'POST /api/classroom/courses/qtm285/assignments',
      'PUT /api/classroom/assignments/hw1/template',
    ])
    assert.deepEqual(fixture.requests[0].body, { name: 'hw1-source', title: 'Homework 1 source', mainFile: 'homework/week0-homework.qmd', format: 'qmd' })
    assert.deepEqual(fixture.requests[2].body, { name: 'hw1-handout', title: 'Homework 1 handout', mainFile: 'hw1-handout.html', format: 'html' })
    assert.deepEqual(fixture.requests[4].body, { name: 'hw1-solutions', title: 'Homework 1 solutions', mainFile: 'hw1-solution.html', format: 'html' })
    assert.equal(daemon.calls.length, 3)
    assert.deepEqual(daemon.calls.map(call => call.op), ['project-source-link', 'project-source-link', 'project-source-link'])
    assert.deepEqual(daemon.calls.map(call => call.params.project), ['hw1-source', 'hw1-handout', 'hw1-solutions'])
    assert.deepEqual(daemon.calls.map(call => call.params.documentRoots), [
      ['homework/week0-homework.qmd'],
      ['hw1-handout.html'],
      ['hw1-solution.html'],
    ])
    const handoutDir = daemon.calls[1].params.sourceDir
    const solutionDir = daemon.calls[2].params.sourceDir
    assert.match(fs.readFileSync(join(handoutDir, '.git/HEAD'), 'utf8'), /refs\/heads/)
    assert.match(fs.readFileSync(join(solutionDir, '.git/HEAD'), 'utf8'), /refs\/heads/)
    const handoutHtml = fs.readFileSync(join(handoutDir, 'hw1-handout.html'), 'utf8')
    const solutionHtml = fs.readFileSync(join(solutionDir, 'hw1-solution.html'), 'utf8')
    assert.match(solutionHtml, /callout-solution/)
    assert.match(solutionHtml, /It.s biggest for list 3 and smallest for list 2/)
    assert.doesNotMatch(handoutHtml, /callout-solution/)
    assert.doesNotMatch(handoutHtml, /It.s biggest for list 3 and smallest for list 2/)
    assert.match(handoutHtml, /exr-calculations-1/)
    assert.deepEqual(fixture.requests[6].body, { id: 'qtm285', title: 'QTM 285' })
    assert.deepEqual(fixture.requests[7].body, {
      id: 'hw1',
      title: 'Homework 1',
      dueAt: '2026-09-01T20:00:00Z',
      sourceDocKey: 'hw1-source',
      handoutFilter: 'bin/make-handout.py',
      solutionFilter: 'homework/solution-callout.lua',
      solutionsDocKey: 'hw1-solutions',
      solutionsVersion: 'solutions-rev',
    })
    assert.deepEqual(fixture.requests[8].body, { templateDocKey: 'hw1-handout' })
  } finally {
    await daemon.close()
    fs.rmSync(sourceRoot, { recursive: true, force: true })
    fs.rmSync(configDir, { recursive: true, force: true })
    await fixture.close()
  }
})

test('classroom setup help documents the required instructor procedure', async () => {
  const result = await runCli(['classroom', 'setup', '--help'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /tlda classroom setup --course <id>/)
  assert.match(result.stdout, /--homework-root <dir> --homework <path>/)
  assert.match(result.stdout, /one authoritative QTM homework QMD/)
  assert.match(result.stdout, /ordinary Git checkouts linked through the project-link daemon path/)
  assert.match(result.stdout, /freezes the generated handout/)
})
