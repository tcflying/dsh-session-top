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
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { planFloatDirty } from './core.js'
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
 * Resolve an optional service without ever letting the lookup throw.
 *
 * A cordis Context is a Proxy: an undeclared property read raises, so every
 * optional service goes through `ctx.get`, which walks the fiber chain and
 * returns `undefined` instead. This wraps even that, because a retried lookup
 * runs from a timer where a throw would become an unhandled rejection.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {string} name - the service name.
 * @returns {unknown} the service, or undefined when this host has none.
 */
function safeService(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
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
 * How a rejected configuration value is quoted in an error.
 *
 * `String()` alone cannot tell the number 400 from the string "400", which are
 * two different mistakes for a user to go and fix.
 * @param {unknown} value - the refused value.
 * @returns {string} a rendering that keeps the type visible.
 */
function describe(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value)
}

/**
 * The largest delay Node's timer accepts.
 *
 * A `setTimeout` past 2^31-1 does not become a long wait; it is silently
 * DOWNGRADED to 1ms with a `TimeoutOverflowWarning` on stderr. A coalescing
 * window configured to be a minute would then flush on every tick, which is the
 * exact opposite of what was asked for — so the boundary is refused at load
 * time instead, where the user can see it, rather than clamped quietly later.
 */
const MAX_TIMER_DELAY_MS = 2147483647

/**
 * Validate the merged config; a bad value fails loud at load.
 *
 * `Number.isSafeInteger`, not `Number.isInteger`: an integer too large to be
 * represented exactly is not a window anyone can use, and accepting it is how
 * the silent 1ms downgrade got in. The range is Node's, stated here and in the
 * error, so nobody has to discover it from a warning.
 *
 * `0` is SUPPORTED, not rejected: a zero window is the honest high-load mode
 * (one pass per coalescing tick), and the plugin never rounds it up to 1 to
 * look tidier.
 * @param {unknown} value - candidate debounce window.
 * @returns {number} the validated window in milliseconds.
 */
function debounceMsOf(value) {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > MAX_TIMER_DELAY_MS
  ) {
    throw new TypeError(
      `dsh-session-top: debounceMs must be a safe integer in 0..${String(MAX_TIMER_DELAY_MS)} `
      + `(ms, the range Node's timer supports), got ${describe(value)}`,
    )
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
 *
 * Same defect as the window — `Number.isInteger` accepted values that are not
 * safe integers — and a deliberately DIFFERENT answer. This key is a COUNT, not
 * a delay, so Node's 32-bit timer ceiling is NOT copied onto it: refusing a
 * large but perfectly representable count would be a policy change smuggled in
 * as validation. The original positive-integer rule stands, with safe-integer
 * arithmetic.
 * @param {unknown} value - configured ceiling.
 * @returns {number} the validated ceiling.
 */
function maxTrackedOf(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `dsh-session-top: maxTrackedSessions must be a positive safe integer (>= 1), got ${describe(value)}`,
    )
  }
  return value
}

/**
 * The activity log's bounds. Fixed, published, and not configurable.
 *
 * They were chosen to make the whole disk cost a round number a user can reason
 * about rather than a number they have to look up: at most one megabyte in the
 * live file, three retained copies beside it, so four megabytes total however
 * long the process runs. The old shape was `flag: 'a'` with no bound at all.
 *
 * `bufferRecords` bounds MEMORY, not the disk: it is how many records may wait
 * for the log worker at once. `recordBytes` is what stops one record from
 * deciding the size of the whole log. Both are reported through `status.log`
 * so a reader can check the ceiling instead of guessing it — these numbers are
 * a contract, not an implementation detail to be rediscovered by reading code.
 */
const LOG_BUFFER_RECORDS = 128
const LOG_RECORD_BYTES = 64 * 1024
const LOG_FILE_BYTES = 1024 * 1024
const LOG_ROTATE_KEEP = 3
const LOG_WRITE_ATTEMPTS = 3
const LOG_RETRY_BACKOFF_MS = 200
const LOG_LIMITS = Object.freeze({
  /** Records that may wait for the single log worker. */
  bufferRecords: LOG_BUFFER_RECORDS,
  /** Largest single record written; a bigger one is dropped and counted. */
  recordBytes: LOG_RECORD_BYTES,
  /** Largest the live file may grow before it is rotated. */
  fileBytes: LOG_FILE_BYTES,
  /** Rotated copies kept beside the live file. */
  rotateKeep: LOG_ROTATE_KEEP,
  /** Attempts one record gets before it is given up on. */
  writeAttempts: LOG_WRITE_ATTEMPTS,
  /** Wait before the next attempt, so a disk that refuses is not hammered. */
  retryBackoffMs: LOG_RETRY_BACKOFF_MS,
  /**
   * The ceiling for the files THIS PLUGIN MANAGES: the live file plus each
   * retained copy, each held to `fileBytes` by the same rotation rule.
   *
   * The scope is the point, not a loophole. This is not a promise about every
   * file that happens to sit at the configured path: a file the plugin did not
   * create is appended to and never moved or removed, and what it held is
   * reported as `status.log.preexistingBytes`. So the promise is exactly the one
   * that can be kept without authority the plugin does not have — and where it
   * cannot be kept, the plugin stops writing and publishes the reason rather
   * than deleting history nobody handed it over.
   */
  maxTotalBytes: LOG_FILE_BYTES * (LOG_ROTATE_KEEP + 1),
})

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
 * The oldest ARRIVAL timestamp among a set of facts, or undefined when there
 * are none.
 *
 * Facts arrive stamped with two different clocks — the event's own `time` and
 * the moment they reached this process (`at`) — and only the second one can say
 * how long something has been QUEUED here. Comparing them would be a category
 * error, so this scans arrivals only.
 * @param {Iterable<{at: number}>} facts - the facts to scan.
 * @returns {number | undefined} the oldest arrival, or undefined when empty.
 */
