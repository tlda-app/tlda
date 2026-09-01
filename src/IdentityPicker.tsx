import { useState, useEffect, useRef } from 'react'
import { useFleetIdentity } from './fleet-data-adapter'
import { subscribeCanPresent } from './authToken'
import { isUsableIdentityName, sanitizeIdentityName, shouldAutoAssignTemporaryIdentity, shouldUseRequestedIdentity, temporaryIdentityName } from './fleet/identity-persistence.mjs'
import { isClassroomSurface } from './classroom/classroomSurface'
import { classroomApi } from './classroom/api'
import { classroomFleetIdentity } from './classroom/classroomIdentity'

function cleanName(name: string | null) {
  const clean = sanitizeIdentityName(name)
  return isUsableIdentityName(clean) ? clean : ''
}

export function IdentityPicker() {
  const { id, name, identityResolved, needsIdentity, login, register } = useFleetIdentity()
  const [notice, setNotice] = useState<string | null>(null)
  const [, setAuthTick] = useState(0)
  const classroom = isClassroomSurface()
  const classroomAuthorityRef = useRef('')

  // Re-render when auth data arrives from the server (isDevMode() updates)
  useEffect(() => subscribeCanPresent(() => setAuthTick(n => n + 1)), [])

  useEffect(() => {
    if (!classroom) return
    let cancelled = false
    void classroomApi.me().then(async authority => {
      const target = classroomFleetIdentity(authority)
      const authorityKey = `${target.agentId}:${target.prettyName}`
      if (cancelled || classroomAuthorityRef.current === authorityKey) return
      await register(target.name, { persist: false, agentId: target.agentId, prettyName: target.prettyName })
      classroomAuthorityRef.current = authorityKey
      if (!cancelled) setNotice(null)
    }).catch(error => {
      if (!cancelled) setNotice(`Could not resolve classroom identity: ${error.message}`)
    })
    return () => { cancelled = true }
  }, [classroom, id, name, login, register])

  useEffect(() => {
    if (classroom) return
    if (!needsIdentity || id || name) setNotice(null)
  }, [id, name, needsIdentity])

  useEffect(() => {
    if (classroom) return
    const params = new URLSearchParams(window.location.search)
    const requestedName = cleanName(params.get('name'))
    const useRequestedName = requestedName && shouldUseRequestedIdentity({ needsIdentity, id, name })
    const useTemporaryName = !requestedName && shouldAutoAssignTemporaryIdentity({ identityResolved, needsIdentity, id, name })
    if (!useRequestedName && !useTemporaryName) return

    let cancelled = false
    const targetName = requestedName || temporaryIdentityName()

    async function identify() {
      try {
        if (requestedName) {
          try { await login(targetName) }
          catch { await register(targetName) }
        } else {
          await register(targetName, { persist: false })
        }
        if (!cancelled) {
          setNotice(requestedName
            ? `Using identity "${targetName}".`
            : `Using temporary identity "${targetName}". Switch identity in Settings > Preferences.`)
          window.setTimeout(() => {
            if (!cancelled) setNotice(null)
          }, 9000)
        }
      } catch (e) {
        if (!cancelled) {
          setNotice(requestedName
            ? `Could not use requested identity: ${(e as Error).message}. Try Settings > Preferences.`
            : `Could not assign temporary identity: ${(e as Error).message}. Try Settings > Preferences.`)
        }
      }
    }

    identify()
    return () => { cancelled = true }
  }, [classroom, id, name, identityResolved, needsIdentity, login, register])

  if (!notice) return null

  return <div className="identity-auto-notice" role="status">{notice}</div>
}
