#!/usr/bin/env node
import { createHash, randomUUID } from 'crypto'
import { gitBlobId } from '../shared/git-blob-id.mjs'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'
import { createSourceLifecycleStore } from '../server/lib/source-lifecycle.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

function usage(exitCode = 1) {
  console.error(`Usage: node bin/repair-source-replica-target.mjs --project <name> --binding-id <id> [options]

Computes and prints the retained source replica row needed to resume an already
accepted source revision. Dry-run is the default; pass --write to mutate
operations.json.

Options:
  --project <name>                 Project name, e.g. bregman
  --binding-id <id>                Source binding id to repair
  --project-dir <path>             Project directory. Default: <projects-dir>/<project>
  --projects-dir <path>            Projects root. Default: PROJECTS_DIR or server/projects
  --registry <path>                Server source binding registry JSON
  --daemon-key <key>               Override daemon key if no registry is available
  --materializations-file <path>   Daemon materializer state JSON
  --base-revision <sha256:...>     Override materialized/base revision
  --source-revision <sha256:...>   Override target revision. Default: current authority
  --write                          Apply the operations.json update
`)
  process.exit(exitCode)
}

function parseArgs(argv) {
  const args = { write: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--write') {
      args.write = true
      continue
    }
    if (arg === '--help' || arg === '-h') usage(0)
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`)
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    args[key] = value
  }
  return args
}

function readJson(path, fallback = null) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback
}

function syncFile(path) {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const pending = `${path}.pending-${process.pid}-${randomUUID()}`
  writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`)
  syncFile(pending)
  renameSync(pending, path)
  syncFile(path)
  syncFile(dirname(path))
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
  }
  return value
}

function byPath(snapshot) {
  return new Map((snapshot?.files || []).map(file => [file.path, file]))
}

function resolveDaemonKey({ registryPath, bindingId, daemonKey }) {
  if (daemonKey) return { daemonKey, bindingRegistryRow: null }
  const registry = readJson(registryPath, { bindings: {} })
  const binding = registry?.bindings?.[bindingId] || null
  if (!binding?.daemonKey) {
    throw new Error(`No daemon key found for binding ${bindingId}; pass --daemon-key or --registry`)
  }
  return { daemonKey: binding.daemonKey, bindingRegistryRow: binding }
}

function resolveBaseRevision({ materializationsFile, bindingId, baseRevision, lifecycle, project, sourceRevision }) {
  if (baseRevision) return { baseRevision, materializerBinding: null, source: 'argument' }
  const materializerState = materializationsFile ? readJson(materializationsFile, null) : null
  const materializerBinding = materializerState?.bindings?.[bindingId] || null
  if (materializerBinding?.materializedRevision) {
    return { baseRevision: materializerBinding.materializedRevision, materializerBinding, source: 'materializer' }
  }
  const target = lifecycle.readRevisionLifecycle(project, sourceRevision)
  const previous = lifecycle.listRevisionLifecycles(project)
    .filter(item => item.acceptSeq < target.acceptSeq)
    .sort((a, b) => (b.acceptSeq ?? 0) - (a.acceptSeq ?? 0))[0] || null
  if (!previous?.sourceRevision) {
    throw new Error('Could not infer base revision; pass --base-revision or --materializations-file')
  }
  return { baseRevision: previous.sourceRevision, materializerBinding: null, source: 'previous-accept-seq' }
}

async function changedFiles({ lifecycle, baseRevision, targetRevision }) {
  const base = await lifecycle.readRevision(baseRevision)
  const target = await lifecycle.readRevision(targetRevision)
  if (!base) throw new Error(`Base revision not found: ${baseRevision}`)
  if (!target) throw new Error(`Target revision not found: ${targetRevision}`)

  const baseFiles = byPath(base)
  const targetFiles = byPath(target)
  const files = []
  const blobs = {}
  const deletedFiles = []

  for (const targetFile of [...targetFiles.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    const old = baseFiles.get(targetFile.path)
    if (old?.sha256 === targetFile.sha256) continue
    const bytes = await lifecycle.readRevisionFile(targetRevision, targetFile.path)
    if (!bytes) throw new Error(`Target file content missing for ${targetFile.path}`)
    const hash = gitBlobId(bytes)
    if (targetFile.sha256 && targetFile.sha256 !== hash) {
      throw new Error(`Stored hash mismatch for ${targetFile.path}: ${targetFile.sha256} != ${hash}`)
    }
    blobs[hash] = bytes.toString('base64')
    files.push({ path: targetFile.path, content: bytes.toString('base64'), encoding: 'base64' })
  }

  for (const baseFile of [...baseFiles.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!targetFiles.has(baseFile.path)) deletedFiles.push(baseFile.path)
  }

  return {
    baseManifest: base.files || [],
    targetManifest: target.files || [],
    sourceManifest: target.manifest || (target.files || []).map(file => file.path),
    files,
    deletedFiles,
    blobs,
  }
}

const args = parseArgs(process.argv.slice(2))
if (!args.project || !args.bindingId) usage()

const projectsDir = resolve(args.projectsDir || process.env.PROJECTS_DIR || join(repoRoot, 'server', 'projects'))
const projectDir = resolve(args.projectDir || join(projectsDir, args.project))
const lifecycleRoot = join(projectDir, '.source-lifecycle')
const operationsPath = join(lifecycleRoot, 'operations.json')
const registryPath = resolve(args.registry || process.env.TLDA_SOURCE_BINDING_REGISTRY_PATH || join(process.env.TLDA_CONFIG_DIR || join(homedir(), '.config', 'tlda'), 'server-source-bindings.json'))
const materializationsFile = args.materializationsFile ? resolve(args.materializationsFile) : null

if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) throw new Error(`Project directory not found: ${projectDir}`)
if (!existsSync(operationsPath)) throw new Error(`Source lifecycle operations file not found: ${operationsPath}`)

