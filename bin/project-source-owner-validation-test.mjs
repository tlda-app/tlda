#!/usr/bin/env node
import assert from 'node:assert/strict'

import { invalidProjectSourceEnvironmentOwners } from '../shared/project-worlds.mjs'

const invalid = invalidProjectSourceEnvironmentOwners({
  '/tmp/paper-a': 'default',
  '/tmp/paper-b': 'testing',
  '/tmp/paper-c': 'stable',
  '/tmp/paper-d': 'gone',
}, ['testing', 'stable'])

assert.deepEqual(invalid, [
  { sourceDir: '/tmp/paper-a', owner: 'default' },
  { sourceDir: '/tmp/paper-d', owner: 'gone' },
])

console.log('PASS: invalid project source-directory environment owners are reported')
