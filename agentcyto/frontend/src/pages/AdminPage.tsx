import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  api,
  KbActiveIngestion,
  KbSearchResult,
  KbSkill,
  KbSkillFile,
  KbStatus,
} from '../lib/api'
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  CloudUpload,
  FileText,
  FolderPlus,
  Library,
  Loader2,
  Lock,
  LogOut,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import { adminSignOut, completeAdminSignIn, getAdminSession, startAdminSignIn, type AdminSession } from '../lib/adminAuth'

const AUTO_INGEST_KEY = 'agentcyto.admin.autoIngest'

// --------------------------------------------------------------------------- //
// Small helpers
// --------------------------------------------------------------------------- //

function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return sessionStorage.getItem(key) ?? localStorage.getItem(key)
    localStorage.setItem(key, value)
  } catch { /* storage unavailable */ }
  return null
}

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

function cleanFileName(name: string) {
  const stem = name.replace(/\.(md|markdown|txt)$/i, '')
  const safe = stem.replace(/[^\w\-. ()&,'+]+/g, '-').replace(/^[.\s-]+/, '').slice(0, 140) || 'document'
  return `${safe}.md`
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fmtNum(n: number | undefined | null) {
  return (n ?? 0).toLocaleString()
}

function ago(ts?: number | null) {
  if (!ts) return ''
  const s = Date.now() / 1000 - ts
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86400)} d ago`
}

function hue(name: string) {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

function SkillAvatar({ skill, title, size = 'md' }: { skill: string; title: string; size?: 'sm' | 'md' | 'lg' }) {
  const h = hue(skill)
  const dims = size === 'lg' ? 'w-14 h-14 text-xl rounded-2xl' : size === 'sm' ? 'w-8 h-8 text-xs rounded-lg' : 'w-10 h-10 text-sm rounded-xl'
  return (
    <div
      className={`${dims} shrink-0 flex items-center justify-center font-semibold text-white shadow-lg`}
      style={{ background: `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 40) % 360} 65% 40%))` }}
      aria-hidden
    >
      {title.slice(0, 1).toUpperCase()}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Toasts
// --------------------------------------------------------------------------- //

type Toast = { id: number; kind: 'ok' | 'err' | 'info'; text: string }

function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, kind, text }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 7000 : 4500)
  }, [])
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id))
  return { toasts, push, dismiss }
}

function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="fixed z-[90] bottom-4 right-4 left-4 sm:left-auto sm:w-96 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto pop-in flex items-start gap-2.5 px-4 py-3 rounded-2xl border shadow-2xl backdrop-blur-xl text-sm ${
            t.kind === 'ok' ? 'bg-success/15 border-success/30 text-success'
              : t.kind === 'err' ? 'bg-danger/15 border-danger/30 text-danger'
              : 'bg-surface-elevated/95 border-surface-border text-ink-100'
          }`}
        >
          {t.kind === 'ok' ? <Check className="w-4 h-4 mt-0.5 shrink-0" /> : t.kind === 'err' ? <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" /> : <Sparkles className="w-4 h-4 mt-0.5 shrink-0 text-brand-500" />}
          <span className="flex-1">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="opacity-60 hover:opacity-100" aria-label="Dismiss"><X className="w-4 h-4" /></button>
        </div>
      ))}
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Modal
// --------------------------------------------------------------------------- //

function Modal({ open, onClose, children, wide = false }: { open: boolean; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm fade-in" onClick={onClose} />
      <div className={`relative w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'} max-h-[90dvh] overflow-y-auto ink-scroll bg-surface-elevated border border-surface-border rounded-t-3xl sm:rounded-3xl shadow-2xl p-6 pop-in`}>
        {children}
      </div>
    </div>
  )
}

type ConfirmSpec = {
  title: string
  body: React.ReactNode
  action: string
  danger?: boolean
  typeToConfirm?: string
  run: () => Promise<void>
}

function ConfirmModal({ spec, onClose }: { spec: ConfirmSpec | null; onClose: () => void }) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setTyped(''); setBusy(false) }, [spec])
  if (!spec) return null
  const blocked = !!spec.typeToConfirm && typed.trim() !== spec.typeToConfirm
  return (
    <Modal open onClose={() => !busy && onClose()}>
      <div className="flex items-start gap-3">
        <div className={`w-10 h-10 shrink-0 rounded-xl flex items-center justify-center ${spec.danger ? 'bg-danger/15 text-danger' : 'bg-brand-500/15 text-brand-500'}`}>
          {spec.danger ? <Trash2 className="w-5 h-5" /> : <Sparkles className="w-5 h-5" />}
        </div>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-ink-50">{spec.title}</h3>
          <div className="text-sm text-ink-400 mt-1 leading-relaxed">{spec.body}</div>
        </div>
      </div>
      {spec.typeToConfirm && (
        <div className="mt-5">
          <label className="block text-xs text-ink-500 mb-1.5">
            Type <span className="font-mono text-ink-200">{spec.typeToConfirm}</span> to confirm
          </label>
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className="field" />
        </div>
      )}
      <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
        <button onClick={onClose} disabled={busy} className="btn-ghost">Cancel</button>
        <button
          disabled={blocked || busy}
          onClick={async () => { setBusy(true); try { await spec.run(); onClose() } catch { setBusy(false) } }}
          className={spec.danger ? 'btn-danger' : 'btn-primary'}
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} {spec.action}
        </button>
      </div>
    </Modal>
  )
}

