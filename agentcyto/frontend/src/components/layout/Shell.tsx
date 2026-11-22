import { useState } from 'react'
import { NavLink } from 'react-router-dom'

export default function Shell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(typeof window !== 'undefined' && window.innerWidth < 768)

  const navItems = [
    { to: '/chat', label: 'Chat', icon: '💬' },
    { to: '/status', label: 'Status', icon: '📊' },
    { to: '/admin', label: 'Admin', icon: '⚙️' },
  ]

  return (
    <div className="flex h-[100dvh] overflow-hidden text-ink-50">
      {!collapsed && (
        <div className="fixed inset-0 z-[65] bg-black/60 md:hidden" onClick={() => setCollapsed(true)} />
      )}
      <button
        onClick={() => setCollapsed(false)}
        className={`fixed top-2 left-2 z-[60] h-10 w-10 rounded-xl bg-surface-card border border-surface-border text-ink-50 text-lg flex items-center justify-center md:hidden active:bg-surface-border ${collapsed ? '' : 'hidden'}`}
        aria-label="Open menu"
      >☰</button>
      <aside
        className={`
          fixed inset-y-0 left-0 z-[70] w-64 glass max-md:!bg-surface-elevated max-md:!backdrop-blur-none
          transition-all duration-300
          ${collapsed ? '-translate-x-full md:translate-x-0 md:w-16' : ''}
          border-r border-surface-border
        `}
      >
        <div className="flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-xl bg-brand-600 flex items-center justify-center shadow-glow">
              <span className="text-[10px] font-bold">A</span>
            </div>
            <span className={collapsed ? 'hidden' : 'font-semibold text-ink-50 tracking-tight'}>
              agentcyto
            </span>
          </div>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="p-2 rounded-lg hover:bg-surface-border text-ink-400 transition-colors"
            aria-label="Collapse sidebar"
          >
            {collapsed ? '☰' : '◀'}
          </button>
        </div>

        <nav className="mt-4 flex-1 overflow-y-auto p-2 space-y-1 ink-scroll">
          {navItems.map((item) => {
            return (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => { if (window.innerWidth < 768) setCollapsed(true) }}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-brand-500/10 text-brand-400 border border-brand-500/20'
                      : 'text-ink-400 hover:bg-surface-border hover:text-ink-100'
                  }`
                }
              >
                <span className="w-6 text-center">{item.icon}</span>
                {!collapsed && item.label}
              </NavLink>
            )
          })}

          <div className="mt-6 pt-4 border-t border-surface-border">
            <div className="flex items-center gap-3 px-3 py-2 text-xs text-ink-600 font-medium">
              <span className="w-6 text-center">🔒</span>
              {!collapsed && 'Basic auth via nginx'}
            </div>
          </div>
        </nav>
      </aside>

        <main className={`
          flex-1 flex flex-col overflow-hidden
          ${collapsed ? 'md:pl-16' : 'md:pl-64'}
          transition-all duration-300
        `}>
          {children}
        </main>
    </div>
  )
}
