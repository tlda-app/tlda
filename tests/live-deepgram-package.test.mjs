import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))

test('live Deepgram runtime COPY owns its import closure and binds without cloud access', async t => {
  const dockerfile = await readFile(join(repo, 'Dockerfile.live'), 'utf8')
  assert.match(dockerfile, /^COPY bin\/deepgram-runtime\/ \.\/bin\/deepgram-runtime\/$/m)
  assert.doesNotMatch(dockerfile, /^COPY bin\/deepgram-[^/]+\.mjs /m)

  const imageRoot = await mkdtemp(join(tmpdir(), 'tlda-deepgram-image-'))
  await mkdir(join(imageRoot, 'bin'), { recursive: true })
  await cp(join(repo, 'bin/deepgram-runtime'), join(imageRoot, 'bin/deepgram-runtime'), { recursive: true })
  await symlink(join(repo, 'shared'), join(imageRoot, 'shared'))
  const nodeModules = process.env.TLDA_PACKAGE_NODE_MODULES || join(repo, 'node_modules')
  await symlink(nodeModules, join(imageRoot, 'node_modules'))

  const bridgePath = join(imageRoot, 'bin/deepgram-runtime/deepgram-sdk-bridge.mjs')
  const bridgeSource = await readFile(bridgePath, 'utf8')
  const localImports = [...bridgeSource.matchAll(/from ['"](\.[^'"]+)['"]/g)].map(match => match[1])
  assert.ok(localImports.includes('./deepgram-epoch-state.mjs'))
  for (const specifier of localImports) {
    await import(new URL(specifier, `file://${bridgePath}`))
  }

  const child = spawn(process.execPath, [bridgePath, '--port', '0'], {
    cwd: imageRoot,
    env: { ...process.env, DEEPGRAM_API_KEY: 'package-smoke-do-not-connect' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill('SIGTERM'))

  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  await Promise.race([
    new Promise((resolve, reject) => {
      const poll = setInterval(() => {
        if (output.includes('WebSocket server on')) {
          clearInterval(poll)
          resolve()
        }
      }, 10)
      child.once('exit', code => {
        clearInterval(poll)
        reject(new Error(`bridge exited before local bind (code ${code}): ${output}`))
      })
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`bridge startup timed out: ${output}`)), 3000)),
  ])

  assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND/)
  assert.doesNotMatch(output, /connected to Deepgram/)
})
