import fs from 'fs'
import path from 'path'
import { builtinModules } from 'module'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// The live image installs dependencies from `server/package.json`, not from the
// repo root -- `Dockerfile.live` does `COPY server/package.json ./package.json`
// then `npm install --production`. A package declared only in the ROOT
// package.json is therefore present for `tsc`, for `node --test` and for every
// local run, because all three resolve against the root `node_modules`, and
// absent in production. It surfaces as a boot crash-loop after deploy.
//
// That happened on 2026-08-08: a `server/` file imported `fflate`, declared at
// the root only, and crash-looped testing for eleven minutes behind a clean
// typecheck and a green suite.
//
// SCOPE: the boot graph, not the shipped tree. Only what actually runs is
// followed, reached transitively from the entrypoints below.
//
// Transitive matters here. The rule is `server/` AND `shared/`, because the
// Dockerfile renames the manifest to /app/package.json so both trees resolve
// against one /app/node_modules -- so a bare import added under `shared/` fails
// identically. This walk covers it: 51 of the 148 files it reads on current main
// are under `shared/`, and injecting a bare import into shared/fleet-labels.mjs
// is reported. A `server/`-only scan would miss that.
//
// Walking every SHIPPED file, on the other hand, finds true-but-unactionable
// things -- `scripts/e2e-test.mjs` ships and imports `puppeteer-core`, genuinely
// absent from the image and never executed there. Reporting those is how an
// alarm earns a mute.
const ENTRYPOINTS = [
  'server/unified-server.mjs',
  'bin/build-worker.mjs',
  'bin/feelings-export.mjs',
]

// The COPY lines in `Dockerfile.live`. A relative import that leaves these
// resolves locally and is absent in the image, which fails the same way. Those
// lines carry a comment pointing at this array; if a COPY is added or removed
// there and not here, this check goes quietly out of date, which is exactly the
// failure mode it exists to stop.
const SHIPPED_PATHS = [
  'server/lib', 'server/routes', 'server/unified-server.mjs',
  'server/qualifications-default.json', 'server/build-info.json',
  'shared', 'scripts', 'config/deployments',
  'agent-launch', 'agent-runtime', 'daemon', 'migrations', 'cli/lib',
  'bin/feelings-export.mjs', 'bin/build-worker.mjs', 'dist',
]

const BUILTINS = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])
const RESOLVE_EXTENSIONS = ['', '.mjs', '.js', '.ts', '.mts', '.cjs', '/index.mjs', '/index.js', '/index.ts']

// Anchored at a line-start `import`/`export`, which is what a static import
// statement always is, and the span up to `from` excludes quotes, backticks and
// semicolons, which no real import clause contains.
//
// An unanchored `from '...'` instead matches SQL inside the template literals
// this codebase is full of: the first version of this check reported 27 of those
// as missing packages, a ~99% false-positive rate on its own first run. Every
// one was a line-start `export` whose template literal happened to contain the
// word `from` followed by a quote, several hundred characters later.
const SPECIFIER_PATTERNS = [
  /^\s*(?:import|export)(?![\w$])[^'"`;]{0,400}?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /^\s*(?:const|let|var)?[^'"`;]{0,120}?\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
]

export function specifiersIn(source) {
  const found = new Set()
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.add(match[1])
  }
  return [...found]
}

// `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`; relative -> null.
export function packageOfSpecifier(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null
  if (BUILTINS.has(specifier)) return null
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

function resolveRelative(fromFile, specifier, exists) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = base + extension
    if (exists(candidate)) return candidate
  }
  return null
}

function isShipped(repoRoot, absolute) {
  const relative = path.relative(repoRoot, absolute)
  if (relative.startsWith('..')) return false
  return SHIPPED_PATHS.some(shipped => relative === shipped || relative.startsWith(`${shipped}/`))
}

// Which manifest ships is a fact stated in the Dockerfile -- `COPY <path>
// ./package.json` -- so it is read from there rather than hard-coded. A guard
// that hard-codes `server/package.json` is asserting something it has not
// checked, and a guard that is wrong for a reason unrelated to the question it
// answers is the same failure it exists to prevent, automated and trusted more.
// If that COPY line moves, this returns null and the check reports that it could
// not determine the shipped manifest, rather than silently checking the wrong one.
export function shippedManifestPath(dockerfileSource) {
  const match = String(dockerfileSource || '').match(/^\s*COPY\s+(\S+)\s+\.\/package\.json\s*$/m)
  return match ? match[1] : null
}

