// Live resolution for clicked file chips: adopt-then-match against the
// project's declared markdown roots, or fail loudly.
//
// Frozen byte-copies were removed from this path. A clicked file that is not
// (or cannot become) a live document root of the project no longer
// snapshots into parts/ -- it returns not-ready, and the client shows the
// shared chip failure sentence. Existing parts keep rendering through the
// parts list and markdown routes, which never imported this module.
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

import { readProject, listProjects, projectPartsRoot } from './project-store.mjs'
import { referencedRootsFromPaths } from '../../shared/source-manifest.mjs'
import { normalizeDocumentRoots } from '../../shared/document-roots.mjs'

export async function resolveLiveProjectDocument({ project = null, sourcePath = null, title = null, provenance = null } = {}) {
  const resolved = await resolveArtifactProject({ project })
  if (!resolved) {
    return {
      kind: 'project-document',
      title: title || null,
      state: 'failed',
      status: 'no project resolved',
      project: project || null,
      projectArtifactId: null,
      sourcePath: sourcePath || null,
      provenance,
      error: `no project resolved for ${project || '(none)'}`,
      ready: false,
    }
  }
  const livePath = await liveProjectDocumentPath(resolved.name, sourcePath)
  if (livePath) {
    return liveDocumentPayload({ project: resolved.name, projectPath: livePath, title, provenance })
  }
  return {
    kind: 'project-document',
    title: title || null,
    state: 'failed',
    status: 'not a live document',
    project: resolved.name,
    projectArtifactId: null,
    sourcePath: sourcePath || null,
    provenance,
    error: `not a live document of ${resolved.name}: ${sourcePath || '(no path)'}`,
    ready: false,
  }
}

export async function resolveArtifactProject({ project = null, cwd = null, projectsProvider = listProjects } = {}) {
  const projects = (await projectsProvider()).map(p => ({
    ...p,
    partsRoot: p.partsRoot || projectPartsRoot(p.name),
    sourceRoot: p.sourceDir || null,
  })).filter(p => p.name)

  if (project) {
    const match = projects.find(p => p.name === project) || (await readProject(project) ? { name: project, partsRoot: projectPartsRoot(project) } : null)
    return match ? { name: match.name, root: match.partsRoot } : null
  }

  const root = resolveProjectCwd(cwd)
  if (!root) return null
  const rootReal = safeRealpath(root)
  let best = null
  for (const candidate of projects) {
    for (const base of [candidate.partsRoot, candidate.sourceRoot].filter(Boolean)) {
      const baseReal = safeRealpath(base)
      if (
        isSameOrInside(root, base) ||
        (rootReal && isSameOrInside(rootReal, base)) ||
        (baseReal && isSameOrInside(root, baseReal)) ||
        (rootReal && baseReal && isSameOrInside(rootReal, baseReal))
      ) {
        const score = String(base).length
        if (!best || score > best.score) best = { name: candidate.name, root: candidate.partsRoot, score }
      }
    }
  }
  return best ? { name: best.name, root: best.root } : null
}

export function resolveProjectCwd(cwd) {
  if (!cwd) return null
  const abs = resolve(expandHome(cwd))
  const parts = abs.split(sep)
  const worktreeIdx = parts.lastIndexOf('.worktrees')
  if (worktreeIdx > 0) return parts.slice(0, worktreeIdx).join(sep) || sep
  const claudeIdx = parts.lastIndexOf('.claude')
  if (claudeIdx > 0 && parts[claudeIdx + 1] === 'worktrees') {
    return parts.slice(0, claudeIdx).join(sep) || sep
  }
  return gitTopLevel(abs) || abs
}