// --------------------------------------------------------------------------- //
// Sign-in gate (outsie Google admin session)
// --------------------------------------------------------------------------- //

export default function AdminPage() {
  const [session, setSession] = useState<AdminSession | null>(getAdminSession)
  const [checking, setChecking] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    completeAdminSignIn()
      .then((s) => { if (s) setSession(s) })
      .catch((e) => setError((e as Error).message))
      .finally(() => setChecking(false))
    const out = () => setSession(null)
    window.addEventListener('agentcyto-admin-signed-out', out)
    return () => window.removeEventListener('agentcyto-admin-signed-out', out)
  }, [])

  if (checking) {
    return (
      <div className="min-h-full flex items-center justify-center p-4 text-ink-500 text-sm gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Checking sign-in…
      </div>
    )
  }

  if (!session) {
    return (
      <div className="min-h-full flex items-center justify-center p-4">
        <div className="relative w-full max-w-sm">
          <div className="absolute -inset-10 bg-brand-500/10 blur-3xl rounded-full" aria-hidden />
          <div className="relative card p-8 space-y-5">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-900 flex items-center justify-center text-white shadow-glow">
              <Library className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-ink-50">Knowledge Bank</h2>
              <p className="text-ink-500 text-sm mt-1">
                Sign in with a Google account on the admin list to manage skills and documents.
                Every change is checked by the server.
              </p>
            </div>
            {error && <p className="text-xs text-danger flex items-center gap-1.5"><AlertTriangle className="w-3 h-3" /> {error}</p>}
            <button
              type="button"
              disabled={busy}
              onClick={async () => { setBusy(true); try { await startAdminSignIn() } catch (e) { setError((e as Error).message); setBusy(false) } }}
              className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Lock className="w-4 h-4" /> Continue with Google
            </button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <>
      <div className="flex items-center justify-end gap-3 px-4 pt-3 text-xs text-ink-500">
        <span className="truncate">Signed in as {session.email}</span>
        <button type="button" onClick={() => { adminSignOut(); setSession(null) }} className="flex items-center gap-1 hover:text-danger shrink-0">
          <LogOut className="w-3 h-3" /> Sign out
        </button>
      </div>
      <AdminBody />
    </>
  )
}

// --------------------------------------------------------------------------- //
// Main admin body
// --------------------------------------------------------------------------- //

type Upload = { id: number; skill: string; name: string; size: number; progress: number; state: 'queued' | 'uploading' | 'done' | 'error'; error?: string }

