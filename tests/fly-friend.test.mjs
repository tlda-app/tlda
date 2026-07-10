import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { flyVolumeName } from '../cli/lib/fly/router.mjs'

test('friend box volume names fit Fly 30-character limit with stable hash suffixes', () => {
  const render = flyVolumeName('coauthors-synth-combined_data')
  const agent = flyVolumeName('coauthors-synth-combined_agent_data')

  assert.equal(render.length <= 30, true)
  assert.equal(agent.length <= 30, true)
  assert.equal(render, 'coauthors_synth_combined_data')
  assert.match(agent, /^coauthors_synth_combin[a-z_]*_[a-f0-9]{6}$/)
  assert.notEqual(render, agent)
  assert.equal(flyVolumeName('coauthors-synth-combined_agent_data'), agent)
})

test('friend box auth trusts Fly token secrets instead of stale generic token config', () => {
  const script = `
    import { initAuth, validateToken } from './server/lib/auth.mjs'
    initAuth()
    if (validateToken('new-rw') !== 'rw') throw new Error('rw secret did not validate')
    if (validateToken('new-read') !== 'read') throw new Error('read secret did not validate')
    if (validateToken('stale-volume-token') !== null) throw new Error('stale config token validated')
  `
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PORT: '5176',
      TLDA_FLEET_SERVER: 'https://friend-box.example.test',
      TLDA_TOKEN_RW: 'new-rw',
      TLDA_TOKEN_READ: 'new-read',
      TLDA_TOKEN: 'stale-volume-token',
    },
  })

  assert.equal(res.status, 0, res.stderr || res.stdout)
})

test('friend box auth fails closed when Fly token secrets are missing', () => {
  const script = `
    import { initAuth } from './server/lib/auth.mjs'
    initAuth()
  `
  const env = { ...process.env, PORT: '5176', TLDA_FLEET_SERVER: 'https://friend-box.example.test' }
  delete env.TLDA_TOKEN
  delete env.TLDA_TOKEN_RW
  delete env.TLDA_TOKEN_READ
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  })

  assert.notEqual(res.status, 0)
  assert.match(res.stderr, /TLDA_FLEET_SERVER is set but no TLDA_TOKEN_READ\/TLDA_TOKEN_RW/)
})
