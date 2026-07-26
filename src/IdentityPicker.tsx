import { useState, useEffect } from 'react'
import { useFleetIdentity } from './fleet-data-adapter'
import { subscribeCanPresent } from './authToken'
import { isUsableIdentityName, sanitizeIdentityName, shouldAutoAssignTemporaryIdentity, temporaryIdentityName } from './fleet/identity-persistence.mjs'

function cleanName(name: string | null) {
  const clean = sanitizeIdentityName(name)
  return isUsableIdentityName(clean) ? clean : ''
}

export function IdentityPicker() {
  const { id, name, needsIdentity, login, register } = useFleetIdentity()
  const [notice, setNotice] = useState<string | null>(null)
  const [, setAuthTick] = useState(0)

  // Re-render when auth data arrives from the server (isDevMode() updates)
  useEffect(() => subscribeCanPresent(() => setAuthTick(n => n + 1)), [])

  useEffect(() => {
    if (!needsIdentity || id || name) setNotice(null)
  }, [id, name, needsIdentity])

  useEffect(() => {
    if (!shouldAutoAssignTemporaryIdentity({ needsIdentity, id, name })) return

    let cancelled = false
    const params = new URLSearchParams(window.location.search)
    const requestedName = cleanName(params.get('name'))
    const targetName = requestedName || temporaryIdentityName()

    async function identify() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const candidate = attempt === 0 ? targetName : temporaryIdentityName()
        try {
          if (requestedName) {
            try { await login(candidate, { persist: false }) }
            catch { await register(candidate, { persist: false }) }
          } else {
            await register(candidate, { persist: false })
          }
          if (!cancelled) {
            setNotice(requestedName
              ? `Using identity "${candidate}".`
              : `Using temporary identity "${candidate}". Switch identity in Settings > Preferences.`)
            window.setTimeout(() => {
              if (!cancelled) setNotice(null)
            }, 9000)
          }
          return
        } catch (e) {
          if (attempt === 2 && !cancelled) {
            setNotice(`Could not auto-assign identity: ${(e as Error).message}. Try Settings > Preferences.`)
          }
        }
      }
    }

    identify()
    return () => { cancelled = true }
  }, [id, name, needsIdentity, login, register])

  if (!notice) return null

  return <div className="identity-auto-notice" role="status">{notice}</div>
}
