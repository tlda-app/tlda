/**
 * IdentityPicker — shown on first visit when no identity is stored.
 * Two modes: login (returning user) or register (new user).
 * ?name= auto-login is for agents opening browsers — uses login, never creates.
 */
import { useState } from 'react'
import { useFleetIdentity } from './fleet-data-adapter'

export function IdentityPicker() {
  const { needsIdentity, login, register } = useFleetIdentity()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [autoIdentified, setAutoIdentified] = useState(false)
  const [mode, setMode] = useState<'login' | 'register'>('login')

  // Auto-login from ?name= query param (agents opening browsers for testing)
  if (needsIdentity && !autoIdentified) {
    const urlName = new URLSearchParams(window.location.search).get('name')
    if (urlName) {
      const trimmed = urlName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
      if (trimmed) {
        setAutoIdentified(true)
        login(trimmed).catch(() => {
          // Login failed — agent not registered. Just show nothing, no ghost created.
          setAutoIdentified(false)
        })
        return null
      }
    }
  }

  if (!needsIdentity) return null

  const submit = async () => {
    const trimmed = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!trimmed) { setError('Enter a name (letters, numbers, dashes)'); return }
    setSubmitting(true)
    setError(null)
    try {
      if (mode === 'login') {
        await login(trimmed)
      } else {
        await register(trimmed)
      }
    } catch (e) {
      const msg = (e as Error).message
      // If registering and name is taken by a human, suggest login
      if (mode === 'register' && msg.includes('already in use')) {
        setError(`"${trimmed}" is taken. Already you? Try logging in.`)
      } else if (mode === 'login' && msg.includes('No agent named')) {
        setError(`No one named "${trimmed}". New here? Register instead.`)
      } else {
        setError(msg)
      }
      setSubmitting(false)
    }
  }

  return (
    <div className="identity-picker-overlay">
      <div className="identity-picker">
        <h3>{mode === 'login' ? 'Log in' : 'Register'}</h3>
        <p>{mode === 'login' ? 'Enter your name to log in.' : 'Pick a name. Must be unique.'}</p>
        <form onSubmit={e => { e.preventDefault(); submit() }}>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="alice"
            autoFocus
            disabled={submitting}
          />
          <button type="submit" disabled={submitting || !name.trim()}>
            {mode === 'login' ? 'Log in' : 'Register'}
          </button>
        </form>
        {error && <p className="identity-error">{error}</p>}
        <p className="identity-switch">
          {mode === 'login'
            ? <>New here? <button type="button" className="identity-link" onClick={() => { setMode('register'); setError(null) }}>Register</button></>
            : <>Already registered? <button type="button" className="identity-link" onClick={() => { setMode('login'); setError(null) }}>Log in</button></>
          }
        </p>
      </div>
    </div>
  )
}
