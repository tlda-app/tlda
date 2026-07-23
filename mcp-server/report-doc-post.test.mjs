/**
 * Regression tests for the project-scoped report post (mcp-server/report-doc-post.mjs).
 *
 * Guards the Gate A split-brain: the authoritative task report/close succeeded,
 * but the project post warned "Project not found" and fell back to chat because
 *   (1) a fresh report doc was never created (dead `check.status === 404` branch), and
 *   (2) the doc name carried the task id's "fleet:" colon, which the project-name
 *       route rejects.
 *
 * Run:  node --test mcp-server/report-doc-post.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportDocName, postReportDoc } from './report-doc-post.mjs';

test('reportDocName slugifies a fleet task id into a valid project name', () => {
  // Project names must match ^[a-z0-9][a-z0-9-]*$ (server/routes/projects.mjs).
  const name = reportDocName('fleet:a7ec-mrxcpjvp');
  assert.equal(name, 'report-fleet-a7ec-mrxcpjvp');
  assert.match(name, /^[a-z0-9][a-z0-9-]*$/);
  assert.ok(!name.includes(':'), 'colon must be stripped');
});

test('reportDocName is deterministic and collapses runs / trims edges', () => {
  assert.equal(reportDocName('fleet:14af-mrw0ro0f'), 'report-fleet-14af-mrw0ro0f');
  assert.equal(reportDocName('fleet::x'), 'report-fleet-x');
  assert.equal(reportDocName(':::'), 'report');
});

// A fake shared-fetch client with the real contract: returns the parsed body,
// throws with `err.status` on a non-2xx response.
function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || 'GET', body: opts.body });
    const key = `${opts.method || 'GET'} ${path}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected fetch: ${key}`);
    return handler();
  };
  return { fetchImpl, calls };
}

function notFound() {
  const err = new Error('Project not found');
  err.status = 404;
  throw err;
}

test('successful project post: creates a missing doc, then pushes with the authority revision', async () => {
  const docName = 'report-fleet-a7ec-mrxcpjvp';
  let created = false;
  const { fetchImpl, calls } = makeFetch({
    // Fresh task → the report doc does not exist yet.
    [`GET /api/projects/${docName}`]: () => (created ? { name: docName } : notFound()),
    ['POST /api/projects/']: () => { created = true; return { name: docName }; },
    // Newly created markdown doc is uninitialized: currentRevision === null.
    [`GET /api/projects/${docName}/source-authority`]: () => ({ state: 'uninitialized', currentRevision: null }),
    [`POST /api/projects/${docName}/push`]: () => ({ ok: true }),
  });

  const result = await postReportDoc({
    reportTaskId: 'fleet:a7ec-mrxcpjvp',
    taskDescription: 'Repair project report routing split',
    reportContent: '# report body',
    cwd: '/tmp/work',
    session: 'sess-1',
    fetchImpl,
  });

  assert.equal(result.docName, docName);
  assert.ok(created, 'a missing report doc must be created, not skipped');

  const push = calls.find(c => c.path === `/api/projects/${docName}/push`);
  assert.ok(push, 'a push must be issued');
  // The push must carry a defined expectedRevision (null is accepted; undefined is a 428).
  assert.equal(push.body.expectedRevision, null);
  assert.notEqual(push.body.expectedRevision, undefined);
  assert.deepEqual(push.body.sourceManifest, [`${docName}.md`]);
  assert.equal(push.body.files[0].path, `${docName}.md`);
});

test('existing doc: skips creation and pushes with the live revision', async () => {
  const docName = 'report-fleet-a7ec-mrxcpjvp';
  let createCalls = 0;
  const { fetchImpl, calls } = makeFetch({
    [`GET /api/projects/${docName}`]: () => ({ name: docName }),
    ['POST /api/projects/']: () => { createCalls++; return { name: docName }; },
    [`GET /api/projects/${docName}/source-authority`]: () => ({ state: 'current', currentRevision: 'rev-7' }),
    [`POST /api/projects/${docName}/push`]: () => ({ ok: true }),
  });

  await postReportDoc({
    reportTaskId: 'fleet:a7ec-mrxcpjvp',
    taskDescription: 'desc',
    reportContent: 'body',
    fetchImpl,
  });

  assert.equal(createCalls, 0, 'an existing doc must not be recreated');
  const push = calls.find(c => c.path === `/api/projects/${docName}/push`);
  assert.equal(push.body.expectedRevision, 'rev-7');
});

test('genuine failure surfaces loudly: a non-404 error is not swallowed', async () => {
  const docName = 'report-fleet-a7ec-mrxcpjvp';
  const { fetchImpl } = makeFetch({
    [`GET /api/projects/${docName}`]: () => {
      const err = new Error('Server not reachable');
      err.status = 503;
      throw err;
    },
  });

  await assert.rejects(
    () => postReportDoc({
      reportTaskId: 'fleet:a7ec-mrxcpjvp',
      taskDescription: 'desc',
      reportContent: 'body',
      fetchImpl,
    }),
    /Server not reachable/,
    'a real error (not 404) must propagate so the caller can report it, not silently fall back',
  );
});

test('create rejection surfaces loudly (does not masquerade as success)', async () => {
  const docName = 'report-fleet-a7ec-mrxcpjvp';
  const { fetchImpl } = makeFetch({
    [`GET /api/projects/${docName}`]: () => notFound(),
    ['POST /api/projects/']: () => {
      const err = new Error('name must be lowercase alphanumeric with hyphens');
      err.status = 400;
      throw err;
    },
  });

  await assert.rejects(
    () => postReportDoc({
      reportTaskId: 'fleet:a7ec-mrxcpjvp',
      taskDescription: 'desc',
      reportContent: 'body',
      fetchImpl,
    }),
    /lowercase alphanumeric/,
  );
});
