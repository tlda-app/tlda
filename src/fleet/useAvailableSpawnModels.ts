import { useEffect, useState } from 'react'
import { DATABASE_HTTP } from '../activeConfig'
// @ts-ignore — shared vanilla module used by server + frontend; lives in shared/ so the live image ships it.
import { spawnModelsFromCapabilitiesResponse } from '../../shared/spawn-model-options.mjs'

export type SpawnModelOptionSpec = {
  default: string
  values: Record<string, { options?: Record<string, SpawnModelOptionSpec> }>
}

export type AvailableSpawnModels = {
  aliases: string[]
  models: Array<{
    alias: string
    kind: string | null
    group?: string | null
    level?: number | null
    description?: string
    options: Record<string, SpawnModelOptionSpec>
  }>
  defaultAlias: string
  machine: string | null
  route: string | null
  loading: boolean
  error: string | null
}

export const EMPTY_SPAWN_MODELS: AvailableSpawnModels = {
  aliases: [],
  models: [],
  defaultAlias: '',
  machine: null,
  route: null,
  loading: false,
  error: null,
}

export async function loadAvailableSpawnModels(
  userId: string,
  contextOrFetch: { doc?: string | null } | typeof fetch = {},
  fetchFn: typeof fetch = fetch,
): Promise<Omit<AvailableSpawnModels, 'loading'>> {
  const context = typeof contextOrFetch === 'function' ? {} : contextOrFetch
  const fetcher = typeof contextOrFetch === 'function' ? contextOrFetch : fetchFn
  const params = new URLSearchParams({
    target: 'fresh-spawn-current',
    user: userId,
  })
  if (context.doc) params.set('doc', context.doc)
  const r = await fetcher(`${DATABASE_HTTP}/api/fleet/spawn-availability?${params.toString()}`)
  if (!r.ok) throw new Error(String(r.status))
  const next = spawnModelsFromCapabilitiesResponse(await r.json())
  return {
    aliases: next.aliases,
    models: next.models,
    defaultAlias: next.defaultAlias,
    machine: next.machine,
    route: next.route,
    error: next.error,
  }
}

export function useAvailableSpawnModels(
  userId: string | null | undefined,
  context: { doc?: string | null } = {},
): AvailableSpawnModels {
  const [models, setModels] = useState<AvailableSpawnModels>(EMPTY_SPAWN_MODELS)
  const doc = context.doc || ''

  useEffect(() => {
    if (!userId) {
      setModels(EMPTY_SPAWN_MODELS)
      return
    }

    let cancelled = false
    setModels(prev => ({ ...prev, loading: true, error: null }))
    loadAvailableSpawnModels(userId, { doc: doc || null })
      .then(next => {
        if (cancelled) return
        setModels({
          aliases: next.aliases,
          models: next.models,
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
  }, [userId, doc])

  return models
}