function AdminBody() {
  const { toasts, push, dismiss } = useToasts()
  const [status, setStatus] = useState<KbStatus | null>(null)
  const [skills, setSkills] = useState<KbSkill[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [files, setFiles] = useState<KbSkillFile[] | null>(null)
  const [uploads, setUploads] = useState<Upload[]>([])
  const [newSkillOpen, setNewSkillOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [autoIngest, setAutoIngestState] = useState(() => store(AUTO_INGEST_KEY) !== '0')
  const setAutoIngest = (v: boolean) => { setAutoIngestState(v); store(AUTO_INGEST_KEY, v ? '1' : '0') }

  const active = status?.active_ingestion ?? null
  // The ingestion we announce when it finishes (ours, or one already running when the page opened).
  const [watch, setWatch] = useState<{ id: string; skill: string | null } | null>(null)
  const autoIngestRef = useRef(autoIngest)
  autoIngestRef.current = autoIngest
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selected

  const loadSkills = useCallback(async () => {
    try {
      const s = await api.kbSkills()
      setSkills(s.skills)
      setSelected((cur) => (cur && s.skills.some((k) => k.skill === cur) ? cur : s.skills[0]?.skill ?? null))
    } catch (err: any) {
      push('err', `Couldn't load skills: ${err.message}`)
    }
  }, [push])

  const loadFiles = useCallback(async (skill: string | null) => {
    if (!skill) { setFiles(null); return }
    try {
      const r = await api.kbSkillFiles(skill)
      if (selectedRef.current === skill) setFiles(r.files)
    } catch {
      if (selectedRef.current === skill) setFiles([])
    }
  }, [])

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.kbStatus()
      setStatus(s)
      return s
    } catch {
      return null
    }
  }, [])

  const refreshAll = useCallback(async () => {
    await Promise.all([loadStatus(), loadSkills(), loadFiles(selectedRef.current)])
  }, [loadStatus, loadSkills, loadFiles])

  useEffect(() => { loadStatus(); loadSkills() }, [loadStatus, loadSkills])
  useEffect(() => { setFiles(null); loadFiles(selected) }, [selected, loadFiles])

  // Poll fast while an ingestion runs, slowly otherwise; announce the result when it finishes.
  useEffect(() => {
    const t = setInterval(async () => {
      const s = await loadStatus()
      if (!s) return
      if (s.active_ingestion) {
        if (!watch) setWatch({ id: s.active_ingestion.id, skill: null })
        return
      }
      if (watch) {
        const w = watch
        setWatch(null)
        try {
          const ing = await api.kbIngestion(w.id)
          const name = w.skill ? skills.find((k) => k.skill === w.skill)?.title ?? w.skill : 'Knowledge Bank'
          const failed = ing.progress?.failed ?? 0
          if (ing.status === 'done' && !failed) {
            push('ok', `${name} is ready — ${ing.files_ingested ?? 0} document(s) ingested, ${fmtNum(ing.nodes_created)} passages indexed.`)
          } else {
            push('err', `${name}: ingestion finished with ${failed || 'some'} failure(s). Check the document list.`)
          }
        } catch { /* ignore */ }
        refreshAll()
      }
    }, active || watch ? 1200 : 15000)
    return () => clearInterval(t)
  }, [active, watch, loadStatus, refreshAll, push, skills])

  const startIngest = useCallback(async (skill: string | null, label?: string) => {
    try {
      const res = skill ? await api.kbIngest(skill) : await api.kbIngest()
      if (res.status === 'nothing') { push('info', 'There are no Markdown files to ingest yet.'); return }
      setWatch({ id: res.ingestion_id, skill })
      push('info', `Ingesting ${label ?? 'the Knowledge Bank'}…`)
      await loadStatus()
    } catch (err: any) {
      push('err', err.message)
    }
  }, [push, loadStatus])

  // Uploads run one at a time; when a batch finishes we optionally ingest the skill.
  const uploading = useRef(false)
  const queue = useRef<{ upload: Upload; file: File }[]>([])

  const pump = useCallback(async () => {
    if (uploading.current) return
    uploading.current = true
    const touched = new Set<string>()
    let ok = 0
    while (queue.current.length) {
      const { upload, file } = queue.current.shift()!
      const patch = (p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.id === upload.id ? { ...x, ...p } : x)))
      patch({ state: 'uploading' })
      try {
        await api.kbUploadFile(upload.skill, upload.name, file, (f) => patch({ progress: f }))
        patch({ state: 'done', progress: 1 })
        touched.add(upload.skill)
        ok++
        setTimeout(() => setUploads((u) => u.filter((x) => x.id !== upload.id)), 2500)
      } catch (err: any) {
        patch({ state: 'error', error: err.message })
      }
    }
    uploading.current = false
    if (!ok) return
    await refreshAll()
    const list = Array.from(touched)
    if (autoIngestRef.current && list.length === 1) {
      const sk = list[0]
      startIngest(sk, skills.find((k) => k.skill === sk)?.title ?? sk)
    } else {
      push('ok', `${ok} file(s) uploaded. Press “Ingest” to make them searchable.`)
    }
  }, [refreshAll, startIngest, push, skills])

  const addFiles = useCallback((list: FileList | File[], skill: string) => {
    const accepted: { upload: Upload; file: File }[] = []
    const rejected: string[] = []
    Array.from(list).forEach((file, i) => {
      if (!/\.(md|markdown|txt)$/i.test(file.name)) { rejected.push(file.name); return }
      accepted.push({ file, upload: { id: Date.now() + i + Math.random(), skill, name: cleanFileName(file.name), size: file.size, progress: 0, state: 'queued' } })
    })
    if (rejected.length) push('err', `Only Markdown (.md) files can be added — skipped ${rejected.join(', ')}.`)
    if (!accepted.length) return
    setUploads((u) => [...u, ...accepted.map((a) => a.upload)])
    queue.current.push(...accepted)
    pump()
  }, [pump, push])

  const current = skills.find((k) => k.skill === selected) ?? null
  const readOnly = status?.writable === false

  return (
    <div className="px-4 py-6 md:px-8 md:py-8 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-900 flex items-center justify-center text-white shadow-glow shrink-0">
            <Library className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-ink-50">Knowledge Bank</h1>
            <p className="text-ink-500 text-sm">Organise your books into skills, upload them, and make them searchable in chat.</p>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2 md:flex">
          <StatPill label="Skills" value={skills.length} />
          <StatPill label="Documents" short="Docs" value={status?.documents} />
          <StatPill label="Passages" value={status?.total_nodes} />
          <StatPill label="Equations" value={status?.total_equations} />
        </div>
      </header>

      {readOnly && (
        <div className="flex items-start gap-3 p-4 rounded-2xl border border-warn/30 bg-warn/10 text-warn text-sm">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>The Knowledge Bank folder is read-only on the server, so new skills and uploads are disabled. Ingesting existing files still works.</span>
        </div>
      )}

      {active && <IngestBanner active={active} />}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6 items-start">
        {/* Skills list */}
        <aside className="space-y-3 lg:sticky lg:top-4">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-500">Skills</h2>
            <button onClick={() => setNewSkillOpen(true)} disabled={readOnly} className="text-xs font-medium text-brand-500 hover:text-brand-100 disabled:opacity-40 flex items-center gap-1">
              <Plus className="w-3.5 h-3.5" /> New skill
            </button>
          </div>
          <div className="flex lg:flex-col gap-2 overflow-x-auto lg:overflow-visible pb-1 -mx-4 px-4 lg:mx-0 lg:px-0 ink-scroll">
            {skills.map((k) => {
              const waiting = Math.max(0, k.source_files - k.documents)
              const on = k.skill === selected
              return (
                <button
                  key={k.skill}
                  onClick={() => setSelected(k.skill)}
                  className={`shrink-0 w-56 lg:w-full text-left flex items-center gap-3 p-3 rounded-2xl border transition-all ${
                    on ? 'bg-brand-500/10 border-brand-500/40 shadow-[0_0_0_1px_rgba(10,132,255,0.15)]' : 'bg-surface-card border-surface-border hover:border-ink-700'
                  }`}
                >
                  <SkillAvatar skill={k.skill} title={k.title} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink-50 truncate">{k.title}</div>
                    <div className="text-[11px] text-ink-500 truncate">
                      {k.documents} doc{k.documents === 1 ? '' : 's'}
                      {waiting > 0 && <span className="text-warn"> · {waiting} waiting</span>}
                      {k.source_files === 0 && k.documents === 0 && ' · empty'}
                    </div>
                  </div>
                  {active && watch?.skill === k.skill && <Loader2 className="w-4 h-4 animate-spin text-brand-500" />}
                </button>
              )
            })}
            <button
              onClick={() => setNewSkillOpen(true)}
              disabled={readOnly}
              className="shrink-0 w-56 lg:w-full flex items-center gap-3 p-3 rounded-2xl border border-dashed border-ink-700 text-ink-400 hover:text-ink-100 hover:border-brand-500/50 hover:bg-brand-500/5 transition-all disabled:opacity-40 disabled:pointer-events-none"
            >
              <div className="w-10 h-10 rounded-xl border border-dashed border-ink-700 flex items-center justify-center"><FolderPlus className="w-4 h-4" /></div>
              <span className="text-sm font-medium">Create a skill</span>
            </button>
          </div>
        </aside>

        {/* Selected skill */}
        <section className="min-w-0">
          {current ? (
            <SkillPanel
              key={current.skill}
              skill={current}
              files={files}
              uploads={uploads.filter((u) => u.skill === current.skill)}
              active={active}
              readOnly={readOnly}
              autoIngest={autoIngest}
              setAutoIngest={setAutoIngest}
              onFiles={(l) => addFiles(l, current.skill)}
              onIngest={() => startIngest(current.skill, current.title)}
              onClearUpload={(id) => setUploads((u) => u.filter((x) => x.id !== id))}
              onDeleteFile={(f) => setConfirm({
                title: `Remove “${f.title}”?`,
                body: <>The file <span className="font-mono text-ink-200">{f.file_name}</span> will be deleted from the server and removed from the Knowledge Bank. Chats will no longer find its passages.</>,
                action: 'Remove document',
                danger: true,
                run: async () => {
                  try {
                    await api.kbDeleteFile(current.skill, f.file_name)
                    push('ok', `Removed ${f.title}.`)
                    await refreshAll()
                  } catch (err: any) { push('err', err.message); throw err }
                },
              })}
              onDeleteSkill={() => setConfirm({
                title: `Delete the ${current.title} skill?`,
                body: <>This deletes all {current.source_files || current.documents} document(s) in <b className="text-ink-200">{current.title}</b> from the server and the Knowledge Bank. This cannot be undone.</>,
                action: 'Delete skill',
                danger: true,
                typeToConfirm: current.source_files + current.documents > 0 ? current.skill : undefined,
                run: async () => {
                  try {
                    await api.kbDeleteSkill(current.skill)
                    push('ok', `Deleted ${current.title}.`)
                    setSelected(null)
                    await refreshAll()
                  } catch (err: any) { push('err', err.message); throw err }
                },
              })}
            />
          ) : (
            <EmptyLibrary onCreate={() => setNewSkillOpen(true)} readOnly={readOnly} />
          )}
        </section>
      </div>

      {/* Tools */}
      <div className="card overflow-hidden">
        <button onClick={() => setToolsOpen(!toolsOpen)} className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-surface-border/30 transition-colors">
          <Wrench className="w-4 h-4 text-ink-500" />
          <div className="flex-1">
            <div className="text-sm font-medium text-ink-100">Tools</div>
            <div className="text-xs text-ink-500">Try a search, rebuild the index, or start over.</div>
          </div>
          <ChevronDown className={`w-4 h-4 text-ink-500 transition-transform ${toolsOpen ? 'rotate-180' : ''}`} />
        </button>
        {toolsOpen && (
          <div className="border-t border-surface-border p-5 space-y-6 fade-in">
            <TestSearch />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <ToolButton
                icon={<RefreshCw className="w-4 h-4" />}
                title="Rebuild everything"
                text="Re-read every file in every skill. Takes a few minutes."
                disabled={!!active}
                onClick={() => setConfirm({
                  title: 'Rebuild the whole Knowledge Bank?',
                  body: 'Every document is parsed again from its file. Chats keep working, but results may be incomplete until it finishes.',
                  action: 'Rebuild',
                  run: async () => {
                    try {
                      const r = await api.kbReindex()
                      if (r.ingestion_id) setWatch({ id: r.ingestion_id, skill: null })
                      push('info', 'Rebuilding the Knowledge Bank…')
                      await loadStatus()
                    } catch (err: any) { push('err', err.message); throw err }
                  },
                })}
              />
              <ToolButton
                danger
                icon={<Trash2 className="w-4 h-4" />}
                title="Clear the index"
                text="Forget every ingested document. Files stay on the server and can be ingested again."
                disabled={!!active}
                onClick={() => setConfirm({
                  title: 'Clear the Knowledge Bank index?',
                  body: 'All ingested documents are forgotten until you ingest them again. Your uploaded files are kept.',
                  action: 'Clear index',
                  danger: true,
                  typeToConfirm: 'clear',
                  run: async () => {
                    try { await api.kbClear(); push('ok', 'Index cleared.'); await refreshAll() } catch (err: any) { push('err', err.message); throw err }
                  },
                })}
              />
            </div>
            {status?.latest_ingestion && (
              <p className="text-xs text-ink-500">
                Last ingestion {ago(status.latest_ingestion.finished_at || status.latest_ingestion.started_at)} · {status.latest_ingestion.status} · {status.latest_ingestion.files_ingested ?? 0} ingested, {status.latest_ingestion.files_skipped ?? 0} unchanged
              </p>
            )}
          </div>
        )}
      </div>

      <NewSkillModal
        open={newSkillOpen}
        existing={skills.map((k) => k.skill)}
        onClose={() => setNewSkillOpen(false)}
        onCreate={async (slug) => {
          await api.kbCreateSkill(slug)
          push('ok', `Created ${slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} — now add some documents.`)
          await loadSkills()
          setSelected(slug)
        }}
      />
      <ConfirmModal spec={confirm} onClose={() => setConfirm(null)} />
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  )
}

