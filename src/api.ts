/** Send a same-origin JSON request and surface server-provided error messages. */
export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: 'same-origin',
  })
  if (!response.ok) {
    let message = `Request failed (${response.status}).`
    try {
      const body: unknown = await response.json()
      if (body && typeof body === 'object') {
        const record = body as { message?: unknown; error?: unknown }
        if (typeof record.message === 'string') message = record.message
        else if (typeof record.error === 'string') message = record.error
      }
    } catch {
      // Keep a useful HTTP error if the server did not return JSON.
    }
    throw new Error(message)
  }
  if (response.status === 204) return undefined as T
  return await response.json() as T
}

/** Extract a useful message from an unknown error value or use the supplied fallback. */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return fallback
}
