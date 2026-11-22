// Bring-your-own-key providers and chat settings, kept in this browser's localStorage only.
// The API key is sent to the BFF per request (held in memory server-side, never stored there).

export type ApiType = 'openai' | 'anthropic' | 'gemini'

export interface Provider {
  id: string
  label: string
  api_type: ApiType
  base_url: string
  api_key: string
  model: string
  models?: string[]
}

export interface Preset {
  key: string
  label: string
  api_type: ApiType
  base_url: string
  model?: string
}

export const API_TYPE_LABEL: Record<ApiType, string> = {
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic Messages',
  gemini: 'Google Gemini',
}

export const PRESETS: Preset[] = [
  { key: 'openai', label: 'OpenAI', api_type: 'openai', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { key: 'anthropic', label: 'Anthropic', api_type: 'anthropic', base_url: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  { key: 'gemini', label: 'Google Gemini', api_type: 'gemini', base_url: 'https://generativelanguage.googleapis.com', model: 'gemini-2.5-flash' },
  { key: 'openrouter', label: 'OpenRouter', api_type: 'openai', base_url: 'https://openrouter.ai/api/v1' },
  { key: 'groq', label: 'Groq', api_type: 'openai', base_url: 'https://api.groq.com/openai/v1' },
  { key: 'together', label: 'Together AI', api_type: 'openai', base_url: 'https://api.together.xyz/v1' },
  { key: 'mistral', label: 'Mistral', api_type: 'openai', base_url: 'https://api.mistral.ai/v1' },
  { key: 'deepseek', label: 'DeepSeek', api_type: 'openai', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { key: 'xai', label: 'xAI (Grok)', api_type: 'openai', base_url: 'https://api.x.ai/v1' },
  { key: 'fireworks', label: 'Fireworks', api_type: 'openai', base_url: 'https://api.fireworks.ai/inference/v1' },
  { key: 'perplexity', label: 'Perplexity', api_type: 'openai', base_url: 'https://api.perplexity.ai' },
  { key: 'cerebras', label: 'Cerebras', api_type: 'openai', base_url: 'https://api.cerebras.ai/v1' },
  { key: 'nvidia', label: 'NVIDIA NIM', api_type: 'openai', base_url: 'https://integrate.api.nvidia.com/v1' },
  { key: 'moonshot', label: 'Moonshot (Kimi)', api_type: 'openai', base_url: 'https://api.moonshot.ai/v1' },
  { key: 'cohere', label: 'Cohere', api_type: 'openai', base_url: 'https://api.cohere.ai/compatibility/v1' },
  { key: 'custom', label: 'Custom URL', api_type: 'openai', base_url: '' },
]

export interface ChatSettings {
  mode: string
  role: 'chat' | 'agent'
  model: string // '' = auto (mode default)
  providerId: string // '' = built-in gateway
  systemPrompt: string
  temperature: number | null
  maxTokens: number | null
}

export const DEFAULT_SETTINGS: ChatSettings = {
  mode: 'heavy', role: 'chat', model: '', providerId: '',
  systemPrompt: '', temperature: null, maxTokens: null,
}

const SETTINGS_KEY = 'agentcyto.settings'
const PROVIDERS_KEY = 'agentcyto.providers'

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch (_) { return fallback }
}

export const loadSettings = (): ChatSettings => read(SETTINGS_KEY, DEFAULT_SETTINGS)
export const saveSettings = (s: ChatSettings) => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch (_) { /* private mode */ } }

export function loadProviders(): Provider[] {
  try {
    const v = JSON.parse(localStorage.getItem(PROVIDERS_KEY) || '[]')
    return Array.isArray(v) ? v : []
  } catch (_) { return [] }
}
export const saveProviders = (p: Provider[]) => { try { localStorage.setItem(PROVIDERS_KEY, JSON.stringify(p)) } catch (_) { /* private mode */ } }

export const byokPayload = (p: Provider) => ({
  api_type: p.api_type, base_url: p.base_url, api_key: p.api_key, model: p.model, label: p.label,
})
