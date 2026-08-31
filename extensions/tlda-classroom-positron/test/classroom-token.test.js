'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { classroomTokenFromUri } = require('../src/classroom-token')

test('accepts the registration callback and normalizes the server', () => {
  const token = 'a'.repeat(64)
  assert.deepEqual(classroomTokenFromUri({
    path: '/classroom-token',
    query: `server=${encodeURIComponent('https://pic.example/')}&token=${token}`,
  }), { server: 'https://pic.example', classroomToken: token })
})

test('rejects another path, an insecure server, and a malformed token', () => {
  const token = 'a'.repeat(64)
  assert.equal(classroomTokenFromUri({ path: '/other', query: '' }), null)
  assert.equal(classroomTokenFromUri({ path: '/classroom-token', query: `server=http://pic.example&token=${token}` }), null)
  assert.equal(classroomTokenFromUri({ path: '/classroom-token', query: 'server=https://pic.example&token=nope' }), null)
})
