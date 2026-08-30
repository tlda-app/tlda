import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const RELEASE_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g
const RELEASE_HTML_ASSET_RE = /<(?:img|script|source|video|audio|link)\s[^>]*\b(?:src|href)=["']([^"']+)["']/g
const RELEASE_INCLUDE_RE = /\{\{<\s*include\s+([^\s>]+)\s*>\}\}/g

function releaseRenderDependencies(content) {
  const dependencies = []
  const collect = (regex, include = false) => {
    for (const match of content.matchAll(regex)) {
      const raw = match[1].trim()
      const target = raw.startsWith('<') && raw.includes('>') ? raw.slice(1, raw.indexOf('>')) : raw.split(/\s+["'(]/, 1)[0]
      const ref = target.split(/[#?]/)[0].trim()
      if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/|~\/)/i.test(ref)) continue
      dependencies.push({ ref, include })
    }
  }
  collect(RELEASE_IMAGE_RE)
  collect(RELEASE_HTML_ASSET_RE)
  collect(RELEASE_INCLUDE_RE, true)
  return dependencies
}

function scanReleaseRenderClosure(mainFile, sourceDir) {
  const root = resolve(sourceDir)
  const queue = [String(mainFile).replace(/\\/g, '/').replace(/^\/+/, '')]
  const files = new Set()
  const missing = []
  while (queue.length) {
    const current = queue.shift()
    if (files.has(current)) continue
    const full = resolve(root, current)
    const rel = relative(root, full).replace(/\\/g, '/')
    if (!rel || rel.startsWith('../') || isAbsolute(rel)) continue
    if (!existsSync(full) || !lstatSync(full).isFile()) {
      missing.push({ from: current, ref: current })
      continue
    }
    files.add(rel)
    if (!/\.(?:qmd|md|markdown)$/i.test(rel)) continue
    for (const dependency of releaseRenderDependencies(readFileSync(full, 'utf8'))) {
      const target = resolve(dirname(full), dependency.ref)
      const targetRel = relative(root, target).replace(/\\/g, '/')
      if (!targetRel || targetRel.startsWith('../') || isAbsolute(targetRel)) continue
      if (!existsSync(target) || !lstatSync(target).isFile()) {
        missing.push({ from: rel, ref: dependency.ref })
      } else if (dependency.include && /\.(?:qmd|md|markdown)$/i.test(targetRel)) {
        queue.push(targetRel)
      } else {
        files.add(targetRel)
      }
    }
  }
  return { files: [...files].sort(), missing }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function contained(root, candidate, label) {
  const absolute = resolve(root, candidate)
  const rel = relative(resolve(root), absolute)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes ${root}: ${candidate}`)
  }
  return absolute
}

function walk(path, root = path, rows = []) {
  if (!existsSync(path)) throw new Error(`required path does not exist: ${path}`)
  const stat = lstatSync(path)
  const rel = relative(root, path) || '.'
  if (stat.isSymbolicLink()) {
    rows.push({ path: rel, type: 'symlink', target: readlinkSync(path) })
  } else if (stat.isDirectory()) {
    rows.push({ path: rel, type: 'directory' })
    for (const entry of readdirSync(path).sort()) walk(join(path, entry), root, rows)
  } else if (stat.isFile()) {
    rows.push({ path: rel, type: 'file', size: stat.size, sha256: sha256(readFileSync(path)) })
  } else {
    throw new Error(`unsupported staged artifact entry: ${path}`)
  }
  return rows
}

export function hashPath(path) {
  return sha256(stableJson(walk(resolve(path))))
}

function expandSources(courseRoot, sources, ignoredMissing = []) {
  const expanded = new Set()
  for (const source of sources) {
    const full = contained(courseRoot, source, 'source path')
    if (!existsSync(full)) throw new Error(`required path does not exist: ${full}`)
    if (lstatSync(full).isFile() && /\.(qmd|md|markdown)$/i.test(full)) {
      const closure = scanReleaseRenderClosure(source, courseRoot)
      const missing = closure.missing.filter(item => !ignoredMissing.includes(`${item.from}:${item.ref}`))
      if (missing.length) {
        const first = missing[0]
        throw new Error(`missing dependency from ${first.from}: ${first.ref}`)
      }
      for (const file of closure.files) expanded.add(file)
    } else {
      expanded.add(source)
    }
  }
  return [...expanded].sort()
}

function sourceHash(courseRoot, sources, ignoredMissing) {
  const rows = []
  for (const source of expandSources(courseRoot, sources, ignoredMissing)) {
    const full = contained(courseRoot, source, 'source path')
    rows.push({ source, entries: walk(full) })
  }
  return sha256(stableJson(rows))
}

function frontMatterRequirement(path) {
  if (!/\.(qmd|md)$/i.test(path) || !existsSync(path)) return null
  const text = readFileSync(path, 'utf8')
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return null
  const end = text.search(/\r?\n---\r?\n/)
  if (end < 0) return null
  const match = text.slice(0, end).match(/^tlda-requires:\s*["']?([0-9a-f]{7,40})["']?\s*$/mi)
  return match?.[1] || null
}

function collectRequirements(courseRoot, sources, ignoredMissing) {
  const requirements = []
  for (const source of expandSources(courseRoot, sources, ignoredMissing)) {
    const full = contained(courseRoot, source, 'source path')
    const stat = lstatSync(full)
    const files = stat.isDirectory()
      ? walk(full).filter(row => row.type === 'file').map(row => join(full, row.path))
      : [full]
    for (const file of files) {
      const required = frontMatterRequirement(file)
      if (required) requirements.push({ source: relative(courseRoot, file), sha: required })
    }
  }
  return requirements.sort((a, b) => a.source.localeCompare(b.source))
}

function validateContract(contract, contractPath) {
  if (contract?.version !== 1) throw new Error('release contract version must be 1')
  if (!contract.sourceRevision) throw new Error('release contract requires sourceRevision')
  if (!contract.releaseRoot) throw new Error('release contract requires releaseRoot')
  if (!Array.isArray(contract.artifacts) || contract.artifacts.length === 0) {
    throw new Error('release contract requires at least one artifact')
  }
  const ids = new Set()
  for (const artifact of contract.artifacts) {
    if (!artifact.id || ids.has(artifact.id)) throw new Error(`artifact id is missing or repeated: ${artifact.id || '(missing)'}`)
    ids.add(artifact.id)
    if (!['app', 'chapter', 'handout-zip', 'syllabus-index', 'full-book-assembly'].includes(artifact.kind)) {
      throw new Error(`unsupported artifact kind for ${artifact.id}: ${artifact.kind}`)
    }
    if (!Array.isArray(artifact.sources)) throw new Error(`artifact ${artifact.id} requires sources`)
    if (!artifact.owner && (!artifact.activation?.type || !artifact.activation?.path)) {
      throw new Error(`artifact ${artifact.id} requires an existing activation pointer or owner`)
    }
    if (artifact.owner && artifact.activation) {
      throw new Error(`component artifact ${artifact.id} cannot have its own activation pointer`)
    }
    if (artifact.activation && !['file', 'symlink', 'json', 'directory'].includes(artifact.activation.type)) {
      throw new Error(`artifact ${artifact.id} has unsupported activation type ${artifact.activation.type}`)
    }
  }
  for (const artifact of contract.artifacts) {
    if (!artifact.owner) continue
    const owner = contract.artifacts.find(candidate => candidate.id === artifact.owner)
    if (!owner) throw new Error(`component artifact ${artifact.id} has unknown owner ${artifact.owner}`)
    if (owner.activation?.type !== 'directory') {
      throw new Error(`component owner ${owner.id} must have one directory activation`)
    }
  }
  return { ...contract, contractPath: contractPath || contract.contractPath }
}

function gitOutput(courseRoot, args) {
  const result = spawnSync('git', args, { cwd: courseRoot, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`)
  return result.stdout.trim()
}

function verifySourceRevision(courseRoot, sourceRevision, artifacts) {
  const declared = gitOutput(courseRoot, ['rev-parse', '--verify', `${sourceRevision}^{commit}`])
  const head = gitOutput(courseRoot, ['rev-parse', '--verify', 'HEAD'])
  if (declared !== head) throw new Error(`sourceRevision ${sourceRevision} is not the course checkout HEAD ${head}`)
  const expanded = [...new Set(artifacts.flatMap(artifact => expandSources(
    courseRoot, artifact.sources, artifact.ignoreMissingDependencies || [],
  )))]
  if (expanded.length === 0) return declared
  const status = gitOutput(courseRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--', ...expanded])
  if (status) throw new Error(`release source differs from sourceRevision ${declared}:\n${status}`)
  return declared
}

export function readReleaseContract(path) {
  const contractPath = resolve(path)
  return validateContract(JSON.parse(readFileSync(contractPath, 'utf8')), contractPath)
}

export function readReleaseManifest(path) {
  const manifest = JSON.parse(readFileSync(resolve(path), 'utf8'))
  if (manifest?.version !== 1 || manifest?.state !== 'staged' || !Array.isArray(manifest.artifacts)) {
    throw new Error('not a staged release manifest')
  }
  return manifest
}

function readPointer(activation) {
  const path = resolve(activation.path)
  if (!existsSync(path)) return null
  if (activation.type === 'directory') {
    if (!lstatSync(path).isDirectory()) throw new Error(`activation path is not a directory: ${path}`)
    return hashPath(path)
  }
  if (activation.type === 'symlink') {
    if (!lstatSync(path).isSymbolicLink()) throw new Error(`activation path is not a symlink: ${path}`)
    return readlinkSync(path)
  }
  const text = readFileSync(path, 'utf8')
  return activation.type === 'json' ? JSON.parse(text) : text.replace(/\n$/, '')
}

function pointerEqual(a, b) {
  return stableJson(a) === stableJson(b)
}

function previousManifest(contract) {
  if (!contract.previousManifest) return null
  const path = resolve(contract.previousManifest)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function planCourseRelease(contractInput) {
  const contract = typeof contractInput === 'string' ? readReleaseContract(contractInput) : validateContract(contractInput)
  const courseRoot = resolve(contract.courseRoot || dirname(contract.contractPath || process.cwd()))
  const previous = previousManifest(contract)
  const sourceRevision = verifySourceRevision(courseRoot, contract.sourceRevision, contract.artifacts)
  const priorById = new Map((previous?.artifacts || []).map(artifact => [artifact.id, artifact]))
  const artifacts = contract.artifacts.map(artifact => {
    const hash = sourceHash(courseRoot, artifact.sources, artifact.ignoreMissingDependencies || [])
    const prior = priorById.get(artifact.id)
    const requirements = collectRequirements(courseRoot, artifact.sources, artifact.ignoreMissingDependencies || [])
    const desired = artifact.desired ?? null
    return {
      id: artifact.id,
      kind: artifact.kind,
      changed: prior?.sourceHash !== hash || prior?.desired !== desired,
      sourceHash: hash,
      previousSourceHash: prior?.sourceHash || null,
      requirements,
      desired,
      url: artifact.url || null,
      activation: artifact.activation,
      owner: artifact.owner || null,
      build: artifact.build || null,
      checks: artifact.checks || [],
      output: artifact.output || null,
      previousArtifact: prior || null,
    }
  })
  const artifactById = new Map(artifacts.map(artifact => [artifact.id, artifact]))
  for (const artifact of artifacts) {
    if (!artifact.owner || !artifact.changed) continue
    artifactById.get(artifact.owner).changed = true
  }
  const plan = {
    version: 1,
    state: 'planned',
    sourceRevision,
    appSha: contract.appSha || null,
    courseRoot,
    releaseRoot: resolve(contract.releaseRoot),
    previousManifest: contract.previousManifest ? resolve(contract.previousManifest) : null,
    artifacts,
  }
  return { ...plan, planHash: sha256(stableJson(plan)) }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}${detail ? `: ${detail}` : ''}`)
  }
  return result
}

function verifyRequirement(courseRoot, required, appSha, runner = run) {
  if (!appSha) throw new Error(`${required.source} requires tlda ${required.sha}, but the contract has no appSha`)
  runner('git', ['merge-base', '--is-ancestor', required.sha, appSha], { cwd: courseRoot, capture: true })
}

function runSpec(spec, courseRoot, variables, runner) {
  const replace = value => String(value).replace(/\{([A-Z_]+)\}/g, (_, key) => {
    if (!(key in variables)) throw new Error(`unknown release variable {${key}}`)
    return variables[key]
  })
  const command = replace(spec.command)
  const args = (spec.args || []).map(replace)
  const cwd = spec.cwd ? contained(courseRoot, replace(spec.cwd), 'command cwd') : courseRoot
  runner(command, args, { cwd, env: { ...process.env, TLDA_RELEASE_STAGE: variables.STAGE_DIR } })
}

function writeImmutable(path, value) {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8')
    if (existing !== value) throw new Error(`immutable release already exists with different bytes: ${path}`)
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  const pending = `${path}.pending-${process.pid}`
  writeFileSync(pending, value, { flag: 'wx' })
  renameSync(pending, path)
}

export function stageCourseRelease(plan, { runner = run } = {}) {
  if (plan?.state !== 'planned' || !plan.planHash) throw new Error('stage requires a release plan')
  const releaseId = `${plan.sourceRevision.slice(0, 12)}-${plan.planHash.slice(0, 12)}`
  const releaseDir = join(plan.releaseRoot, 'releases', releaseId)
  const artifactRoot = join(releaseDir, 'artifacts')
  const staged = []

  for (const artifact of plan.artifacts) {
    for (const requirement of artifact.requirements) {
      verifyRequirement(plan.courseRoot, requirement, plan.appSha, runner)
    }
  }

  for (const artifact of plan.artifacts.filter(item => item.owner)) {
    if (!artifact.changed && artifact.previousArtifact) {
      staged.push({ ...artifact.previousArtifact, changed: false })
      continue
    }
    const stageDir = join(artifactRoot, artifact.id)
    mkdirSync(stageDir, { recursive: true })
    const variables = { STAGE_DIR: stageDir, SOURCE_REVISION: plan.sourceRevision, APP_SHA: plan.appSha || '' }
    if (artifact.build) runSpec(artifact.build, plan.courseRoot, variables, runner)
    const output = artifact.output ? contained(plan.courseRoot, artifact.output, 'artifact output') : stageDir
    if (output !== stageDir) {
      const destination = lstatSync(output).isDirectory() ? stageDir : join(stageDir, basename(output))
      cpSync(output, destination, { recursive: true, verbatimSymlinks: true })
    }
    for (const check of artifact.checks) runSpec(check, plan.courseRoot, variables, runner)
    staged.push({
      id: artifact.id, kind: artifact.kind, changed: true, sourceHash: artifact.sourceHash,
      requirements: artifact.requirements, contentHash: hashPath(stageDir), stagedPath: stageDir,
      url: artifact.url, desired: artifact.desired, owner: artifact.owner,
    })
  }

  for (const artifact of plan.artifacts.filter(item => !item.owner)) {
    if (!artifact.changed && artifact.previousArtifact) {
      staged.push({ ...artifact.previousArtifact, changed: false, previous: readPointer(artifact.activation) })
      continue
    }
    const stageDir = join(artifactRoot, artifact.id)
    mkdirSync(stageDir, { recursive: true })
    const variables = { STAGE_DIR: stageDir, SOURCE_REVISION: plan.sourceRevision, APP_SHA: plan.appSha || '' }
    const components = staged.filter(item => item.owner === artifact.id)
    if (components.length) {
      const live = resolve(artifact.activation.path)
      if (existsSync(live)) cpSync(live, stageDir, { recursive: true, verbatimSymlinks: true })
      else if (components.some(component => !component.changed)) {
        throw new Error(`cannot assemble ${artifact.id}: live output is absent with unchanged components`)
      }
      for (const component of components.filter(item => item.changed)) {
        cpSync(component.stagedPath, stageDir, { recursive: true, verbatimSymlinks: true })
      }
    } else if (artifact.build) runSpec(artifact.build, plan.courseRoot, variables, runner)
    const output = artifact.output ? contained(plan.courseRoot, artifact.output, 'artifact output') : stageDir
    if (output !== stageDir) {
      const destination = lstatSync(output).isDirectory() ? stageDir : join(stageDir, basename(output))
      cpSync(output, destination, { recursive: true, verbatimSymlinks: true })
    }
    for (const check of artifact.checks) runSpec(check, plan.courseRoot, variables, runner)
    const contentHash = hashPath(stageDir)
    staged.push({
      id: artifact.id,
      kind: artifact.kind,
      changed: true,
      sourceHash: artifact.sourceHash,
      requirements: artifact.requirements,
      contentHash,
      stagedPath: stageDir,
      url: artifact.url,
      desired: artifact.desired,
      activation: artifact.activation,
      previous: readPointer(artifact.activation),
    })
  }

  const manifest = {
    version: 1,
    state: 'staged',
    releaseId,
    sourceRevision: plan.sourceRevision,
    appSha: plan.appSha,
    planHash: plan.planHash,
    artifacts: staged,
  }
  const manifestHash = sha256(stableJson(manifest))
  const finalManifest = { ...manifest, manifestHash }
  const manifestPath = join(releaseDir, 'release.json')
  writeImmutable(manifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`)
  return { manifest: finalManifest, manifestPath }
}

function verifyManifest(manifest) {
  const { manifestHash, ...body } = manifest
  if (sha256(stableJson(body)) !== manifestHash) throw new Error('release manifest hash does not match its contents')
  for (const artifact of manifest.artifacts) {
    if (artifact.changed && hashPath(artifact.stagedPath) !== artifact.contentHash) {
      throw new Error(`staged artifact hash changed: ${artifact.id}`)
    }
  }
}

function atomicPointerWrite(activation, value) {
  const path = resolve(activation.path)
  if (value == null) {
    rmSync(path, { recursive: true, force: true })
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  const pending = join(dirname(path), `.${basename(path)}.pending-${process.pid}`)
  rmSync(pending, { recursive: true, force: true })
  if (activation.type === 'symlink') symlinkSync(String(value), pending)
  else writeFileSync(pending, activation.type === 'json' ? `${JSON.stringify(value)}\n` : `${value}\n`, { flag: 'wx' })
  renameSync(pending, path)
}

function releaseDirForArtifact(artifact) {
  return dirname(dirname(artifact.stagedPath))
}

function activateArtifact(artifact) {
  if (artifact.activation.type !== 'directory') {
    atomicPointerWrite(artifact.activation, activationValue(artifact))
    return null
  }
  const live = resolve(artifact.activation.path)
  const releaseDir = releaseDirForArtifact(artifact)
  const previous = join(releaseDir, 'previous', artifact.id)
  if (existsSync(previous)) throw new Error(`previous directory already recorded for ${artifact.id}`)
  mkdirSync(dirname(previous), { recursive: true })
  const incoming = join(dirname(live), `.${basename(live)}.release-${process.pid}`)
  rmSync(incoming, { recursive: true, force: true })
  cpSync(artifact.stagedPath, incoming, { recursive: true, verbatimSymlinks: true })
  if (existsSync(live)) renameSync(live, previous)
  try {
    renameSync(incoming, live)
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, live)
    throw error
  }
  return previous
}

function restoreArtifact(artifact, { retainCurrent = false } = {}) {
  if (artifact.activation.type !== 'directory') {
    atomicPointerWrite(artifact.activation, artifact.previous)
    return
  }
  const live = resolve(artifact.activation.path)
  const releaseDir = releaseDirForArtifact(artifact)
  const previous = join(releaseDir, 'previous', artifact.id)
  if (retainCurrent && existsSync(live)) {
    const retired = join(releaseDir, 'retired', artifact.id)
    mkdirSync(dirname(retired), { recursive: true })
    if (existsSync(retired)) throw new Error(`retired directory already recorded for ${artifact.id}`)
    renameSync(live, retired)
  } else {
    rmSync(live, { recursive: true, force: true })
  }
  if (existsSync(previous)) renameSync(previous, live)
}

function activationValue(artifact) {
  if (artifact.desired != null) return artifact.desired
  return artifact.stagedPath
}

function activePointerValue(artifact) {
  return artifact.activation.type === 'directory' ? artifact.contentHash : activationValue(artifact)
}

export function deployCourseRelease(manifest, { failAfter = null } = {}) {
  verifyManifest(manifest)
  for (const artifact of manifest.artifacts.filter(item => item.activation)) {
    const current = readPointer(artifact.activation)
    if (!pointerEqual(current, artifact.previous)) {
      throw new Error(`activation pointer changed since stage: ${artifact.id}`)
    }
  }

  const moved = []
  try {
    for (const artifact of manifest.artifacts.filter(item => item.changed && item.activation)) {
      activateArtifact(artifact)
      moved.push(artifact)
      if (failAfter != null && moved.length === failAfter) throw new Error('injected activation failure')
    }
  } catch (error) {
    for (const artifact of moved.reverse()) restoreArtifact(artifact)
    throw error
  }
  return { releaseId: manifest.releaseId, activated: moved.map(item => item.id) }
}

export function rollbackCourseRelease(manifest) {
  verifyManifest(manifest)
  const changed = manifest.artifacts.filter(item => item.changed && item.activation)
  for (const artifact of changed) {
    const current = readPointer(artifact.activation)
    if (!pointerEqual(current, activePointerValue(artifact))) {
      throw new Error(`cannot roll back ${artifact.id}: live pointer no longer names this release`)
    }
  }
  for (const artifact of [...changed].reverse()) restoreArtifact(artifact, { retainCurrent: true })
  return { releaseId: manifest.releaseId, restored: changed.map(item => item.id) }
}

export function formatReleasePlan(plan) {
  const lines = [`source ${plan.sourceRevision}`, `app ${plan.appSha || '(unchanged)'}`]
  for (const artifact of plan.artifacts) {
    lines.push(`${artifact.changed ? 'CHANGE' : 'KEEP  '} ${artifact.kind.padEnd(18)} ${artifact.id} ${artifact.sourceHash.slice(0, 12)}${artifact.url ? ` ${artifact.url}` : ''}`)
    for (const requirement of artifact.requirements) lines.push(`       requires ${requirement.sha} (${requirement.source})`)
  }
  return lines.join('\n')
}
