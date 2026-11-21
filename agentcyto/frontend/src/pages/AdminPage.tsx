import { useState, useEffect } from 'react'
import {
  api,
  KbStatus,
  KbDocument,
  KbSearchResult,
} from '../lib/api'
import { Lock, RefreshCw, Trash2, Search, FileText, Database, Play, AlertTriangle } from 'lucide-react'

const ADMIN_PASSWORD = 'apple'

export default function AdminPage() {
  const [unlocked, setUnlocked] = useState(false)
  const [password, setPassword] = useState('')
  const [wrongPassword, setWrongPassword] = useState(false)

  if (!unlocked) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-ink-50">
        <div className="card p-8 md:p-12 w-full max-w-sm space-y-5">
          <div className="w-10 h-10 rounded-xl bg-brand-600/20 flex items-center justify-center text-brand-400 mb-2">
            <Lock className="w-5 h-5" />
          </div>
          <h2 className="text-xl font-semibold text-ink-50">Admin</h2>
          <p className="text-ink-500 text-sm">Knowledge base administration is password-gated.</p>
          <form onSubmit={(e) => { e.preventDefault(); if (password === ADMIN_PASSWORD) { setUnlocked(true); setWrongPassword(false) } else { setWrongPassword(true) } }} className="space-y-3">
            <div>
              <label className="block text-xs text-ink-500 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-surface-base border border-surface-border text-ink-50 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
                placeholder="••••••"
              />
            </div>
            {wrongPassword && (
              <div className="flex items-center gap-2 text-xs text-danger">
                <AlertTriangle className="w-3 h-3" /> Incorrect password.
              </div>
            )}
            <button
              type="submit"
              className="w-full py-2 rounded-xl bg-brand-600 text-white font-medium shadow-glow hover:bg-brand-500 transition-colors"
            >
              Unlock
            </button>
          </form>
          <p className="text-[10px] text-ink-600 italic">Soft gate — real security later.</p>
        </div>
      </div>
    )
  }

  return <AdminBody />
}

