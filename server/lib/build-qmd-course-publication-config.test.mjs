import assert from 'node:assert/strict'
import test from 'node:test'

import { coursePublicationGenerator } from './build-qmd.mjs'

test('course publication generator is absent for an unconfigured project', () => {
  assert.equal(coursePublicationGenerator('ordinary', JSON.stringify({
    course: {
      repository: 'https://example.com/course-site.git',
      revision: 'a'.repeat(40),
    },
  })), null)
})

test('course publication generator requires a reproducible repository revision', () => {
  assert.deepEqual(coursePublicationGenerator('course', JSON.stringify({
    course: {
      repository: 'https://example.com/course-site.git',
      revision: 'A'.repeat(40),
    },
  })), {
    repository: 'https://example.com/course-site.git',
    revision: 'a'.repeat(40),
    builder: 'build-site.py',
    requirements: 'requirements.txt',
  })
  assert.throws(
    () => coursePublicationGenerator('course', '{"course":{"repository":"https://example.com/course-site.git","revision":"main"}}'),
    /exact 40-character Git revision/,
  )
})

test('course publication generator rejects local machine paths', () => {
  assert.throws(
    () => coursePublicationGenerator('course', JSON.stringify({
      course: { repository: '/Users/skip/work/site', revision: 'a'.repeat(40) },
    })),
    /HTTPS repository/,
  )
})
