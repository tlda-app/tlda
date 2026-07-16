import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { homedir } from 'node:os'

import { createProjectPartRecord } from '../../shared/project-parts.mjs'
import { parseMarkdownPart } from '../../shared/project-parts.mjs'
import { readProject, listProjects, projectPartsRoot } from './project-store.mjs'
import {
  readProjectPartsManifest,
  upsertProjectPartsManifest,
} from './project-parts-scanner.mjs'
import {
  checkpointProjectPartWriteback,
  mergeWritebackMetadata,
} from './project-part-writeback.mjs'
import { resolveContainedPath } from './path-containment.mjs'

export const PROJECT_ARTIFACT_KIND = 'artifact'
export const PROJECT_ARTIFACT_DIR = 'parts'

export function realizeProjectMarkdownArtifact({
  project = null,
  cwd = null,
  markdown = null,
  sourcePath = null,
  title = null,
  actor = null,
  provenance = {},
  projectsProvider = listProjects,
  git = runGit,
  idFactory = randomUUID,
  now = () => new Date().toISOString(),
  writebackOptions = {},
  logger = console,
} = {}) {
  const resolved = resolveArtifactProject({ project, cwd, projectsProvider })
  if (!resolved) {
    return notReadyPayload({
      status: 'not materialized',
      title,
      sourcePath,
      provenance,
      error: 'No project resolved for artifact',
    })
  }

  const root = projectPartsRoot(resolved.name)
  let source
  try {
    source = readMarkdownArtifactSource({ markdown, sourcePath, allowedRoot: root })
  } catch (e) {
    return notReadyPayload({
      status: e.code === 'SOURCE_UNREADABLE' ? 'source unreadable' : e.code === 'SOURCE_NOT_ROUTED' ? 'owner-missing' : 'not materialized',
      title,
      sourcePath,
      provenance,
      error: e.message,
    })
  }
  mkdirSync(join(root, PROJECT_ARTIFACT_DIR), { recursive: true })

  // Re-clicking the same chip/source file should update its existing column,
  // not pile up a fresh duplicate every time — match by resolved sourcePath.
  if (sourcePath) {
    const resolvedSourcePath = resolve(expandHome(sourcePath))
    const manifest = readProjectPartsManifest(root)
    const existing = manifest.parts.find(part =>
      part.kind === PROJECT_ARTIFACT_KIND && part.metadata?.sourcePath === resolvedSourcePath
    )
    if (existing) {
      return writeProjectMarkdownArtifact({
        project: resolved.name,
        projectArtifactId: existing.id,
        markdown: source.markdown,
        title,
        actor,
        provenance,
        git,
        now,
        writebackOptions,
        logger,
      })
    }
  }

  const id = idFactory()
  const projectPath = uniqueArtifactPath(root, id)
  const localPath = join(root, projectPath)
  const artifactTitle = title || source.title || 'Untitled artifact'
  const body = stripMarkdownFrontmatter(source.markdown).trimStart()
  const content = artifactMarkdown({ id, title: artifactTitle, body })

  const writebackResult = checkpointProjectPartWriteback({
    filePath: localPath,
    content,
    now,
    ...writebackOptions,
  })
  const manifest = upsertArtifactManifest(root, {
    id,
    path: projectPath,
    title: artifactTitle,
    sourcePath: source.sourcePath || sourcePath,
    provenance,
    createdAt: now(),
    hash: sha256(content),
    writeback: writebackResult.writeback,
  })

  const actorInfo = normalizeActor(actor)
  const gitResult = commitArtifact(root, {
    projectPath,
    manifestPath: join('.tlda', 'parts.json'),
    title: artifactTitle,
    actor: actorInfo,
    git,
    logger,
    enabled: writebackResult.ok,
  })

  return artifactPayload({
    id,
    title: artifactTitle,
    project: resolved.name,
    projectRoot: root,
    projectPath,
    localPath,
    content,
    sourcePath: source.sourcePath || sourcePath,
    provenance,
    manifest,
    gitResult,
    writeback: writebackResult.writeback,
    writebackOk: writebackResult.ok,
  })
}