function oldestArrivalAt(facts) {
  let oldest
  for (const fact of facts) {
    if (oldest === undefined || fact.at < oldest) oldest = fact.at
  }
  return oldest
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
  // The directory the CONFIGURED path needs. For the default that is the plugin
  // home; for a custom `logFile` it is whatever the user pointed at, whose
  // parents may not exist yet.
  const logDirectory = logPath === undefined ? undefined : dirname(logPath)
  const logger = safeLogger(ctx)

  // Session id → newest qualifying activity time (epoch ms). Populated only by
  // live activity in this process; `fallbackTimes` covers sessions that have
  // not run here with their persisted header creation time.
  //
  // This map is a DIAGNOSTIC record of what happened, NOT a standing sort
  // intent: it is never re-read as "this is where the user wants the account".
  // Replaying it on every flush is exactly what let one workspace's stale rank
  // undo another workspace's manual drag. Ordering reads `pendingActivity`
  // instead — see `reorderSessions`.
  const lastActivity = new Map()
  const fallbackTimes = new Map()
  /**
   * How many headers the host actually handed over on the last resync, kept
   * apart from `fallbackTimes.size` on purpose: the retained map is capped, and
   * a reader told "10000 fallback sessions" for a cache holding two would be
   * told a lie about this plugin's memory. Never described as activity.
   */
  const fallbackCounters = { enumerated: 0, lastResyncAt: undefined }
  /** The resync currently running, so concurrent callers share one list. */
  let resyncInFlight

  // Sessions that acted and have not been consumed by a finished pass yet.
  // id → {time, seq, attempts}. `seq` is a monotonic arrival counter so two
  // commits in the same millisecond keep a defined order; `attempts` counts how
  // many times the host has refused this fact (see REFUSAL_RETRY_LIMIT).
  const pendingActivity = new Map()
  // Facts the host refused past the retry limit. Kept, not discarded: they are
  // reported by the diagnostics route and are picked up again — with a fresh
  // budget — the next time that session actually does something.
  const deferredActivity = new Map()
  let activitySeq = 0

  // Lifecycle validity. Set by an effect cleanup that nothing else owns, so
  // every dispose path flips it — including `enabled:false`, which registers no
  // activity listener at all.
  let disposed = false
  /** @returns {boolean} whether this apply may still touch the host. */
  const alive = () => !disposed
  ctx.effect(() => () => { disposed = true }, 'dsh-session-top: lifecycle validity')

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
    deferredSessions: 0,
    lastReorderError: undefined,
    lastDeferralReason: undefined,
    registryMissing: false,
    lastEventAt: undefined,
    lastFlushAt: undefined,
    lastError: undefined,
    // Pass accounting, distinct from `flushes`: a coalescing window that fired
    // is not a pass that ran. Under the old chain these were the same number,
    // which is exactly why a queue of pending passes was invisible.
    //
    // `flushes` itself is NOT a pure window count — `resync()` has always
    // incremented it too, and that pre-existing behaviour is deliberately left
    // alone here rather than quietly "fixed" inside a scheduling change. Read
    // it as "flushes", nothing more precise.
    //
    // `passesFailed` counts PASS-level exceptions only: something that escaped
    // the whole pass. A workspace refusing one durable write is NOT a failed
    // pass — that is `reorderAborts`, and the fact it refused is requeued or
    // deferred. The distinction matters because a refused write is routine and
    // a failed pass is not.
    passesStarted: 0,
    passesCompleted: 0,
    passesFailed: 0,
    lastPassDurationMs: undefined,
  }

  let timer
  let warnedRegistryMissing = false
  /**
   * The activity log is a bounded QUEUE drained by ONE worker, deliberately
   * separate from the reorder runner and deliberately not shared with it. A
   * slow disk — or a log write that never settles — freezes ordering exactly as
   * surely as a slow host RPC does when two independent resources serialize
   * each other for no reason at all.
   *
   * It used to be a promise chain: one `.then()` closure appended per record,
   * which grew without limit, retained the whole apply scope through its
   * closure, AND — the part that mattered most — was POISONED FOREVER by the
   * first rejection. None of that is here any more. The queue is a plain array
   * with a fixed ceiling, and a worker takes one record at a time.
   *
   * Every step of the worker re-checks `alive()` before it starts, so a torn
   * down apply begins no mkdir, no stat, no rename, no unlink and no write.
   * Work already handed to the kernel is not cancelled — it cannot be — and is
   * allowed to finish, because claiming otherwise would be a lie.
   */
  /** @type {{line: string, bytes: number, attempts: number}[]} */
  const logQueue = []
  let logWorking = false
  /** The backoff between attempts; held so dispose can release it. */
  let logBackoffTimer
  /** Whether the log path's parent directory is known to exist. */
  let logDirReady = false
  /** Whether the live file's size has been read yet. */
  let logSizeKnown = false
  /** The live file's size as far as this apply knows. */
  let logBytesOnDisk = 0
  /** What the live file held before this apply wrote anything to it. */
  let logPreexistingBytes = 0
  /**
   * Whether this apply manages the live file, and may therefore rotate it.
   *
   * OWNERSHIP IS NOT INHERITED FROM APPENDING. This apply owns the live file
   * only when it CREATED it — proved by the exclusive create below, not by a
   * `stat` that said "absent" and was over before the write happened. A file
   * that was already at the configured path belongs to whoever put it there,
   * and the fact that this plugin appended a line to it changes nothing about
   * who may move or delete it later.
   *
   * The consequence is a boundary worth stating plainly: after a restart, the
   * log from the previous run can be APPENDED to until it reaches its
   * per-file ceiling, and then logging stops rather than rotating a file this
   * process did not create. `status.log` reports the reason and the size it
   * found, and the operator can move or rename that file themselves. Stopping
   * is observable and recoverable; renaming somebody's file is neither.
   */
  let logOwnsLive = false
  /** Whether the exclusive create has already answered the ownership question. */
  let logOwnershipDecided = false
  /** How many rotated copies THIS apply created, capped by `rotateKeep`. */
  let logOwnedRotations = 0
  /** Why logging stopped, if it did. Never cleared: no timer can fix a file. */
  let logBlockReason
  /** When logging stopped, so a reader can see how long it has been. */
  let logBlockSince
  /**
   * Two separate silences, not one.
   *
   * They used to share a latch, which meant a record dropped for being too
   * big could spend the log's one warning and leave a genuine disk failure
   * unreported for as long as it lasted. Capacity and encoding are the plugin's
   * own housekeeping; a write that fails is the host's disk having a problem,
   * and that one must always be able to reach the host on its own.
   */
  let logWriteFailureReported = false
  let logRecordDropReported = false

  const logCounters = {
    /** Records offered to the log since apply, dropped ones included. */
    queued: 0,
    /** Records that reached the disk. */
    written: 0,
    /** Records refused by a ceiling, or given up on after failing. */
    droppedRecords: 0,
    /** The bytes those dropped records would have occupied. */
    droppedBytes: 0,
    /**
     * WHY each record was dropped, kept apart from the total on purpose. The
     * total alone cannot answer the question a reader actually has: a log that
     * is dropping because the DISK is refusing is a different problem from one
     * that is dropping because the WRITER cannot keep up, and only one of them
     * is fixed by making the disk faster.
     */
    droppedOversize: 0,
    droppedOverflow: 0,
    droppedUnwritable: 0,
    droppedAbandoned: 0,
    droppedUnserializable: 0,
    /**
     * Records refused because logging is STOPPED, not because they were too
     * big or the disk was busy. Kept apart so "the log is not being written at
     * all" can never be mistaken for "the log is being written, some of it was
     * dropped".
     */
    droppedBlocked: 0,
    /** Times a record was refused because logging was stopped. */
    blockEvents: 0,
    /** Write attempts that failed. */
    writeFailures: 0,
    /** Times the live file was rotated. */
    rotations: 0,
    /** Times the log path's parent directory was created. */
    mkdirs: 0,
    /** The most recent failure, for a caller who wants to know why. */
    lastError: undefined,
  }
  /**
   * The reorder runner's shape: ONE pass in flight, plus at most ONE boolean
   * recording that a pass was asked for while it ran.
   *
   * It used to append `reorderSessions(batch)` to the shared chain once per
   * flush, so the queue grew with the number of coalescing windows that elapsed
   * while one write was blocked — and each queued closure held its own batch map
   * and, through it, the whole apply scope. `trailing` is deliberately a
   * boolean rather than a queue: the runner has no use for the individual
   * requests, because the facts that produced them are all waiting in
   * `pendingActivity` and the next pass consumes them together.
   */
  let running = false
  let trailing = false
  /**
   * Arrival time of the oldest fact the RUNNING pass is holding, or undefined
   * when no pass is holding one.
   *
   * A whole batch would answer `pendingAgeMs` perfectly and undo this ticket's
   * retention work, so only this one number crosses the boundary. It is set
   * when the pass takes its batch and cleared when that pass stops — a fact the
   * pass refused is back on the pending map with its `at` intact, and a fact it
   * applied is consumed, so neither is lost by dropping it here.
   */
  let runningOldestAt

  /**
   * Report through the host logger without ever letting a broken logger reach
   * the caller. A `logger.warn` that throws used to be able to reject a promise
   * nobody was holding, and on the log worker's own path that is an unhandled
   * rejection — which takes the host process down over a diagnostics message.
   * @param {string} message - what to report.
   */
  const warn = (message) => {
    try {
      logger.warn?.(message)
    } catch {
      // Deliberately empty. The report is a courtesy; failing to deliver it
      // must not become the plugin's problem.
    }
  }

  /**
   * Record one dropped record, with the reason and the bytes it would have
   * occupied. Every drop goes through here, so the total is always the sum of
   * the reasons and cannot drift from them.
   * @param {number} bytes - what the record would have cost.
   * @param {'droppedOversize' | 'droppedOverflow' | 'droppedUnwritable' | 'droppedAbandoned' | 'droppedUnserializable'} reason - why.
   */
  const dropLogRecord = (bytes, reason) => {
    logCounters.droppedRecords += 1
    logCounters.droppedBytes += bytes
    logCounters[reason] += 1
  }

  /**
   * Throw away whatever is still queued, counting it.
   *
   * Used at dispose. These records are ABANDONED, not written and not silently
   * forgotten: a reader who sees a queue depth of zero needs to be able to see
   * where they went.
   */
  const abandonLogQueue = () => {
    while (logQueue.length > 0) {
      const entry = logQueue.shift()
      dropLogRecord(entry.bytes, 'droppedAbandoned')
    }
  }

  /** Wait before the next attempt, so a disk that refuses is not hammered. */
  const armLogBackoff = () => {
    if (logBackoffTimer !== undefined) return
    if (!alive()) return
    logBackoffTimer = setTimeout(() => {
      logBackoffTimer = undefined
      kickLogWorker()
    }, LOG_RETRY_BACKOFF_MS)
  }

  /**
   * Whether the slot this rotation is about to write into is free.
   *
   * `rename` onto an existing destination REPLACES it — silently, on POSIX.
   * Windows fails with EEXIST, so a Windows-only test would have called this
   * safe for years. The question is therefore never "will the platform let me",
   * it is "is that file mine".
   *
   * The slot a rotation writes into is the one just above everything this apply
   * has already created. Everything below it is ours and is shifted; the one
   * above is ours only if we have not created it yet, which is the single check
   * here. That is also what keeps a foreign `.2` or `.3` safe: they are never a
   * destination until they are a slot WE emptied.
   * @returns {Promise<boolean>} true when the destination slot can be taken.
   */
  const rotationSlotIsFree = async () => {
    const target = Math.min(logOwnedRotations + 1, LOG_ROTATE_KEEP)
    if (target <= logOwnedRotations) return true
    try {
      await stat(`${logPath}.${String(target)}`)
      return false
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      throw error
    }
  }

  /**
   * Rotate the live file aside, keeping `rotateKeep` copies.
   *
   * A NORMAL WRITE POLICY, not a startup sweep: nothing here runs until a
   * record actually needs the room. Nothing is read and nothing is truncated —
   * an existing log that is not JSONL is somebody's file, and this code has no
   * business deciding it is garbage.
   *
   * ONLY COPIES THIS APPLY CREATED ARE EVER MOVED OR REMOVED. The first
   * rotation moves the live file (which this apply adopted, so it is ours) into
   * slot 1 and touches nothing else; each later rotation shifts only the copies
   * it already made, and the oldest of those leaves once the keep count is
   * full. A `.3` that was already sitting there when this process started is
   * never renamed and never deleted, because this plugin cannot prove it wrote
   * it.
   *
   * @returns {Promise<'ok' | 'slot-conflict' | 'abandoned'>} what happened.
   */
  const rotateLog = async () => {
    if (!alive()) return 'abandoned'
    if (!(await rotationSlotIsFree())) {
      if (!alive()) return 'abandoned'
      return 'slot-conflict'
    }
    // Free the top slot. Only ever remove a copy this apply created: at this
    // point the cascade count says it made at least `rotateKeep` of them.
    if (logOwnedRotations >= LOG_ROTATE_KEEP) {
      await rm(`${logPath}.${String(LOG_ROTATE_KEEP)}`, { force: true })
      if (!alive()) return 'abandoned'
    }
    const cascadeFrom = Math.min(logOwnedRotations, LOG_ROTATE_KEEP - 1)
    for (let index = cascadeFrom; index >= 1; index -= 1) {
      try {
        await rename(`${logPath}.${String(index)}`, `${logPath}.${String(index + 1)}`)
      } catch (error) {
        // A copy that is not there is the normal case, not a failure.
        if (error?.code !== 'ENOENT') throw error
      }
      if (!alive()) return 'abandoned'
    }
    logOwnedRotations = Math.min(logOwnedRotations + 1, LOG_ROTATE_KEEP)
    try {
      await rename(logPath, `${logPath}.1`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    logBytesOnDisk = 0
    logCounters.rotations += 1
    // The live file is gone; the next one has not been made yet, so ownership is
    // an open question again rather than an inherited answer.
    logOwnsLive = false
    logOwnershipDecided = false
    logPreexistingBytes = 0
    return 'ok'
  }

  /**
   * Refuse this record because logging is stopped, and say why.
   *
   * THE CONSERVATIVE DIRECTION. When keeping the plugin's promise would mean
   * renaming or deleting a file the plugin did not create, the promise loses.
   * The alternative — rotating it anyway — is how a plugin that is supposed to
   * be polite to a user's files ends up deleting one, and it is irreversible.
   * Stopping is recoverable: the file is exactly where it was, the reason is
   * published, and nothing else the plugin does changes.
   *
   * Sticky for the life of the apply, deliberately. The thing being waited on is
   * a file only a person (or a restart) can move, and re-stat'ing it per record
   * is precisely the per-record probing this design exists to avoid.
   * @param {{line: string, bytes: number, attempts: number}} entry - the record.
   * @param {string} reason - why logging stopped.
   * @returns {string} always `'blocked'`.
   */
  const blockLogRecord = (entry, reason) => {
    logCounters.blockEvents += 1
    dropLogRecord(entry.bytes, 'droppedBlocked')
    if (logBlockReason === reason) return 'blocked'
    logBlockReason = reason
    logBlockSince = new Date().toISOString()
    if (!logRecordDropReported) {
      logRecordDropReported = true
      warn(`dsh-session-top: activity log stopped writing (${reason}); status.log.preexistingBytes `
        + 'reports what it found. A file this plugin did not create is never renamed or removed to make room.')
    }
    return 'blocked'
  }

  /**
   * Account for a failed write and decide the record's fate.
   *
   * The record keeps its place at the head of the queue for a bounded number
   * of attempts, so a transient failure — a directory that was removed, a disk
   * briefly full — recovers on its own. After that it is dropped and counted.
   * Either way the worker STOPS here and resumes after the backoff, which is
   * what makes a broken disk cost one attempt per backoff window instead of
   * one per activity event.
   * @param {{line: string, bytes: number, attempts: number}} entry - the record.
   * @param {unknown} error - what went wrong.
   * @returns {string} always `'failed'`; the worker stops for it.
   */
  const failLogRecord = (entry, error) => {
    logCounters.writeFailures += 1
    logCounters.lastError = String(error)
    stats.lastError = String(error)
    // A failure is at least as likely to mean "the directory is gone" as
    // anything else, so the next attempt re-establishes it rather than
    // assuming it is still there.
    logDirReady = false
    logSizeKnown = false
    entry.attempts += 1
    // ONE report per failure streak, not one per record: a log that cannot be
    // written would otherwise fill the host's log with one line per activity
    // event, forever, for a condition nobody is going to act on per record.
    if (!logWriteFailureReported) {
      logWriteFailureReported = true
      warn(`dsh-session-top: activity log write failed: ${String(error)}`)
    }
    if (entry.attempts >= LOG_WRITE_ATTEMPTS) {
      logQueue.shift()
      dropLogRecord(entry.bytes, 'droppedUnwritable')
    }
    armLogBackoff()
    return 'failed'
  }

  /**
   * Put one record on the disk.
   *
   * Uses short-lived calls only — `mkdir`, `stat`, `rename`, `writeFile` — so
   * nothing is held open between records and dispose has no descriptor to
   * flush. `alive()` is checked before EVERY step, not once at the top, so a
   * torn-down apply begins no further filesystem work from wherever this got to.
   * @param {{line: string, bytes: number, attempts: number}} entry - the record.
   * @returns {Promise<'written' | 'failed' | 'abandoned'>} what became of it.
   */
  const writeLogRecord = async (entry) => {
    if (!alive()) return 'abandoned'
    if (!logDirReady) {
      // The PARENT OF THE CONFIGURED PATH, which is not necessarily the plugin
      // home: a custom `logFile` may point anywhere, and the old shape created
      // the default directory and then appended to the custom one, so every
      // record failed, forever, with a warning each time. Once per directory
      // state rather than once per record.
      try {
        await mkdir(logDirectory, { recursive: true })
      } catch (error) {
        return failLogRecord(entry, error)
      }
      if (!alive()) return 'abandoned'
      logCounters.mkdirs += 1
      logDirReady = true
      // A directory created just now cannot already hold the live file.
      logSizeKnown = false
    }
    if (!alive()) return 'abandoned'
    if (!logSizeKnown) {
      try {
        const info = await stat(logPath)
        logBytesOnDisk = typeof info?.size === 'number' ? info.size : 0
      } catch {
        // A missing file is size zero. Any other reason shows up in the write
        // below, which is the operation that actually matters, so this does not
        // report anything of its own.
        logBytesOnDisk = 0
      }
      logSizeKnown = true
      if (!logOwnershipDecided) logPreexistingBytes = logBytesOnDisk
      // A file this plugin did not create, already past the point where it
      // could be rotated without moving it aside. Appending would keep growing
      // it — which is exactly what this ticket exists to stop — and the only
      // way to stop growing it is to move it, which is not ours to do.
      if (logBytesOnDisk > LOG_FILE_BYTES) return blockLogRecord(entry, 'preexisting-file')
    }
    if (!alive()) return 'abandoned'
    if (logBytesOnDisk > 0 && logBytesOnDisk + entry.bytes > LOG_FILE_BYTES) {
      // Rotation means MOVING this file. Appending to it — even once, even by
      // configuration — never made it ours: a file that was already there when
      // this process started is somebody's file, and this plugin has no marker,
      // no way to ask, and no authority to guess whose.
      if (!logOwnsLive) return blockLogRecord(entry, 'preexisting-file')
      let rotated
      try {
        rotated = await rotateLog()
      } catch (error) {
        return failLogRecord(entry, error)
      }
      if (rotated === 'abandoned') return 'abandoned'
      if (rotated === 'slot-conflict') return blockLogRecord(entry, 'slot-conflict')
    }
    if (!alive()) return 'abandoned'
    try {
      if (!logOwnershipDecided) {
        // Ownership is decided ATOMICALLY, by trying to CREATE the file: an
        // exclusive create either makes it — and then it is this plugin's — or
        // proves it was already there, and then it is not. Deciding it from a
        // `stat` that said "absent" would be claiming ownership of a moment
        // that is over before the write happens.
        logOwnershipDecided = true
        try {
          await writeFile(logPath, entry.line, { encoding: 'utf8', flag: 'wx' })
          logOwnsLive = true
          logPreexistingBytes = 0
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
          // Already there. Appending is what the configured path is FOR, and it
          // destroys nothing, so it is allowed — it simply confers no ownership.
          await writeFile(logPath, entry.line, { encoding: 'utf8', flag: 'a' })
        }
      } else {
        await writeFile(logPath, entry.line, { encoding: 'utf8', flag: 'a' })
      }
      // The bytes ARE on disk, so they are counted even if this apply was torn
      // down while the kernel was busy with the write. Recording that only when
      // the plugin happened to still be alive would understate what the log
      // left behind — and this loop must never cancel work it has already
      // issued, only refuse to start new work.
      logBytesOnDisk += entry.bytes
      logCounters.written += 1
      entry.attempts = 0
      logWriteFailureReported = false
      logRecordDropReported = false
      return 'written'
    } catch (error) {
      return failLogRecord(entry, error)
    }
  }

  /** Drain the queue, one record at a time, stopping at the first failure. */
  const runLogWorker = async () => {
    try {
      while (alive() && logQueue.length > 0) {
        const entry = logQueue[0]
        const outcome = await writeLogRecord(entry)
        if (outcome === 'failed') return
        logQueue.shift()
        // `abandoned` means the write was never started because the apply was
        // already gone. It is still a record the log accepted and will never
        // have, so it leaves the queue counted rather than unaccounted.
        if (outcome === 'abandoned') dropLogRecord(entry.bytes, 'droppedAbandoned')
      }
    } finally {
      logWorking = false
      if (!alive()) abandonLogQueue()
      else if (logBackoffTimer === undefined && logQueue.length > 0) kickLogWorker()
    }
  }

  /**
   * Start the worker unless one is already running, already backing off, or
   * there is nothing to do. The queue itself is the backpressure: this can be
   * called on every event and the depth of work still stays bounded.
   */
  const kickLogWorker = () => {
    if (!alive()) return
    if (logWorking) return
    if (logBackoffTimer !== undefined) return
    if (logQueue.length === 0) return
    logWorking = true
    // The catch is a guard, not the error path: failures are counted inside the
    // worker. It exists so nothing on this path can become an unhandled
    // rejection and take the host process with it.
    void runLogWorker().catch((error) => {
      logCounters.lastError = String(error)
      stats.lastError = String(error)
    })
  }

  /**
   * Offer one record to the log. Never throws into the caller, never waits on
   * the disk, and never grows without limit.
   *
   * The record is serialized HERE, so what the queue bounds is bytes that are
   * already known rather than objects that might expand later.
   * @param {object} record - the diagnostic record.
   */
  const logLine = (record) => {
    if (logPath === undefined) return
    if (!alive()) return
    // Counted HERE, before anything can reject it. A record that is offered and
    // then refused — too big, unserializable, or blocked — was still offered,
    // and `written + droppedRecords === queued` is the invariant that says so.
    // Counting it only once it reached the queue made both public numbers wrong
    // on exactly the paths where somebody goes looking to see whether records
    // are being lost silently.
    logCounters.queued += 1
    let line
    try {
      // `JSON.stringify` escapes newlines inside strings, so one record is
      // always exactly one line and the file stays parseable line by line.
      line = `${JSON.stringify(record)}\n`
    } catch (error) {
      dropLogRecord(0, 'droppedUnserializable')
      if (!logRecordDropReported) {
        logRecordDropReported = true
        warn(`dsh-session-top: activity log record could not be serialized: ${String(error)}`)
      }
      return
    }
    const bytes = Buffer.byteLength(line)
    if (bytes > LOG_RECORD_BYTES) {
      // Dropping is the honest response. Truncating it would leave a lie in the
      // file; writing it would let one record decide the size of the log.
      dropLogRecord(bytes, 'droppedOversize')
      if (!logRecordDropReported) {
        logRecordDropReported = true
        warn(`dsh-session-top: activity log record of ${String(bytes)} bytes exceeds the ${String(LOG_RECORD_BYTES)} byte limit and was dropped`)
      }
      return
    }
    if (logQueue.length >= LOG_BUFFER_RECORDS) {
      // The OLDEST goes, because it is the least likely to still be what
      // anyone is looking for. Whatever arrived most recently is the answer to
      // "what was the plugin doing just now".
      const evicted = logQueue.shift()
      dropLogRecord(evicted.bytes, 'droppedOverflow')
    }
    logQueue.push({ line, bytes, attempts: 0 })
    kickLogWorker()
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
   * Keep the deferred set inside the same ceiling as the rank map. It is fed
   * only by facts that were pending, so it cannot grow within one pass, but
   * across a long-lived host the set of sessions that have ever been refused
   * would otherwise accumulate without limit.
   */
  const trimDeferred = () => {
    if (deferredActivity.size <= maxTracked) return
    const byAge = [...deferredActivity.entries()].sort((a, b) => a[1].seq - b[1].seq)
    for (const [id] of byAge.slice(0, deferredActivity.size - maxTracked)) {
      deferredActivity.delete(id)
    }
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
   * The most recently active sessions, newest first — the top 25 of the
   * activity record.
   *
   * This is a DIAGNOSTIC ("can a user confirm the plugin is actually seeing
   * activity?"), NOT the order the sidebar shows. The durable order is whatever
   * `planFloatDirty` wrote into each account, and it deliberately disagrees
   * with this whenever the user has dragged rows. Nothing here may be read as a
   * screen order, and this list must never become the input to a plan.
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

  /**
   * How long the OLDEST unconsumed fact has been waiting, in milliseconds.
   *
   * Measured from ARRIVAL (`fact.at`), never from the event's own timestamp: a
   * commit can carry an event time from long before this process saw it, so
   * `time` would report an age nobody experienced. `requeueActivity` carries
   * `at` back onto the pending set, so a fact the host refused keeps the age it
   * had when it first arrived instead of looking brand new on every retry.
   *
   * THE RUNNING PASS COUNTS. A fact the running pass is holding is still
   * unconsumed — that pass may yet fail and put it back — and it is the very fact
   * a user diagnosing a stuck runner is looking for. Scanning only the pending map
   * reported 0 for exactly the case this field exists to explain, so the oldest
   * arrival in the running batch is tracked alongside it.
   *
   * Only that ONE number is tracked, never the batch: holding a whole batch Map
   * alive purely to answer a status question would reintroduce the retention this
   * ticket removed.
   *
   * Boundaries: a pass that ends releases it — whatever the pass refused went back
   * to the pending set with its `at` intact and is picked up from there; and
   * dispose clears it, because after teardown the in-flight pass can no longer
   * requeue anything, so those facts are abandoned rather than waiting.
   * @returns {number} the age in milliseconds; 0 when nothing is unconsumed.
   */
  const pendingAgeMs = () => {
    const candidates = [oldestArrivalAt(pendingActivity.values()), runningOldestAt]
      .filter(value => value !== undefined)
    return candidates.length === 0 ? 0 : Date.now() - Math.min(...candidates)
  }

  const getStatus = () => ({
    ...stats,
    debounceMs,
    maxTrackedSessions: maxTracked,
    home: pluginHome(),
    logFile: logPath ?? null,
    /**
     * The log's real bounds and its real accounting, read from the same
     * variables the log worker branches on.
     *
     * `depth` is what is waiting; `written` + `droppedRecords` is where every
     * offered record went. A dropped record is reported rather than quietly
     * forgotten, because a log that silently loses records is worse than one
     * that admits it: a reader cannot tell the difference between "nothing
     * happened" and "the line about it was dropped".
     *
     * `limits` is published rather than left in the source on purpose — the
     * ceilings are part of this plugin's contract with whoever reads them, and
     * the numbers above are how a reader checks that contract.
     */
    log: {
      limits: LOG_LIMITS,
      depth: logQueue.length,
      bytes: logBytesOnDisk,
      working: logWorking,
      queued: logCounters.queued,
      written: logCounters.written,
      droppedRecords: logCounters.droppedRecords,
      droppedBytes: logCounters.droppedBytes,
      droppedOversize: logCounters.droppedOversize,
      droppedOverflow: logCounters.droppedOverflow,
      droppedUnwritable: logCounters.droppedUnwritable,
      droppedAbandoned: logCounters.droppedAbandoned,
      droppedUnserializable: logCounters.droppedUnserializable,
      droppedBlocked: logCounters.droppedBlocked,
      /**
       * Whether this apply may MOVE the live file. True only when this apply
       * created it, which is proved by an exclusive create rather than by a
       * `stat` that said "absent". Appending to a file this plugin did not
       * create is allowed and changes nothing here.
       */
      owned: logOwnsLive,
      /** What the live file held before this apply wrote anything to it. */
      preexistingBytes: logPreexistingBytes,
      /**
       * Why logging stopped, if it did: `preexisting-file` when the file at the
       * configured path is not this apply's to rotate, `slot-conflict` when a
       * rotated copy this plugin did not create is in the way.
       *
       * It does not clear by itself. What is being waited on is a file only a
       * person can move, and re-checking it per record is the per-record probing
       * this design exists to avoid. The plugin stops rather than renaming a
       * file it cannot prove it wrote.
       */
      blocked: logBlockReason === undefined ? null : { reason: logBlockReason, since: logBlockSince },
      blockEvents: logCounters.blockEvents,
      writeFailures: logCounters.writeFailures,
      rotations: logCounters.rotations,
      mkdirs: logCounters.mkdirs,
      lastError: logCounters.lastError,
    },
    trackedSessions: lastActivity.size,
    /**
     * The fallback cache, and the two numbers that are easy to confuse.
     *
     * `fallbackSessions` is what is RETAINED: the map itself, already capped at
     * `maxTrackedSessions`. `fallbackEnumerated` is how many headers the host
     * actually handed over on the last resync. They are reported separately on
     * purpose — a capped map presented as "10000 fallback sessions" would be a
     * lie about retention, and a reader checking this plugin's memory cost
     * would be checking the wrong number.
     *
     * Neither number is activity and neither takes part in ordering. This map
     * is a diagnostic record of what the host persisted; see the declaration.
     */
    fallbackSessions: fallbackTimes.size,
    fallbackEnumerated: fallbackCounters.enumerated,
    // The runner's REAL shape, read from the same variables the scheduler
    // branches on — not a description of what was intended.
    //
    // `running` is whether a pass is in flight.
    //
    // `queueDepth` is how many passes have been ASKED FOR and have not STARTED.
    // Both ways of asking count, and they used to report differently for the
    // same real state: a request made while a pass runs only sets `trailing`,
    // while a request made with no pass running only arms the debounce timer.
    // Counting the timer as well is what makes "work is waiting to happen" one
    // number. Read it with `running`: depth 0 while idle, 1 while a pass is
    // running and one more is queued, 1 while one is armed and none is running.
    // Both go to 0 the moment the pass starts (`flush` clears the timer,
    // `requestPass` clears `trailing`) and at dispose.
    running,
    queueDepth: (trailing || timer !== undefined) ? 1 : 0,
    pendingAgeMs: pendingAgeMs(),
    // What a refused write left behind, and why. `pending` is work that will be
    // retried on its own; `deferred` is work the host refused past its retry
    // budget, which resumes only when that session is active again — so a
    // caller can tell "still working on it" from "given up until it moves".
    pendingActivity: [...pendingActivity.entries()].map(([id, fact]) => ({
      id,
      time: fact.time,
      // ARRIVAL, as epoch milliseconds — when this fact entered the pending set.
      at: fact.at,
      attempts: fact.attempts,
    })),
    // NOTE ON THE TWO `at` FIELDS: they are NOT the same clock and must not be
    // compared or sorted as if they were. `pendingActivity[].at` is a NUMBER —
    // when the fact arrived here, and what `pendingAgeMs` counts from.
    // `deferredActivity[].at` is an ISO STRING — when the host gave up on it.
    // They are reported side by side for reading convenience only; unifying the
    // representation is a documentation-contract change (R14), not something to
    // half-do by renaming a field a consumer may already be reading.
    deferredActivity: [...deferredActivity.entries()].map(([id, fact]) => ({
      id,
      time: fact.time,
      attempts: fact.attempts,
      reason: fact.reason,
      at: fact.at,
    })),
    registry: registryProjection(),
    ranked: rankedSessions(),
  })

  /**
   * Rebuild the cold-session fallback map from persistence, by REPLACEMENT.
   *
   * AN EXPLICIT, REVERSIBLE BEHAVIOUR CHANGE — the call SHAPE changed, not just
   * a limit. Startup used to run this for every process, so a host with a
   * hundred thousand sessions paid a full O(headers) enumeration before it had
   * served a single event, over a service that may not even have activated yet.
   * It now runs only when someone asks for it through resync. Nothing else
   * about the map changes: it is still a diagnostic record, still keyed by
   * `createdAt`, and still takes no part in ordering.
   *
   * `sessionPersistence.list()` resolves to `SessionHeader[]` — the headers
   * THEMSELVES, not records wrapping a header (that is `listSnapshots()`). And
   * a header's `createdAt` is epoch milliseconds as a NUMBER, so it is read as
   * a number rather than parsed from a date string.
   *
   * Two properties the old `set()`-per-header loop did not have:
   *
   *   - REPLACEMENT. The old loop only ever added, so a session that stopped
   *     existing stayed in the map for the life of the process. The new map is
   *     published by clearing and refilling in one synchronous step, so no
   *     reader can ever see a half-replaced cache, and "the host now reports
   *     nothing" really does leave it empty.
   *   - A CEILING. The retained map is held to `maxTrackedSessions`, the same
   *     ceiling the other retained maps use. `enumerated` counts what the host
   *     handed over; `fallbackSessions` counts what was kept. Publishing only
   *     the first would describe memory this plugin is not using.
   *
   * Unload: the list is a host call that cannot be cancelled, so an in-flight
   * one is allowed to settle — but its RESULT IS NOT PUBLISHED. A disposed apply
   * must not be the one filling a map nobody can reach.
   * @returns {Promise<{reachable: boolean, enumerated: number}>} what happened.
   */
  const rebuildFallbackTimes = async () => {
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) return { reachable: false, enumerated: 0 }
    const headers = await persistence.list()
    if (!alive()) return { reachable: true, enumerated: 0 }
    const next = new Map()
    for (const header of headers ?? []) {
      const id = header?.id
      const created = header?.createdAt
      if (id === undefined || typeof created !== 'number' || !Number.isFinite(created)) continue
      next.set(String(id), created)
    }
    const enumerated = next.size
    if (next.size > maxTracked) {
      const newest = [...next.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxTracked)
      next.clear()
      for (const [id, created] of newest) next.set(id, created)
    }
    // One synchronous step: clear then refill, so no reader observes a
    // partially replaced cache.
    fallbackTimes.clear()
    for (const [id, created] of next) fallbackTimes.set(id, created)
    fallbackCounters.enumerated = enumerated
    return { reachable: true, enumerated }
  }

  /**
   * The single-flight resync.
   *
   * Twenty concurrent POSTs used to mean twenty full enumerations of the host's
   * persisted headers, overlapping. They now share ONE underlying list and all
   * get its answer — which is the only difference worth making, because twenty
   * identical readers of the same cache add nothing a twentieth reader does not
   * already have.
   *
   * The route's shape is untouched: POST, loopback-fenced, `{ ok: true, ... }`.
   *
   * The one host read that survives unload if a caller got hold of the route
   * handler first: everything else checks `alive()` before touching a service.
   * A stale handler starts no new read, and a read already in flight publishes
   * nothing.
   * @returns {Promise<{seeded: boolean, fallbackSessions?: number, fallbackEnumerated?: number}>} the answer.
   */
  const resync = async () => {
    if (!alive()) return { seeded: false, error: 'plugin disposed' }
    if (resyncInFlight !== undefined) return await resyncInFlight
    const run = (async () => {
      try {
        const outcome = await rebuildFallbackTimes()
        if (!alive()) return { seeded: false, fallbackSessions: fallbackTimes.size }
        if (!outcome.reachable) {
          stats.lastError = 'no sessionPersistence service on this host'
          return { seeded: false, fallbackSessions: fallbackTimes.size }
        }
        stats.flushes += 1
        stats.lastFlushAt = new Date().toISOString()
        fallbackCounters.lastResyncAt = stats.lastFlushAt
        return {
          seeded: true,
          fallbackSessions: fallbackTimes.size,
          fallbackEnumerated: outcome.enumerated,
        }
      } catch (error) {
        stats.lastError = String(error)
        warn(`dsh-session-top: resync failed: ${String(error)}`)
        return { seeded: false, error: String(error) }
      }
    })()
    resyncInFlight = run
    try {
      return await run
    } finally {
      if (resyncInFlight === run) resyncInFlight = undefined
    }
  }

  /**
   * How many times one activity fact may be refused by the host and put back
   * before it is set aside instead.
   *
   * Bounded on purpose. A fact is refused when the account changed under the
   * plan — a concurrent drag, a migration — and the usual cause clears on its
   * own, so an automatic retry is the right default. But a fact the host will
   * never accept must not spin: every retry is another durable write attempt,
   * and an unbounded one turns a single stuck account into an endless loop that
   * also starves every other account's ordering.
   *
   * Past the limit the fact is DEFERRED, not discarded: it keeps its reason and
   * its latest time, the diagnostics report it, and the next real activity
   * event for that session picks it up again with a fresh budget.
   */
  const REFUSAL_RETRY_LIMIT = 3

  /**
   * Return a candidate fact to `pendingActivity` without ever letting an OLD
   * fact overwrite a NEWER one that arrived while the pass was running, and
   * without retrying a fact the host has already refused too many times.
   *
   * @param {string} id - the session id.
   * @param {{time: number, seq: number, at?: number, attempts?: number}} fact - the fact to restore.
   * @returns {boolean} true when it went back on the pending set (so the pass
   *   should re-arm), false when it was deferred instead.
   */
  const requeueActivity = (id, fact) => {
    const current = pendingActivity.get(id)
    // A newer fact is already queued. The older one has nothing left to
    // contribute: replaying it would order this session by a time the host has
    // already moved past.
    if (current !== undefined && current.seq > fact.seq) return true
    const attempts = (current?.attempts ?? fact.attempts ?? 0) + 1
    if (attempts > REFUSAL_RETRY_LIMIT) {
      if (!deferredActivity.has(id)) {
        stats.deferredSessions += 1
        stats.lastDeferralReason = stats.lastReorderError?.message ?? 'host refused the durable write'
      }
      deferredActivity.set(id, {
        time: fact.time,
        seq: fact.seq,
        attempts,
        reason: stats.lastReorderError?.message ?? String('host refused the durable write'),
        at: new Date().toISOString(),
      })
      pendingActivity.delete(id)
      return false
    }
    // `at` is the ARRIVAL clock, carried unchanged so a refusal retry does not
    // reset the fact's age back to zero.
    pendingActivity.set(id, { time: fact.time, seq: fact.seq, at: fact.at ?? Date.now(), attempts })
    return true
  }

  /**
   * Behavior 1's durable half: float the sessions that acted to the top of
   * their own account.
   *
   * The sidebar's default "recent" view already sorts by `updatedAt` on every
   * render, but the durable account (`workspace.sessionIds`) only changes
   * through `insertSessionBefore`. Replaying the move through that official API
   * is what makes activity keep mattering after the user switches the sidebar
   * to manual order — and it survives a restart, which a purely client-side
   * sort would not.
   *
   * THE BATCH IS THE PERMISSION. `batch` is an immutable snapshot of the
   * activity that arrived since the last pass took its own snapshot; anything
   * that arrives during this pass lands in the NEXT batch. Only sessions named
   * in `batch` may move, and only inside the account they currently belong to.
   * Ranking every workspace against the permanently retained `lastActivity`
   * map instead is what turned one workspace's activity into a licence to
   * re-assert another workspace's stale order, undoing a manual drag.
   *
   * A workspace holding no member of the batch is skipped entirely — no read of
   * its `sessionIds`, no plan, no write. An account the batch does not disturb
   * produces no host call at all.
   *
   * At most one of these runs at a time. The runner is single-flight, so a
   * manual drag in the sidebar and this pass can no more interleave on one
   * account than the old serialized chain allowed — but the serialization no
   * longer costs a queue, so a pass can no longer be stranded behind unrelated
   * queued work, and a blocked write can no longer postpone a later pass past
   * an unbounded backlog of ones that never started.
   *
   * A pass is NEVER given a timeout, and a blocked write NEVER opens a second
   * concurrent write to the same account. That is deliberate: the host API
   * cannot be aborted, so a "timeout then retry anyway" policy would produce
   * two writers on one account instead of one slow one. The runner reports how
   * long a pass has taken (`lastPassDurationMs`, `running`) and lets the host
   * see it instead.
   *
   * Unload semantics: an RPC already handed to the host is not cancellable and
   * is allowed to settle — claiming otherwise would be a lie. What is
   * guaranteed is that nothing NEW starts: the validity check runs before the
   * registry is touched and again after every `await`, so no later workspace,
   * no later move, no log line and no next pass begins once this apply is gone.
   *
   * @param {ReadonlyMap<string, {time: number, seq: number}>} batch - the consumed activity facts.
   * @returns {Promise<number>} moves applied.
   */
  const reorderSessions = async (batch) => {
    if (!alive()) return 0
    if (batch.size === 0) return 0
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) {
      stats.registryMissing = true
      return 0
    }
    stats.registryMissing = false
    let applied = 0
    let workspaces
    try {
      workspaces = registry.list()
    } catch (error) {
      stats.lastError = String(error)
      return 0
    }
    for (const workspace of workspaces) {
      if (!alive()) return applied
      let account
      try {
        account = [...workspace.sessionIds].map(String)
      } catch (error) {
        stats.lastError = String(error)
        stats.reorderAborts += 1
        continue
      }
      const candidates = []
      for (const id of account) {
        const fact = batch.get(id)
        if (fact !== undefined) candidates.push({ id, time: fact.time })
      }
      // No member of this account acted in this batch: do not even read it.
      if (candidates.length === 0) continue
      const moves = planFloatDirty(account, candidates)
      for (let index = 0; index < moves.length; index += 1) {
        if (!alive()) return applied
        const move = moves[index]
        try {
          await workspace.insertSessionBefore(move.id, move.beforeId)
          applied += 1
        } catch (error) {
          // The account aged out from under the plan (a concurrent detach, a
          // manual drag). Stop this workspace.
          //
          // The refused one was planned but never achieved, so it goes back on
          // the pending set. Marking it as done is what silently dropped it —
          // its float-up then depended on some unrelated session happening to
          // be active later.
          //
          // WHAT GOES BACK IS THE WHOLE CANDIDATE SET OF THIS ACCOUNT, not just
          // the refused tail. Returning only the tail lets the retry re-rank on
          // a strict subset of the batch, and an OLDER candidate can then rise
          // above a NEWER one this very batch had already placed — a transient
          // refusal would silently change the order the batch chose. Carrying
          // the whole set keeps the batch's answer intact: the retry re-plans
          // the same ranking and lands on the same order.
          //
          // Three boundaries this does NOT cross:
          //
          //   - Only THIS account's candidates. An account the same pass already
          //     wrote is not touched, so no unrelated account has its rank
          //     re-asserted from this batch's permissions — that is the R01
          //     defect itself.
          //   - Only facts from THIS batch. `lastActivity` is never consulted
          //     for ordering, so this is not a replay of accumulated history; a
          //     candidate already sitting where the batch wants it yields no
          //     move and simply consumes its fact.
          //   - A newer fact wins. `requeueActivity` refuses to overwrite a
          //     fact with a higher arrival sequence, so a retry that overlaps
          //     fresh activity cannot order the account by an older time.
          stats.lastError = String(error)
          stats.reorderAborts += 1
          stats.lastReorderError = {
            workspace: String(workspace.id),
            session: move.id,
            at: new Date().toISOString(),
            message: String(error),
          }
          if (alive()) {
            for (const candidate of candidates) {
              const fact = batch.get(candidate.id)
              if (fact !== undefined) requeueActivity(candidate.id, fact)
            }
          }
          break
        }
        // The account is read fresh per workspace, so a member that migrated
        // away mid-pass is not chased back into it. A member that migrated IN is
        // simply floated when its new account is read — the batch named it, and
        // its new home is where it now lives.
      }
    }
    stats.movesApplied += applied
    return applied
  }

  /**
   * Hold the pending set inside the same ceiling as the rank map, and for the
   * same reason: a burst inside one coalescing window must not turn the pending
   * set into the unbounded structure the rank map is careful not to be. The
   * oldest facts go first — they are the ones whose accounts have had the most
   * chances to be reordered already.
   *
   * Called on every event AND on every take. On the take alone the ceiling would
   * only hold while passes keep succeeding: a runner blocked on a host write
   * takes nothing for as long as it is blocked, which is precisely the window in
   * which "bounded" has to stay true.
   *
   * KNOWN, NOT OPTIMIZED: over the ceiling this sorts the whole map, ~58µs per
   * event at the default 2000 ceiling on the machine this was measured on —
   * single-digit percent of one core at the ~320 events/s of the 60s stress,
   * but it becomes visible with thousands of active sessions and a high event
   * rate. Recorded rather than fixed: the cheap form (drop only the overflow,
   * or trim to a watermark so the cost amortizes) changes the trimming
   * strategy, and that is not a change to slip into a scheduling fix.
   */
  const boundPending = () => {
    if (pendingActivity.size <= maxTracked) return
    const byAge = [...pendingActivity.entries()].sort((a, b) => a[1].seq - b[1].seq)
    for (const [id] of byAge.slice(0, pendingActivity.size - maxTracked)) {
      pendingActivity.delete(id)
    }
  }

  /**
   * Take the pending activity as an immutable batch.
   *
   * `pendingActivity` is emptied HERE, not after the pass succeeds, so events
   * that arrive while the pass is running form the next batch instead of being
   * silently merged into a plan that was already computed. A candidate the pass
   * failed to apply is restored by `requeueActivity`.
   *
   * Called at the moment a pass actually starts, and nowhere else: taking at
   * flush time handed the facts to a pass that might not run for a long time,
   * and the batch map then had to be retained for as long as it waited.
   * @returns {Map<string, {time: number, seq: number, at: number}>} the batch.
   */
  const takeActivityBatch = () => {
    boundPending()
    const batch = new Map(pendingActivity)
    pendingActivity.clear()
    return batch
  }

  /**
   * One coalescing window elapsed.
   *
   * The batch is NOT taken here. `trim`/`boundPending` do run — the timer fires
   * whether or not a pass can start, which is what keeps the retained maps
   * bounded while a pass is blocked — but the facts themselves stay in
   * `pendingActivity` for the pass that actually consumes them.
   */
  const flush = () => {
    timer = undefined
    if (!alive()) return
    trim()
    trimDeferred()
    stats.flushes += 1
    stats.lastFlushAt = new Date().toISOString()
    requestPass()
  }

  /**
   * The single-flight reorder pass.
   *
   * `takeActivityBatch` happens HERE — the moment this pass is the one that
   * will consume the facts — which is also the only moment `batch.size` is an
   * honest number to log.
   *
   * A failing pass costs ordering precision for one round, never the pin set, so
   * it is recorded and swallowed rather than propagated: an unhandled rejection
   * here would take the whole host process down with it.
   */
  const runPass = async () => {
    if (!alive()) return
    running = true
    trailing = false
    const startedAt = Date.now()
    stats.passesStarted += 1
    try {
      const batch = takeActivityBatch()
      // Only this one number leaves the batch with the pass; see the
      // declaration. A refused fact keeps its `at` on the pending map, so
      // nothing ages away by being tracked this way.
      runningOldestAt = oldestArrivalAt(batch.values())
      const takenAt = new Date().toISOString()
      // Recorded only now. Before this line `batch.size` described a pass that
      // had not started, which is what let the log claim a batch the host was
      // never actually asked to reorder. Still before the first `await`.
      //
      // No error guard is wrapped around this, and deliberately so. The only
      // thing here that can throw is the `ctx.get` in `rankedSessions` — the
      // registry read and the sort below it are already guarded internally —
      // and `reorderSessions` opens with the very same lookup. A host that
      // refuses it therefore fails the pass either way, so a guard here would
      // promise a batch survives that in fact cannot be reached. Wrapping it
      // would only relocate `lastError`, and the path it does guard (a passing
      // pass whose diagnostics failed) is not one this code can produce.
      if (alive()) {
        const ranked = rankedSessions()
        void logLine({ at: takenAt, tracked: lastActivity.size, batch: batch.size, top: ranked.slice(0, 5) })
      }
      await reorderSessions(batch)
      stats.passesCompleted += 1
    } catch (error) {
      stats.passesFailed += 1
      stats.lastError = String(error)
      if (alive()) warn(`dsh-session-top: session reorder pass failed: ${String(error)}`)
    } finally {
      stats.lastPassDurationMs = Date.now() - startedAt
      running = false
      // The pass is over: what it applied is consumed and what it refused went
      // back to the pending map, so nothing it held is still waiting.
      runningOldestAt = undefined
    }
    if (!alive()) return
    // Re-arm only when there is genuinely something left: a fact the host
    // refused is waiting to be retried, and whether that happens must not depend
    // on some unrelated session happening to be active later — the debounce
    // window is the backoff, and the retry budget is what stops the loop.
    //
    // `trailing` and `pendingActivity` are read together because they mean the
    // same thing from the runner's side (a pass was asked for) for different
    // reasons (a mid-pass request, or a refused fact). Either way this arms ONE
    // window: `schedule` is a no-op while a timer is already armed, so a burst
    // of trailing requests still produces exactly one follow-up pass.
    if (trailing || pendingActivity.size > 0) schedule()
  }

  /**
   * Ask for a reorder pass without ever queueing more than one.
   *
   * A request made while a pass is running collapses to a single boolean. The
   * facts behind those requests are already in `pendingActivity`, so nothing is
   * lost by not remembering them individually — and the running pass re-arms
   * the window on its way out.
   */
  const requestPass = () => {
    if (!alive()) return
    if (running) {
      trailing = true
      return
    }
    trailing = false
    void runPass()
  }

  const schedule = () => {
    if (!alive()) return
    if (timer !== undefined) return
    timer = setTimeout(flush, debounceMs)
  }

  const onSessionEvent = (session, event) => {
    if (!alive()) return
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
    // Recorded for the NEXT pass only. `seq` is the arrival counter that makes
    // consumption identity checkable; it deliberately takes no part in deciding
    // which session leads an account.
    //
    // A session that was deferred after too many refusals resumes here, with a
    // fresh retry budget: the reason it was refused is usually a transient
    // account race, and the session doing something new is exactly the moment
    // that race is over.
    if (deferredActivity.delete(id)) stats.deferredSessions = Math.max(0, stats.deferredSessions - 1)
    // `at` is when the fact got here, recorded separately from `time` (the
    // event's own clock) because the two answer different questions: `time`
    // orders the batch, `at` ages the backlog.
    pendingActivity.set(id, { time, seq: ++activitySeq, at: Date.now(), attempts: 0 })
    // Held under the ceiling here as well as at take, so a runner blocked on a
    // host write cannot let the pending set grow without bound while it waits.
    boundPending()
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
          // The log worker goes first: a queued record is a fact about a
          // plugin that is about to stop existing, and the backoff timer is a
          // live handle that would otherwise wake the process after teardown
          // and try to write. Neither is cancelled mid-write — an I/O already
          // handed to the kernel is not cancellable, and is allowed to finish.
          if (logBackoffTimer !== undefined) {
            clearTimeout(logBackoffTimer)
            logBackoffTimer = undefined
          }
          // Records the worker never reached are ABANDONED, and counted as
          // dropped so a reader can tell where they went. If the worker is
          // mid-write it keeps its one record and abandons the rest when it
          // comes back, rather than being cut off mid-file.
          if (!logWorking) abandonLogQueue()
          if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
          }
          // The runner's own state goes with it. `pendingActivity` is the last
          // structure this apply would keep growing while an in-flight write is
          // outstanding, and a torn-down plugin holding it is the tail of R03-b:
          // the facts are releasable NOW. `running` is deliberately NOT reset —
          // a pass really is still in flight, and claiming otherwise would make
          // the status route lie about a frame this code cannot cancel.
          trailing = false
          pendingActivity.clear()
          // The in-flight pass can no longer requeue anything, so the facts it
          // is holding are abandoned rather than waiting on anything. Reporting
          // them as a growing backlog would describe work nobody can still do.
          runningOldestAt = undefined
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

    // Report that the plugin is up. NO seeding happens here any more, and that
    // is the visible half of a deliberate change: this used to enumerate every
    // persisted header before the process had served a single event, filling a
    // map that never took part in ordering. The fallback cache is now filled on
    // demand, through resync, and it stays empty until someone asks.
    void (async () => {
      // Every remaining step is a host interaction; none of them may start
      // once this apply has been torn down.
      if (!alive()) return
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined && !warnedRegistryMissing) {
        warnedRegistryMissing = true
        warn('dsh-session-top: no workspaceRegistry on this host; pin diagnostics stay empty')
      } else {
        warnedRegistryMissing = false
      }
      const pinned = registryProjection().pinned.length
      // The summary says where fallback times COME FROM rather than how many
      // there happen to be: a count here would invite reading it as "current
      // activity", which it has never been.
      const summary = `dsh-session-top: active (activity ${activity}, debounce ${debounceMs}ms, ${pinned} pinned, `
        + `fallback times load on resync, state in ${pluginHome()})`
      logger.info?.(summary)
      void logLine({ at: new Date().toISOString(), kind: 'start', summary })
    })()
  }

  // Diagnostics are strictly optional: a host with no web server (headless,
  // acp) simply has no routes and the plugin is otherwise unaffected.
  const registerDiagnosticsRoutes = (webServer) => {
    if (webServer === undefined || typeof webServer.register !== 'function') return false
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
    return true
  }

  if (!registerDiagnosticsRoutes(safeService(ctx, 'webServer'))) {
    // The host publishes `webServer` asynchronously, and a plugin activated by
    // an early bundle row can easily run BEFORE the web server exists — in
    // which case a single apply-time probe loses the diagnostics for the whole
    // process. Retry twice, gently; the first success stops the sequence.
    //
    // Still entirely invisible to a host that has no web server: two timers that
    // resolve nothing and are cleared on dispose, no listener, no log line.
    try {
      ctx.effect(() => {
        let done = false
        const timers = [5000, 15000].map(delay => setTimeout(() => {
          if (done) return
          if (registerDiagnosticsRoutes(safeService(ctx, 'webServer'))) done = true
        }, delay))
        return () => {
          for (const timer of timers) clearTimeout(timer)
        }
      }, 'dsh-session-top: diagnostics route registration retry')
    } catch (error) {
      // A web server that rejects route registration costs diagnostics only.
      warn(`dsh-session-top: diagnostics routes unavailable: ${String(error)}`)
    }
  }
}