/**
 * The project-relative path of a markdown document this project already renders
 * live at `/docs/<project>/<stem>.html`, or null.
 *
 * Deliberately narrower than "reachable": a declared markdown document root is
 * the app's own statement that a file is a document of this project, and it is
 * the same set the Projects tab offers to open -- `/:name/files` builds its
 * `documents` list from exactly these, through `markdownProjectRootColumn`. So a
 * match always has a live column, whatever the parent project's own format is.
 * A markdown file that is merely reachable is not a document here.
 *
 * `normalizeDocumentRoots` rather than `project.documentRoots`: a project whose
 * roots were never declared explicitly has none stored, and its main file is
 * its document. That is the same normalization `/:name/files` applies.
 *
 * NOT `listSourceFiles`, which is the trap next door. It intersects the disk
 * walk with the CLIENT SOURCE MANIFEST, so a project pushed before that manifest
 * existed reports zero files while its documents sit on disk and render --
 * measured here on a project with no manifest, where it returned `[]` and this
 * function silently answered "not a document" for the project's own main file.
 * See `missingDeclaredMainFile` in build-decision.mjs, which refuses the same
 * instrument for the same reason.
 *
 * The clicked path arrives absolute and on the AUTHOR'S machine -- that is what
 * the chat chip carried -- while the project speaks in project-relative paths.
 * `referencedRootsFromPaths` is the existing tail-match between the two, already
 * used for this same question by `sourceMembershipContext`. Reuse rather than a
 * second matcher beside it: two encodings of one rule can disagree.
 */
async function liveProjectDocumentPath(projectName, sourcePath) {
  const normalized = String(sourcePath ?? '').replace(/\\/g, '/')
  // A bare filename is not a path on any machine. The tail-match's equality
  // branch would sit it straight on top of a same-named project document, so a
  // `notes.md` with no directory would open the project's own notes.md. A path
  // has a directory in it.
  if (!normalized.includes('/')) return null

  const project = await readProject(projectName)
  if (!project) return null
  const candidates = declaredMarkdownRootPaths(project)
  if (candidates.length === 0) return null

  const [match] = referencedRootsFromPaths([expandHome(normalized)], candidates)
  return match || null
}

function declaredMarkdownRootPaths(project) {
  return normalizeDocumentRoots(project?.documentRoots, {
    mainFile: project?.mainFile,
    format: project?.format,
  })
    .filter(root => root.format === 'markdown')
    .map(root => normalizeProjectPath(root.path))
    .filter(path => path && /\.(md|markdown)$/i.test(path))
}

/**
 * The response for a click that resolved to the live document.
 *
 * `projectPath` is the whole contract: the route maps it through
 * `markdownColumnFileForSource` into `outputFile`. The shape that comes out is
 * the one the Projects tab already builds for a live document -- same
 * `/docs/<p>/<f>` url, same `materializedDoc`/`materializedFile` meta -- and
 * `props.source` resolves to the real source file rather than to a part
 * under `parts/`.
 */
function liveDocumentPayload({ project, projectPath, title, provenance }) {
  return {
    kind: 'project-document',
    live: true,
    title: title || null,
    state: 'available',
    status: 'ready',
    project,
    projectArtifactId: null,
    projectPath,
    localPath: null,
    localPathVerified: false,
    contentType: 'text/markdown',
    provenance,
    error: null,
    render: { kind: 'markdown', project, projectPath },
    ready: true,
    recipientRef: null,
  }
}

function safeRealpath(path) {
  try {
    if (!path) return null
    return realpathSync(path)
  } catch {
    return null
  }
}

function isSameOrInside(child, parent) {
  if (!child || !parent) return false
  const a = resolve(child)
  const b = resolve(parent)
  return a === b || a.startsWith(`${b}${sep}`)
}

function expandHome(path) {
  if (!path) return path
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function normalizeProjectPath(path) {
  return path.split(sep).join('/')
}

// Filesystem checks, not subprocesses -- identical reasoning and measurements to
// task-doc-materializer: a `git rev-parse` to answer "is this a repo / where is
// its root" cost ~47ms of blocked event loop per call. `.git` is a directory in
// a clone and a FILE in a linked worktree, so existsSync is the correct test.
function gitTopLevel(cwd) {
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
