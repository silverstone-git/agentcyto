import { useEffect, useState } from 'react'
import { api, Health, Usage } from '../lib/api'
import { RefreshCw, AlertCircle, CheckCircle } from 'lucide-react'

export default function StatusPage() {
  const [health, setHealth] = useState<Health | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    try {
      setLoading(true)
      const [h, u] = await Promise.all([api.health(), api.usage()])
      setHealth(h)
      setUsage(u)
      setError(null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 15000)
    return () => clearInterval(t)
  }, [])

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-ink-600">
        <RefreshCw className="w-8 h-8 animate-spin mb-3" />
        <p>Loading status…</p>
      </div>
    )
  }

  const pct = usage && usage.budget_usd ? Math.min(100, (usage.spent_usd / usage.budget_usd) * 100) : 0

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-50">System status</h1>
          <p className="text-ink-500 text-sm">Gateway, budget, and recent usage.</p>
        </div>
        <button
          onClick={refresh}
          className={`p-2 rounded-xl transition-all ${
            loading ? 'opacity-50 cursor-not-allowed' : 'hover:bg-surface-border hover:text-ink-100'
          }`}
          disabled={loading}
        >
          <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Health cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-ink-500">Gateway</p>
              <p className="text-lg font-semibold text-ink-50">{health?.gateway === 'ok' ? 'Operational' : 'Down'}</p>
            </div>
            <div className={`w-2 h-2 rounded-full ${health?.gateway === 'ok' ? 'bg-success' : 'bg-danger'}`} />
          </div>
          <p className="mt-2 text-xs text-ink-600">{health?.status || '—'}</p>
        </div>
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-ink-500">Daily budget</p>
              <p className="text-lg font-semibold text-ink-50">
                ${usage?.spent_usd?.toFixed(4) || '0'} / ${usage?.budget_usd?.toFixed(2) || '0'}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs font-semibold">{pct.toFixed(0)}%</p>
            </div>
          </div>
          <div className="mt-3 h-2 bg-surface-border rounded-full overflow-hidden">
            <div
              className="h-full bg-brand-500 shadow-glow"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-ink-600">
            {usage?.spent_usd ? `$${usage.spent_usd.toFixed(4)} spent today` : 'No usage yet'}
          </p>
        </div>
      </div>

      {/* Recent usage */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-ink-200">Recent usage</h2>
          <span className="text-xs text-ink-600">{usage?.recent?.length || 0} entries</span>
        </div>
        {error && (
          <div className="p-3 rounded-xl bg-danger/10 border border-danger/20 text-danger text-sm">
            {error}
          </div>
        )}
        {!usage || usage.recent.length === 0 ? (
          <div className="text-center py-8 text-ink-600 italic">No recent usage records.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-surface-border text-ink-600">
                  <th className="pb-2 pr-3 whitespace-nowrap">Time</th>
                  <th className="pb-2 pr-3 whitespace-nowrap">Model</th>
                  <th className="pb-2 pr-3 whitespace-nowrap text-right">Tokens</th>
                  <th className="pb-2 pr-3 whitespace-nowrap text-right">Cost</th>
                  <th className="pb-2 pr-3 whitespace-nowrap">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {usage.recent.slice().reverse().map((u: any, i: number) => (
                  <tr key={i}>
                    <td className="py-2 pr-3 text-ink-400">{u.timestamp || '—'}</td>
                    <td className="py-2 pr-3 text-ink-300">{u.model || '—'}</td>
                    <td className="py-2 pr-3 text-ink-300 text-right">{u.tokens || '—'}</td>
                    <td className="py-2 pr-3 text-ink-300 text-right">${(u.cost_usd || 0).toFixed(4)}</td>
                    <td className="py-2 pr-3">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium">
                        {u.status === 'done' ? (
                          <>
                            <CheckCircle className="w-2.5 h-2.5 text-success" />
                            <span className="text-success">done</span>
                          </>
                        ) : (
                          <>
                            <AlertCircle className="w-2.5 h-2.5 text-danger" />
                            <span className="text-danger">{u.status}</span>
                          </>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
