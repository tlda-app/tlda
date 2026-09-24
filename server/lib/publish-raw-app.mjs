import { resolve } from 'node:path'

import { resolvePublishedAssetPath } from './site-lib-asset.mjs'

/**
 * Serve a built app-half file for publish, raw.
 *
 * The app route answers the reader shell by design, so a publish that fetched
 * it would stage the application in place of the page. The static route
 * already answers `?_tldaPublishRaw=1` with the built bytes; this is the same
 * bypass for the app half, so a preview copy carries the canvas pages
 * themselves — whatever they contain — instead of copies of their static
 * twins. The halves are different content and may differ; the publish
 * hash-checks every fetch, so that difference ships faithfully rather than
 * refusing.
 *
 * NOT the `_tldaShape` fall-through. That downstream serves the page with the
 * serve-time bridge injected and may substitute solutions content for the
 * entitled — neither is the inventoried bytes the publish checks. This sends
 * the output file untouched; the staged copy gets its bridge from the
 * publish's own patch step.
 *
 * Returns true when it answered (bytes or 404), false when the request is
 * not a publish-raw app-file fetch and the caller should carry on to the
 * shell. Non-HTML falls through deliberately: the downstream already serves
 * it raw.
 */
export async function servePublishRawApp(req, res, { outputRoot }) {
  if (req.query?._tldaPublishRaw !== '1') return false
  if (!req.path.endsWith('.html') && !req.path.endsWith('/')) return false
  const rawSegments = Array.isArray(req.params?.coursePath) ? req.params.coursePath : [req.params?.coursePath]
  const servedRoot = ['app', ...rawSegments.filter(Boolean)].join('/')
  const served = req.path.endsWith('/') ? `${servedRoot}/index.html` : servedRoot
  let projectPath = null
  try {
    projectPath = await resolvePublishedAssetPath(outputRoot, served)
  } catch {
    res.status(404).json({ error: 'Not found' })
    return true
  }
  if (!projectPath) {
    res.status(404).json({ error: 'Not found' })
    return true
  }
  res.sendFile(resolve(projectPath))
  return true
}
