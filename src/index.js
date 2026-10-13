/**
 * dsh-session-top — host half.
 *
 * Responsibilities, all through official dsh host services (no core changes):
 *
 * 1. **Pin state lives where the Host already keeps it.** The registry-global
 *    pin set (`workspaceRegistry.pinnedSessionIds`) is durable, survives
 *    restarts, and is the same store the shipped sidebar pin action writes.
 *    This plugin deliberately does NOT keep a second copy: a plugin-local pin
 *    file would be a second source of truth that could disagree with the Host
 *    after a manual unpin elsewhere. Behavior 5 ("survives restarts") is
 *    therefore satisfied by reusing the official store rather than by writing
 *    our own.
 *
 * 2. **Activity tracking.** Every committed session event refreshes that
 *    session's recency rank. The rank map is what "active float-up" is
 *    measured against, and it feeds the loopback diagnostics so a user can
 *    confirm the plugin is actually seeing activity.
 *
 * 3. **A plugin-private state directory** under `$DSH_HOME/dsh-session-top/`
 *    holds the activity log (debuggable across restarts) and nothing else that
 *    matters for correctness. Losing or corrupting it costs ordering precision
 *    for sessions that have not run in this process, never the pin state.
 *
 * Loopback-only diagnostics:
 *   GET  /api/dsh-session-top/status  → counters, pin set, top-ranked sessions
 *   POST /api/dsh-session-top/resync  → re-seed activity from persistence
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { planFloatToTop } from './core.js'
import { isLoopbackRequest } from './routes.js'

/** Stable cordis plugin name. */
export const name = 'session-top'

/**
 * Nothing is injected: the plugin must run on hosts that have no web server and
 * no session registry (it then simply observes nothing). Both optional services
 * are resolved through `ctx.get` at apply time instead.
 */
export const inject = []

/** Defaults merged over the composition entry (if any). */
export const defaultConfig = Object.freeze({
  /** Master switch; false keeps the plugin fully dormant (no listener, no files). */
  enabled: true,
  /**
   * Recency basis: 'any' advances on every committed session event (a running
   * task keeps bubbling), 'prompt' only on the user's own messages (the same
   * basis the GUI's "last updated" labels show).
   */
  activity: 'any',
  /** Coalescing window for bursty activity, in milliseconds. */
  debounceMs: 400,
  /** Maximum activity entries retained in memory and in the log file. */
  maxTrackedSessions: 2000,
  /** Round-log path; '' = $DSH_HOME/dsh-session-top/activity.log, 'off' = disabled. */
  logFile: '',
})

/**
 * Keep the package from being applied twice in one process (a bundle row plus a
 * plugin-add row, or an HMR reload, can otherwise load it twice). Shares the
 * same Symbol.for registry key the host's web UI uses for mounted-plugin dedupe.
 */
const MOUNTED = Symbol.for('dsh-web-ui.mounted-plugins')
function mountOnce(packageName, fn) {
  return (...args) => {
    const registry = globalThis
    const mounted = (registry[MOUNTED] ??= new Set())
    if (mounted.has(packageName)) return
    mounted.add(packageName)
    const ctx = args[0]
    ctx?.effect?.(() => () => { mounted.delete(packageName) })
    return fn(...args)
  }
}

/**
 * Logger without inject-guard surprises: `ctx.logger` is a cordis accessor, not
 * a mixin — resolve defensively and fall back to console.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @returns {{info?: Function, warn?: Function}} a best-effort logger.
 */
function safeLogger(ctx) {
  try {
    return ctx.logger ?? console
  } catch {
    return console
  }
}

/**
 * Resolve the plugin's home directory. `$DSH_HOME` when the launcher set it
 * (the documented override), otherwise `~/.dsh`, matching the host's own
 * `dsh-home-paths` default.
 * @returns {string} the absolute plugin state directory.
 */
function pluginHome() {
  const override = process.env.DSH_HOME
  const base = typeof override === 'string' && override.length > 0 ? override : join(homedir(), '.dsh')
  return join(base, 'dsh-session-top')
}

/**
 * Validate the merged config; a bad value fails loud at load.
 * @param {unknown} value - candidate debounce window.
 * @returns {number} the validated window in milliseconds.
 */
function debounceMsOf(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`dsh-session-top: debounceMs must be a non-negative integer, got ${String(value)}`)
  }
  return value
}

/**
 * Validate the recency basis.
 * @param {unknown} value - configured basis.
 * @returns {'any' | 'prompt'} the validated basis.
 */
