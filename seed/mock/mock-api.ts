// arche-ui seed — runtime mock-mode toggle. Copy into src/utils/ and adapt as needed.
// Domain-agnostic. See docs/14-mock-api-layer.md and docs/01-runtime-env-injection.md.
declare global {
  interface Window {
    __ENV__?: Record<string, string | undefined>
  }
}

/** True when the app should serve mock responses instead of calling the real backend. */
export function isMockMode(): boolean {
  if (typeof window !== 'undefined' && window.__ENV__) {
    return window.__ENV__.NEXT_PUBLIC_USE_MOCK_API === 'true'
  }
  return process.env.NEXT_PUBLIC_USE_MOCK_API === 'true'
}

/** Resolve an endpoint name to the mock route prefix or the real proxy prefix. */
export function getApiUrl(endpoint: string): string {
  const clean = endpoint.replace(/^\/+/, '')
  return isMockMode() ? `/ui-api/mock/${clean}` : `/ui-api/${clean}`
}

export {}