function AdminBody() {
  const [status, setStatus] = useState<KbStatus | null>(null)
  const [docs, setDocs] = useState<KbDocument[]>([])
  const [searchResults, setSearchResults] = useState<KbSearchResult[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [searchType, setSearchType] = useState('')
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [statusType, setStatusType] = useState<'ok' | 'err' | 'info'>('info')
  const [loading, setLoading] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)

  useEffect(() => {
    loadStatus()
    loadDocs()
    const t = setInterval(loadStatus, 10000)
    return () => clearInterval(t)
  }, [])

  const loadStatus = async () => {
    try {
      const s = await api.kbStatus()
      setStatus(s)
    } catch (err: any) {
      // silently ignore
    }
  }

  const loadDocs = async () => {
    try {
      const d = await api.kbDocuments()
      setDocs(d)
    } catch (err: any) {
      setDocs([])
    }
  }

  const runAction = async (fn: () => Promise<any>, label: string) => {
    setLoading(true)
    setStatusMsg(`${label} running…`)
    setStatusType('info')
    try {
      const res = await fn()
      setStatusMsg(`✓ ${label} done.`)
      setStatusType('ok')
      await loadStatus()
      await loadDocs()
      return res
    } catch (err: any) {
      setStatusMsg(`✗ ${label} failed: ${err.message}`)
      setStatusType('err')
      throw err
    } finally {
      setLoading(false)
    }
  }

  const doSearch = async () => {
    if (!searchQuery && !searchType) return
    setSearchLoading(true)
    try {
      const data = await api.kbSearch({ q: searchQuery || undefined, type: searchType || undefined, limit: 50 })
      setSearchResults(data.results || [])
    } catch (err: any) {
      setSearchResults([])
      setStatusMsg(`Search failed: ${err.message}`)
      setStatusType('err')
    } finally {
      setSearchLoading(false)
    }
  }

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-50">Knowledge base</h1>
          <p className="text-ink-500 text-sm">Admin controls for the physics KB. Source: read-only Markdown in repo/physics/.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-2 py-1 rounded text-[10px] font-medium border ${status?.source_dir_exists ? 'bg-success/10 text-success border-success/20' : 'bg-danger/10 text-danger border-danger/20'}`}>
            {status?.source_dir_exists ? 'Source dir OK' : 'Source dir missing'}
          </span>
        </div>
      </div>

      {/* Status message */}
      {statusMsg && (
        <div className={`p-3 rounded-xl border text-sm ${
          statusType === 'ok' ? 'bg-success/10 text-success border-success/20' :
          statusType === 'err' ? 'bg-danger/10 text-danger border-danger/20' :
          'bg-surface-border text-ink-300 border-surface-border'
        }`}>
          {statusMsg}
        </div>
      )}

      {/* Live counts */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard title="Source files" value={status?.source_files ?? '—'} icon={<FileText className="w-5 h-5" />} />
        <StatCard title="Documents" value={status?.documents ?? '—'} icon={<Database className="w-5 h-5" />} />
        <StatCard title="Nodes" value={status?.total_nodes?.toLocaleString() ?? '—'} icon={<Play className="w-5 h-5" />} />
        <StatCard title="Equations" value={status?.total_equations?.toLocaleString() ?? '—'} icon={<FileText className="w-5 h-5" />} />
      </div>

      {/* Actions */}
      <div className="card p-4">
        <h2 className="text-sm font-semibold text-ink-200 mb-4">Actions</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <button
            onClick={() => runAction(api.kbIngest, 'Ingest')}
            disabled={loading}
            className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${loading ? 'bg-surface-border text-ink-500' : 'bg-brand-600 text-white shadow-glow hover:bg-brand-500'}`}
          >
            {loading ? <RefreshCw className="w-4 h-4 animate-spin mr-2" /> : ''}Ingest / Update
          </button>
          <button
            onClick={() => runAction(api.kbReindex, 'Rebuild')}
            disabled={loading}
            className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${loading ? 'bg-surface-border text-ink-500' : 'bg-ink-800 text-white hover:bg-ink-600'}`}
          >
            Rebuild from scratch
          </button>
          <button
            onClick={() => {
              if (!confirm('Delete ALL knowledge base data? This cannot be undone.')) return
              runAction(api.kbClear, 'Clear')
            }}
            disabled={loading}
            className={`px-4 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed ${loading ? 'bg-surface-border text-ink-500' : 'bg-danger/10 text-danger border border-danger/20 hover:bg-danger/20'}`}
          >
            <Trash2 className="w-4 h-4 mr-2" /> Clear all KB
          </button>
        </div>
        {status?.latest_ingestion && (
          <div className="mt-4 p-3 rounded-xl bg-surface-border border border-surface-border/50 text-xs text-ink-400">
            <div className="flex items-center gap-2 mb-1">
              <Database className="w-3 h-3" />
              <span className="font-medium text-ink-300">Latest ingestion</span>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between">
                <span>Status</span>
                <span>{status.latest_ingestion.status}</span>
              </div>
              <div className="flex justify-between">
                <span>Files</span>
                <span>{status.latest_ingestion.files_ingested ?? 0} ingested · {status.latest_ingestion.files_skipped ?? 0} skipped</span>
              </div>
              <div className="flex justify-between">
                <span>Nodes created</span>
                <span>{status.latest_ingestion.nodes_created ?? 0}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Search */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-ink-200">Full-text search</h2>
        </div>
        <div className="flex flex-col md:flex-row gap-3 mb-4">
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            placeholder="Search knowledge base…"
            className="flex-1 px-3 py-2 rounded-xl bg-surface-base border border-surface-border text-ink-50 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
          />
          <select
            value={searchType}
            onChange={(e) => setSearchType(e.target.value)}
            className="px-3 py-2 rounded-xl bg-surface-base border border-surface-border text-ink-50 focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none text-sm"
          >
            <option value="">All types</option>
            <option value="paragraph">Paragraph</option>
            <option value="equation">Equation</option>
            <option value="section">Section</option>
            <option value="theorem">Theorem</option>
            <option value="definition">Definition</option>
          </select>
          <button
            onClick={doSearch}
            disabled={searchLoading}
            className="px-4 py-2 rounded-xl bg-brand-600 text-white font-medium shadow-glow hover:bg-brand-500 transition-colors disabled:opacity-50"
          >
            {searchLoading ? <RefreshCw className="w-4 h-4 animate-spin mr-2" /> : <Search className="w-4 h-4" />} Search
          </button>
        </div>
        {searchResults.length === 0 && searchQuery ? (
          <div className="text-center py-4 text-ink-600 italic text-sm">No results.</div>
        ) : searchResults.length > 0 ? (
          <div className="space-y-2">
            {searchResults.map((r, i) => (
              <div key={i} className="p-3 rounded-xl border border-surface-border bg-surface-card">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-bold text-brand-400 uppercase tracking-wider">{r.type}</span>
                  {r.label && <span className="text-[10px] text-ink-600">[{r.label}]</span>}
                </div>
                <div className="text-sm font-medium text-ink-200 truncate">{r.title || '(untitled)'}</div>
                <div className="text-[11px] text-ink-600 mb-2">
                  {r.document_name || ''} · lines {r.line_start}-{r.line_end}
                </div>
                <div className="text-xs text-ink-500 italic">{r.content?.slice(0, 300)}{r.content && r.content.length > 300 ? '…' : ''}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {/* Documents */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-ink-200">Documents ({docs.length})</h2>
        </div>
        {docs.length === 0 ? (
          <div className="text-center py-6 text-ink-600 italic">No documents ingested yet.</div>
        ) : (
          <div className="space-y-2">
            {docs.map((d) => (
              <div key={d.id} className="flex items-center justify-between p-3 rounded-xl border border-surface-border hover:bg-surface-border/30 transition-colors group">
                <div className="flex-1">
                  <div className="text-sm font-medium text-ink-200">{d.title || d.file_name}</div>
                  <div className="text-[11px] text-ink-600">{d.node_count || 0} nodes · {d.equation_count || 0} eqns · {d.status}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                    d.status === 'done' ? 'bg-success/10 text-success border border-success/20' : 'bg-ink-800/20 text-ink-400 border border-ink-700'
                  }`}>{d.status}</span>
                  <button
                    onClick={() => {
                      if (!confirm(`Remove document "${d.title || d.file_name}" and all its nodes?`)) return
                      api.kbDeleteDocument(d.id).then(() => {
                        setDocs(docs.filter((x) => x.id !== d.id))
                        setStatusMsg(`✓ Removed ${d.title || d.file_name}.`)
                        setStatusType('ok')
                        loadStatus()
                      }).catch((err: any) => {
                        setStatusMsg(`✗ Remove failed: ${err.message}`)
                        setStatusType('err')
                      })
                    }}
                    className="p-1.5 text-ink-500 hover:text-danger transition-colors"
                    title="Remove document"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({ title, value, icon }: { title: string; value: string | number; icon: React.ReactNode }) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-ink-500">{title}</p>
          <p className="text-2xl font-semibold text-ink-50">{value}</p>
        </div>
        <div className="w-8 h-8 rounded-xl bg-brand-600/10 flex items-center justify-center text-brand-400">
          {icon}
        </div>
      </div>
    </div>
  )
}
