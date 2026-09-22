import fs from 'node:fs'
import path from 'node:path'

import { resolveContainedPath } from './path-containment.mjs'

const { posix } = path

/**
 * A Quarto page can probe `site_libs/...` relative to its own directory before
 * walking toward the publication root. Serve that first probe from the nearest
 * ancestor `site_libs` directory when the page-local copy does not exist.
 */
export function siteLibAssetCandidates(filePath) {
  const segments = filePath.split('/').filter(Boolean)
  const siteLibsIndex = segments.indexOf('site_libs')
  if (siteLibsIndex < 0) return [filePath]

  const suffix = segments.slice(siteLibsIndex)
  const prefix = segments.slice(0, siteLibsIndex)
  const candidates = []
  for (let length = prefix.length; length >= 0; length--) {
    candidates.push(posix.join(...prefix.slice(0, length), ...suffix))
  }
  return [...new Set(candidates)]
}

export async function resolvePublishedAssetPath(outputRoot, filePath) {
  for (const candidate of siteLibAssetCandidates(filePath)) {
    const assetPath = resolveContainedPath(outputRoot, candidate)
    try {
      await fs.promises.access(assetPath)
      return assetPath
    } catch { /* try the next ancestor */ }
  }
  return null
}
