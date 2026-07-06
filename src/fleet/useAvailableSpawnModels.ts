import { useEffect, useState } from 'react'
// @ts-ignore — shared vanilla module used by server + frontend; lives in shared/ so the live image ships it.
import { spawnModelsFromCapabilitiesResponse } from '../../shared/spawn-model-options.mjs'

export type AvailableSpawnModels = {
  aliases: string[]
  defaultAlias: string
  machine: string | null
  route: string | null
  loading: boolean
  error: string | null
}

export const EMPTY_SPAWN_MODELS: AvailableSpawnModels = {
  aliases: [],
  defaultAlias: '',
  machine: null,
  route: null,
  loading: false,
  error: null,
}

export async function loadAvailableSpawnModels(
  userId: string,
  fetchFn: typeof fetch = fetch,
): Promise<Omit<AvailableSpawnModels, 'loading'>> {
  const r = await fetchFn(`/api/fleet/spawn-availability?target=fresh-spawn-current&user=${encodeURIComponent(userId)}`)
  if (!r.ok) throw new Error(String(r.status))
  const next = spawnModelsFromCapabilitiesResponse(await r.json())
  return {
    aliases: next.aliases,
    defaultAlias: next.defaultAlias,
    machine: next.machine,
    route: next.route,
    error: next.error,
  }
}

export function useAvailableSpawnModels(userId: string | null | undefined): AvailableSpawnModels {
  const [models, setModels] = useState<AvailableSpawnModels>(EMPTY_SPAWN_MODELS)

  useEffect(() => {
    if (!userId) {
      setModels(EMPTY_SPAWN_MODELS)
      return
    }

    let cancelled = false
    setModels(prev => ({ ...prev, loading: true, error: null }))
    loadAvailableSpawnModels(userId)
      .then(next => {
        if (cancelled) return
        setModels({
          aliases: next.aliases,
          defaultAlias: next.defaultAlias,
          machine: next.machine,
          route: next.route,
          loading: false,
          error: next.error,
        })
      })
      .catch(e => {
        if (cancelled) return
        setModels({
          ...EMPTY_SPAWN_MODELS,
          error: e?.message || String(e),
        })
      })
    return () => { cancelled = true }
  }, [userId])

  return models
}
