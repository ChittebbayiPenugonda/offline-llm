import type { Conversation, Settings } from './types'

const CONV_KEY = 'offline-llm:conversations'
const SETTINGS_KEY = 'offline-llm:settings'
const MODEL_KEY = 'offline-llm:model'

export const defaultSettings: Settings = {
  systemPrompt: 'You are a helpful, concise assistant. Use Markdown when it helps.',
  temperature: 0.7,
  maxTokens: 0,
  contextLength: 8192,
}

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export const loadConversations = () => read<Conversation[]>(CONV_KEY, [])
export function saveConversations(c: Conversation[]) {
  if (write(CONV_KEY, c)) return
  // Storage full (usually images): drop image data from older chats and retry.
  const slim = c.map((conv, i) =>
    i < 3 ? conv : { ...conv, messages: conv.messages.map((m) => ({ ...m, images: undefined })) },
  )
  write(CONV_KEY, slim)
}

export const loadSettings = () => ({ ...defaultSettings, ...read<Partial<Settings>>(SETTINGS_KEY, {}) })
export const saveSettings = (s: Settings) => write(SETTINGS_KEY, s)
export const loadModelChoice = () => read<string | null>(MODEL_KEY, null)
export const saveModelChoice = (m: string | null) => write(MODEL_KEY, m)

export const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)
