export function storedIdentityLoginFailureAction(err) {
  const msg = String(err?.message || err || '')
  return /No agent named/i.test(msg) ? 'register-stored' : 'retry-stored'
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
