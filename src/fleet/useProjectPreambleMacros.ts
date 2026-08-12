import { useEffect, useState } from 'react'

const macroCache = new Map<string, Record<string, string>>()
const pendingMacroLoads = new Map<string, Promise<Record<string, string>>>()

export function useProjectPreambleMacros(projectName: string | null | undefined): Record<string, string> {
  const key = projectName || ''
  const [macros, setMacros] = useState<Record<string, string>>(() => key ? macroCache.get(key) || {} : {})

  useEffect(() => {
    if (!key) {
      setMacros({})
      return
    }

    const cached = macroCache.get(key)
    if (cached) {
      setMacros(cached)
      return
    }

    setMacros({})
    let live = true
    loadProjectPreambleMacros(key)
      .then(loaded => { if (live) setMacros(loaded) })
      .catch(error => console.warn('[fleet-chat] macros fetch failed:', error?.message || error))

    return () => { live = false }
  }, [key])

  return macros
}

function loadProjectPreambleMacros(projectName: string): Promise<Record<string, string>> {
  const existing = pendingMacroLoads.get(projectName)
  if (existing) return existing

  const promise = fetch(`/api/projects/${encodeURIComponent(projectName)}/macros`)
    .then(response => response.ok ? response.json() : null)
    .then(data => {
      const macros = data?.macros || {}
      macroCache.set(projectName, macros)
      pendingMacroLoads.delete(projectName)
      return macros
    })
    .catch(error => {
      pendingMacroLoads.delete(projectName)
      throw error
    })

  pendingMacroLoads.set(projectName, promise)
  return promise
}