// --------------------------------------------------------------------------- //
// Pieces
// --------------------------------------------------------------------------- //

function StatPill({ label, short, value }: { label: string; short?: string; value: number | undefined | null }) {
  return (
    <div className="min-w-0 px-2.5 md:px-3.5 py-2 rounded-2xl bg-surface-card border border-surface-border">
      <div className="text-[9px] md:text-[10px] uppercase tracking-wider text-ink-500 truncate"><span className="md:hidden">{short ?? label}</span><span className="hidden md:inline">{label}</span></div>
      <div className="text-sm md:text-base font-semibold text-ink-50 tabular-nums truncate">{value == null ? '—' : fmtNum(value)}</div>
    </div>
  )
}

function IngestBanner({ active }: { active: KbActiveIngestion }) {
  const pct = active.total ? Math.round((active.done / active.total) * 100) : 0
  return (
    <div className="card p-4 border-brand-500/30 bg-brand-500/5 fade-in">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl bg-brand-500/15 flex items-center justify-center text-brand-500"><Loader2 className="w-4 h-4 animate-spin" /></div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink-50">Ingesting documents…</div>
          <div className="text-xs text-ink-500 truncate">
            {active.current ? <>Reading <span className="text-ink-300">{active.current}</span> · </> : null}
            {active.done} done{active.failed ? <span className="text-danger"> · {active.failed} failed</span> : null}
          </div>
        </div>
        <div className="text-xs font-medium tabular-nums text-brand-500 shrink-0">File {Math.min(active.done + 1, active.total)} of {active.total}</div>
      </div>
      <div className="mt-3 h-1.5 rounded-full bg-surface-border overflow-hidden">
        <div className="h-full rounded-full bg-gradient-to-r from-brand-600 to-brand-500 transition-all duration-700 progress-shimmer" style={{ width: `${Math.max(pct, 4)}%` }} />
      </div>
    </div>
  )
}