export function checkServerImports({
  repoRoot,
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  exists = (file) => { try { return fs.statSync(file).isFile() } catch { return false } },
} = {}) {
  const dockerfilePath = path.join(repoRoot, 'Dockerfile.live')
  let manifestRelative
  try {
    manifestRelative = shippedManifestPath(readFile(dockerfilePath))
  } catch (e) {
    throw new Error(`cannot read ${dockerfilePath}: ${e.message}`)
  }
  if (!manifestRelative) {
    throw new Error(`${dockerfilePath} has no \`COPY <path> ./package.json\` line, so the shipped dependency manifest cannot be determined`)
  }
  const manifestPath = path.join(repoRoot, manifestRelative)
  let manifest
  try {
    manifest = JSON.parse(readFile(manifestPath))
  } catch (e) {
    throw new Error(`cannot read ${manifestPath}: ${e.message}`)
  }
  const declared = new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
  ])

  const missing = []
  const unshipped = []
  const unresolved = []
  const visited = new Set()
  const queue = ENTRYPOINTS.map(entry => path.join(repoRoot, entry)).filter(exists)

  while (queue.length) {
    const file = queue.pop()
    if (visited.has(file)) continue
    visited.add(file)
    let source
    try {
      source = readFile(file)
    } catch (e) {
      throw new Error(`cannot read ${file}: ${e.message}`)
    }
    for (const specifier of specifiersIn(source)) {
      const pkg = packageOfSpecifier(specifier)
      if (pkg) {
        if (!declared.has(pkg)) missing.push({ file: path.relative(repoRoot, file), specifier, pkg })
        continue
      }
      if (!specifier.startsWith('.')) continue
      const target = resolveRelative(file, specifier, exists)
      if (!target) {
        unresolved.push({ file: path.relative(repoRoot, file), specifier })
        continue
      }
      if (!isShipped(repoRoot, target)) {
        unshipped.push({ file: path.relative(repoRoot, file), specifier, target: path.relative(repoRoot, target) })
        continue
      }
      queue.push(target)
    }
  }

  return { reachable: visited.size, declared: declared.size, manifest: manifestRelative, missing, unshipped, unresolved }
}

export function describeServerImportFailures({ missing, unshipped, unresolved }) {
  const blocks = []
  if (missing.length) {
    blocks.push([
      '**Imported on the server boot path, not declared in `server/package.json`:**',
      '',
      ...missing.map(entry => `- \`${entry.pkg}\` — \`${entry.file}\` imports \`${entry.specifier}\``),
      '',
      'The live image installs from `server/package.json`, so these resolve locally against the root `node_modules` and are absent in production. A typecheck and the test suite pass; the deploy crash-loops.',
    ].join('\n'))
  }
  if (unshipped.length) {
    blocks.push([
      '**On the boot path, not copied into the image by `Dockerfile.live`:**',
      '',
      ...unshipped.map(entry => `- \`${entry.file}\` imports \`${entry.specifier}\` → \`${entry.target}\``),
    ].join('\n'))
  }
  if (unresolved.length) {
    blocks.push([
      '**On the boot path, does not resolve to a file at all:**',
      '',
      ...unresolved.map(entry => `- \`${entry.file}\` imports \`${entry.specifier}\``),
    ].join('\n'))
  }
  return blocks.join('\n\n')
}

// --- CLI ------------------------------------------------------------------
//
// `node scripts/check-server-imports.mjs <repoRoot>` — exit 0 clean, 1 with
// findings, 2 if the check itself could not run. That third code matters: a
// guard that cannot read the Dockerfile must not pass quietly, because a silent
// pass is indistinguishable from a clean tree and this exists to stop exactly
// that class of thing.
//
// Dependency-free by construction — only `node:fs`, `node:path`, `node:module`,
// `node:url`. The pre-receive hook runs this against an extracted archive BEFORE
// `npm ci`, so anything it imported from node_modules would make it unrunnable
// there.
//
// The entry test resolves symlinks and encodes the path, and both halves are
// load-bearing. The obvious `import.meta.url === \`file://${process.argv[1]}\``
// is wrong on macOS in exactly the place this runs: pre-receive extracts to
// `mktemp -d`, which is under `/var/folders/...`, while `import.meta.url`
// reports the realpath `/private/var/folders/...`. They never match, the block
// never runs, node exits 0, and the hook reads that as a clean tree.
//
// That is not hypothetical — it is what this file did when first wired in, and
// the hook accepted a push carrying the very `yjs` import it was added to catch.
// A guard that silently does not run is the failure it exists to stop.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const repoRoot = process.argv[2] || process.cwd()
  let result
  try {
    result = checkServerImports({ repoRoot })
  } catch (e) {
    console.error(`server import check could not run: ${e.message}`)
    process.exit(2)
  }
  const failed = result.missing.length + result.unshipped.length + result.unresolved.length
  if (!failed) {
    console.log(`server import check: ${result.reachable} files on the boot path, ${result.declared} packages declared in ${result.manifest}, nothing missing`)
    process.exit(0)
  }
  console.error(describeServerImportFailures(result))
  process.exit(1)
}
