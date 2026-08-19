/**
 * Post a task report as its own tlda markdown doc ("report-<task>").
 *
 * Split out of the report tool so the project-post sequence is unit-testable
 * and shares the one server HTTP contract (shared/http-client.mjs: returns the
 * parsed body, throws with `err.status` on a non-2xx response).
 *
 * Two split-brain defects lived in the old inline version, which is why the
 * authoritative task report/close succeeded while the project-scoped report
 * post warned "Project not found" and fell back to chat:
 *
 *   1. It called a local fetch wrapper that ALWAYS returned `{ status: 200 }`
 *      and hid the real status inside a thrown error. Its `check.status === 404`
 *      create branch was therefore dead code: a fresh report doc was never
 *      created, so the first GET threw 404 and every post fell back to chat.
 *   2. It derived the doc name straight from the task id
 *      (e.g. "report-fleet:a7ec-mrxcpjvp"), whose "fleet:" colon the project
 *      name route rejects (^[a-z0-9][a-z0-9-]*$) — so even reaching the create
 *      call would have 400'd.
 *
 * Both are fixed here. Genuine failures (create rejected, push rejected, server
 * unreachable) still throw so the caller can surface them loudly — a real
 * missing project is not silently swallowed.
 */
import { normalizeSourceManifest } from '../shared/source-manifest.mjs';

/**
 * Slugify a task id into a valid project name.
 * Project names must match ^[a-z0-9][a-z0-9-]*$ (server/routes/projects.mjs),
 * but task ids carry a "fleet:" prefix and colons, so strip everything else.
 * @param {string} taskId
 * @returns {string}
 */
export function reportDocName(taskId) {
  const slug = `report-${String(taskId ?? '')}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'report';
}

/**
 * Ensure the report doc exists, then push the report content into it.
 *
 * @param {object}   opts
 * @param {string}   opts.reportTaskId    task id the report belongs to
 * @param {string}   opts.taskDescription doc title
 * @param {string}   opts.reportContent   markdown body to push
 * @param {string}  [opts.session]        session id for the push
 * @param {Function} opts.fetchImpl       (path, options) => Promise<body>, throws with err.status on non-2xx
 * @param {string}  [opts.server]         server override forwarded to fetchImpl
 * @returns {Promise<{ docName: string }>} resolves on success; throws on genuine failure
 */
export async function postReportDoc({
  reportTaskId,
  taskDescription,
  reportContent,
  session = null,
  fetchImpl,
  server = undefined,
}) {
  if (typeof fetchImpl !== 'function') throw new Error('postReportDoc requires fetchImpl');
  const docName = reportDocName(reportTaskId);
  const mainFile = `${docName}.md`;
  const base = `/api/projects/${docName}`;

  // Existence check: a 404 means "create it", any other failure is genuine.
  let exists = true;
  try {
    await fetchImpl(base, { server });
  } catch (e) {
    if (e && e.status === 404) exists = false;
    else throw e;
  }
  if (!exists) {
    await fetchImpl('/api/projects/', {
      method: 'POST',
      body: { name: docName, title: taskDescription, format: 'markdown', mainFile },
      server,
    });
  }

  // A freshly-created doc is uninitialized, so `currentRevision` is null and is
  // sent as null. The old route's rule -- null accepted, undefined a 428 -- no
  // longer applies here: the carrier destructures `expectedRevision = null`, so
  // absent and null reach the same branch. Kept explicit anyway, because the
  // value being read is the point; do not carry the 428 claim forward, it
  // describes a route this no longer calls.
  const authority = await fetchImpl(`${base}/source-authority`, { server });
  // The JSON accept carrier. `sourceDir` is deliberately NOT carried: it is not
  // read from any request body, the old route's destructure already dropped it,
  // and every server use reads `project.sourceDir` from storage. Sending it was
  // a field nobody read, so dropping it corrects a defect rather than losing a
  // capability -- and it is dropped knowingly rather than by not being listed.
  await fetchImpl(`${base}/source-snapshot`, {
    method: 'POST',
    body: {
      files: [{ path: mainFile, content: reportContent }],
      sourceManifest: normalizeSourceManifest([mainFile], { format: 'markdown', mainFile }),
      session: session || undefined,
      expectedRevision: authority?.currentRevision ?? null,
    },
    server,
  });

  return { docName };
}
