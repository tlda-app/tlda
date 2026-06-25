export function storedIdentityLoginFailureAction(err) {
  const msg = String(err?.message || err || '')
  return /No agent named/i.test(msg) ? 'register-stored' : 'retry-stored'
}