export function writeProjectMarkdownArtifact({
  project,
  projectArtifactId,
  projectPath = null,
  markdown,
  title = null,
  actor = null,
  provenance = {},
  git = runGit,
  now = () => new Date().toISOString(),
  writebackOptions = {},
  logger = console,
} = {}) {
  if (!project) throw new Error('Project artifact writeback requires project')
  if (!projectArtifactId && !projectPath) throw new Error('Project artifact writeback requires projectArtifactId or projectPath')
  if (markdown == null) throw new Error('Project artifact writeback requires markdown')

  const root = projectPartsRoot(project)
  const manifest = readProjectPartsManifest(root)
  const normalizedPath = projectPath ? normalizeProjectPath(projectPath) : null
  const existing = manifest.parts.find(part =>
    (projectArtifactId && part.id === projectArtifactId) ||
    (normalizedPath && part.path === normalizedPath)
  )
  if (!existing) throw new Error('Project artifact is not in the parts manifest')
  if (existing.kind !== PROJECT_ARTIFACT_KIND) throw new Error(`Project part ${existing.id} is not an artifact`)

  const targetPath = normalizeProjectPath(existing.path || existing.storage?.path)
  if (!targetPath || targetPath.includes('\0') || targetPath.startsWith('/') || targetPath.split('/').includes('..')) {
    throw new Error('Project artifact has invalid path')
  }
  const localPath = join(root, targetPath)
  if (!existsSync(localPath)) throw new Error('Project artifact file is missing')

  const parsed = parseMarkdownPart(String(markdown), { contextualTitle: existing.title })
  if (parsed.id && parsed.id !== existing.id) {
    throw new Error(`Project artifact id mismatch: expected ${existing.id}, got ${parsed.id}`)
  }
  const nextTitle = title || parsed.title || existing.title || 'Untitled artifact'
  const body = stripMarkdownFrontmatter(String(markdown)).trimStart()
  const content = artifactMarkdown({ id: existing.id, title: nextTitle, body })
  const writebackResult = checkpointProjectPartWriteback({
    filePath: localPath,
    content,
    part: existing,
    now,
    ...writebackOptions,
  })
  const updatedAt = now()

  const nextManifest = upsertArtifactManifest(root, {
    id: existing.id,
    path: targetPath,
    title: nextTitle,
    sourcePath: existing.metadata?.sourcePath || null,
    provenance: {
      ...(existing.metadata?.provenance || {}),
      ...provenance,
    },
    createdAt: existing.metadata?.createdAt || updatedAt,
    updatedAt,
    hash: sha256(content),
    writeback: writebackResult.writeback,
  })

  const actorInfo = normalizeActor(actor)
  const gitResult = commitArtifact(root, {
    projectPath: targetPath,
    manifestPath: join('.tlda', 'parts.json'),
    title: nextTitle,
    actor: actorInfo,
    git,
    logger,
    messagePrefix: 'Update markdown artifact',
    enabled: writebackResult.ok,
  })

  return artifactPayload({
    id: existing.id,
    title: nextTitle,
    project,
    projectRoot: root,
    projectPath: targetPath,
    localPath,
    content,
    sourcePath: existing.metadata?.sourcePath || null,
    provenance: {
      ...(existing.metadata?.provenance || {}),
      ...provenance,
      updatedAt,
    },
    manifest: nextManifest,
    gitResult,
    writeback: writebackResult.writeback,
    writebackOk: writebackResult.ok,
  })
}

