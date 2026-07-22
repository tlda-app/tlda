#!/usr/bin/env node
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const root = mkdtempSync(join(tmpdir(), 'tlda-sandbox-authority-'))
const source = join(root, 'source')
const output = join(root, 'output')
const plist = join(output, 'sandbox.plist')
mkdirSync(source, { recursive: true })

writeFileSync(join(source, 'daemon.yaml'), `
defaultServer: source
machineId: shared-live-machine
servers:
  source:
    database: https://isolated-db.example
    store: https://isolated-store.example
    licenseKey: ISOLATED-LICENSE
`)
writeFileSync(join(source, 'tokens.json'), JSON.stringify({ tokenRw: 'isolated-token' }))

try {
  const sourceEnv = { ...process.env, TLDA_CONFIG_DIR: source, TLDA_CONFIG: 'source' }
  delete sourceEnv.TLDA_MACHINE_ID
  execFileSync(process.execPath, [
    'cli/tlda.mjs', 'daemon', 'write-test-plist',
    '--dir', output, '--plist', plist,
  ], {
    cwd: new URL('..', import.meta.url).pathname,
    env: sourceEnv,
    stdio: 'pipe',
  })

  const configDir = join(output, 'config')
  const plistText = readFileSync(plist, 'utf8')
  const resolved = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    const c = await import('./shared/config.mjs');
    console.log(JSON.stringify({
      database: c.getFleetServerUrl(),
      store: c.getServerUrl(),
      token: c.getRwToken(),
      machineId: c.getMachineId(),
      name: c.getActiveConfigName(),
    }));
  `], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...sourceEnv, TLDA_CONFIG_DIR: configDir, TLDA_CONFIG: 'sandbox' },
    encoding: 'utf8',
  }).trim())

  const checks = [
    ['sandbox database is isolated target', resolved.database === 'https://isolated-db.example'],
    ['sandbox store is isolated target', resolved.store === 'https://isolated-store.example'],
    ['sandbox token comes from isolated token authority', resolved.token === 'isolated-token'],
    ['sandbox has its own machine identity', resolved.machineId !== 'shared-live-machine' && resolved.machineId.includes('SANDBOXTEST')],
    ['sandbox selects its generated server name', resolved.name === 'sandbox'],
    ['plist selects shared config directory', plistText.includes('<key>TLDA_CONFIG_DIR</key>') && plistText.includes(configDir)],
    ['plist selects daemon state directory', plistText.includes('<key>TLDA_DAEMON_CONFIG_DIR</key>') && plistText.includes(configDir)],
    ['retired config file is not generated', !existsSync(join(configDir, 'config.json'))],
  ]
  const failed = checks.filter(([, ok]) => !ok)
  for (const [name, ok] of checks) console.log(`${ok ? '  ok  ' : '  FAIL '}${name}`)
  if (failed.length) process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
