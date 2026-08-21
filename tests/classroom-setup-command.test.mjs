import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'

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
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) : null
      requests.push({ method: req.method, url: req.url, body, authorization: req.headers.authorization })
      res.setHeader('content-type', 'application/json')
      if (req.method === 'POST' && req.url === '/api/classroom/courses') {
        res.end(JSON.stringify({ id: body.id, title: body.title }))
      } else if (req.method === 'POST' && req.url === '/api/classroom/courses/qtm285/assignments') {
        res.end(JSON.stringify({ id: body.id, title: body.title, dueAt: body.dueAt, solutionsDocKey: body.solutionsDocKey, solutionsVersion: body.solutionsVersion }))
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

test('classroom setup posts course, assignment, and frozen handout through existing API routes', async () => {
  const fixture = await classroomServer()
  try {
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
      '--handout', 'hw1-handout',
      '--solutions', 'hw1-solutions',
      '--solutions-version', 'solutions-rev',
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /Classroom setup complete/)
    assert.match(result.stdout, /Handout frozen: hw1-handout@handout-rev/)
    assert.match(result.stdout, /Solutions: hw1-solutions@solutions-rev/)
    assert.match(result.stdout, /Registration: \?workspace=classroom-register&course=qtm285/)
    assert.doesNotMatch(result.stdout, /name=/)
    assert.deepEqual(fixture.requests.map(req => `${req.method} ${req.url}`), [
      'POST /api/classroom/courses',
      'POST /api/classroom/courses/qtm285/assignments',
      'PUT /api/classroom/assignments/hw1/template',
    ])
    assert.deepEqual(fixture.requests[0].body, { id: 'qtm285', title: 'QTM 285' })
    assert.deepEqual(fixture.requests[1].body, {
      id: 'hw1',
      title: 'Homework 1',
      dueAt: '2026-09-01T20:00:00Z',
      solutionsDocKey: 'hw1-solutions',
      solutionsVersion: 'solutions-rev',
    })
    assert.deepEqual(fixture.requests[2].body, { templateDocKey: 'hw1-handout' })
  } finally {
    await fixture.close()
  }
})

test('classroom setup help documents the required instructor procedure', async () => {
  const result = await runCli(['classroom', 'setup', '--help'])
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /tlda classroom setup --course <id>/)
  assert.match(result.stdout, /Creates or updates the course/)
  assert.match(result.stdout, /freezes the handout/)
})
