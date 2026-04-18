/**
 * IdentityPicker — shown on first visit when no identity is stored.
 * User picks a name, which is sent to the server via WS 'identify'.
 */
import { useState } from 'react'
import { useFleetIdentity } from './fleet-data-adapter'

export function IdentityPicker() {
  const { needsIdentity, identify } = useFleetIdentity()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!needsIdentity) return null

  const submit = async () => {
    const trimmed = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!trimmed) { setError('Enter a name (letters, numbers, dashes)'); return }
    setSubmitting(true)
    setError(null)
    try {
      await identify(trimmed)
    } catch (e) {
      setError((e as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <div className="identity-picker-overlay">
      <div className="identity-picker">
        <h3>Who are you?</h3>
        <p>Pick a name for this device. You can change it later.</p>
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
            Join
          </button>
        </form>
        {error && <p className="identity-error">{error}</p>}
      </div>
    </div>
  )
}
