'use strict'

function classroomTokenFromUri(uri) {
  if (uri.path !== '/classroom-token') return null
  const params = new URLSearchParams(uri.query)
  const server = (params.get('server') || '').replace(/\/$/, '')
  const classroomToken = params.get('token') || ''
  let parsedServer
  try {
    parsedServer = new URL(server)
  } catch {
    return null
  }
  if (parsedServer.protocol !== 'https:' || !/^[a-f0-9]{64}$/i.test(classroomToken)) return null
  return { server, classroomToken }
}

module.exports = { classroomTokenFromUri }
