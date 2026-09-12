import assert from 'node:assert/strict'
import test from 'node:test'
import { validateServerConfigTopLevel } from '../../shared/daemon-config-schema.mjs'

const valid = {
  account: 'agents@example.com',
  replyDomain: 'example.com',
  replySecretEnv: 'TLDA_EMAIL_REPLY_SECRET',
  transport: {
    kind: 'smtp', host: 'smtp.example.com', port: 465, secure: true,
    username: 'agents@example.com', passwordEnv: 'TLDA_EMAIL_PASSWORD',
  },
  inbound: {
    kind: 'imap', host: 'imap.example.com', port: 993, secure: true,
    username: 'agents@example.com', passwordEnv: 'TLDA_EMAIL_PASSWORD', pollInterval: '30s',
  },
  identities: {
    'fleet:example': { address: 'person@example.net', verified: true },
  },
}

test('private server email configuration passes the closed schema', () => {
  assert.deepEqual(validateServerConfigTopLevel({ email: valid }).email, valid)
})

test('email bindings must explicitly carry verified identity authority', () => {
  assert.throws(() => validateServerConfigTopLevel({ email: {
    ...valid,
    identities: { 'fleet:example': { address: 'person@example.net' } },
  } }), /verified: true/)
})

test('email config refuses inline secrets and unknown provider keys', () => {
  assert.throws(() => validateServerConfigTopLevel({ email: { ...valid, password: 'secret' } }), /unknown key/)
  assert.throws(() => validateServerConfigTopLevel({ email: {
    ...valid,
    transport: { ...valid.transport, password: 'secret' },
  } }), /unknown key/)
})

test('SMTP credentials cannot be configured over a plaintext connection', () => {
  assert.throws(() => validateServerConfigTopLevel({ email: {
    ...valid,
    transport: { ...valid.transport, secure: false },
  } }), /secure must be true/)
})
