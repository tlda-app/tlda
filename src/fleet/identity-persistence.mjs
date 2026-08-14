export function storedIdentityLoginFailureAction(err) {
  const msg = String(err?.message || err || '')
  return /No agent named/i.test(msg) ? 'register-stored' : 'retry-stored'
}

export function sanitizeIdentityName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

export function isUsableIdentityName(name) {
  const clean = sanitizeIdentityName(name)
  return !!clean && clean !== 'none' && clean !== 'null' && clean !== 'undefined'
}

export function completedLoginIdentity(response) {
  if (response?.queued) throw new Error('identity login queued without a completed response')
  const id = typeof response?.id === 'string' ? response.id : ''
  const rawName = typeof response?.name === 'string' ? response.name : ''
  const name = sanitizeIdentityName(rawName)
  if (!/^fleet:\S+$/.test(id) || rawName !== name || !isUsableIdentityName(name)) {
    throw new Error('identity login returned an invalid response')
  }
  return { id, name }
}

export function completedRegistrationIdentity(response) {
  if (response?.queued) throw new Error('identity registration queued without a completed response')
  const id = typeof response?.agent?.id === 'string' ? response.agent.id : ''
  if (!/^fleet:\S+$/.test(id)) throw new Error('identity registration returned an invalid response')
  return { id }
}

export function shouldUseRequestedIdentity({ needsIdentity, id, name }) {
  return !!needsIdentity && !id && !isUsableIdentityName(name)
}

export function shouldAutoAssignTemporaryIdentity({ identityResolved, needsIdentity, id, name }) {
  return !!identityResolved && !!needsIdentity && !id && !isUsableIdentityName(name)
}

export function temporaryIdentityName() {
  const names = [
    'big-bird',
    'cookie',
    'grover',
    'oscar',
    'snuffy',
    'abby',
    'bert',
    'ernie',
    'count',
  ]
  const base = names[Math.floor(Math.random() * names.length)]
  return `${base}-${Math.random().toString(36).slice(2, 6)}`
}