const lifecycle = createSourceLifecycleStore({ root: lifecycleRoot })
const authority = await lifecycle.readAuthority()
const sourceRevision = args.sourceRevision || authority.currentRevision
if (!sourceRevision) throw new Error('No source revision supplied and authority has no current revision')
const revisionLifecycle = lifecycle.readRevisionLifecycle(args.project, sourceRevision)
if (!revisionLifecycle) throw new Error(`Revision ${sourceRevision} is not accepted for ${args.project}`)

const { daemonKey, bindingRegistryRow } = resolveDaemonKey({ registryPath, bindingId: args.bindingId, daemonKey: args.daemonKey })
const { baseRevision, materializerBinding, source: baseRevisionSource } = resolveBaseRevision({
  materializationsFile,
  bindingId: args.bindingId,
  baseRevision: args.baseRevision,
  lifecycle,
  project: args.project,
  sourceRevision,
})

if (baseRevision === sourceRevision) {
  throw new Error(`Base revision already equals target revision: ${sourceRevision}`)
}

const manifests = await changedFiles({ lifecycle, baseRevision, targetRevision: sourceRevision })
const operationId = `materialize:${args.bindingId}:${sourceRevision}`
const updatedAt = new Date().toISOString()
const command = stableValue({
  project: args.project,
  previousRevision: baseRevision,
  sourceRevision,
  files: manifests.files,
  deletedFiles: manifests.deletedFiles,
  sourceManifest: manifests.sourceManifest,
  sourceBindingId: null,
  requestId: null,
  baseManifest: manifests.baseManifest,
  targetManifest: manifests.targetManifest,
  blobs: manifests.blobs,
  bindingId: args.bindingId,
})
const replicaEntry = stableValue({
  state: 'pending',
  daemonKey,
  operationId,
  command,
  result: null,
  updatedAt,
})

const operations = readJson(operationsPath, {})
const currentLifecycle = operations.revisionLifecycle?.[sourceRevision]
if (!currentLifecycle || currentLifecycle.project !== args.project) {
  throw new Error(`operations.json does not contain ${args.project} lifecycle for ${sourceRevision}`)
}
const existingReplica = currentLifecycle.replicas?.[args.bindingId] || null

const patch = {
  op: existingReplica ? 'replace' : 'add',
  path: `/revisionLifecycle/${sourceRevision}/replicas/${args.bindingId}`,
  value: replicaEntry,
}

const plan = stableValue({
  dryRun: !args.write,
  project: args.project,
  projectDir,
  operationsPath,
  registryPath,
  materializationsFile,
  bindingId: args.bindingId,
  daemonKey,
  bindingRegistryRow,
  materializerBinding,
  baseRevision,
  baseRevisionSource,
  sourceRevision,
  authority,
  existingReplica,
  replicaTargetsRecorded: currentLifecycle.replicaTargetsRecorded === true,
  changedFileCount: manifests.files.length,
  deletedFileCount: manifests.deletedFiles.length,
  patch,
})

console.log(JSON.stringify(plan, null, 2))

if (!args.write) process.exit(0)

operations.revisionLifecycle[sourceRevision] = {
  ...currentLifecycle,
  replicas: {
    ...(currentLifecycle.replicas || {}),
    [args.bindingId]: replicaEntry,
  },
  replicaTargetsRecorded: true,
  updatedAt,
}
atomicJson(operationsPath, operations)
console.error(`Wrote ${operationsPath}`)
