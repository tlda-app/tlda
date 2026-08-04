export async function optionalJson<T = unknown>(response: Response): Promise<T | null> {
  if (!response.ok || response.status === 204) return null
  return response.json() as Promise<T>
}
