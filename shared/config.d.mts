export interface ResolvedTldaEndpoint {
  http: string
  ws: string
}

export interface ResolvedTldaConfig {
  name: string
  database: ResolvedTldaEndpoint
  store: ResolvedTldaEndpoint
  licenseKey: string
}

export const hasTls: boolean
export function resolveConfig(config?: unknown): ResolvedTldaConfig
