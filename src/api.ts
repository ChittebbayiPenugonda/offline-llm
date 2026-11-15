import type { Estimate, LocalModel, Message, Stats, SystemInfo } from './types'

const LLM = '/llm/v1'
const BRIDGE_HEADERS = { 'Content-Type': 'application/json', 'X-Offline-LLM': '1' }

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as any)?.error?.message ?? (body as any)?.error ?? `HTTP ${res.status}`)
  return body as T
}

export const getSystem = () => fetch('/local/system').then((r) => json<SystemInfo>(r))
export const getLocalModels = () => fetch('/local/models').then((r) => json<LocalModel[]>(r))

export const estimateModel = (modelKey: string, contextLength: number) =>
  fetch('/local/estimate', {
    method: 'POST',
    headers: BRIDGE_HEADERS,
    body: JSON.stringify({ modelKey, contextLength, gpu: 'max' }),
  }).then((r) => json<Estimate>(r))

export const loadModel = (modelKey: string, contextLength: number) =>
  fetch('/local/load', {
    method: 'POST',
    headers: BRIDGE_HEADERS,
    body: JSON.stringify({ modelKey, contextLength, gpu: 'max' }),
  }).then((r) => json<{ ok: true; models: LocalModel[] }>(r))

export const unloadAll = () =>
  fetch('/local/unload', { method: 'POST', headers: BRIDGE_HEADERS }).then((r) => json(r))

/**
 * Holds a connection open while this window is open. With `npm start`, the
 * server shuts down (and restores LM Studio) a few seconds after the last
 * window closes. EventSource reconnects by itself after sleep or a hiccup.
 */
export function keepAlive(): () => void {
  const es = new EventSource('/local/alive')
  return () => es.close()
}

export const startServer = () =>
  fetch('/local/server/start', { method: 'POST', headers: BRIDGE_HEADERS }).then((r) => json(r))

/** Models the OpenAI-compatible server reports (works for LM Studio, Ollama, llama.cpp…). */
export async function getServerModels(): Promise<string[]> {
  const r = await fetch(`${LLM}/models`)
  const body = await json<{ data: { id: string }[] }>(r)
  return body.data.map((m) => m.id).filter((id) => !/embed/i.test(id))
}

function toApiMessages(messages: Message[], systemPrompt: string) {
  const out: any[] = []
  if (systemPrompt.trim()) out.push({ role: 'system', content: systemPrompt })
  for (const m of messages) {
    if (m.error) continue
    if (m.images?.length) {
      out.push({
        role: m.role,
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

export interface StreamUpdate {
  content: string
  reasoning: string
}

/** Streams a chat completion; splits <think>…</think> blocks from reasoning models into `reasoning`. */
export async function streamChat(opts: {
  model: string
  messages: Message[]
  systemPrompt: string
  temperature: number
  maxTokens: number
  signal: AbortSignal
  onUpdate: (u: StreamUpdate) => void
}): Promise<{ content: string; reasoning: string; stats: Stats }> {
  const start = performance.now()
  let firstTokenAt = 0
  let raw = ''
  let reasoningField = ''
  let usageTokens: number | null = null
  let serverTps: number | null = null

  const res = await fetch(`${LLM}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: toApiMessages(opts.messages, opts.systemPrompt),
      temperature: opts.temperature,
      ...(opts.maxTokens > 0 ? { max_tokens: opts.maxTokens } : {}),
      stream: true,
      stream_options: { include_usage: true },
    }),
  })
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => '')
    let msg = t
    try {
      const j = JSON.parse(t)
      msg = j?.error?.message ?? j?.error ?? t
    } catch {}
    throw new Error(msg || `HTTP ${res.status}`)
  }

  const split = () => splitThinking(raw, reasoningField)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const l = line.trim()
        if (!l.startsWith('data:')) continue
        const data = l.slice(5).trim()
        if (data === '[DONE]') continue
        let chunk: any
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        if (chunk.error) throw new Error(chunk.error.message ?? String(chunk.error))
        const delta = chunk.choices?.[0]?.delta ?? {}
        const piece: string = delta.content ?? ''
        const rpiece: string = delta.reasoning_content ?? delta.reasoning ?? ''
        if ((piece || rpiece) && !firstTokenAt) firstTokenAt = performance.now()
        raw += piece
        reasoningField += rpiece
        if (chunk.usage?.completion_tokens) usageTokens = chunk.usage.completion_tokens
        if (chunk.stats?.tokens_per_second) serverTps = chunk.stats.tokens_per_second
        if (piece || rpiece) opts.onUpdate(split())
      }
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e
  }

  const end = performance.now()
  const { content, reasoning } = split()
  // Rate over the streaming phase; the first token's time is counted in TTFT.
  const genSecs = Math.max((end - (firstTokenAt || start)) / 1000, 0.05)
  const approx = usageTokens == null
  const tokens = usageTokens ?? Math.round((content.length + reasoning.length) / 4)
  return {
    content,
    reasoning,
    stats: {
      tokens,
      tokensPerSec: serverTps ?? (tokens > 1 ? (tokens - 1) / genSecs : 0),
      ttftMs: firstTokenAt ? firstTokenAt - start : end - start,
      approx,
    },
  }
}

export function splitThinking(raw: string, reasoningField = ''): StreamUpdate {
  let reasoning = reasoningField
  let content = raw
  const open = content.indexOf('<think>')
  if (open !== -1) {
    const close = content.indexOf('</think>', open)
    if (close === -1) {
      reasoning += content.slice(open + 7)
      content = content.slice(0, open)
    } else {
      reasoning += content.slice(open + 7, close)
      content = content.slice(0, open) + content.slice(close + 8)
    }
  }
  return { content: content.replace(/^\s+/, ''), reasoning: reasoning.trim() }
}
