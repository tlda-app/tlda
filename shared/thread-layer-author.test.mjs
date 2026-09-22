import test from 'node:test'
import assert from 'node:assert/strict'
import {
  threadAuthorBelongsToAnswer,
  threadLayerAuthor,
  threadSpeakerLabel,
} from './thread-layer-author.mjs'

const ANSWER = { submissionRoomId: 'doc-sub-ada', problemId: 'ans-ex3' }
const INSTRUCTOR = { role: 'instructor', instructorId: 'sam' }
const ADA = { role: 'student', studentId: 'ada' }
const BO = { role: 'student', studentId: 'bo' }

test('the instructor records as instructor, the answering student as themselves', () => {
  assert.deepEqual(threadLayerAuthor({ principal: INSTRUCTOR, answer: ANSWER }), { role: 'instructor' })
  assert.deepEqual(threadLayerAuthor({ principal: ADA, answer: ANSWER }), { role: 'student', studentId: 'ada' })
})

test('a lecture records no author, and nobody records none', () => {
  assert.equal(threadLayerAuthor({ principal: INSTRUCTOR, answer: null }), null)
  assert.equal(threadLayerAuthor({ principal: INSTRUCTOR, answer: {} }), null)
  assert.equal(threadLayerAuthor({ principal: null, answer: ANSWER }), null)
})

test('a client-supplied author is never consulted — only the principal decides', () => {
  // There is no parameter for it: the signature takes principal and answer
  // only, so a body claiming `author: { role: 'instructor' }` has nowhere to go.
  assert.deepEqual(
    threadLayerAuthor({ principal: ADA, answer: ANSWER, author: { role: 'instructor' } }),
    { role: 'student', studentId: 'ada' },
  )
})

test('a student author must be the answer’s own student', () => {
  assert.equal(
    threadAuthorBelongsToAnswer({ author: { role: 'instructor' }, answer: ANSWER, submissionOwnerId: 'ada' }),
    true,
  )
  assert.equal(
    threadAuthorBelongsToAnswer({ author: { role: 'student', studentId: 'ada' }, answer: ANSWER, submissionOwnerId: 'ada' }),
    true,
  )
  assert.equal(
    threadAuthorBelongsToAnswer({ author: { role: 'student', studentId: 'bo' }, answer: ANSWER, submissionOwnerId: 'ada' }),
    false,
    'another student’s id on the row is a write the gate could not have admitted',
  )
  assert.equal(
    threadAuthorBelongsToAnswer({ author: null, answer: ANSWER, submissionOwnerId: 'ada' }),
    false,
    'a thread layer with no author answers nothing about who said it',
  )
  assert.equal(
    threadAuthorBelongsToAnswer({ author: null, answer: null, submissionOwnerId: null }),
    true,
    'a lecture is not a thread layer and has nothing to check',
  )
})

test('the speaker reads Instructor, Student, or You depending on who is looking', () => {
  assert.equal(threadSpeakerLabel({ author: { role: 'instructor' }, viewer: ADA }), 'Instructor')
  assert.equal(threadSpeakerLabel({ author: { role: 'instructor' }, viewer: INSTRUCTOR }), 'Instructor')
  assert.equal(
    threadSpeakerLabel({ author: { role: 'student', studentId: 'ada' }, viewer: ADA }),
    'You',
  )
  assert.equal(
    threadSpeakerLabel({ author: { role: 'student', studentId: 'ada' }, viewer: INSTRUCTOR }),
    'Student',
  )
  assert.equal(
    threadSpeakerLabel({ author: { role: 'student', studentId: 'ada' }, viewer: BO }),
    'Student',
  )
  assert.equal(threadSpeakerLabel({ author: null, viewer: ADA }), null)
})