function EmptyLibrary({ onCreate, readOnly }: { onCreate: () => void; readOnly: boolean }) {
  return (
    <div className="card p-10 text-center">
      <div className="w-14 h-14 mx-auto rounded-2xl bg-brand-500/10 text-brand-500 flex items-center justify-center mb-4"><BookOpen className="w-7 h-7" /></div>
      <h2 className="text-lg font-semibold text-ink-50">Your Knowledge Bank is empty</h2>
      <p className="text-sm text-ink-500 mt-1 max-w-sm mx-auto">Start with a skill, a subject like Physics or History, then add your books to it.</p>
      <button onClick={onCreate} disabled={readOnly} className="btn-primary mt-6 mx-auto"><FolderPlus className="w-4 h-4" /> Create your first skill</button>
    </div>
  )
}

const STATE_META: Record<KbSkillFile['state'], { label: string; cls: string }> = {
  ready: { label: 'Ready', cls: 'bg-success/10 text-success border-success/25' },
  new: { label: 'Not ingested', cls: 'bg-warn/10 text-warn border-warn/25' },
  changed: { label: 'Updated — ingest again', cls: 'bg-warn/10 text-warn border-warn/25' },
  failed: { label: 'Failed', cls: 'bg-danger/10 text-danger border-danger/25' },
  missing: { label: 'File missing', cls: 'bg-ink-800/40 text-ink-400 border-ink-700' },
}

