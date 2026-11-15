/**
 * Mac hardware bridge.
 *
 * A tiny Vite plugin that adds a few local-only endpoints under /local/* so the
 * browser UI can:
 *   - read the Mac's chip, unified memory and GPU core count (sysctl / system_profiler)
 *   - list downloaded models and what's loaded (lms ls / lms ps)
 *   - load a model with full Metal GPU offload and a chosen context length (lms load --gpu max)
 *   - estimate memory before loading (lms load --estimate-only)
 *   - start the LM Studio server (lms server start)
 * and proxies /llm/* to the model server (LM Studio's port is discovered via
 * `lms server status`), so the browser never deals with CORS.
 *
 * Everything runs through execFile with fixed argument lists (no shell), and the
 * model key is checked against `lms ls` before it is passed to `lms load`.
 */
import type { Plugin } from 'vite'
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LMS_CANDIDATES = [
  process.env.LMS_PATH,
  path.join(os.homedir(), '.lmstudio', 'bin', 'lms'),
  '/usr/local/bin/lms',
  '/opt/homebrew/bin/lms',
].filter(Boolean) as string[]

const lmsPath = LMS_CANDIDATES.find((p) => existsSync(p)) ?? null

function run(cmd: string, args: string[], timeoutMs = 120_000, withStderr = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).toString().trim()))
      else resolve(stdout.toString() + (withStderr ? '\n' + stderr.toString() : ''))
    })
  })
}

const lms = (args: string[], timeoutMs?: number, withStderr = false) => {
  if (!lmsPath) throw new Error('lms CLI not found. Open LM Studio once, or set LMS_PATH.')
  return run(lmsPath, args, timeoutMs, withStderr)
}

async function sysctl(key: string): Promise<string | null> {
  try {
    return (await run('/usr/sbin/sysctl', ['-n', key], 5000)).trim()
  } catch {
    return null
  }
}

let systemCache: unknown = null

async function systemInfo() {
  if (systemCache) return systemCache
  const totalBytes = os.totalmem()
  const totalGB = totalBytes / 1024 ** 3
  const chip = (await sysctl('machdep.cpu.brand_string')) ?? os.cpus()[0]?.model ?? 'Unknown'
  const pCores = Number(await sysctl('hw.perflevel0.physicalcpu')) || null
  const eCores = Number(await sysctl('hw.perflevel1.physicalcpu')) || null
  const wiredLimitMb = Number(await sysctl('iogpu.wired_limit_mb')) || 0

  let gpuCores: number | null = null
  if (process.platform === 'darwin') {
    try {
      const out = await run('/usr/sbin/system_profiler', ['SPDisplaysDataType'], 15000)
      const m = out.match(/Total Number of Cores:\s*(\d+)/)
      if (m) gpuCores = Number(m[1])
    } catch {
      /* ignore */
    }
  }

  // macOS lets the GPU wire roughly 2/3 of unified memory on machines with
  // <= 36 GB and ~3/4 above that, unless iogpu.wired_limit_mb overrides it.
  const defaultFraction = totalGB <= 36 ? 0.67 : 0.75
  const gpuBudgetGB = wiredLimitMb > 0 ? wiredLimitMb / 1024 : totalGB * defaultFraction

  systemCache = {
    platform: process.platform,
    arch: process.arch,
    appleSilicon: process.platform === 'darwin' && process.arch === 'arm64',
    chip,
    totalMemoryGB: Math.round(totalGB * 10) / 10,
    gpuBudgetGB: Math.round(gpuBudgetGB * 10) / 10,
    gpuWiredLimitOverridden: wiredLimitMb > 0,
    performanceCores: pCores,
    efficiencyCores: eCores,
    gpuCores,
    lmsAvailable: !!lmsPath,
  }
  return systemCache
}

async function listModels() {
  const [all, loaded] = await Promise.all([
    lms(['ls', '--json']).then((s) => JSON.parse(s) as any[]),
    lms(['ps', '--json'])
      .then((s) => JSON.parse(s) as any[])
      .catch(() => [] as any[]),
  ])
  return all
    .filter((m) => m.type === 'llm' || m.type === 'vlm')
    .map((m) => {
      const l = loaded.find((x) => x.modelKey === m.modelKey)
      return {
        key: m.modelKey as string,
        name: (m.displayName as string) ?? m.modelKey,
        format: (m.format as string) ?? 'unknown', // "mlx" | "gguf"
        sizeGB: Math.round(((m.sizeBytes as number) / 1024 ** 3) * 100) / 100,
        params: (m.paramsString as string) ?? null,
        quant: m.quantization?.name ?? null,
        vision: !!m.vision,
        tools: !!m.trainedForToolUse,
        maxContext: (m.maxContextLength as number) ?? null,
        loaded: !!l,
        identifier: l?.identifier ?? null,
        contextLength: l?.contextLength ?? null,
        status: l?.status ?? null,
      }
    })
}

