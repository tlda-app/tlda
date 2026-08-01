/**
 * Build decision tree — one place that answers "should this trigger a build?"
 *
 * Every entry point (push, manual build, ensure) asks this module instead
 * of reimplementing the decision. The execution (calling runBuild, buildMarkdown,
 * etc.) stays with the caller.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { outputDir, sourceDir } from './project-store.mjs'

/**
 * The project's declared main file, when the source tree does not contain it.
 *
 * Declared-but-absent is the error. Undeclared is not: a project created before
 * its first push has no mainFile at all, and a `book` is an aggregate of member
 * projects that never has one. Those still build.
 *
 * The test is the filesystem, deliberately, not the client source manifest.
 * `listSourceFiles` intersects the on-disk walk with that manifest, and a project
 * pushed before the manifest existed reports zero files while its main file sits
 * on disk and compiles — `synth-combined`, 99 pages, built today, is exactly
 * that. Asking the manifest would refuse the projects that work.
 *
 * @returns {string|null} the declared path, project-relative, or null
 */
export function missingDeclaredMainFile(project, name) {
  const declared = String(project?.mainFile || '').replace(/\\/g, '/').replace(/^\.?\/+/, '')
  if (!declared) return null
  return existsSync(join(sourceDir(name), declared)) ? null : declared
}

/** The message a build refuses with. It names the file, because that is the fix. */
export function missingMainFileMessage(name, declared) {
  return `${declared} does not exist in the source of project "${name}". ` +
    `project.json declares it as mainFile, so the build stops here rather than ` +
    `rendering whatever else is lying around and calling it this project.`
}

/**
 * Decide whether a file push should trigger a build.
 *
 * @param {object} project     — project metadata from readProject()
 * @param {string} name        — project name
 * @param {object} options
 * @param {Array}  options.changedFiles  — files that changed (from push)
 * @param {boolean} options.anyChanged   — whether any files actually changed on disk
 * @param {boolean} options.building     — dispatcher-authoritative queued/in-flight state
 * @returns {{ build: boolean, eager: boolean, reason: string }}
 *   - build: whether a build should happen
 *   - eager: true = start now
 *   - reason: human-readable explanation
 */
export function shouldBuildOnPush(project, name, { changedFiles = [], anyChanged = false, building = false } = {}) {
  const format = project.format

  if (format === 'svg' && Number(project.pages || 0) === 0 && building) {
    return { build: false, eager: false, reason: 'already-building' }
  }

  if (!anyChanged && project.buildStatus === 'success') {
    return { build: false, eager: false, reason: 'unchanged' }
  }

  // A brand-new SVG project builds eagerly, like every other changed project.
  if (format === 'svg' && Number(project.pages || 0) === 0) {
    return { build: true, eager: true, reason: 'initial-svg-build' }
  }

  // Non-SVG formats always build eagerly on push
  if (format === 'markdown' || format === 'html' || format === 'slides' || format === 'qmd') {
    return { build: true, eager: true, reason: 'format-eager' }
  }

  // SVG: check relevant-files filter
  if (format === 'svg' && changedFiles.length > 0) {
    const relevantPath = join(outputDir(name), 'relevant-files.json')

    if (!existsSync(relevantPath)) {
      return { build: true, eager: false, reason: 'no-relevant-files-yet' }
    }

    try {
      // Scope and changedFiles are both project-relative — compare directly.
      const { files: relevantList } = JSON.parse(readFileSync(relevantPath, 'utf8'))
      const relevantSet = new Set(relevantList || [])

      const anyRelevant = changedFiles.some(f => relevantSet.has(f))

      if (!anyRelevant) {
        return { build: false, eager: false, reason: 'outside-tree' }
      }
    } catch (e) {
      return { build: true, eager: false, reason: `relevant-files-parse-failed: ${e.message}` }
    }
  }

  // A successful build is also the project's automatic Git checkpoint.
  // Deferring an SVG build until somebody requests a page leaves accepted
  // source edits outside project history whenever nobody is viewing the paper.
  return { build: true, eager: true, reason: 'svg-eager' }
}

/**
 * Check if a project's SVG build output is stale.
 *
 * build.stamp stores the source.stamp mtime captured at build start: the source
 * version the last successful build covered. A source edit that lands while a
 * build is running will therefore have a newer source.stamp than build.stamp's
 * content even if the build finishes after the edit.
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

  const builtSourceVersion = Number(readFileSync(buildStamp, 'utf8'))
  if (!Number.isFinite(builtSourceVersion)) return true

  return statSync(sourceStamp).mtimeMs > builtSourceVersion
}

/**
 * Get the builder function name for a format.
 * @param {string} format
 * @returns {'runBuild' | 'buildMarkdown' | 'buildHtml' | 'buildSlides' | 'buildQmd'}
 */
export function builderForFormat(format) {
  const map = {
    markdown: 'buildMarkdown',
    html: 'buildHtml',
    slides: 'buildSlides',
    qmd: 'buildQmd',
  }
  return map[format] || 'runBuild'
}