export function resolveArtifactProject({ project = null, cwd = null, projectsProvider = listProjects } = {}) {
  const projects = projectsProvider().map(p => ({
    ...p,
    partsRoot: p.partsRoot || safeProjectPartsRoot(p.name),
    sourceRoot: p.sourceDir || null,
  })).filter(p => p.name)

  if (project) {
    const match = projects.find(p => p.name === project) || (readProject(project) ? { name: project, partsRoot: safeProjectPartsRoot(project) } : null)
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

function readMarkdownArtifactSource({ markdown, sourcePath, allowedRoot = null }) {
  if (markdown != null) {
    const text = String(markdown)
    return { markdown: text, title: titleFromMarkdown(text) }
  }
  if (sourcePath) {
    const attempted = resolve(expandHome(sourcePath))
    let resolved
    try {
      resolved = resolveContainedPath(allowedRoot, expandHome(sourcePath))
    } catch {
      const err = new Error(`Source markdown is not routed through the project owner: ${attempted}`)
      err.code = 'SOURCE_NOT_ROUTED'
      throw err
    }
    try {
      const text = readFileSync(resolved, 'utf8')
      return { markdown: text, title: titleFromMarkdown(text), sourcePath: resolved }
    } catch (e) {
      const err = new Error(`Source markdown is not readable: ${resolved}`)
      err.code = 'SOURCE_UNREADABLE'
      err.cause = e
      throw err
    }
  }
  throw new Error('Project artifact materialization requires markdown or sourcePath')
}

function upsertArtifactManifest(root, { id, path, title, sourcePath, provenance, createdAt, updatedAt, hash, writeback = null }) {
  const part = createProjectPartRecord({
    id,
    kind: PROJECT_ARTIFACT_KIND,
    path,
    title,
    storage: { type: 'project', path },
    metadata: mergeWritebackMetadata(compactObject({
      sourcePath: sourcePath ? resolve(expandHome(sourcePath)) : null,
      provenance,
      createdAt,
      updatedAt,
      hash,
    }), writeback),
  })
  return upsertProjectPartsManifest(root, part)
}

function artifactMarkdown({ id, title, body }) {
  return [
    '---',
    `tlda-id: ${id}`,
    `tlda-kind: ${PROJECT_ARTIFACT_KIND}`,
    `title: ${yamlScalar(title)}`,
    '---',
    '',
    body || `# ${title}`,
    '',
  ].join('\n')
}

function uniqueArtifactPath(root, id) {
  const shortId = id.replace(/-/g, '').slice(0, 8)
  let candidate = join(PROJECT_ARTIFACT_DIR, `${shortId}.md`)
  let n = 1
  while (existsSync(join(root, candidate))) {
    candidate = join(PROJECT_ARTIFACT_DIR, `${shortId}-${n}.md`)
    n++
  }
  return normalizeProjectPath(candidate)
}

function artifactPayload({ id, title, project, projectRoot, projectPath, localPath, content, sourcePath, provenance, manifest, gitResult, writeback = null, writebackOk = true }) {
  const readable = writebackOk && isReadableFile(localPath)
  const ref = artifactRecipientRef({
    id,
    title,
    projectPath,
    localPath: readable ? localPath : null,
    hash: sha256(content),
    sourceAgent: provenance.sourceAgent || provenance.source_agent || null,
    provenance,
  })
  return {
    kind: PROJECT_ARTIFACT_KIND,
    title,
    state: readable ? 'available' : 'failed',
    status: readable ? 'ready' : writeback?.status || 'not materialized',
    project,
    projectArtifactId: id,
    projectPath,
    localPath: readable ? localPath : null,
    localPathVerified: readable,
    targetPath: localPath,
    contentType: 'text/markdown',
    hash: sha256(content),
    sourceAgent: provenance.sourceAgent || provenance.source_agent || null,
    provenance: compactObject({
      ...provenance,
      sourcePath: sourcePath ? resolve(expandHome(sourcePath)) : null,
    }),
    writeback,
    error: readable ? null : writeback?.message || 'Artifact writeback did not land',
    render: {
      kind: 'markdown',
      project,
      projectPath,
      localPath: readable ? localPath : null,
    },
    git: gitResult,
    manifestPath: join(projectRoot, '.tlda', 'parts.json'),
    ready: readable,
    recipientRef: readable ? ref : null,
    manifest,
  }
}

function notReadyPayload({ status, title, sourcePath, provenance, error }) {
  return {
    kind: PROJECT_ARTIFACT_KIND,
    title: title || null,
    state: 'failed',
    status,
    projectArtifactId: null,
    localPath: null,
    localPathVerified: false,
    targetPath: sourcePath ? resolve(expandHome(sourcePath)) : null,
    contentType: 'text/markdown',
    sourceAgent: provenance?.sourceAgent || provenance?.source_agent || null,
    provenance,
    error,
    ready: false,
    recipientRef: null,
  }
}

function artifactRecipientRef({ id, title, projectPath, localPath, hash, sourceAgent, provenance }) {
  return {
    kind: PROJECT_ARTIFACT_KIND,
    state: 'available',
    status: 'ready',
    title,
    localPath,
    projectPath,
    projectArtifactId: id,
    contentType: 'text/markdown',
    hash,
    sourceAgent,
    provenance,
  }
}

function commitArtifact(root, { projectPath, manifestPath, title, actor, git, logger, messagePrefix = 'Realize markdown artifact', enabled = true }) {
  if (!enabled) return { committed: false, skipped: true, reason: 'writeback-not-landed' }
  if (!isGitRepo(root, git)) return { committed: false, reason: 'not a git repo' }
  try {
    git(['add', projectPath, manifestPath], root)
    const status = git(['status', '--porcelain=v1', '--', projectPath, manifestPath], root)
    if (!status.trim()) return { committed: false, reason: 'no changes' }
    const message = `${messagePrefix}: ${truncate(title, 72)}`
    git([
      '-c', `user.name=${actor.name}`,
      '-c', `user.email=${actor.email}`,
      'commit',
      `--author=${actor.name} <${actor.email}>`,
      '-m', message,
      '--',
      projectPath,
      manifestPath,
    ], root)
    const hash = git(['rev-parse', 'HEAD'], root)
    return { committed: true, hash, version: hash, message, author: `${actor.name} <${actor.email}>` }
  } catch (e) {
    logger.warn?.(`[project-artifact] git writeback skipped in ${root}: ${e.message}`)
    return { committed: false, reason: e.message }
  }
}

function normalizeActor(actor) {
  if (!actor) return { name: 'project-artifact', email: 'project-artifact@tlda.local' }
  if (typeof actor === 'string') return { name: actor, email: actor }
  return {
    name: actor.friendlyName || actor.friendly_name || actor.name || actor.id || 'project-artifact',
    email: actor.fleetId || actor.fleet_id || actor.email || actor.id || 'project-artifact@tlda.local',
  }
}

function titleFromMarkdown(markdown) {
  const body = stripMarkdownFrontmatter(markdown)
  const heading = body.match(/^#\s+(.+?)\s*$/m)
  if (heading) return heading[1].replace(/\s*\{#[\w-]+\}\s*$/, '').trim()
  const first = body.split(/\r?\n/).map(line => line.trim()).find(Boolean)
  return first ? truncate(first.replace(/[*_`~[\]()]/g, ''), 80) : null
}

function stripMarkdownFrontmatter(markdown) {
  return String(markdown ?? '').replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
}

function yamlScalar(value) {
  return JSON.stringify(String(value ?? 'Untitled artifact'))
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex')
}

function isReadableFile(path) {
  try {
    if (!path || !existsSync(path)) return false
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

function isGitRepo(dir, git = runGit) {
  try {
    git(['rev-parse', '--is-inside-work-tree'], dir)
    return true
  } catch {
    return false
  }
}

function gitTopLevel(cwd) {
  try {
    return runGit(['rev-parse', '--show-toplevel'], cwd)
  } catch {
    return null
  }
}

function safeProjectPartsRoot(name) {
  try {
    if (!name || !readProject(name)) return null
    return projectPartsRoot(name)
  } catch {
    return null
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

function compactObject(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, value]) => value != null))
}

function truncate(value, max) {
  const s = String(value ?? '')
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`
}

function runGit(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
