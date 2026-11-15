export type Role = 'system' | 'user' | 'assistant'

export interface Stats {
  tokens: number
  tokensPerSec: number
  ttftMs: number
  approx: boolean
}

export interface Message {
  id: string
  role: Role
  content: string
  reasoning?: string
  images?: string[] // data URLs
  model?: string
  stats?: Stats
  error?: string
}

export interface Conversation {
  id: string
  title: string
  model: string | null
  messages: Message[]
  createdAt: number
  updatedAt: number
}

export interface Settings {
  systemPrompt: string
  temperature: number
  maxTokens: number // 0 = no limit
  contextLength: number
}

export interface SystemInfo {
  appleSilicon: boolean
  chip: string
  totalMemoryGB: number
  gpuBudgetGB: number
  gpuWiredLimitOverridden: boolean
  performanceCores: number | null
  efficiencyCores: number | null
  gpuCores: number | null
  lmsAvailable: boolean
}

export interface LocalModel {
  key: string
  name: string
  format: string
  sizeGB: number
  params: string | null
  quant: string | null
  vision: boolean
  tools: boolean
  maxContext: number | null
  loaded: boolean
  identifier: string | null
  contextLength: number | null
  status: string | null
}

export interface Estimate {
  gpuGB: number | null
  totalGB: number | null
  fits: boolean
  raw: string
}
