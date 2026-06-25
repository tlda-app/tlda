import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const forkPackagesDir = path.join(root, 'tldraw-fork', 'packages')

const runtimePackages = ['utils', 'state', 'validate', 'store', 'tlschema', 'sync-core']

const external = [
  '@babel/*',
  '@vitejs/*',
  'vite',
  'vitest',
  'typescript',
  'react',
  'react-dom',
]

async function updatePackageJson(pkg) {
  const packageJsonPath = path.join(forkPackagesDir, pkg, 'package.json')
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'))

  packageJson.main = './dist-esm/index.mjs'
  packageJson.module = './dist-esm/index.mjs'
  packageJson.exports = {
    '.': {
      types: packageJson.types ?? './.tsbuild/index.d.ts',
      import: './dist-esm/index.mjs',
    },
  }

  await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
}

async function buildPackage(pkg) {
  const packageDir = path.join(forkPackagesDir, pkg)
  const entryPoint = path.join(packageDir, 'src', 'index.ts')
  const outfile = path.join(packageDir, 'dist-esm', 'index.mjs')

  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node23',
    minify: true,
    sourcemap: false,
    packages: 'bundle',
    external,
    logLevel: 'info',
  })

  await updatePackageJson(pkg)
}

for (const pkg of runtimePackages) {
  await buildPackage(pkg)
}