function SkillPanel(props: {
  skill: KbSkill
  files: KbSkillFile[] | null
  uploads: Upload[]
  active: KbActiveIngestion | null
  readOnly: boolean
  autoIngest: boolean
  setAutoIngest: (v: boolean) => void
  onFiles: (l: FileList | File[]) => void
  onIngest: () => void
  onClearUpload: (id: number) => void
  onDeleteFile: (f: KbSkillFile) => void
  onDeleteSkill: () => void
}) {
  const { skill, files, uploads, active, readOnly } = props
  const [filter, setFilter] = useState('')
  const pending = (files ?? []).filter((f) => f.state === 'new' || f.state === 'changed' || f.state === 'failed')
  const ready = (files ?? []).filter((f) => f.state === 'ready')
  const hasFiles = (files?.length ?? 0) > 0
  const busyUploading = uploads.some((u) => u.state === 'uploading' || u.state === 'queued')

  const steps = [
    { n: 1, short: 'Add', title: 'Add documents', text: 'Drop Markdown books below', done: hasFiles },
    { n: 2, short: 'Ingest', title: 'Ingest', text: pending.length ? `${pending.length} waiting` : 'Index for search', done: hasFiles && pending.length === 0 },
    { n: 3, short: 'Chat', title: 'Use in chat', text: 'Attach with + in the composer', done: ready.length > 0 && pending.length === 0 },
  ]
  const currentStep = steps.find((s) => !s.done)?.n ?? 4

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = [...(files ?? [])].sort((a, b) => {
      const rank = (f: KbSkillFile) => (f.state === 'ready' ? 1 : f.state === 'missing' ? 2 : 0)
      return rank(a) - rank(b) || a.title.localeCompare(b.title)
    })
    return q ? list.filter((f) => f.title.toLowerCase().includes(q) || f.file_name.toLowerCase().includes(q)) : list
  }, [files, filter])

  return (
    <div className="space-y-5 fade-in">
      {/* Skill header */}
      <div className="card p-5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex items-center gap-4 min-w-0 flex-1">
            <SkillAvatar skill={skill.skill} title={skill.title} size="lg" />
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-semibold text-ink-50 truncate">{skill.title}</h2>
              <p className="text-sm text-ink-500">
                {skill.documents} document{skill.documents === 1 ? '' : 's'} · {fmtNum(skill.nodes)} passages · {fmtNum(skill.equations)} equations
                {skill.updated ? <> · updated {ago(skill.updated)}</> : null}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              style={{ flex: '1 1 auto' }}
              onClick={props.onIngest}
              disabled={!!active || pending.length === 0 || busyUploading}
              className={pending.length || active ? 'btn-primary' : 'btn-ghost'}
              title={pending.length === 0 ? 'Everything in this skill is already ingested' : undefined}
            >
              {active ? <Loader2 className="w-4 h-4 animate-spin" /> : pending.length ? <Sparkles className="w-4 h-4" /> : <Check className="w-4 h-4" />}
              {pending.length ? `Ingest ${pending.length} document${pending.length === 1 ? '' : 's'}` : active ? 'Ingesting…' : 'All ingested'}
            </button>
            <button onClick={props.onDeleteSkill} disabled={!!active || readOnly} className="btn-icon hover:text-danger hover:bg-danger/10" title="Delete skill" aria-label="Delete skill">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Steps */}
        <ol className="mt-5 grid grid-cols-3 gap-2">
          {steps.map((s) => {
            const isCurrent = s.n === currentStep
            return (
              <li key={s.n} className={`relative rounded-xl p-3 border transition-colors ${
                s.done ? 'border-success/25 bg-success/5' : isCurrent ? 'border-brand-500/40 bg-brand-500/10' : 'border-surface-border'
              }`}>
                <div className="flex items-center gap-2">
                  <span className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0 ${
                    s.done ? 'bg-success text-black' : isCurrent ? 'bg-brand-500 text-white' : 'bg-surface-border text-ink-400'
                  }`}>{s.done ? <Check className="w-3 h-3" /> : s.n}</span>
                  <span className={`text-xs sm:text-sm font-medium truncate ${s.done || isCurrent ? 'text-ink-50' : 'text-ink-500'}`}><span className="sm:hidden">{s.short}</span><span className="hidden sm:inline">{s.title}</span></span>
                </div>
                <div className="hidden sm:block text-[11px] text-ink-500 mt-1 pl-7 truncate">
                  {s.n === 3 && s.done ? <Link to="/chat" className="text-brand-500 hover:underline inline-flex items-center gap-1">Open chat <ArrowRight className="w-3 h-3" /></Link> : s.text}
                </div>
              </li>
            )
          })}
        </ol>
      </div>

      {/* Upload */}
      <DropZone disabled={readOnly} compact={hasFiles} onFiles={props.onFiles} skillTitle={skill.title} />
      <label className="flex items-center gap-2.5 px-1 text-sm text-ink-400 cursor-pointer select-none w-fit">
        <span className={`relative w-9 h-5 rounded-full transition-colors ${props.autoIngest ? 'bg-brand-500' : 'bg-surface-border'}`}>
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${props.autoIngest ? 'translate-x-4' : ''}`} />
        </span>
        <input type="checkbox" className="sr-only" checked={props.autoIngest} onChange={(e) => props.setAutoIngest(e.target.checked)} />
        Ingest automatically after upload
      </label>

      {uploads.length > 0 && (
        <div className="card divide-y divide-surface-border overflow-hidden">
          {uploads.map((u) => (
            <div key={u.id} className="flex items-center gap-3 px-4 py-3">
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${u.state === 'error' ? 'bg-danger/15 text-danger' : u.state === 'done' ? 'bg-success/15 text-success' : 'bg-brand-500/15 text-brand-500'}`}>
                {u.state === 'done' ? <Check className="w-4 h-4" /> : u.state === 'error' ? <AlertTriangle className="w-4 h-4" /> : <CloudUpload className="w-4 h-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex justify-between gap-2 text-sm">
                  <span className="truncate text-ink-100">{u.name}</span>
                  <span className="text-ink-500 tabular-nums shrink-0 text-xs">
                    {u.state === 'error' ? 'Failed' : u.state === 'done' ? 'Uploaded' : u.state === 'queued' ? 'Waiting' : `${Math.round(u.progress * 100)}%`} · {fmtSize(u.size)}
                  </span>
                </div>
                {u.state === 'error' ? (
                  <div className="text-xs text-danger mt-0.5">{u.error}</div>
                ) : (
                  <div className="mt-1.5 h-1 rounded-full bg-surface-border overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${u.state === 'done' ? 'bg-success' : 'bg-brand-500'}`} style={{ width: `${u.progress * 100}%` }} />
                  </div>
                )}
              </div>
              {u.state === 'error' && <button onClick={() => props.onClearUpload(u.id)} className="btn-icon" aria-label="Dismiss"><X className="w-4 h-4" /></button>}
            </div>
          ))}
        </div>
      )}

      {/* Documents */}
      <div className="card overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-surface-border">
          <h3 className="text-sm font-semibold text-ink-100 flex-1">Documents {files ? <span className="text-ink-500 font-normal">· {files.length}</span> : null}</h3>
          {(files?.length ?? 0) > 6 && (
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-600" />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className="field !py-1.5 pl-8 w-36 sm:w-48 text-sm" />
            </div>
          )}
        </div>
        {files === null ? (
          <div className="p-5 space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-12 rounded-xl bg-surface-border/40 animate-pulse" />)}</div>
        ) : files.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-ink-500">No documents yet. Drop your first book above.</div>
        ) : (
          <ul className="divide-y divide-surface-border">
            {shown.map((f) => {
              const meta = STATE_META[f.state]
              const ingesting = !!active && active.current === f.file_name
              return (
                <li key={f.doc_id + f.file_name} className="group flex items-center gap-3 px-5 py-3.5 hover:bg-surface-border/20 transition-colors">
                  <div className="w-9 h-9 rounded-xl bg-surface-border/60 flex items-center justify-center text-ink-400 shrink-0"><FileText className="w-4 h-4" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink-50 truncate" title={f.title}>{f.title}</div>
                    <div className="text-[11px] text-ink-500 truncate">
                      {f.file_name} · {fmtSize(f.size)}
                      {f.state === 'ready' && <> · {fmtNum(f.nodes)} passages · {fmtNum(f.equations)} equations</>}
                    </div>
                    {f.state === 'failed' && f.error && <div className="text-[11px] text-danger truncate" title={f.error}>{f.error}</div>}
                  </div>
                  <span className={`hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-medium shrink-0 ${ingesting ? 'bg-brand-500/10 text-brand-500 border-brand-500/30' : meta.cls}`}>
                    {ingesting ? <><Loader2 className="w-3 h-3 animate-spin" /> Ingesting</> : meta.label}
                  </span>
                  <span className={`sm:hidden w-2 h-2 rounded-full shrink-0 ${f.state === 'ready' ? 'bg-success' : f.state === 'failed' ? 'bg-danger' : f.state === 'missing' ? 'bg-ink-600' : 'bg-warn'}`} title={meta.label} />
                  <button
                    onClick={() => props.onDeleteFile(f)}
                    disabled={!!active || (readOnly && f.state !== 'missing')}
                    className="btn-icon sm:opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-danger hover:bg-danger/10 disabled:!opacity-30"
                    title="Remove document"
                    aria-label={`Remove ${f.title}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {ready.length > 0 && (
        <div className="flex items-center gap-3 p-4 rounded-2xl bg-gradient-to-r from-brand-500/10 to-transparent border border-brand-500/20">
          <MessageSquare className="w-5 h-5 text-brand-500 shrink-0" />
          <p className="text-sm text-ink-300 flex-1">In chat, press <b className="text-ink-50">+</b> and pick <b className="text-ink-50">{skill.title}</b> to answer from these books.</p>
          <Link to="/chat" className="text-sm font-medium text-brand-500 hover:text-brand-100 inline-flex items-center gap-1 shrink-0">Open chat <ArrowRight className="w-3.5 h-3.5" /></Link>
        </div>
      )}
    </div>
  )
}

function DropZone({ onFiles, disabled, compact, skillTitle }: { onFiles: (l: FileList | File[]) => void; disabled: boolean; compact: boolean; skillTitle: string }) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const depth = useRef(0)
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={() => !disabled && input.current?.click()}
      onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); input.current?.click() } }}
      onDragEnter={(e) => { e.preventDefault(); depth.current++; if (!disabled) setOver(true) }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => { depth.current--; if (depth.current <= 0) setOver(false) }}
      onDrop={(e) => {
        e.preventDefault(); depth.current = 0; setOver(false)
        if (!disabled && e.dataTransfer.files.length) onFiles(e.dataTransfer.files)
      }}
      className={`relative rounded-3xl border-2 border-dashed text-center cursor-pointer transition-all outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
        compact ? 'px-6 py-6' : 'px-6 py-14'
      } ${disabled ? 'opacity-40 cursor-not-allowed border-ink-700' : over ? 'border-brand-500 bg-brand-500/10 scale-[1.01]' : 'border-ink-700 hover:border-brand-500/60 hover:bg-brand-500/5'}`}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        className="hidden"
        onChange={(e) => { if (e.target.files?.length) onFiles(e.target.files); e.target.value = '' }}
      />
      <div className={`flex ${compact ? 'flex-row justify-center gap-3' : 'flex-col'} items-center`}>
        <div className={`${compact ? 'w-10 h-10' : 'w-14 h-14 mb-4'} rounded-2xl flex items-center justify-center transition-colors ${over ? 'bg-brand-500 text-white' : 'bg-brand-500/15 text-brand-500'}`}>
          <CloudUpload className={compact ? 'w-5 h-5' : 'w-7 h-7'} />
        </div>
        <div className={compact ? 'text-left' : ''}>
          <div className="text-sm font-medium text-ink-50">
            {over ? 'Drop to upload' : <>Drop Markdown files here or <span className="text-brand-500">browse</span></>}
          </div>
          <div className="text-xs text-ink-500 mt-0.5">Added to {skillTitle} · .md files, any size</div>
        </div>
      </div>
    </div>
  )
}

const SUGGESTIONS = ['Chemistry', 'History', 'Mathematics', 'Biology', 'Economics', 'Computer Science']

function NewSkillModal({ open, existing, onClose, onCreate }: { open: boolean; existing: string[]; onClose: () => void; onCreate: (slug: string) => Promise<void> }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (open) { setName(''); setError(null); setBusy(false) } }, [open])
  const slug = slugify(name)
  const taken = existing.includes(slug)
  const title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return (
    <Modal open={open} onClose={() => !busy && onClose()}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!slug || taken) return
          setBusy(true); setError(null)
          try { await onCreate(slug); onClose() } catch (err: any) { setError(err.message); setBusy(false) }
        }}
      >
        <div className="flex items-start justify-between">
          <div className="w-11 h-11 rounded-2xl bg-brand-500/15 text-brand-500 flex items-center justify-center"><FolderPlus className="w-5 h-5" /></div>
          <button type="button" onClick={onClose} className="btn-icon" aria-label="Close"><X className="w-4 h-4" /></button>
        </div>
        <h3 className="text-lg font-semibold text-ink-50 mt-4">New skill</h3>
        <p className="text-sm text-ink-500 mt-1">A skill is a subject that groups related books. In chat you can attach a whole skill at once.</p>

        <label className="block text-xs text-ink-500 mt-5 mb-1.5" htmlFor="skill-name">Name</label>
        <input id="skill-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Organic Chemistry" className="field" maxLength={60} />
        <div className="flex flex-wrap gap-1.5 mt-3">
          {SUGGESTIONS.filter((s) => !existing.includes(slugify(s))).map((s) => (
            <button type="button" key={s} onClick={() => setName(s)} className="px-2.5 py-1 rounded-full text-xs border border-surface-border text-ink-400 hover:text-ink-50 hover:border-ink-600">{s}</button>
          ))}
        </div>

        {slug && (
          <div className={`mt-5 flex items-center gap-3 p-3 rounded-2xl border ${taken ? 'border-danger/30 bg-danger/5' : 'border-surface-border bg-surface-card'}`}>
            <SkillAvatar skill={slug} title={title} size="sm" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink-50 truncate">{title}</div>
              <div className={`text-[11px] ${taken ? 'text-danger' : 'text-ink-500'}`}>{taken ? 'A skill with this name already exists' : <>ID <span className="font-mono">{slug}</span></>}</div>
            </div>
          </div>
        )}
        {error && <p className="text-xs text-danger mt-3">{error}</p>}

        <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
          <button type="submit" disabled={!slug || taken || busy} className="btn-primary">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create skill
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ToolButton({ icon, title, text, onClick, danger, disabled }: { icon: React.ReactNode; title: string; text: string; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`text-left flex gap-3 p-4 rounded-2xl border transition-colors disabled:opacity-40 disabled:pointer-events-none ${
        danger ? 'border-danger/20 hover:bg-danger/5' : 'border-surface-border hover:bg-surface-border/30'
      }`}
    >
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${danger ? 'bg-danger/10 text-danger' : 'bg-surface-border text-ink-300'}`}>{icon}</div>
      <div>
        <div className={`text-sm font-medium ${danger ? 'text-danger' : 'text-ink-100'}`}>{title}</div>
        <div className="text-xs text-ink-500 mt-0.5">{text}</div>
      </div>
    </button>
  )
}

function TestSearch() {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<KbSearchResult[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    if (!q.trim()) return
    setLoading(true); setError(null)
    try { setResults((await api.kbSearch({ q, limit: 20 })).results || []) } catch (err: any) { setError(err.message); setResults(null) } finally { setLoading(false) }
  }
  return (
    <div>
      <div className="text-sm font-medium text-ink-100 mb-1">Try a search</div>
      <p className="text-xs text-ink-500 mb-3">See which passages the Knowledge Bank finds for a phrase. Plain keyword search, without the AI planning used in chat.</p>
      <form onSubmit={(e) => { e.preventDefault(); run() }} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-600" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. conservation of angular momentum" className="field pl-9" />
        </div>
        <button type="submit" disabled={loading || !q.trim()} className="btn-primary">{loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}</button>
      </form>
      {error && <p className="text-xs text-danger mt-2">{error}</p>}
      {results && (
        results.length === 0 ? <p className="text-sm text-ink-500 mt-4">No passages matched.</p> : (
          <ul className="mt-4 space-y-2 max-h-96 overflow-y-auto ink-scroll pr-1">
            {results.map((r) => (
              <li key={r.id} className="p-3 rounded-xl border border-surface-border bg-surface-base/40">
                <div className="flex items-center gap-2 text-[11px] text-ink-500">
                  <span className="px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-500 font-medium capitalize">{r.type}</span>
                  <span className="truncate">{r.document_title || r.document_name}{r.parent_title ? ` › ${r.parent_title}` : ''}</span>
                </div>
                {r.title && <div className="text-sm font-medium text-ink-100 mt-1 truncate">{r.title}</div>}
                <div className="text-xs text-ink-400 mt-1 line-clamp-3">{r.content}</div>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  )
}
