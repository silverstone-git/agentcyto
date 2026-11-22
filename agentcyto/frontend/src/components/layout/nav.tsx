import { createContext, useContext } from 'react'

export const NavContext = createContext<{ openMenu: () => void }>({ openMenu: () => {} })

export function MenuButton({ className = '' }: { className?: string }) {
  const { openMenu } = useContext(NavContext)
  return (
    <button
      onClick={openMenu}
      aria-label="Open menu"
      className={`h-9 w-9 shrink-0 rounded-xl flex items-center justify-center text-ink-100 hover:bg-surface-border active:bg-surface-border md:hidden ${className}`}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
    </button>
  )
}
