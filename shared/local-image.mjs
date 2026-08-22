/**
 * `/api/local-image` serves one thing: a filesystem image referenced from a math
 * note's markdown — `![](~/fig.png)` or `![](/abs/fig.png)`. An absolute path is
 * the feature, not an oversight: the file deliberately lives outside every
 * project, on the machine.
 *
 * What the route is NOT is a general file reader, and until this module existed
 * it was one. It computed a mime type, set it as the `Content-Type`, and then
 * served whatever it had been handed — Markdown, HTML, anything with a path. A
 * shared read token was therefore a general file-read primitive on the server.
 * Measured 2026-08-22 against a server at `e2545ebea` with token gating on: a
 * bare read token, no enrollment, got `HTTP 200` and the bytes of a plain-text
 * file outside any project.
 *
 * The mime type is not a new fact, an allowlist, or a stored rule that can drift
 * from something else. It is the one the route already computed and discarded.
 * Refusing a non-image is the route honouring its own name.
 *
 * RESIDUAL, unclosed and deliberate: a read-token holder can still read any
 * *image* on the box. Closing that means scoping the path to a project, which
 * deletes the feature — a note's image is outside every project by design. That
 * is a product decision about whether local images in notes survive, not a
 * defect to patch here, and it has not been made.
 *
 * Both callers live here so the rule is one rule in one place:
 *   - `server/unified-server.mjs` — the production route, behind `requireRead`.
 *   - `vite.config.ts` `localImagePlugin` — its dev-server twin, which has no
 *     read check at all and never had one. Whoever changes one of these will not
 *     know about the other; that is why the decision is not written twice.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { lookup as mimeLookup } from 'mime-types'

/**
 * @param {unknown} rawPath the caller-supplied `path` parameter
 * @returns {{ok: true, path: string, mimeType: string} | {ok: false, status: number, error: string}}
 */
export function resolveLocalImage(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return { ok: false, status: 400, error: 'Missing path' }
  const expanded = rawPath.startsWith('~/') ? join(homedir(), rawPath.slice(2)) : rawPath
  if (!expanded.startsWith('/')) return { ok: false, status: 400, error: 'Path must be absolute' }
  // Mime before existence, so a non-image answers the same way whether or not it
  // is there. Ordered the other way, the 404/415 split is an existence oracle
  // over the whole filesystem — which is most of what was wrong here already.
  const mimeType = mimeLookup(expanded)
  if (!mimeType || !mimeType.startsWith('image/')) return { ok: false, status: 415, error: 'Not an image' }
  if (!existsSync(expanded)) return { ok: false, status: 404, error: 'Not found' }
  return { ok: true, path: resolve(expanded), mimeType }
}
