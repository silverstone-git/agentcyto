import { PREFIX } from './prefix'
const BASE = PREFIX

async function apiJson(path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${BASE}/api/${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail = body.detail || detail
    } catch (_) {
      /* keep statusText */
    }
    throw new Error(detail)
  }
  if (res.status === 204) return null
  return res.json()
}

export async function apiGet(path: string) {
  return apiJson(path)
}

export async function apiPost(path: string, body: any) {
  return apiJson(path, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function apiDelete(path: string) {
  return apiJson(path, { method: 'DELETE' })
}

export async function apiPatch(path: string, body: any) {
  return apiJson(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
  model?: string | null
  meta?: any
  id?: number
  archived?: number
}

export interface SearchResult {
  kind: 'session' | 'message'
  session_id: string
  session_name: string
  message_id?: number
  role?: string
  snippet: string
  match?: string
  updated: number
}

export interface Job {
  id: string
  session_id: string
  mode: string
  role: string
  model: string
  status: string
  attempts: number
  resolved_model?: string | null
  error?: string | null
  created_at?: number
  updated_at?: number
}

export interface Session {
  id: string
  name: string
  created_at?: number
  updated_at?: number
}

export interface SessionDetail extends Session {
  messages: Message[]
  jobs: Job[]
}

export interface ModeConfig {
  label: string
  chat: string
  agent: string
  paid: boolean
  description: string
}

export interface ModesConfig {
  default_mode: string
  daily_budget_usd: number
  allow_paid: boolean
  request_timeout_seconds: number
  modes: Record<string, ModeConfig>
  chat_models: string[]
  agent_models: string[]
  price_usd_per_million: Record<string, number>
  retrieval?: { model?: string; plan_model?: string; rerank_model?: string }
  web_search_available?: boolean
}

export interface Health {
  status: string
  gateway: string
}

export interface Usage {
  spent_usd: number
  budget_usd: number
  recent: any[]
}

export interface KbStatus {
  source_dir: string
  source_dir_exists: boolean
  source_files: number
  documents: number
  total_nodes: number
  total_equations: number
  total_symbols: number
  latest_ingestion: any | null
  skills?: number
  default_skill?: string
  writable?: boolean
  active_ingestion?: KbActiveIngestion | null
}

export interface KbActiveIngestion {
  id: string
  total: number
  done: number
  current: string | null
  failed: number
}

export type KbFileState = 'ready' | 'changed' | 'new' | 'failed' | 'missing'

export interface KbSkillFile {
  file_name: string
  doc_id: string
  size: number
  modified: number | null
  state: KbFileState
  title: string
  nodes: number
  equations: number
  error?: string | null
  ingested_at?: number | null
}

export interface KbSkill {
  skill: string
  title: string
  documents: number
  nodes: number
  equations: number
  source_files: number
  updated?: number | null
}

export interface KbDocument {
  id: string
  skill?: string | null
  file_name: string
  title?: string | null
  status: string
  node_count: number
  equation_count: number
}

export interface KbSearchResult {
  id: string
  type: string
  title?: string | null
  label?: string | null
  content: string
  line_start: number
  line_end: number
  document_name?: string | null
  document_title?: string | null
  parent_title?: string | null
  parent_type?: string | null
  score?: number
}

export interface KbStats {
  [key: string]: number
}

// API methods
export const api = {
  health: () => apiGet('health') as Promise<Health>,
  modes: () => apiGet('modes') as Promise<ModesConfig>,
  usage: () => apiGet('usage') as Promise<Usage>,

  sessions: () => apiGet('sessions') as Promise<Session[]>,
  createSession: (name: string) => apiPost('sessions', { name }) as Promise<Session>,
  getSession: (id: string) => apiGet(`sessions/${id}`) as Promise<SessionDetail>,
  renameSession: (id: string, name: string) =>
    apiPatch(`sessions/${id}`, { name }) as Promise<SessionDetail>,
  autonameSession: (id: string) => apiPost(`sessions/${id}/autoname`, {}) as Promise<Session>,
  deleteSession: (id: string) => apiDelete(`sessions/${id}`),

  search: (q: string) => apiGet(`search?q=${encodeURIComponent(q)}`) as Promise<{ query: string; results: SearchResult[] }>,
  compressSession: (id: string, body: { action: 'summarize' | 'clear'; model?: string; byok?: any }) =>
    apiPost(`sessions/${id}/compress`, body) as Promise<{ status: string; archived: number; summary: string }>,
  byokModels: (byok: any) => apiPost('byok/models', { byok }) as Promise<{ models: string[] }>,

  chat: (body: any) => apiPost('chat', body),
  getJob: (id: string) => apiGet(`jobs/${id}`) as Promise<Job>,
  cancelJob: (id: string) => apiPost(`jobs/${id}/cancel`, {}),

  kbStatus: () => apiGet('kb/status') as Promise<KbStatus>,
  kbDocuments: () => apiGet('kb/documents') as Promise<KbDocument[]>,
  kbDocument: (id: string) => apiGet(`kb/documents/${id}`),
  kbDeleteDocument: (id: string) => apiDelete(`kb/documents/${id}`),
  kbIngest: (skill?: string) => apiPost(skill ? `kb/ingest?skill=${encodeURIComponent(skill)}` : 'kb/ingest', {}),
  kbSkills: () => apiGet('kb/skill-list') as Promise<{ skills: KbSkill[]; default: string }>,
  kbReindex: () => apiPost('kb/reindex', {}),
  kbClear: () => apiDelete('kb/clear'),
  kbSearch: (params: { q?: string; type?: string; doc?: string; limit?: number }) => {
    const qs = new URLSearchParams()
    if (params.q) qs.set('q', params.q)
    if (params.type) qs.set('type', params.type)
    if (params.doc) qs.set('doc', params.doc)
    if (params.limit) qs.set('limit', String(params.limit))
    return apiGet(`kb/search?${qs.toString()}`) as Promise<{ results: KbSearchResult[]; count: number }>
  },
  kbStats: () => apiGet('kb/stats') as Promise<KbStats>,
  kbEquations: (doc?: string, limit = 50) =>
    apiGet(`kb/equations?${new URLSearchParams(doc ? { doc } : {}).toString()}&limit=${limit}`),
  kbSymbols: (doc?: string, limit = 50) =>
    apiGet(`kb/symbols?${new URLSearchParams(doc ? { doc } : {}).toString()}&limit=${limit}`),
  kbDerivations: (doc?: string) =>
    apiGet(`kb/derivations${doc ? `?doc=${doc}` : ''}`),
  kbConcepts: (doc?: string) =>
    apiGet(`kb/concepts${doc ? `?doc=${doc}` : ''}`),
  kbIngestions: () => apiGet('kb/ingestions'),
  kbIngestion: (id: string) => apiGet(`kb/ingestions/${id}`),
  kbCreateSkill: (skill: string) => apiPost(`kb/skills/${encodeURIComponent(skill)}`, {}) as Promise<KbSkill>,
  kbDeleteSkill: (skill: string) => apiDelete(`kb/skills/${encodeURIComponent(skill)}`),
  kbSkillFiles: (skill: string) =>
    apiGet(`kb/skills/${encodeURIComponent(skill)}/files`) as Promise<{ skill: string; title: string; exists: boolean; files: KbSkillFile[] }>,
  kbDeleteFile: (skill: string, name: string) =>
    apiDelete(`kb/skills/${encodeURIComponent(skill)}/files/${encodeURIComponent(name)}`),
  kbUploadFile,
  kbEnrich: (model: string) => apiPost('kb/enrich', { model }),
}

/** Upload a file in chunks: each request stays below nginx's 1 MB default body limit. */
const UPLOAD_CHUNK = 512 * 1024

export async function kbUploadFile(skill: string, name: string, file: Blob, onProgress?: (fraction: number) => void) {
  const url = `${BASE}/api/kb/skills/${encodeURIComponent(skill)}/files/${encodeURIComponent(name)}`
  let offset = 0
  let result: any = null
  do {
    const chunk = file.slice(offset, offset + UPLOAD_CHUNK)
    const final = offset + chunk.size >= file.size
    const res = await fetch(`${url}?offset=${offset}${final ? '&final=true' : ''}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: chunk,
    })
    if (!res.ok) {
      let detail = res.status === 413 ? 'File chunk rejected by the server (too large).' : res.statusText
      try { detail = (await res.json()).detail || detail } catch (_) { /* keep */ }
      throw new Error(detail)
    }
    result = await res.json()
    offset += chunk.size
    onProgress?.(file.size ? offset / file.size : 1)
  } while (offset < file.size)
  return result as { status: string; file_name: string; size: number; doc_id: string; replaced: boolean }
}
