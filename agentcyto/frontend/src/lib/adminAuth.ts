// KB admin sign-in: Google via Supabase (PKCE), finished by outsie's POST /admin/session (proxied by
// our BFF at /api/admin/session). outsie only answers for a verified Google account on its admin
// allow-list. The 2-hour token lives in sessionStorage and goes out as X-Admin-Token on every API call;
// the BFF re-checks it with outsie for anything that changes the knowledge base.
import { PREFIX } from './prefix'

const PKCE_KEY = 'agentcyto_admin_pkce'
const SESSION_KEY = 'agentcyto_admin_session'

export type AdminSession = { token: string; email: string; expires_at: string }

export function getAdminSession(): AdminSession | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null') as AdminSession | null
    if (s && new Date(s.expires_at).getTime() > Date.now() + 30_000) return s
  } catch { /* corrupt */ }
  sessionStorage.removeItem(SESSION_KEY)
  return null
}

export function adminSignOut() {
  sessionStorage.removeItem(SESSION_KEY)
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export async function startAdminSignIn(): Promise<void> {
  const r = await fetch(`${PREFIX}/api/admin/auth-config`)
  const { supabase_url } = (await r.json()) as { supabase_url: string | null }
  if (!supabase_url) throw new Error('Google sign-in is not configured on outsie')
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  sessionStorage.setItem(PKCE_KEY, verifier)
  const params = new URLSearchParams({
    provider: 'google',
    redirect_to: `${window.location.origin}${PREFIX}/admin`,
    code_challenge: challenge,
    code_challenge_method: 's256',
  })
  window.location.assign(`${supabase_url}/auth/v1/authorize?${params}`)
}

/** On return from Google: exchange ?code= for an admin session. Null when this isn't a callback. */
export async function completeAdminSignIn(): Promise<AdminSession | null> {
  const url = new URL(window.location.href)
  const code = url.searchParams.get('code')
  const providerError = url.searchParams.get('error_description') || url.searchParams.get('error')
  if (!code && !providerError) return null
  for (const k of ['code', 'error', 'error_code', 'error_description', 'state']) url.searchParams.delete(k)
  window.history.replaceState(null, '', url.pathname + url.search + url.hash)
  const verifier = sessionStorage.getItem(PKCE_KEY)
  sessionStorage.removeItem(PKCE_KEY)
  if (providerError) throw new Error(providerError)
  if (!verifier) throw new Error('Sign-in session expired, please try again')
  const r = await fetch(`${PREFIX}/api/admin/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
  })
  if (!r.ok) {
    let detail = r.status === 403 ? 'This Google account is not an admin' : 'Sign-in failed, please try again'
    try { const j = await r.json(); if (typeof j.detail === 'string') detail = j.detail } catch { /* not JSON */ }
    throw new Error(detail)
  }
  const s = (await r.json()) as AdminSession
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(s))
  return s
}