function activityOf(value) {
  if (value !== 'any' && value !== 'prompt') {
    throw new TypeError(`dsh-session-top: activity must be 'any' or 'prompt', got ${String(value)}`)
  }
  return value
}

/**
 * Validate the tracked-session ceiling.
 * @param {unknown} value - configured ceiling.
 * @returns {number} the validated ceiling.
 */
function maxTrackedOf(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`dsh-session-top: maxTrackedSessions must be a positive integer, got ${String(value)}`)
  }
  return value
}

/**
 * Resolve the round-log path from config.
 * @param {unknown} value - 'off', '' (default), or an explicit path.
 * @returns {string | undefined} absolute log path, or undefined when disabled.
 */
function logFileOf(value) {
  if (value === 'off') return undefined
  if (value === undefined || value === '') return join(pluginHome(), 'activity.log')
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`dsh-session-top: logFile must be '', 'off', or a path, got ${String(value)}`)
  }
  return value
}

/**
 * Whether one committed event counts as activity under the configured basis.
 * @param {string} basis - 'any' or 'prompt'.
 * @param {unknown} event - the committed session event.
 * @returns {boolean} true when the event advances recency.
 */
export function countsAsActivity(basis, event) {
  if (basis === 'any') return true
  return event?.type === 'user/message' && event?.data?.source?.kind === 'user'
}

/**
 * Mount the activity listener, the durable log, and the diagnostics routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {object} [config] - composition-entry config.
 */
export const apply = mountOnce('dsh-session-top', applyImpl)