async function knownModelKey(key: unknown): Promise<string> {
  if (typeof key !== 'string' || !key) throw new Error('modelKey is required')
  const models = await listModels()
  if (!models.some((m) => m.key === key)) throw new Error(`Unknown model: ${key}`)
  return key
}

function ctxArg(n: unknown): string[] {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return []
  return ['-c', String(Math.min(Math.max(Math.round(v), 512), 1_048_576))]
}

function gpuArg(g: unknown): string[] {
  if (g === 'off' || g === 'max') return ['--gpu', g]
  const v = Number(g)
  if (Number.isFinite(v) && v >= 0 && v <= 1) return ['--gpu', String(v)]
  return ['--gpu', 'max'] // default: everything on the Apple GPU
}

function parseEstimate(out: string) {
  const gib = (label: string) => {
    const m = out.match(new RegExp(label + ':\\s*([\\d.]+)\\s*GiB'))
    return m ? Number(m[1]) : null
  }
  return {
    gpuGB: gib('Estimated GPU Memory'),
    totalGB: gib('Estimated Total Memory'),
    fits: !/may not|will not|cannot|exceed/i.test(out),
    raw: out.trim(),
  }
}

let cachedTarget: string | null = null

async function llmTarget(override?: string, fresh = false): Promise<string> {
  if (override) return override.replace(/\/$/, '')
  if (cachedTarget && !fresh) return cachedTarget
  let port = 1234
  try {
    const st = JSON.parse(await lms(['server', 'status', '--json'], 10_000))
    if (st?.port) port = Number(st.port)
  } catch {
    /* lms missing or server off: fall back to LM Studio's default port */
  }
  cachedTarget = `http://127.0.0.1:${port}`
  return cachedTarget
}

function proxy(req: IncomingMessage, res: ServerResponse, target: string, path: string) {
  return new Promise<void>((resolve) => {
    const url = new URL(path, target)
    const headers = { ...req.headers, host: url.host }
    delete headers.origin
    delete headers.referer
    const upstream = http.request(url, { method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
      up.on('end', resolve)
    })
    upstream.on('error', (e) => {
      cachedTarget = null // port may have changed; rediscover next time
      if (!res.headersSent) send(res, 502, { error: `Model server unreachable at ${target} (${e.message})` })
      else res.end()
      resolve()
    })
    req.on('aborted', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

export function macBridge(opts: { llmServer?: string } = {}): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = req.url ?? ''
    if (url.startsWith('/llm/')) {
      return proxy(req, res, await llmTarget(opts.llmServer), url.slice(4))
    }
    if (!url.startsWith('/local/')) return next()
    const route = url.split('?')[0]
    // Only the app itself may call the bridge: a custom header forces a CORS
    // preflight, so other websites open in your browser can't trigger loads.
    if (req.method !== 'GET' && req.headers['x-offline-llm'] !== '1') {
      return send(res, 403, { error: 'Forbidden' })
    }
    try {
      if (req.method === 'GET' && route === '/local/system') return send(res, 200, await systemInfo())
      if (req.method === 'GET' && route === '/local/models') return send(res, 200, await listModels())

      if (req.method === 'POST' && route === '/local/estimate') {
        const body = await readJson(req)
        const key = await knownModelKey(body.modelKey)
        const out = await lms(['load', key, '--estimate-only', '-y', ...gpuArg(body.gpu), ...ctxArg(body.contextLength)], 60_000, true)
        return send(res, 200, parseEstimate(out))
      }

      if (req.method === 'POST' && route === '/local/load') {
        const body = await readJson(req)
        const key = await knownModelKey(body.modelKey)
        // 16 GB-class Macs can't hold two big models at once: free the GPU first.
        if (body.unloadOthers !== false) await lms(['unload', '--all']).catch(() => {})
        await lms(
          ['load', key, '-y', '--identifier', key, ...gpuArg(body.gpu), ...ctxArg(body.contextLength)],
          10 * 60_000,
        )
        return send(res, 200, { ok: true, models: await listModels() })
      }

      if (req.method === 'POST' && route === '/local/unload') {
        await lms(['unload', '--all'])
        return send(res, 200, { ok: true })
      }

      if (req.method === 'POST' && route === '/local/server/start') {
        const out = await lms(['server', 'start'], 60_000)
        await llmTarget(opts.llmServer, true)
        return send(res, 200, { ok: true, output: out.trim() })
      }

      return send(res, 404, { error: 'Not found' })
    } catch (e) {
      return send(res, 500, { error: (e as Error).message })
    }
  }

  return {
    name: 'mac-bridge',
    configureServer(server) {
      server.middlewares.use(handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler)
    },
  }
}
