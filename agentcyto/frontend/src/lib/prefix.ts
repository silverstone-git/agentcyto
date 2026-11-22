// Public deployment lives under /agentcyto/ (nginx strips it); local dev is at /.
export const PREFIX = typeof window !== 'undefined' && window.location.pathname.startsWith('/agentcyto') ? '/agentcyto' : ''
