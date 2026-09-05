import assert from 'node:assert/strict'

Object.assign(globalThis, {
  window: { location: { search: '?course=missing' }, localStorage: { getItem: () => null } },
  fetch: async () => new Response(JSON.stringify({ error: 'Course not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  }),
})

const { classroomApi } = await import('../src/classroom/api')
await assert.rejects(classroomApi.me(), { message: 'Course not found' })
