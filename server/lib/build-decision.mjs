/**
 * Build decision tree — one place that answers "should this trigger a build?"
 *
 * Every entry point (push, manual build, ensure) asks this module instead
 * of reimplementing the decision. The execution (calling runBuild, buildMarkdown,
 * etc.) stays with the caller.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { outputDir, sourceDir as getSourceDir } from './project-store.mjs'

/**
 * Decide whether a file push should trigger a build.
 *
 * @param {object} project     — project metadata from readProject()
 * @param {string} name        — project name
 * @param {object} options
 * @param {Array}  options.changedFiles  — files that changed (from push)
 * @param {boolean} options.anyChanged   — whether any files actually changed on disk
 * @returns {{ build: boolean, eager: boolean, reason: string }}
 *   - build: whether a build should happen
 *   - eager: true = start now, false = mark stale for on-demand (SVG only)
 *   - reason: human-readable explanation
 */
export function shouldBuildOnPush(project, name, { changedFiles = [], anyChanged = false } = {}) {
  if (!anyChanged && project.buildStatus === 'success') {
    return { build: false, eager: false, reason: 'unchanged' }
  }

  const format = project.format

  // Non-SVG formats always build eagerly on push
  if (format === 'markdown' || format === 'html' || format === 'slides') {
    return { build: true, eager: true, reason: 'format-eager' }
  }

  // SVG: check relevant-files filter
  if (format === 'svg' && changedFiles.length > 0) {
    const relevantPath = join(outputDir(name), 'relevant-files.json')

    if (!existsSync(relevantPath)) {
      return { build: true, eager: false, reason: 'no-relevant-files-yet' }
    }

    try {
      const { files: relevantList } = JSON.parse(readFileSync(relevantPath, 'utf8'))
      const relevantSet = new Set(relevantList || [])
      const mirrorDir = getSourceDir(name)
      const authorDir = project.sourceDir

      const anyRelevant = changedFiles.some(f => {
        const mirrorPath = join(mirrorDir, f)
        if (relevantSet.has(mirrorPath)) return true
        if (authorDir && relevantSet.has(join(authorDir, f))) return true
        return false
      })

      if (!anyRelevant) {
        return { build: false, eager: false, reason: 'outside-tree' }
      }
    } catch (e) {
      return { build: false, eager: false, reason: 'relevant-files-parse-failed' }
    }
  }

  // SVG default: mark stale, let ensure handle it
  return { build: true, eager: false, reason: 'svg-stale' }
}

/**
 * Check if a project's SVG build output is stale (source newer than build).
 * Used by the ensure system for on-demand builds.
 *
 * @param {string} name — project name
 * @returns {boolean}
 */
export function isSvgBuildStale(name) {
  const projDir = join(outputDir(name), '..')
  const sourceStamp = join(projDir, 'source.stamp')
  const buildStamp = join(outputDir(name), 'build.stamp')

  if (!existsSync(sourceStamp)) return false
  if (!existsSync(buildStamp)) return true

  return statSync(sourceStamp).mtimeMs > statSync(buildStamp).mtimeMs
}

/**
 * Get the builder function name for a format.
 * @param {string} format
 * @returns {'runBuild' | 'buildMarkdown' | 'buildHtml' | 'buildSlides'}
 */
export function builderForFormat(format) {
  const map = {
    markdown: 'buildMarkdown',
    html: 'buildHtml',
    slides: 'buildSlides',
  }
  return map[format] || 'runBuild'
}
