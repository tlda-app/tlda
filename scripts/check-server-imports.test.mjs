import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { checkServerImports } from './check-server-imports.mjs'

test('a createRequire dependency must be declared by the manifest copied into the live image', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-server-import-require-'))
  try {
    fs.mkdirSync(path.join(root, 'server'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Dockerfile.live'), 'COPY server/package.json ./package.json\n')
    fs.writeFileSync(path.join(root, 'server', 'package.json'), JSON.stringify({ dependencies: {} }))
    fs.writeFileSync(path.join(root, 'server', 'unified-server.mjs'), [
      "import { createRequire } from 'node:module'",
      'const require = createRequire(import.meta.url)',
      "const QRCode = require('qrcode-terminal/vendor/QRCode')",
      'void QRCode',
      '',
    ].join('\n'))

    const missing = checkServerImports({ repoRoot: root })
    assert.deepEqual(missing.missing, [{
      file: 'server/unified-server.mjs',
      specifier: 'qrcode-terminal/vendor/QRCode',
      pkg: 'qrcode-terminal',
    }])

    fs.writeFileSync(path.join(root, 'server', 'package.json'), JSON.stringify({
      dependencies: { 'qrcode-terminal': '^0.12.0' },
    }))
    assert.deepEqual(checkServerImports({ repoRoot: root }).missing, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