function applyImpl(ctx, config = {}) {
  const resolved = { ...defaultConfig, ...(config ?? {}) }
  const enabled = resolved.enabled !== false
  const activity = activityOf(resolved.activity)
  const debounceMs = debounceMsOf(resolved.debounceMs)
  const maxTracked = maxTrackedOf(resolved.maxTrackedSessions)
  const logPath = logFileOf(resolved.logFile)
  const logger = safeLogger(ctx)

  // Session id → newest qualifying activity time (epoch ms). Populated only by
  // live activity in this process; `fallbackTimes` covers sessions that have
  // not run here with their persisted header creation time.
  const lastActivity = new Map()
  const fallbackTimes = new Map()

  const stats = {
    startedAt: new Date().toISOString(),
    enabled,
    activity,
    eventCount: 0,
    subagentIgnored: 0,
    otherIgnored: 0,
    staleIgnored: 0,
    flushes: 0,
    movesApplied: 0,
    reorderAborts: 0,
    registryMissing: false,
    lastEventAt: undefined,
    lastFlushAt: undefined,
    lastError: undefined,
  }

  let timer
  let warnedRegistryMissing = false
  let chain = Promise.resolve()

  /** Fire-and-forget append; logging must never throw into the caller. */
  const logLine = (record) => {
    if (logPath === undefined) return
    chain = chain.then(async () => {
      try {
        await mkdir(pluginHome(), { recursive: true })
        await writeFile(logPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
      } catch (error) {
        stats.lastError = String(error)
        logger.warn?.(`dsh-session-top: activity log write failed: ${String(error)}`)
      }
    })
    return chain
  }

  /**
   * Trim the rank map to `maxTracked`, dropping the oldest entries first. The
   * map is a ranking aid, not a ledger: forgetting the coldest sessions costs
   * nothing, while growing without bound would leak on a long-lived host.
   */
  const trim = () => {
    if (lastActivity.size <= maxTracked) return
    const ranked = [...lastActivity.entries()].sort((a, b) => b[1] - a[1])
    lastActivity.clear()
    for (const [id, time] of ranked.slice(0, maxTracked)) lastActivity.set(id, time)
  }

  /**
   * The registry projection the diagnostics report: the pin set plus each
   * workspace's session account. A host without a registry simply reports
   * empty — the plugin never invents pin state of its own.
   * @returns {{pinned: string[], workspaces: {id: string, title: string, sessionCount: number}[]}} the projection.
   */
  const registryProjection = () => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return { pinned: [], workspaces: [] }
    let pinned = []
    try {
      pinned = [...(registry.pinnedSessionIds ?? [])].map(String)
    } catch (error) {
      stats.lastError = String(error)
      return { pinned: [], workspaces: [] }
    }
    let workspaces = []
    try {
      workspaces = registry.list().map(workspace => ({
        id: String(workspace.id),
        title: workspace.title,
        sessionCount: workspace.sessionIds.length,
      }))
    } catch (error) {
      stats.lastError = String(error)
    }
    return { pinned, workspaces }
  }

  /**
   * The sessions the sidebar would show, newest first. This is what behavior 1
   * promises and what the status route lets a user verify.
   * @returns {{id: string, rank: number, title: string | undefined, workspace: string | undefined}[]} the ranking.
   */
  const rankedSessions = () => {
    const registry = ctx.get('workspaceRegistry')
    const ownerOf = new Map()
    if (registry !== undefined) {
      try {
        for (const workspace of registry.list()) {
          for (const id of workspace.sessionIds) ownerOf.set(String(id), String(workspace.title ?? workspace.id))
        }
      } catch (error) {
        stats.lastError = String(error)
      }
    }
    return [...lastActivity.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([id, rank]) => ({ id, rank, title: undefined, workspace: ownerOf.get(id) }))
  }

  const getStatus = () => ({
    ...stats,
    debounceMs,
    home: pluginHome(),
    logFile: logPath ?? null,
    trackedSessions: lastActivity.size,
    fallbackSessions: fallbackTimes.size,
    registry: registryProjection(),
    ranked: rankedSessions(),
  })

  /**
   * Seed cold-session fallback times from persistence so a session that has
   * never run in this process still ranks by its birth rather than sinking.
   * @returns {Promise<boolean>} whether persistence was reachable.
   */
  const seedOnce = async () => {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return false
    for (const snapshot of await persistence.list()) {
      const id = snapshot?.header?.id
      const created = Date.parse(snapshot?.header?.createdAt ?? '')
      if (id !== undefined && Number.isFinite(created)) fallbackTimes.set(String(id), created)
    }
    return true
  }

  const resync = async () => {
    try {
      const seeded = await seedOnce()
      if (!seeded) {
        stats.lastError = 'no sessionPersistence service on this host'
        return { seeded: false, fallbackSessions: fallbackTimes.size }
      }
      stats.flushes += 1
      stats.lastFlushAt = new Date().toISOString()
      return { seeded: true, fallbackSessions: fallbackTimes.size }
    } catch (error) {
      stats.lastError = String(error)
      logger.warn?.(`dsh-session-top: resync failed: ${String(error)}`)
      return { seeded: false, error: String(error) }
    }
  }

  /**
   * Behavior 1's durable half: float each workspace's most recently active
   * session to the top of its account.
   *
   * The sidebar's default "recent" view already sorts by `updatedAt` on every
   * render, but the durable account (`workspace.sessionIds`) only changes
   * through `insertSessionBefore`. Replaying the move through that official API
   * is what makes activity keep mattering after the user switches the sidebar
   * to manual order — and it survives a restart, which a purely client-side
   * sort would not.
   *
   * Only the session that acted is moved. Re-sorting the whole account would
   * silently discard a manual arrangement the user built by dragging rows; the
   * drag order is durable state, and a background event is not a licence to
   * throw it away. So "active float-up" means exactly that: the active session
   * rises, everything else keeps its relative position.
   *
   * Serialized on one chain: a manual drag in the sidebar and this pass both
   * write the same account, and interleaving them would produce a visible
   * fight.
   * @returns {Promise<number>} moves applied.
   */
  const reorderSessions = async () => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) {
      stats.registryMissing = true
      return 0
    }
    stats.registryMissing = false
    const rankOf = (id) => lastActivity.get(id) ?? 0
    let applied = 0
    let workspaces
    try {
      workspaces = registry.list()
    } catch (error) {
      stats.lastError = String(error)
      return 0
    }
    for (const workspace of workspaces) {
      const moves = planFloatToTop(workspace.sessionIds, rankOf)
      for (const move of moves) {
        try {
          await workspace.insertSessionBefore(move.id, move.beforeId)
          applied += 1
        } catch (error) {
          // The account aged out from under the plan (a concurrent detach, a
          // manual drag). Stop this workspace; the next activity replans.
          stats.lastError = String(error)
          stats.reorderAborts += 1
          break
        }
      }
    }
    stats.movesApplied += applied
    return applied
  }

  const flush = () => {
    timer = undefined
    trim()
    stats.flushes += 1
    stats.lastFlushAt = new Date().toISOString()
    // A failing reorder costs ordering precision for one round, never the pin
    // set, so it is logged and swallowed rather than propagated.
    chain = chain.then(reorderSessions).catch(error => {
      stats.lastError = String(error)
      logger.warn?.(`dsh-session-top: session reorder pass failed: ${String(error)}`)
    })
    const ranked = rankedSessions()
    void logLine({ at: stats.lastFlushAt, tracked: lastActivity.size, top: ranked.slice(0, 5) })
  }

  const schedule = () => {
    if (timer !== undefined) return
    timer = setTimeout(flush, debounceMs)
  }

  const onSessionEvent = (session, event) => {
    // Subagent sessions stay hidden on every grouping surface, so their writes
    // must not reorder what the user sees.
    if (session?.header?.origin === 'subagent') {
      stats.subagentIgnored += 1
      return
    }
    const id = session?.id
    if (typeof id !== 'string' || id.length === 0) return
    stats.eventCount += 1
    stats.lastEventAt = new Date().toISOString()
    if (!countsAsActivity(activity, event)) {
      stats.otherIgnored += 1
      return
    }
    const time = typeof event?.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now()
    // Out-of-order delivery (a replayed stream, a late tool commit) must not
    // walk a session backwards in the ranking.
    if ((lastActivity.get(id) ?? Number.NEGATIVE_INFINITY) >= time) {
      stats.staleIgnored += 1
      return
    }
    lastActivity.set(id, time)
    schedule()
  }

  const disposers = []
  if (enabled) {
    try {
      ctx.effect(() => {
        // `global: true` admits the listener for every session regardless of
        // scope filtering: recency must observe agent-scoped and main sessions
        // alike.
        disposers.push(ctx.on('session/event', onSessionEvent, { global: true }))
        return () => {
          if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
          }
          for (const dispose of disposers.splice(0)) {
            try {
              dispose()
            } catch (error) {
              console.error('[dsh-session-top] dispose failed:', error)
            }
          }
        }
      }, 'dsh-session-top: activity listener')
    } catch (error) {
      console.error('[dsh-session-top] activity listener registration failed:', error)
      return
    }

    // Seed cold-session fallback times. The persistence service activates
    // asynchronously, so the first attempt at apply time can legitimately see
    // it absent; retry once after a grace period before giving up.
    void (async () => {
      try {
        let seeded = false
        try {
          seeded = await seedOnce()
        } catch (error) {
          stats.lastError = String(error)
        }
        if (!seeded) {
          await new Promise(resolve => setTimeout(resolve, 15000))
          await seedOnce().catch(error => { stats.lastError = String(error) })
        }
      } catch (error) {
        stats.lastError = String(error)
        logger.warn?.(`dsh-session-top: seeding fallback times failed: ${String(error)}`)
      }
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined && !warnedRegistryMissing) {
        warnedRegistryMissing = true
        logger.warn?.('dsh-session-top: no workspaceRegistry on this host; pin diagnostics stay empty')
      } else {
        warnedRegistryMissing = false
      }
      const pinned = registryProjection().pinned.length
      const summary = `dsh-session-top: active (activity ${activity}, debounce ${debounceMs}ms, ${pinned} pinned, ${fallbackTimes.size} fallback times seeded, state in ${pluginHome()})`
      logger.info?.(summary)
      void logLine({ at: new Date().toISOString(), kind: 'start', summary })
    })()
  }

  // Diagnostics are strictly optional: a host with no web server (headless,
  // acp) simply has no routes and the plugin is otherwise unaffected.
  try {
    const webServer = ctx.get('webServer')
    if (webServer !== undefined && typeof webServer.register === 'function') {
      ctx.effect(() => {
        const routes = [
          {
            kind: 'exact',
            path: '/api/dsh-session-top/status',
            handler: async (req, res) => {
              if (!isLoopbackRequest(req)) {
                res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: 'forbidden: loopback-only' }))
                return
              }
              if ((req.method ?? 'GET') !== 'GET') {
                res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: `method not allowed: ${req.method}` }))
                return
              }
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
              res.end(JSON.stringify(getStatus()))
            },
          },
          {
            kind: 'exact',
            path: '/api/dsh-session-top/resync',
            handler: async (req, res) => {
              if (!isLoopbackRequest(req)) {
                res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: 'forbidden: loopback-only' }))
                return
              }
              if ((req.method ?? 'GET') !== 'POST') {
                res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: `method not allowed: ${req.method}` }))
                return
              }
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
              res.end(JSON.stringify({ ok: true, ...(await resync()) }))
            },
          },
        ]
        const registered = routes.map(route => webServer.register(route))
        return () => {
          for (const dispose of registered.splice(0)) {
            try {
              dispose()
            } catch (error) {
              console.error('[dsh-session-top] route dispose failed:', error)
            }
          }
        }
      }, 'dsh-session-top: diagnostics routes')
    }
  } catch (error) {
    // A web server that rejects route registration costs diagnostics only.
    logger.warn?.(`dsh-session-top: diagnostics routes unavailable: ${String(error)}`)
  }
}