import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getLocalModels, getServerModels, getSystem, keepAlive, loadModel, startServer, streamChat } from './api'
import { HardwarePanel, fitLabel } from './components/HardwarePanel'
import { MessageView } from './components/MessageView'
import {
  loadConversations,
  loadModelChoice,
  loadSettings,
  saveConversations,
  saveModelChoice,
  saveSettings,
  uid,
} from './storage'
import type { Conversation, LocalModel, Message, Settings, SystemInfo } from './types'

type ServerState = 'checking' | 'online' | 'offline'

function newConversation(model: string | null): Conversation {
  const now = Date.now()
  return { id: uid(), title: 'New chat', model, messages: [], createdAt: now, updatedAt: now }
}

async function fileToDataUrl(file: File, max = 1024): Promise<string> {
  // Downscale so images stay small in context and in local storage.
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.85)
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>(() => loadConversations())
  const [activeId, setActiveId] = useState<string | null>(() => loadConversations()[0]?.id ?? null)
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [localModels, setLocalModels] = useState<LocalModel[]>([])
  const [serverModels, setServerModels] = useState<string[]>([])
  const [server, setServer] = useState<ServerState>('checking')
  const [model, setModel] = useState<string | null>(() => loadModelChoice())
  const [input, setInput] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [streamingId, setStreamingId] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [showHardware, setShowHardware] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 800)
  const abortRef = useRef<AbortController | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const stickToBottom = useRef(true)

  const active = conversations.find((c) => c.id === activeId) ?? null
  const bridge = !!system?.lmsAvailable

  // ---- persistence -------------------------------------------------------
  useEffect(() => {
    if (streamingId) return // avoid hammering storage on every token
    saveConversations(conversations)
  }, [conversations, streamingId])
  useEffect(() => void saveSettings(settings), [settings])
  useEffect(() => void saveModelChoice(model), [model])

  // ---- discovery ---------------------------------------------------------
  const refresh = useCallback(async () => {
    const [sys, local, remote] = await Promise.allSettled([getSystem(), getLocalModels(), getServerModels()])
    if (sys.status === 'fulfilled') setSystem(sys.value)
    if (local.status === 'fulfilled') setLocalModels(local.value)
    if (remote.status === 'fulfilled') {
      setServerModels(remote.value)
      setServer('online')
    } else setServer('offline')
    const keys =
      local.status === 'fulfilled' && local.value.length
        ? local.value.map((m) => m.key)
        : remote.status === 'fulfilled'
          ? remote.value
          : []
    setModel((cur) => {
      if (cur && keys.includes(cur)) return cur
      const loaded = local.status === 'fulfilled' ? local.value.find((m) => m.loaded) : undefined
      // Prefer something already in GPU memory, then MLX builds (fastest on Apple Silicon).
      const mlx = local.status === 'fulfilled' ? local.value.find((m) => m.format === 'mlx') : undefined
      return loaded?.key ?? mlx?.key ?? keys[0] ?? null
    })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])
  useEffect(() => keepAlive(), [])

  const modelOptions = useMemo(() => {
    if (localModels.length) return localModels.map((m) => ({ key: m.key, model: m as LocalModel | null }))
    return serverModels.map((k) => ({ key: k, model: null }))
  }, [localModels, serverModels])
  const currentLocal = localModels.find((m) => m.key === model) ?? null

  // ---- scrolling ---------------------------------------------------------
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  }, [active?.messages])

  // ---- conversation helpers ---------------------------------------------
  const updateConv = (id: string, fn: (c: Conversation) => Conversation) =>
    setConversations((cs) => cs.map((c) => (c.id === id ? fn(c) : c)))

  const patchMessage = (convId: string, msgId: string, patch: Partial<Message>) =>
    updateConv(convId, (c) => ({
      ...c,
      updatedAt: Date.now(),
      messages: c.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)),
    }))

  async function ensureLoaded(key: string) {
    if (!bridge) return // non-LM Studio servers: let them handle it
    const lm = localModels.find((m) => m.key === key)
    if (!lm || lm.loaded) return
    setStatus(`Loading ${lm.name} onto the GPU…`)
    const r = await loadModel(key, settings.contextLength)
    setLocalModels(r.models)
  }

  async function runCompletion(convId: string, history: Message[]) {
    if (!model) return
    const assistant: Message = { id: uid(), role: 'assistant', content: '', model }
    updateConv(convId, (c) => ({ ...c, messages: [...history, assistant], updatedAt: Date.now() }))
    setStreamingId(assistant.id)
    stickToBottom.current = true
    const ctrl = new AbortController()
    abortRef.current = ctrl
    try {
      await ensureLoaded(model)
      setStatus(null)
      const result = await streamChat({
        model,
        messages: history,
        systemPrompt: settings.systemPrompt,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        signal: ctrl.signal,
        onUpdate: (u) => patchMessage(convId, assistant.id, u),
      })
      patchMessage(convId, assistant.id, { ...result })
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        patchMessage(convId, assistant.id, { error: (e as Error).message })
        refresh()
      }
    } finally {
      setStatus(null)
      setStreamingId(null)
      abortRef.current = null
    }
  }

  async function send() {
    const text = input.trim()
    if ((!text && !images.length) || streamingId || !model) return
    let conv = active
    if (!conv) {
      conv = newConversation(model)
      setConversations((cs) => [conv!, ...cs])
      setActiveId(conv.id)
    }
    const userMsg: Message = { id: uid(), role: 'user', content: text, images: images.length ? images : undefined }
    const history = [...conv.messages, userMsg]
    const title = conv.messages.length ? conv.title : (text || 'Image').slice(0, 48)
    setConversations((cs) => {
      const rest = cs.filter((c) => c.id !== conv!.id)
      return [{ ...conv!, title, model, messages: history, updatedAt: Date.now() }, ...rest]
    })
    setInput('')
    setImages([])
    await runCompletion(conv.id, history)
  }

  function regenerate() {
    if (!active || streamingId) return
    const msgs = active.messages
    const lastUser = msgs.map((m) => m.role).lastIndexOf('user')
    if (lastUser === -1) return
    runCompletion(active.id, msgs.slice(0, lastUser + 1))
  }

  function newChat() {
    if (active && active.messages.length === 0) return
    const c = newConversation(model)
    setConversations((cs) => [c, ...cs])
    setActiveId(c.id)
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  function deleteChat(id: string) {
    setConversations((cs) => cs.filter((c) => c.id !== id))
    if (id === activeId) setActiveId(conversations.find((c) => c.id !== id)?.id ?? null)
  }

  async function addFiles(files: FileList | File[]) {
    const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'))
    const urls = await Promise.all(imgs.map((f) => fileToDataUrl(f)))
    setImages((cur) => [...cur, ...urls].slice(0, 6))
  }

  // auto-grow composer (re-measured on resize, since width changes line wrapping)
  const growComposer = useCallback(() => {
    const t = textareaRef.current
    if (!t) return
    t.style.height = 'auto'
    t.style.height = Math.min(t.scrollHeight, 260) + 'px'
  }, [])
  useEffect(growComposer, [input, images.length, growComposer])
  useEffect(() => {
    const ro = new ResizeObserver(growComposer)
    if (textareaRef.current) ro.observe(textareaRef.current.parentElement!)
    return () => ro.disconnect()
  }, [growComposer])

  const canAttach = currentLocal ? currentLocal.vision : true
  const fit = currentLocal ? fitLabel(currentLocal, system) : null
  const messages = active?.messages ?? []

  return (
    <div className={'app ' + (sidebarOpen ? 'sidebar-open' : '')}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand">
            <span className="logo" /> Offline LLM
          </div>
          <button className="icon-btn" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar">⟨</button>
        </div>
        <button className="new-chat" onClick={newChat}>＋ New chat</button>
        <div className="conv-list">
          {conversations.length === 0 && <p className="muted small pad">No chats yet.</p>}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={'conv ' + (c.id === activeId ? 'active' : '')}
              onClick={() => {
                setActiveId(c.id)
                if (window.innerWidth <= 800) setSidebarOpen(false)
              }}
            >
              <span className="conv-title">{c.title}</span>
              <button
                className="conv-del"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteChat(c.id)
                }}
                aria-label="Delete chat"
              >
                🗑
              </button>
            </div>
          ))}
        </div>
        <div className="sidebar-foot">
          <button className="hw-btn" onClick={() => setShowHardware(true)}>
            <span className={'dot ' + server} />
            <span>
              <b>{system?.chip ?? 'Local server'}</b>
              <small>
                {system ? `${system.totalMemoryGB} GB · ${system.gpuCores ?? '?'}-core GPU` : server === 'online' ? 'Connected' : 'Offline'}
              </small>
            </span>
          </button>
          <button className="icon-btn" onClick={() => setShowSettings(true)} aria-label="Settings">⚙</button>
        </div>
      </aside>
      {sidebarOpen && <div className="scrim" onClick={() => setSidebarOpen(false)} />}

      <main className="main">
        <header className="topbar">
          {!sidebarOpen && (
            <button className="icon-btn" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">☰</button>
          )}
          <div className="model-picker">
            <select value={model ?? ''} onChange={(e) => setModel(e.target.value || null)} disabled={!!streamingId}>
              {modelOptions.length === 0 && <option value="">No models found</option>}
              {modelOptions.map(({ key, model: m }) => (
                <option key={key} value={key}>
                  {m ? `${m.name} · ${m.format.toUpperCase()}${m.quant ? ' ' + m.quant : ''} · ${m.sizeGB} GB${m.loaded ? ' ●' : ''}` : key}
                </option>
              ))}
            </select>
          </div>
          {currentLocal && (
            <button className={'badge ' + (fit?.cls ?? '')} onClick={() => setShowHardware(true)} title="GPU / memory details">
              {currentLocal.loaded ? 'On GPU' : 'Not loaded'} · {fit?.text}
            </button>
          )}
        </header>

        {server === 'offline' && (
          <div className="banner">
            <span>
              Can’t reach the local model server.{' '}
              {bridge ? 'LM Studio’s server looks stopped.' : 'Start LM Studio’s server (Developer tab) or Ollama.'}
            </span>
            {bridge && (
              <button
                className="primary"
                onClick={async () => {
                  setServer('checking')
                  try {
                    await startServer()
                  } catch {}
                  refresh()
                }}
              >
                Start LM Studio server
              </button>
            )}
            <button onClick={refresh}>Retry</button>
          </div>
        )}

        <div
          className="scroll"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          {messages.length === 0 ? (
            <div className="empty">
              <span className="logo big" />
              <h1>What can I help with?</h1>
              <p className="muted">
                Running {currentLocal?.name ?? model ?? 'a local model'} entirely on your{' '}
                {system?.appleSilicon ? system.chip : 'machine'}. Nothing leaves this computer.
              </p>
            </div>
          ) : (
            <div className="thread">
              {messages.map((m, i) => (
                <MessageView
                  key={m.id}
                  message={m}
                  streaming={m.id === streamingId}
                  onRegenerate={i === messages.length - 1 && m.role === 'assistant' ? regenerate : undefined}
                />
              ))}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          {status && <div className="status">{status}</div>}
          <div
            className="composer"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              if (canAttach) addFiles(e.dataTransfer.files)
            }}
          >
            {images.length > 0 && (
              <div className="attachments">
                {images.map((src, i) => (
                  <div key={i} className="thumb">
                    <img src={src} alt="" />
                    <button onClick={() => setImages((im) => im.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              placeholder={model ? 'Message ' + (currentLocal?.name ?? model) : 'Load a model in LM Studio to start'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  send()
                }
              }}
              onPaste={(e) => {
                if (canAttach && e.clipboardData.files.length) {
                  e.preventDefault()
                  addFiles(e.clipboardData.files)
                }
              }}
            />
            <div className="composer-row">
              <div>
                {canAttach && (
                  <>
                    <button className="icon-btn" onClick={() => fileRef.current?.click()} title="Attach image">📎</button>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(e) => {
                        if (e.target.files) addFiles(e.target.files)
                        e.target.value = ''
                      }}
                    />
                  </>
                )}
              </div>
              {streamingId ? (
                <button className="send stop" onClick={() => abortRef.current?.abort()} aria-label="Stop">■</button>
              ) : (
                <button className="send" onClick={send} disabled={(!input.trim() && !images.length) || !model} aria-label="Send">↑</button>
              )}
            </div>
          </div>
          <p className="footnote">Local models can make mistakes. Everything runs on-device.</p>
        </div>
      </main>

      {showHardware && (
        <HardwarePanel
          system={system}
          models={localModels}
          selected={model}
          contextLength={settings.contextLength}
          onContextLength={(n) => setSettings((s) => ({ ...s, contextLength: n }))}
          onModelsChanged={setLocalModels}
          onClose={() => setShowHardware(false)}
        />
      )}

      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Settings</h2>
              <button className="icon-btn" onClick={() => setShowSettings(false)} aria-label="Close">✕</button>
            </div>
            <label className="field">
              <span>System prompt</span>
              <textarea
                rows={5}
                value={settings.systemPrompt}
                onChange={(e) => setSettings((s) => ({ ...s, systemPrompt: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>Temperature: {settings.temperature.toFixed(2)}</span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={settings.temperature}
                onChange={(e) => setSettings((s) => ({ ...s, temperature: Number(e.target.value) }))}
              />
            </label>
            <label className="field">
              <span>Max response tokens (0 = no limit)</span>
              <input
                type="number"
                min={0}
                value={settings.maxTokens}
                onChange={(e) => setSettings((s) => ({ ...s, maxTokens: Math.max(0, Number(e.target.value) || 0) }))}
              />
            </label>
            <div className="row">
              <button
                className="danger"
                onClick={() => {
                  if (confirm('Delete all chats? This cannot be undone.')) {
                    setConversations([])
                    setActiveId(null)
                  }
                }}
              >
                Delete all chats
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
