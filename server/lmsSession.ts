/**
 * LM Studio session lifecycle: "leave it the way you found it".
 *
 * On start we record what was already running (the LM Studio engine/app, its
 * local server, and which models were in memory), then start whatever is
 * missing. On exit we undo only what this app turned on:
 *   - unload models that weren't loaded before
 *   - stop the server if it was off before
 *   - quit LM Studio / its daemon if this app is what launched it
 *
 * Cleanup is synchronous so it also completes from a process 'exit' handler
 * (Ctrl+C, closing the Terminal window, or the browser-window-closed shutdown).
 */
import { execFile, execFileSync } from 'node:child_process'

interface EngineState {
  running: boolean
  pid: number | null
  isDaemon: boolean
}

export interface Snapshot {
  engine: EngineState
  serverRunning: boolean
  loaded: string[]
}

const log = (msg: string) => console.log(`\x1b[2m[offline-llm]\x1b[0m ${msg}`)

export function createLmsSession(lmsPath: string) {
  const lmsSync = (args: string[], timeout = 30_000) =>
    execFileSync(lmsPath, args, { timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const lmsAsync = (args: string[], timeout = 120_000) =>
    new Promise<string>((resolve, reject) =>
      execFile(lmsPath, args, { timeout }, (err, out, errOut) =>
        err ? reject(new Error((errOut || out || err.message).toString().trim())) : resolve(out.toString()),
      ),
    )

  function engineState(): EngineState {
    try {
      const s = JSON.parse(lmsSync(['daemon', 'status', '--json'], 10_000))
      return { running: s.status === 'running', pid: s.pid ?? null, isDaemon: !!s.isDaemon }
    } catch {
      return { running: false, pid: null, isDaemon: false }
    }
  }

  function serverRunning(): boolean {
    try {
      return !!JSON.parse(lmsSync(['server', 'status', '--json'], 10_000)).running
    } catch {
      return false
    }
  }

  function loadedModels(): string[] {
    try {
      return (JSON.parse(lmsSync(['ps', '--json'], 10_000)) as any[]).map((m) => m.identifier)
    } catch {
      return []
    }
  }

  // ---- snapshot (before touching anything) --------------------------------
  const engineBefore = engineState()
  const before: Snapshot = {
    engine: engineBefore,
    // Querying server/models would launch LM Studio if it's not running, so
    // only ask when the engine is already up.
    serverRunning: engineBefore.running ? serverRunning() : false,
    loaded: engineBefore.running ? loadedModels() : [],
  }
  let engineWeStarted: EngineState | null = null
  let cleanedUp = false

  log(
    `LM Studio was ${before.engine.running ? 'running' : 'not running'}, server ${
      before.serverRunning ? 'on' : 'off'
    }, ${before.loaded.length} model(s) loaded. This will be restored on exit.`,
  )

  // ---- start what's missing (async, so the web server comes up immediately)
  const ready: Promise<void> = (async () => {
    if (before.serverRunning) return
    log('Starting LM Studio server…')
    try {
      await lmsAsync(['server', 'start'], 120_000)
      if (!before.engine.running) {
        const now = engineState()
        if (now.running) engineWeStarted = now
      }
      log('LM Studio server is running.')
    } catch (e) {
      log(`Could not start LM Studio server: ${(e as Error).message}`)
    }
  })()

  // ---- restore ------------------------------------------------------------
  function cleanup() {
    if (cleanedUp) return
    cleanedUp = true
    const step = (what: string, fn: () => void) => {
      try {
        fn()
        log(what)
      } catch {
        /* best effort: never block exit */
      }
    }

    // If LM Studio wasn't running and isn't now, there's nothing to undo
    // (and querying it would launch it).
    const engineNow = engineState()
    if (!engineNow.running) return

    for (const id of loadedModels()) {
      if (!before.loaded.includes(id)) step(`Unloaded ${id}`, () => lmsSync(['unload', id]))
    }
    if (!before.serverRunning) step('Stopped LM Studio server', () => lmsSync(['server', 'stop']))

    // Quit LM Studio only if we launched it and it's still that same process
    // (if you opened it yourself in the meantime, it stays open).
    if (!before.engine.running && engineWeStarted && engineNow.pid === engineWeStarted.pid) {
      if (engineNow.isDaemon) step('Stopped LM Studio daemon', () => lmsSync(['daemon', 'down']))
      else
        step('Quit LM Studio', () =>
          execFileSync('/usr/bin/osascript', ['-e', 'quit app "LM Studio"'], { timeout: 15_000, stdio: 'ignore' }),
        )
    }
  }

  return { before, ready, cleanup }
}

/** Run `cleanup` once on any way the process can end. */
export function cleanupOnExit(cleanup: () => void) {
  process.on('exit', cleanup)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(sig, () => process.exit(0)) // 'exit' handler runs the cleanup
  }
}
