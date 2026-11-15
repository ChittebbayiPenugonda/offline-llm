import { useEffect, useState } from 'react'
import { estimateModel, loadModel, unloadAll } from '../api'
import type { Estimate, LocalModel, SystemInfo } from '../types'

const CONTEXT_OPTIONS = [4096, 8192, 16384, 32768, 65536]

export function fitLabel(model: LocalModel, sys: SystemInfo | null) {
  if (!sys) return null
  const ratio = model.sizeGB / sys.gpuBudgetGB
  if (ratio < 0.6) return { cls: 'good', text: 'Fits on GPU' }
  if (ratio < 0.85) return { cls: 'ok', text: 'Tight fit' }
  return { cls: 'bad', text: 'Too big for GPU' }
}

export function HardwarePanel({
  system,
  models,
  selected,
  contextLength,
  onContextLength,
  onModelsChanged,
  onClose,
}: {
  system: SystemInfo | null
  models: LocalModel[]
  selected: string | null
  contextLength: number
  onContextLength: (n: number) => void
  onModelsChanged: (m: LocalModel[]) => void
  onClose: () => void
}) {
  const model = models.find((m) => m.key === selected) ?? null
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setEstimate(null)
    if (!model) return
    let alive = true
    estimateModel(model.key, contextLength)
      .then((e) => alive && setEstimate(e))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [model?.key, contextLength])

  const hasMlx = models.some((m) => m.format === 'mlx')
  const budget = system?.gpuBudgetGB ?? 0
  const used = estimate?.gpuGB ?? model?.sizeGB ?? 0

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Mac hardware</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {system ? (
          <div className="hw-grid">
            <div><span>Chip</span><b>{system.chip}</b></div>
            <div><span>Unified memory</span><b>{system.totalMemoryGB} GB</b></div>
            <div><span>GPU cores</span><b>{system.gpuCores ?? '—'}</b></div>
            <div><span>CPU cores</span><b>{system.performanceCores ?? '?'}P + {system.efficiencyCores ?? '?'}E</b></div>
            <div className="span2">
              <span>GPU memory budget {system.gpuWiredLimitOverridden ? '(custom limit)' : '(macOS default)'}</span>
              <b>≈ {system.gpuBudgetGB} GB</b>
            </div>
          </div>
        ) : (
          <p className="muted">Hardware info unavailable — run the app with <code>npm run dev</code> on your Mac.</p>
        )}

        {model ? (
          <>
            <h3>{model.name}</h3>
            <div className="chips">
              <span className={'chip ' + (model.format === 'mlx' ? 'good' : '')}>{model.format.toUpperCase()}</span>
              {model.params && <span className="chip">{model.params}</span>}
              {model.quant && <span className="chip">{model.quant}</span>}
              <span className="chip">{model.sizeGB} GB</span>
              {model.vision && <span className="chip">Vision</span>}
              {model.loaded && <span className="chip good">Loaded · ctx {model.contextLength}</span>}
            </div>

            <label className="field">
              <span>Context length</span>
              <select value={contextLength} onChange={(e) => onContextLength(Number(e.target.value))}>
                {CONTEXT_OPTIONS.filter((c) => !model.maxContext || c <= model.maxContext).map((c) => (
                  <option key={c} value={c}>{(c / 1024).toFixed(0)}k tokens</option>
                ))}
              </select>
            </label>

            {budget > 0 && (
              <div className="meter">
                <div
                  className={'meter-fill ' + (used / budget > 0.85 ? 'bad' : used / budget > 0.6 ? 'ok' : 'good')}
                  style={{ width: Math.min(100, (used / budget) * 100) + '%' }}
                />
                <span>
                  {estimate?.gpuGB != null ? `${estimate.gpuGB.toFixed(2)} GB estimated` : `${model.sizeGB} GB weights`} of ≈{budget} GB GPU budget
                </span>
              </div>
            )}

            <div className="row">
              <button
                className="primary"
                disabled={!!busy}
                onClick={async () => {
                  setBusy('Loading onto GPU…')
                  setErr(null)
                  try {
                    const r = await loadModel(model.key, contextLength)
                    onModelsChanged(r.models)
                  } catch (e) {
                    setErr((e as Error).message)
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                {busy ?? (model.loaded ? 'Reload with these settings' : 'Load on GPU (Metal)')}
              </button>
              <button
                disabled={!!busy}
                onClick={async () => {
                  setBusy('Unloading…')
                  try {
                    await unloadAll()
                    onModelsChanged(models.map((m) => ({ ...m, loaded: false })))
                  } catch (e) {
                    setErr((e as Error).message)
                  } finally {
                    setBusy(null)
                  }
                }}
              >
                Free GPU memory
              </button>
            </div>
            {err && <p className="msg-error">{err}</p>}
          </>
        ) : (
          <p className="muted">Pick a model to see whether it fits.</p>
        )}

        <div className="tips">
          <b>Getting the most out of {system?.chip ?? 'Apple Silicon'}</b>
          <ul>
            {!hasMlx && (
              <li>
                Download <b>MLX</b> builds in LM Studio (filter by “MLX”). MLX is Apple’s own framework for the M-series GPU and is
                usually faster than GGUF on a Mac.
              </li>
            )}
            <li>Models are loaded with 100% GPU offload. Keep model + context under the green zone so nothing spills to swap.</li>
            {system && system.totalMemoryGB <= 16 && (
              <li>
                On {system.totalMemoryGB} GB, 4-bit models up to ~8B params run well; 12–14B 4-bit fits with short context. Close
                heavy apps (browsers, Xcode) before loading big models.
              </li>
            )}
            <li>Larger context = more memory for the KV cache. 8k is a good default; raise it only for long documents.</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
