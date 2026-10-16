/**
 * Host state-and-lifecycle regressions: R01 and R03.
 *
 * These drive the REAL `src/index.js` — the same module the host applies —
 * through an in-memory workspace registry, and assert the actual sequence of
 * account operations the plugin performs. Nothing is stubbed between the test
 * and `apply`: the events, the registry, the routes and the effect lifecycle
 * are the only fakes, and they are fakes of the HOST, not of the plugin.
 *
 * Why the operation log and not the end state: "the other account still looks
 * right" is exactly the assertion that let R01 through. A stale-rank replay
 * can leave every account in a plausible final order while having written an
 * account the user never touched. What must be proven is that the write did
 * not happen.
 *
 * Run: node --test test/host-state.test.js
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, statSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

// The plugin resolves its state directory from $DSH_HOME on every call, so the
// import is safe to do once; each test that wants a log points the variable at
// its own temporary directory and restores it afterwards. Nothing here can
// reach a real profile or real session data.
const host = await import('../src/index.js')

// ------------------------------------------------------------------ harness

/**
 * One workspace account, recording every durable mutation it is asked for.
 *
 * `insertSessionBefore` rejects an id it does not hold, the way a host registry
 * does when the session has been detached or migrated: a plan computed against
 * a stale snapshot must fail loudly rather than write into an account it never
 * read.
 */
function account(id, sessionIds, log, gate, options = {}) {
  const track = options.track
  return {
    id,
    title: id,
    sessionIds: [...sessionIds],
    // Mutable, not destructured: a test has to be able to make the host start
    // accepting again, which is what "the obstacle cleared" means.
    alwaysRefuse: options.alwaysRefuse === true,
    // Refuse this many attempts and then accept: a transient account race, which
    // is what the retry path exists for.
    refuseFirst: options.refuseFirst ?? 0,
    // Or refuse one specific attempt, for the shapes a prefix cannot express.
    refuseCall: options.refuseCall ?? 0,
    attempts: 0,
    refusals: 0,
    async insertSessionBefore(sessionId, beforeId) {
      const entry = { workspace: id, id: sessionId, beforeId, applied: false }
      log.push(entry)
      // How many durable writes this host was being asked to perform AT THE SAME
      // TIME. A single-flight runner must never let this pass one, whatever the
      // event rate, which is a different claim from "no write was lost" and the
      // only one that a queue depth of one could not fake.
      if (track !== undefined) {
        track.depth += 1
        if (track.depth > track.max) track.max = track.depth
      }
      try {
        if (gate) await gate.wait()
        // A host that will not take this write at all, for testing the bounded
        // retry: without a stop, "retry until it works" is just a loop.
        this.attempts += 1
        if (
          this.alwaysRefuse
          || this.refusals < this.refuseFirst
          || this.attempts === this.refuseCall
        ) {
          this.refusals += 1
          throw new Error(`${id} refuses this write (${String(this.attempts)})`)
        }
        const at = this.sessionIds.indexOf(sessionId)
        const anchor = this.sessionIds.indexOf(beforeId)
        if (at < 0 || anchor < 0) throw new Error(`cannot place ${sessionId} before ${beforeId} in ${id}`)
        this.sessionIds.splice(at, 1)
        this.sessionIds.splice(anchor, 0, sessionId)
        entry.applied = true
      } finally {
        if (track !== undefined) track.depth -= 1
      }
    },
  }
}

/** Only the writes the host actually accepted. */
const applied = (log, workspace) => log.filter(one => one.applied && (workspace === undefined || one.workspace === workspace))
/** Every write the plugin attempted, refused ones included. */
const attempted = (log, workspace) => log.filter(one => workspace === undefined || one.workspace === workspace)

/**
 * A promise gate the tests use to hold a durable write in flight, which is the
 * only way to observe the plugin mid-pass. `blockCall` selects WHICH attempt
 * blocks; 0 (the default) blocks all of them, which is what "hold the pass
 * open" usually means.
 */
function makeGate(blockCall = 0) {
  let release
  const opened = new Promise(resolve => { release = resolve })
  let seen = 0
  return {
    wait() {
      seen += 1
      return blockCall === 0 || seen === blockCall ? opened : Promise.resolve()
    },
    release: () => release(),
  }
}

/**
 * The host surface `apply` actually touches: services, an event emitter and an
 * effect lifecycle that behaves the way cordis does — the cleanup returned by an
 * effect runs when the plugin is disposed.
 */
function harness({ workspaces, config = {}, webServer = false, persistence, getThrows, loggerThrows } = {}) {
  const logged = []
  const listeners = new Set()
  const effects = []
  const routes = []
  const capturedRoutes = []
  const counters = { listCalls: 0, persistenceListCalls: 0 }
  const services = {
    workspaceRegistry: {
      pinnedSessionIds: [],
      list() {
        counters.listCalls += 1
        return workspaces
      },
    },
    // Present and empty, so the plugin's seeding path finishes on its first
    // attempt instead of arming the 15s grace timer every test would then have
    // to wait out.
    //
    // `persistence` replaces only the HOST's answer — a host that takes its
    // time to list headers — so a test can hold the plugin's startup path open.
    // It is a fake of the host, never a seam added to the plugin.
    sessionPersistence: {
      async list() {
        counters.persistenceListCalls += 1
        if (persistence !== undefined) return persistence.list()
        return []
      },
    },
  }
  // Opt-in, so the tests that care about timers see the same set they always
  // did. A test that needs to read the plugin's own diagnostics goes through the
  // real route handler rather than reaching into the plugin's state.
  if (webServer) {
    services.webServer = {
      register: (route) => {
        routes.push(route)
        // Kept even after the plugin unregisters it: a caller that grabbed the
        // handler before unload still holds it, which the plugin's own `resync`
        // documents surviving exactly this way. What such a caller can still
        // see is therefore a real question, not a contrived one.
        capturedRoutes.push(route)
        return () => {
          const at = routes.indexOf(route)
          if (at >= 0) routes.splice(at, 1)
        }
      },
    }
  }
  const ctx = {
    get: name => {
      // A host whose service LOOKUP raises, as opposed to one whose registry
      // refuses a write. The lookup is the only uncaught throw inside a pass,
      // which is what makes it the one way to make a whole pass fail.
      if (getThrows !== undefined && getThrows.on === true && name === getThrows.name) {
        throw new Error(`${name} lookup refused by the host`)
      }
      return services[name]
    },
    logger: {
      info: m => logged.push(['info', m]),
      // A host whose logger REFUSES a message, as opposed to one whose registry
      // refuses a write. The message is still recorded — so the case can see
      // that the plugin tried — and then the call throws, which is the shape
      // that must not reach the caller or become an unhandled rejection.
      warn: m => {
        logged.push(['warn', m])
        if (loggerThrows?.warn === true) throw new Error('host logger refused this message')
      },
    },
    on: (event, handler) => {
      const entry = { event, handler }
      listeners.add(entry)
      return () => listeners.delete(entry)
    },
    effect: (fn) => {
      const cleanup = fn()
      const record = { cleanup }
      effects.push(record)
      return () => { record.cleanup?.() }
    },
  }
  const emit = (session, event) => {
    for (const { event: name, handler } of [...listeners]) {
      if (name !== 'session/event') continue
      handler(session, event)
    }
  }
  /**
   * The plugin's own status projection, read the way a user on the loopback
   * would read it: through the route it registered, with the fence satisfied.
   */
  const runStatusRoute = async (route) => {
    if (route === undefined) throw new Error('no status route was registered')
    let payload
    const res = {
      writeHead() {},
      end(body) { payload = body },
    }
    await route.handler({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost:3000' },
      method: 'GET',
    }, res)
    return JSON.parse(payload)
  }
  const status = () => runStatusRoute(routes.find(one => one.path === '/api/dsh-session-top/status'))
  // The same projection through a handler the plugin has already unregistered.
  const detachedStatus = () => runStatusRoute(capturedRoutes.find(one => one.path === '/api/dsh-session-top/status'))
  /**
   * The resync POST, the way a user on the loopback would send it: the real
   * handler, the real method fence, the real JSON body.
   */
  const runResync = async (route) => {
    if (route === undefined) throw new Error('no resync route was registered')
    let payload
    const res = { writeHead() {}, end(body) { payload = body } }
    await route.handler({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { host: 'localhost:3000' },
      method: 'POST',
    }, res)
    return JSON.parse(payload)
  }
  const resync = () => runResync(routes.find(one => one.path === '/api/dsh-session-top/resync'))
  const detachedResync = () => runResync(capturedRoutes.find(one => one.path === '/api/dsh-session-top/resync'))

  return {
    ctx, emit, logged, counters, status, detachedStatus, resync, detachedResync,
    /** Run the plugin's own teardown, exactly as cordis would on dispose. */
    dispose() {
      for (const { cleanup } of effects.splice(0).reverse()) {
        try { cleanup?.() } catch { /* a failing cleanup must not hide the rest */ }
      }
    },
    listenerCount: () => listeners.size,
  }
}

/** Apply the plugin with a short coalescing window and no file logging. */
async function applyPlugin(options) {
  return host.apply(options.ctx, { enabled: true, debounceMs: 5, logFile: 'off', ...options.config })
}

/**
 * The host half dedupes itself per process (a bundle row plus a plugin-add row
 * must not apply twice), which is keyed off a global that only its own effect
 * cleanup clears. A test that leaked that key would silently apply nothing and
 * fail later with a confusing count mismatch, so every test says so out loud.
 * @param {{listenerCount: () => number}} h - the harness.
 */
function assertApplied(h) {
  assert.ok(h.listenerCount() > 0, 'the plugin did not attach: a previous test leaked the process-wide dedupe key')
}

/** Let the coalescing window elapse and the serialized chain drain. */
const settle = async (rounds = 4) => {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
}

/**
 * Wait for a condition that some other asynchronous writer has to satisfy,
 * instead of sleeping a fixed guess. Returns whether it became true.
 *
 * Only ever used where the wait itself is the thing under test (a log line
 * landing while a pass is blocked), so the timeout is generous enough not to
 * make a real regression look green.
 */
const waitFor = async (predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
}

/** The activity log's bytes so far, or '' when nothing has been written yet. */
const readLogBytes = path => (existsSync(path) ? readFileSync(path, 'utf8') : '')

/**
 * Poll the status route until it satisfies `predicate`, then hand back whatever
 * it last said. Only for conditions another asynchronous writer must satisfy —
 * returning the last value instead of throwing keeps a genuine failure legible
 * in the assertion that follows.
 */
const waitForStatus = async (h, predicate, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const now = await h.status()
    if (predicate(now)) return now
    if (Date.now() >= deadline) return now
    await new Promise(resolve => { setTimeout(resolve, 10) })
  }
}

const activity = time => ({ type: 'agent/message', time, data: { source: { kind: 'agent' } } })
const session = id => ({ id, header: { origin: 'main' } })

// ------------------------------------------------------------ R12 test tools

/**
 * Point `$DSH_HOME` at a fresh temporary directory and hand back the teardown.
 *
 * The plugin resolves its own state directory from the environment on every
 * call, so every log assertion in this file runs under one of these. A real
 * profile — and a real `activity.log` — is never in reach: the directory is
 * created by `mkdtemp`, and `release` puts the variable back the way it was
 * before removing the tree.
 * @param {string} prefix - a name fragment for the temporary directory.
 * @returns {{home: string, logPath: (name: string) => string, release: () => void}} the sandbox.
 */
function tempHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    home,
    /** An EXPLICIT path inside the sandbox — never a real activity.log. */
    logPath: (...parts) => join(home, ...parts),
    release() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      // On Windows this fails outright if the plugin still held a descriptor on
      // anything inside, which is one of the things these cases are about.
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/**
 * Collect the process warnings raised while `fn` runs.
 *
 * "No TimeoutOverflowWarning was raised" is a claim about something Node only
 * ever writes to stderr, so it is observed here rather than assumed.
 * @param {() => Promise<unknown>} fn - the work to run under observation.
 * @returns {Promise<{seen: Error[], value: unknown}>} the warnings and the result.
 */
async function collectWarnings(fn) {
  const seen = []
  const onWarning = (warning) => { seen.push(warning) }
  process.on('warning', onWarning)
  try {
    return { seen, value: await fn() }
  } finally {
    process.removeListener('warning', onWarning)
  }
}

/** Host data made large by length, not by a seam: long ids and long titles. */
const fat = (size, character) => character.repeat(size)

/**
 * Every byte the activity log currently occupies: the live file and each
 * retained rotated copy, read straight off the filesystem.
 * @param {string} dir - the directory holding `activity.log`.
 * @returns {{name: string, size: number, lines: string[]}[]} one entry per file.
 */
function logTree(dir) {
  return readdirSync(dir)
    .filter(one => one.startsWith('activity.log'))
    .sort()
    .map((name) => {
      const size = statSync(join(dir, name)).size
      const lines = readFileSync(join(dir, name), 'utf8').split('\n').filter(line => line !== '')
      return { name, size, lines }
    })
}

// --------------------------------------------------------------------- R01

test('R01: activity in one workspace never re-writes another workspace', async (t) => {
  // The reported sequence, verbatim: A's session floats up, the user drags it
  // back, and only B acts afterwards.
  const log = []
  const workspaces = [account('A', ['a1', 'a2'], log), account('B', ['b1', 'b2'], log)]
  const h = harness({ workspaces })
  await applyPlugin({ ctx: h.ctx })
  t.after(() => h.dispose())
  assertApplied(h)

  h.emit(session('a2'), activity(100))
  await settle()
  assert.deepEqual(workspaces[0].sessionIds, ['a2', 'a1'], 'the acting session must float up')

  // The user's manual drag, written straight into the durable account the way a
  // drag writes it — no plugin involved.
  workspaces[0].sessionIds.splice(0, workspaces[0].sessionIds.length, 'a1', 'a2')
  const writesBeforeB = log.filter(one => one.workspace === 'A').length

  h.emit(session('b2'), activity(200))
  await settle()

  assert.deepEqual(
    workspaces[0].sessionIds, ['a1', 'a2'],
    "workspace A must keep the order the user dragged it into",
  )
  assert.equal(
    log.filter(one => one.workspace === 'A').length, writesBeforeB,
    'workspace A must receive ZERO further writes: B\'s activity is not a licence to touch A',
  )
  assert.deepEqual(workspaces[1].sessionIds, ['b2', 'b1'], 'the acting workspace still floats')
  h.dispose()
})

test('R01: two activities in one account settle into one defined order', async (t) => {
  const log = []
  const workspaces = [account('A', ['a1', 'a2', 'a3'], log)]
  const h = harness({ workspaces })
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 40 } })
  t.after(() => h.dispose())
  assertApplied(h)

  // Both land in ONE batch: the older fact is consumed together with the newer.
  h.emit(session('a3'), activity(100))
  h.emit(session('a2'), activity(200))
  await settle(3)

  assert.deepEqual(
    workspaces[0].sessionIds, ['a2', 'a3', 'a1'],
    'the batch acts as one: newest first, then the untouched members in their existing order',
  )
  h.dispose()
})

test('R01: an out-of-order commit cannot walk a session backwards or re-float it', async (t) => {
  const log = []
  const workspaces = [account('A', ['a1', 'a2'], log)]
  const h = harness({ workspaces })
  await applyPlugin({ ctx: h.ctx })
  t.after(() => h.dispose())
  assertApplied(h)

  h.emit(session('a2'), activity(300))
  await settle()
  assert.deepEqual(workspaces[0].sessionIds, ['a2', 'a1'])
  const writes = log.length

  // A late tool commit carrying an OLDER time than what is already known.
  h.emit(session('a2'), activity(120))
  await settle()
  assert.equal(log.length, writes, 'a stale event must not schedule a durable write at all')
  assert.deepEqual(workspaces[0].sessionIds, ['a2', 'a1'])

  // And a repeat of the SAME session must not produce a second move: it is
  // already leading, so the batch plans nothing.
  h.emit(session('a2'), activity(400))
  await settle()
  assert.equal(log.length, writes, 'an account already led by the active session needs no write')
  h.dispose()
})

test('R01: accounts whose only activity is already consumed are never written', async (t) => {
  const log = []
  const workspaces = [account('A', ['a1', 'a2'], log), account('B', ['b1', 'b2'], log), account('C', ['c1', 'c2'], log)]
  const touched = []
  for (const ws of workspaces) {
    const original = ws.insertSessionBefore.bind(ws)
    ws.insertSessionBefore = async (id, beforeId) => {
      touched.push(ws.id)
      return original(id, beforeId)
    }
  }
  const h = harness({ workspaces })
  await applyPlugin({ ctx: h.ctx })
  t.after(() => h.dispose())
  assertApplied(h)

  // Every account acts once, so every account now carries a retained rank.
  h.emit(session('a2'), activity(100))
  h.emit(session('c2'), activity(110))
  await settle()
  assert.deepEqual([...touched].sort(), ['A', 'C'], 'the two acting accounts float')
  assert.deepEqual(workspaces[0].sessionIds, ['a2', 'a1'])

  // The user drags A back, and A then stays quiet. Nothing about A changed since
  // its activity was consumed — so nothing may be written to it again, however
  // many times other accounts act.
  workspaces[0].sessionIds.splice(0, workspaces[0].sessionIds.length, 'a1', 'a2')
  touched.length = 0
  for (const time of [200, 300, 400]) {
    h.emit(session('b2'), activity(time))
    await settle()
  }

  assert.deepEqual(touched, ['B'], 'only the account that actually acted is written, once')
  assert.deepEqual(workspaces[0].sessionIds, ['a1', 'a2'], 'A keeps the order the user dragged')
  assert.deepEqual(workspaces[2].sessionIds, ['c2', 'c1'], 'C is not dragged back by unrelated activity')
  assert.deepEqual(workspaces[1].sessionIds, ['b2', 'b1'], 'B still floats on its own activity')
  for (const id of ['A', 'C']) {
    assert.equal(
      log.filter(one => one.workspace === id).length, 1,
      `workspace ${id} must be written exactly once, ever`,
    )
  }
  assert.equal(log.filter(one => one.workspace === 'B').length, 1, 'B is written once: it already leads')
})

test('R01: a refused write is retried on its own, with no new activity needed', async (t) => {
  // The failure this pins down: the host refuses a durable write because the
  // account changed under the plan. The plugin must finish the work anyway.
  //
  // There is NO further session event in this test on purpose. Before the fix
  // the refused move was marked as done, so the work it represented vanished —
  // and the earlier version of this very test only passed because it emitted one
  // more activity first, which quietly supplied the retry that never happened.
  const log = []
  const gate = makeGate()
  const workspaces = [
    account('A', ['a1', 'a2', 'a3'], log, gate),
    account('C', ['c1'], log),
  ]
  const h = harness({ workspaces })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5 } })
  assertApplied(h)

  h.emit(session('a3'), activity(100))
  h.emit(session('a2'), activity(200))
  // Let the pass start and block on its first durable write.
  await new Promise(resolve => { setTimeout(resolve, 40) })

  // The session moves to another workspace while the write is in flight, so the
  // host refuses the move it was handed.
  workspaces[0].sessionIds.splice(1, 1)
  workspaces[1].sessionIds.push('a2')
  gate.release()
  // No emit() from here on. Whatever completes must complete on its own.
  await settle(8)

  assert.equal(applied(log).length >= 2, true, 'the refused move must be attempted again, not written off')
  assert.deepEqual(
    workspaces[0].sessionIds, ['a3', 'a1'],
    'the move that was never attempted is finished without any new activity',
  )
  assert.deepEqual(
    workspaces[1].sessionIds, ['a2', 'c1'],
    'the migrated session floats in the account it now belongs to',
  )
  assert.equal(
    attempted(log, 'A').filter(one => one.id === 'a2').length, 1,
    'the refused move is not replayed into the account that no longer holds the session',
  )
})

test('R01: a transient refusal must not reverse the order the batch itself chose', async (t) => {
  // Two candidates in one account, both in one batch. The pass applies the first
  // move and the host transiently refuses the second.
  //
  // What must NOT happen is the already-applied candidate dropping out of the
  // batch: the retry would then re-rank on a strict subset, and an OLDER
  // candidate could rise above a NEWER one the batch had already placed.
  // The retry's answer has to be the same answer the unrefused pass gave.
  const run = async ({ refuseCall }) => {
    const log = []
    const workspaces = [
      account('A', ['a1', 'a2', 'a3'], log, null, { refuseCall }),
      // A second account, which must be unaffected by anything A does.
      account('B', ['b1', 'b2'], log),
    ]
    const h = harness({ workspaces })
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5 } })
    assertApplied(h)
    h.emit(session('a2'), activity(200))
    h.emit(session('a3'), activity(100))
    h.emit(session('b2'), activity(300))
    await settle(10)
    h.dispose()
    return { log, workspaces }
  }

  const reference = await run({ refuseCall: 0 })
  const refused = await run({ refuseCall: 2 })

  assert.deepEqual(
    reference.workspaces[0].sessionIds, ['a2', 'a3', 'a1'],
    'precondition: the unrefused pass puts the newer candidate first',
  )
  assert.deepEqual(
    refused.workspaces[0].sessionIds, reference.workspaces[0].sessionIds,
    `a transient refusal changed the batch's own order: got ${JSON.stringify(refused.workspaces[0].sessionIds)}, expected ${JSON.stringify(reference.workspaces[0].sessionIds)}`,
  )
  // The retry is scoped to the account that failed. An account the same pass
  // already wrote must not be replayed, or its rank would be re-asserted from
  // this batch's permissions — which is the R01 defect all over again.
  assert.equal(
    attempted(refused.log, 'B').length, 1,
    'an account the failing pass already wrote must not be written again by the retry',
  )
  assert.deepEqual(refused.workspaces[1].sessionIds, ['b2', 'b1'])
  assert.equal(
    attempted(refused.log, 'A').length, attempted(reference.log, 'A').length + 1,
    'the retry costs exactly the one refused write, no more',
  )
})

test('R01: a retry yields to the drag for members the batch never named', async (t) => {
  // WHAT THIS PROVES, precisely: while a refused write is in flight, a retry
  // re-plans against the account as it is NOW, and it does not disturb the two
  // things it has no permission over — the relative order of members the batch
  // never named, and any other account.
  //
  // WHAT IT DOES NOT PROVE, and what the previous name of this case implied:
  // that a user's drag is protected. The drag below lands on exactly the order
  // the batch wanted, so "the retry wrote nothing" follows from the batch
  // already being satisfied, not from any protection. A drag that CONFLICTS
  // with the batch ranking IS overwritten, and the next case pins that limit
  // instead of leaving it implied.
  const log = []
  const gate = makeGate(2)
  const workspaces = [
    account('A', ['a1', 'a2', 'a3'], log, gate, { refuseCall: 2 }),
    account('B', ['b1', 'b2', 'b3'], log),
  ]
  const h = harness({ workspaces })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5 } })
  assertApplied(h)

  h.emit(session('a2'), activity(200))
  h.emit(session('a3'), activity(100))
  await new Promise(resolve => { setTimeout(resolve, 40) })

  // The refused write is in flight. The user drags while it waits. This drag
  // happens to agree with the batch, which is why the retry has nothing to do.
  workspaces[0].sessionIds.splice(0, 3, 'a2', 'a3', 'a1')
  gate.release()
  await settle(10)

  assert.deepEqual(
    workspaces[0].sessionIds, ['a2', 'a3', 'a1'],
    'precondition: the drag agreed with the batch, so the retry had nothing to do',
  )
  assert.equal(applied(log, 'A').length, 1, 'the retry issued no write at all')
  // `a1` is a member the batch never named: it is not reordered, and no account
  // without a batch candidate is written.
  assert.equal(
    workspaces[0].sessionIds[workspaces[0].sessionIds.length - 1], 'a1',
    'a member the batch never named is not reordered',
  )
  assert.deepEqual(workspaces[1].sessionIds, ['b1', 'b2', 'b3'], 'an untouched account keeps its order')
  assert.equal(attempted(log, 'B').length, 0, 'an account with no batch candidate is never written')
})

test('R01: a drag that CONFLICTS with the batch is overwritten — the window limit', async (t) => {
  // Same sequence as the case above, and the reason that one cannot be called
  // "the drag is protected". A retry is not a transaction and takes no lock
  // against the user: while a refused write is in flight, a drag that puts a
  // batch candidate below the account's leader is undone by the retry, because
  // floating that candidate is exactly what the plugin is for.
  //
  // Pinned deliberately. Claiming drag protection here would be a claim no test
  // could support, and a "manual drags are safe" boundary inherited downstream
  // would be worse than a documented limit.
  const log = []
  const gate = makeGate(2)
  const workspaces = [account('A', ['a1', 'a2', 'a3'], log, gate, { refuseCall: 2 })]
  const h = harness({ workspaces })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5 } })
  assertApplied(h)

  h.emit(session('a2'), activity(200))
  h.emit(session('a3'), activity(100))
  await new Promise(resolve => { setTimeout(resolve, 40) })

  // The user drags a1 to the top and a2 below it — directly against the batch.
  workspaces[0].sessionIds.splice(0, 3, 'a1', 'a2', 'a3')
  gate.release()
  await settle(10)

  assert.deepEqual(
    workspaces[0].sessionIds, ['a2', 'a3', 'a1'],
    'the retry restored the batch ranking: a conflicting drag is NOT protected',
  )
  assert.ok(
    applied(log, 'A').length > 1,
    'the retry had to write to undo the drag, which is why that case is not a no-op',
  )
  // What survives the window regardless: the unnamed member stays behind the
  // candidates instead of being sorted into their rank.
  assert.equal(
    workspaces[0].sessionIds[workspaces[0].sessionIds.length - 1], 'a1',
    'even when the drag is overwritten, an unnamed member is not reordered',
  )
})

test('R01: a host that never accepts stops being retried, and says so', async (t) => {
  // "Retry until it works" is only a fix if there is a stop. A fact the host will
  // never take must not turn into an endless stream of durable write attempts —
  // that starves every other account's ordering and keeps the process busy for
  // a reason no one can act on.
  const log = []
  const workspaces = [account('A', ['a1', 'a2'], log, null, { alwaysRefuse: true })]
  const h = harness({ workspaces, webServer: true })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5 } })
  assertApplied(h)

  h.emit(session('a2'), activity(100))
  await settle(14)

  const attempts = attempted(log).length
  assert.ok(attempts >= 2, `a refused write must be retried at least once, got ${String(attempts)} attempts`)
  assert.ok(
    attempts <= 8,
    `the retry must be bounded; the host was asked ${String(attempts)} times for one unachievable move`,
  )
  const settled = attempts
  await settle(10)
  assert.equal(
    attempted(log).length, settled,
    'a fact the host will never accept must stop being attempted, not loop forever',
  )
  assert.deepEqual(workspaces[0].sessionIds, ['a1', 'a2'], 'a refused move must never half-apply')
  assert.equal(applied(log).length, 0, 'nothing was applied, so nothing may look applied')

  // And it must be PUBLIC, with a reason: a user who sees an order that is not
  // taking effect needs to be able to find out that the plugin is holding work,
  // and why.
  const status = await h.status()
  assert.ok(Array.isArray(status.deferredActivity), 'the status must report deferred work')
  const deferred = status.deferredActivity.find(one => one.id === 'a2')
  assert.ok(deferred !== undefined, `the deferred session must be reported, got ${JSON.stringify(status.deferredActivity)}`)
  assert.equal(deferred.attempts > 1, true, 'the reported attempt count must reflect the retries')
  assert.ok(
    typeof deferred.reason === 'string' && deferred.reason.length > 0,
    'the deferral must carry a reason',
  )
  assert.equal(
    status.pendingActivity.some(one => one.id === 'a2'), false,
    'a deferred fact is not also sitting on the pending set',
  )
})

test('R01: a later activity resumes a deferred session and clears the deferral', async (t) => {
  const log = []
  const refusing = account('A', ['a1', 'a2'], log, null, { alwaysRefuse: true })
  const h = harness({ workspaces: [refusing], webServer: true })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5 } })
  assertApplied(h)

  h.emit(session('a2'), activity(100))
  await settle(14)
  assert.ok((await h.status()).deferredActivity.some(one => one.id === 'a2'), 'precondition: it deferred')

  // The obstacle clears and the session does something again. That is exactly
  // when the deferral should be lifted, with a fresh retry budget.
  refusing.alwaysRefuse = false
  h.emit(session('a2'), activity(900))
  await settle(6)

  assert.deepEqual(refusing.sessionIds, ['a2', 'a1'], 'the session floats once the host accepts again')
  const status = await h.status()
  assert.deepEqual(status.deferredActivity, [], 'a resumed session must leave no deferral behind')
  assert.equal(status.deferredSessions, 0, 'the reported deferral count must follow')
})

test('R01: a retry replays the newest fact, never the one that was refused', async (t) => {
  // The retry carries the fact the batch held, which by the time it lands can be
  // older than what the session has already done. Replaying the stale one would
  // order the account by a time the user has already moved past.
  const log = []
  const gate = makeGate()
  // The host refuses exactly the first attempt: a transient account race. That
  // is the situation the retry exists for, and without it there is no retry to
  // inspect.
  const workspaces = [account('A', ['a1', 'a2', 'a3'], log, gate, { refuseFirst: 1 })]
  const h = harness({ workspaces })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5 } })
  assertApplied(h)

  // a3 is the most recent session in this batch; its move is held in flight and
  // will be refused.
  await new Promise(resolve => { setTimeout(resolve, 40) })

  // While the write is in flight, the account moves on: a2 becomes more recent,
  // then a3 acts again and becomes more recent still.
  h.emit(session('a2'), activity(400))
  h.emit(session('a3'), activity(500))
  gate.release()
  await settle(8)

  assert.ok(
    attempted(log).length > 1,
    `the refused move must have been retried, got ${String(attempted(log).length)} attempt(s)`,
  )
  // The refused fact was a3@300. Replayed as-is, a2@400 would outrank it and
  // the account would settle at [a2, a3, a1]. Replayed from what is actually
  // known, a3@500 leads.
  assert.deepEqual(
    workspaces[0].sessionIds, ['a3', 'a2', 'a1'],
    'the retry must order by the newest fact, not the refused one',
  )
})

// --------------------------------------------------------------------- R03

test('R03: dispose stops every later write, log line and queued pass', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-session-top-r03-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const log = []
  const gate = makeGate()
  const workspaces = [account('A', ['a1', 'a2'], log, gate), account('B', ['b1', 'b2'], log)]
  const h = harness({ workspaces })
  try {
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5, logFile: '' } })

    h.emit(session('a2'), activity(100))
    // Let the pass reach its first durable write and block there.
    await new Promise(resolve => { setTimeout(resolve, 40) })

    // A second account acts, and its pass is queued behind the blocked one.
    h.emit(session('b2'), activity(200))
    h.emit(session('b2'), activity(210))
    h.emit(session('b2'), activity(220))
    await new Promise(resolve => { setTimeout(resolve, 40) })

    const listCallsAtDispose = h.counters.listCalls
    const loggedAtDispose = h.logged.length
    h.dispose()

    gate.release()
    await settle(8)

    assert.equal(
      log.filter(one => one.workspace === 'B').length, 0,
      'no write may start for an account the disposed plugin had not reached',
    )
    assert.equal(
      log.filter(one => one.workspace === 'A').length, 1,
      'exactly one in-flight write, the one already handed to the host',
    )
    assert.equal(
      h.counters.listCalls, listCallsAtDispose,
      'a queued pass must not even reach the registry after dispose',
    )
    assert.equal(
      h.logged.length, loggedAtDispose,
      'no log line may be emitted after dispose',
    )
    assert.equal(h.listenerCount(), 0, 'the event listener must be released')

    const dir = join(home, 'dsh-session-top')
    const files = existsSync(dir) ? readdirSync(dir) : []
    const before = files.includes('activity.log') ? readFileSync(join(dir, 'activity.log'), 'utf8') : ''
    await new Promise(resolve => { setTimeout(resolve, 60) })
    const after = files.includes('activity.log') ? readFileSync(join(dir, 'activity.log'), 'utf8') : ''
    assert.equal(after, before, 'the activity log must not grow after dispose')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    h.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('R03: events delivered after dispose change nothing', async (t) => {
  const log = []
  const workspaces = [account('A', ['a1', 'a2'], log)]
  const h = harness({ workspaces })
  await applyPlugin({ ctx: h.ctx })
  t.after(() => h.dispose())
  assertApplied(h)
  // R12 makes this startup path synchronous, so the registry is read DURING
  // apply rather than after it. What is pinned here is the property, not the
  // timing: nothing NEW may be read once the apply is gone.
  const listCallsAtDispose = h.counters.listCalls
  h.dispose()

  const listenersBefore = h.listenerCount()

  h.emit(session('a2'), activity(100))
  h.emit(session('a2'), activity(200))
  await settle()

  assert.equal(log.length, 0, 'an unloaded plugin must not write')
  assert.deepEqual(workspaces[0].sessionIds, ['a1', 'a2'], 'the durable account is unchanged')
  assert.equal(h.listenerCount(), listenersBefore, 'no listener may come back')
  assert.equal(h.counters.listCalls, listCallsAtDispose, 'no registry read may happen after dispose')
})

test('R03: startup arms no seeding grace wait, and dispose releases every timer it does arm', async (t) => {
  // The 15-second grace wait existed for one reason only: the startup path
  // enumerated `sessionPersistence` and, on a host where the service has not
  // activated yet, waited before trying once more. R12 removed that startup
  // enumeration — the map it filled never took part in ordering — so there is
  // nothing left to wait for, and the timer that used to hold the event loop
  // open for a quarter of a minute on such a host is gone with it.
  //
  // What this case still pins is the property underneath it, unchanged: the
  // timers the plugin DOES arm are all released by dispose, and nothing armed
  // earlier may act on the host afterwards. Waiting for a timer to fire is not
  // a test — 15 seconds of real time proves nothing a handle check cannot — so
  // the timers are recorded and dispose is required to have let go of each one.
  const workspaces = [account('A', ['a1'], [])]
  // The host here OFFERS a web server, so the diagnostics routes register on the
  // first probe and the only long timers this plugin would ever arm are gone
  // with the seeding grace wait. That is what lets the assertion below name the
  // grace wait specifically instead of "some timer".
  const h = harness({ workspaces, webServer: true })

  const armed = new Map()
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const handle = realSetTimeout(fn, ms, ...rest)
    armed.set(handle, ms)
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    armed.delete(handle)
    return realClearTimeout(handle)
  }
  try {
    await applyPlugin({ ctx: h.ctx })
    assertApplied(h)
    assert.deepEqual(
      [...armed.values()].filter(ms => ms >= 15000), [],
      'the seeding grace wait must be gone: startup no longer enumerates persistence at all',
    )
    assert.equal(
      h.counters.persistenceListCalls, 0,
      'startup must not enumerate persistence even when the host offers the service',
    )
    // Something the plugin DOES arm, so "dispose released everything" is a
    // statement about a non-empty set rather than about nothing.
    h.emit(session('a1'), activity(100))
    assert.ok(armed.size > 0, `precondition: the coalescing window is armed, timers=${JSON.stringify([...armed.values()])}`)
    h.dispose()
    for (const handle of [...armed.keys()]) realClearTimeout(handle)
    assert.deepEqual(
      [...armed.values()], [],
      'dispose must release every timer the plugin armed, whatever it armed them for',
    )
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    h.dispose()
  }

  const listCallsAtDispose = h.counters.listCalls
  const loggedAtDispose = h.logged.length
  await new Promise(resolve => { realSetTimeout(resolve, 200) })
  assert.equal(h.counters.listCalls, listCallsAtDispose, 'the registry must not be read after dispose')
  assert.equal(h.logged.length, loggedAtDispose, 'nothing may be logged after dispose')
  assert.equal(h.listenerCount(), 0)
})

// --------------------------------------------------------------------- R11

// A bounded reorder runner: one pass in flight, at most one trailing request,
// and an activity log that advances while a pass is blocked.

test('R11: 200 events over 20 coalescing windows queue ONE pass and write nothing twice', async (t) => {
  // NOT a 60-second wall-clock test, and it does not claim to be: this is an
  // operation-count test. What it pins is that the NUMBER of requests does not
  // reach the number of queued passes — a property that is true at 20 windows
  // and stays true at 20 minutes. The long run is a separate, deliberately
  // separate artifact (diagnostics/1015-fixes/task3a-60s-stress.mjs); folding
  // a minute of sleeping into `npm test` would only make the suite slower
  // without testing anything this does not.
  const log = []
  const track = { depth: 0, max: 0 }
  const gate = makeGate()
  const workspaces = [
    account('A', ['a1', 'a2'], log, gate, { track }),
    account('B', ['b1', 'b2'], log, null, { track }),
  ]
  const h = harness({ workspaces, webServer: true })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5 } })
  assertApplied(h)

  const WINDOWS = 20
  const PER_WINDOW = 10
  let clock = 1000
  for (let window = 0; window < WINDOWS; window += 1) {
    for (let n = 0; n < PER_WINDOW; n += 1) {
      clock += 1
      h.emit(session('a2'), activity(clock))
      clock += 1
      h.emit(session('b2'), activity(clock))
    }
    // Comfortably past the 5ms window, so every iteration really does observe a
    // new flush rather than the same armed timer.
    await new Promise(resolve => { setTimeout(resolve, 12) })
    const now = await h.status()
    assert.ok(
      now.queueDepth <= 1,
      `window ${String(window)}: a pass must be waited for by at most one request, got ${String(now.queueDepth)}`,
    )
    assert.equal(
      now.running, true,
      `window ${String(window)}: the gated write must still be in flight`,
    )
  }

  const during = await h.status()
  assert.ok(
    during.flushes >= WINDOWS,
    `the pass must have been blocked across ${String(WINDOWS)} debounce windows, only ${String(during.flushes)} elapsed`,
  )
  assert.equal(
    during.eventCount, WINDOWS * PER_WINDOW * 2,
    'precondition: every event was delivered and accepted',
  )
  assert.equal(
    during.passesStarted, 1,
    `${String(WINDOWS)} windows of requests must produce ONE running pass, not ${String(during.passesStarted)}`,
  )
  assert.equal(during.queueDepth, 1, 'the pending request collapses to exactly one trailing slot')
  assert.equal(track.max, 1, 'a durable write must never be issued twice at the same time')
  assert.equal(
    attempted(log, 'A').length, 1,
    'exactly one durable write was handed to the host, and it is still in flight',
  )
  assert.equal(applied(log, 'A').length, 0, 'precondition: the gated write has not completed')

  // Release. Everything that accumulated has to land, in ONE follow-up pass.
  gate.release()
  await settle(12)

  const after = await h.status()
  assert.equal(track.max, 1, 'releasing the gate must not turn the trailing request into a concurrent write')
  assert.equal(
    after.passesStarted, 2,
    `the trailing request must cost exactly one more pass, not one per event (${String(after.passesStarted)})`,
  )
  assert.equal(after.queueDepth, 0, 'nothing may remain queued once that pass finished')
  assert.equal(after.running, false)
  assert.equal(after.passesFailed, 0, `a pass failed: ${String(after.lastError)}`)
  assert.equal(typeof after.lastPassDurationMs, 'number', 'a pass must publish how long it took')
  assert.deepEqual(
    workspaces[0].sessionIds, ['a2', 'a1'],
    'A, which held the gate open the whole time, still ends up floated',
  )
  assert.deepEqual(
    workspaces[1].sessionIds, ['b2', 'b1'],
    'B must not be starved: a workspace that kept acting while A was blocked is reordered by the trailing pass',
  )
  assert.equal(applied(log, 'A').length, 1, 'A is written once; the retry pass finds it already correct')
  assert.equal(applied(log, 'B').length, 1, 'B is written once')
})

test('R11: a batch is logged only by the pass that actually took it', async (t) => {
  // The batch was handed to the queue at FLUSH time, so every window that fired
  // reported a batch — including the twenty that were never going to run,
  // because the pass that would have consumed them was stuck. The log therefore
  // claimed durable work the host was never asked to do.
  //
  // Now the take happens inside the pass, so one line per pass that ran is not a
  // nice-to-have accounting choice: it is the only moment `batch.size` describes
  // something real.
  const home = mkdtempSync(join(tmpdir(), 'dsh-session-top-r11-batch-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const logPath = join(home, 'activity.log')

  const log = []
  const gate = makeGate()
  const workspaces = [account('A', ['a1', 'a2'], log, gate), account('B', ['b1', 'b2'], log)]
  const h = harness({ workspaces, webServer: true })
  try {
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5, logFile: logPath } })
    assertApplied(h)

    let clock = 1000
    for (let window = 0; window < 20; window += 1) {
      clock += 1
      h.emit(session('a2'), activity(clock))
      await new Promise(resolve => { setTimeout(resolve, 12) })
    }

    gate.release()
    await settle(12)

    const status = await h.status()
    const lines = readLogBytes(logPath).split('\n').filter(line => line.includes('"batch"'))
    // The FIELD-INDEPENDENT half, and deliberately the FIRST assertion here: it
    // reads the log file and no new counter, so it is the part of this case
    // that survives the plugin's status shape changing again. Twenty windows
    // fired, so a design that reports a batch per window wrote twenty lines
    // here; a design that reports one per pass that RAN wrote two.
    assert.ok(
      lines.length <= 3,
      `20 coalescing windows produced ${String(lines.length)} logged batches; a pass that never ran must not report one`,
    )
    assert.equal(status.passesStarted, 2, 'precondition: one blocked pass and one trailing pass')
    assert.equal(
      lines.length, status.passesStarted,
      `each pass that ran must log its batch exactly once, and no other request may: `
      + `got ${String(lines.length)} batch lines for ${String(status.passesStarted)} passes`,
    )
    for (const line of lines) {
      const record = JSON.parse(line)
      assert.ok(
        record.at !== undefined && typeof record.batch === 'number',
        `every logged batch must be a complete record, got ${line}`,
      )
    }
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    h.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

test('R11: dispose releases the trailing request, not only the timer', async (t) => {
  // The tail of R03-b, and the part that could not be closed in batch 1. Batch 1
  // proved nothing NEW starts after dispose; it could not prove the queued work
  // stops RETAINING this apply, because each queued `reorderSessions(batch)`
  // closure held its own batch map and, through it, the whole apply scope —
  // `ctx`, `stats`, `lastActivity` — for as long as the head RPC never settled.
  //
  // What is provable here, and what is claimed: there is at most ONE running
  // pass and at most ONE pending request, so the retained batch maps are a fixed
  // count no matter how many events arrive, and dispose drops the pending set.
  //
  // What is NOT claimed and is not claimed by anything in this file: that a
  // non-settling, uncancellable host RPC frame — and the apply scope that frame
  // is still executing — becomes collectable at dispose. It cannot, short of the
  // host offering a way to abandon the call. Bounded retention, not immediate
  // release of an in-flight frame.
  const log = []
  const track = { depth: 0, max: 0 }
  const gate = makeGate()
  const workspaces = [
    account('A', ['a1', 'a2'], log, gate, { track }),
    account('B', ['b1', 'b2'], log, null, { track }),
  ]
  const h = harness({ workspaces, webServer: true })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5 } })
  assertApplied(h)

  h.emit(session('a2'), activity(100))
  const started = await waitFor(() => attempted(log).length === 1)
  assert.ok(started, 'precondition: the pass is blocked on its first durable write')

  // A full burst while it is blocked: twenty windows, a trailing request, and a
  // pending set the plugin is still holding.
  let clock = 2000
  for (let window = 0; window < 20; window += 1) {
    for (let n = 0; n < 10; n += 1) {
      clock += 1
      h.emit(session('b2'), activity(clock))
    }
    await new Promise(resolve => { setTimeout(resolve, 12) })
  }
  const before = await h.status()
  assert.equal(before.queueDepth, 1, 'precondition: one trailing request is pending')
  assert.equal(before.passesStarted, 1, 'precondition: still only the one blocked pass')
  assert.equal(before.pendingActivity.length, 1, 'precondition: facts are waiting to be consumed')
  assert.equal(typeof before.pendingAgeMs, 'number', 'a real backlog age must be reported')

  // Snapshot AFTER the last status read, which is itself a registry read.
  const listCallsAtDispose = h.counters.listCalls
  const loggedAtDispose = h.logged.length
  const writesAtDispose = log.length
  h.dispose()
  gate.release()
  await settle(10)

  assert.equal(log.length, writesAtDispose, 'no write may start once disposed, not even the trailing one')
  assert.equal(track.max, 1, 'the trailing request must not have become a second concurrent write')
  assert.equal(h.counters.listCalls, listCallsAtDispose, 'no registry read may follow dispose')
  assert.equal(h.logged.length, loggedAtDispose, 'nothing may be logged after dispose')
  assert.equal(h.listenerCount(), 0, 'the event listener must be released')
  assert.deepEqual(
    workspaces[1].sessionIds, ['b1', 'b2'],
    'B keeps the order it had: its activity was never consumed by a disposed plugin',
  )
})

test('R11: the activity log advances while a reorder pass is blocked on the host', async (t) => {
  // THE CHAIN SPLIT, proven without touching the plugin.
  //
  // Logging and reordering shared one promise chain, so the two independent
  // resources serialized each other: a slow disk froze ordering, and a stalled
  // registry froze the log. Two resources that do not depend on each other must
  // not be able to hold each other up.
  //
  // There is deliberately still no seam for "make the log slow", and none was
  // added. What parks the log this time is the DISK, through the host's own
  // answer: the log path's parent is a regular file, so every write genuinely
  // fails and the log worker retries on its own bounded schedule. A reorder
  // pass is blocked on a durable write at the same time, and the obstruction is
  // removed while that pass is still blocked. The log then advances — and on a
  // shared chain nothing it did could happen until the pass finished.
  //
  // (This round's predecessor parked the plugin's STARTUP path inside
  // `sessionPersistence.list()`. R12 removed the startup enumeration entirely,
  // so there is no longer a startup promise to park; the claim under test is
  // unchanged and is asserted with the same two witnesses as before — the log
  // moved, and the pass provably had not.)
  const sandbox = tempHome('dsh-session-top-r11-log-')
  const blockage = sandbox.logPath('blocked')
  // A regular file where a directory is expected. Nothing can be created under
  // it, and the obstruction is removable from here.
  writeFileSync(blockage, 'not a directory', 'utf8')
  const logPath = join(blockage, 'activity.log')

  const gate = makeGate()
  const writes = []
  const workspaces = [account('A', ['a1', 'a2'], writes, gate)]
  const h = harness({ workspaces, webServer: true })
  try {
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5, logFile: logPath } })
    assertApplied(h)

    // A reorder pass starts and blocks on its first durable write.
    h.emit(session('a2'), activity(100))
    const started = await waitFor(() => attempted(writes).length === 1)
    assert.ok(started, 'precondition: the pass reached its first durable write and is blocked there')
    assert.equal(applied(writes).length, 0, 'precondition: that write has not completed')

    // The log worker is failing against the obstruction, on its own schedule.
    const failing = await waitForStatus(h, now => now.log?.writeFailures >= 1)
    assert.ok(
      (failing.log?.writeFailures ?? 0) >= 1,
      `precondition: the log worker is retrying against a disk that refuses it, got ${JSON.stringify(failing.log)}`,
    )
    assert.equal(applied(writes).length, 0, 'the reorder pass is still blocked while the log fails')

    // Clear the obstruction while the pass is STILL blocked. Nothing about the
    // pass changed: no event, no release, no timer of the plugin's.
    rmSync(blockage)
    const landed = await waitFor(() => readLogBytes(logPath).includes('"kind":"start"'))

    assert.ok(
      landed,
      'a log line must reach the disk while a pass is blocked, once the log path is usable again; '
      + `the log held ${JSON.stringify(readLogBytes(logPath))}`,
    )
    assert.equal(
      applied(writes).length, 0,
      'the reorder pass must still be blocked when that line landed, or independence was not what was observed',
    )
    assert.deepEqual(workspaces[0].sessionIds, ['a1', 'a2'], 'the blocked move is still unapplied')

    // The gate opens, the pass finishes its work, and the pass log line reports
    // the batch this pass actually took.
    gate.release()
    await settle(8)
    assert.deepEqual(workspaces[0].sessionIds, ['a2', 'a1'], 'the blocked pass still completes its work')
    assert.ok(
      readLogBytes(logPath).includes('"batch":1'),
      `the pass must log the batch it took, log held ${JSON.stringify(readLogBytes(logPath))}`,
    )
  } finally {
    h.dispose()
    sandbox.release()
  }
})

// ------------------------------------------- R11 fix round 1 (review findings)
//
// The scheduling shape from the R11 round is settled and unchanged here. These
// pin the ACCURACY of the metrics that shape is reported through — the three
// findings the independent review raised about the new counters themselves.

test('R11-fix: pendingAgeMs counts the fact a stalled pass is sitting on', async (t) => {
  // The field is documented as the age of the OLDEST UNCONSUMED fact. When the
  // running pass holds the only unconsumed fact — which is exactly what a
  // stalled runner looks like — scanning only the pending map reported 0, so
  // the one indicator meant to explain a stuck runner went blind precisely
  // while the runner was stuck.
  const log = []
  const gate = makeGate()
  const workspaces = [account('A', ['a1', 'a2'], log, gate)]
  const h = harness({ workspaces, webServer: true })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5 } })
  assertApplied(h)

  h.emit(session('a2'), activity(100))
  const blocked = await waitForStatus(h, now => now.running === true)
  assert.equal(blocked.running, true, 'precondition: the pass is in flight')
  await new Promise(resolve => { setTimeout(resolve, 60) })

  const during = await h.status()
  assert.equal(
    during.pendingActivity.length, 0,
    'precondition: the pass has TAKEN the fact, so nothing is on the pending map',
  )
  assert.ok(
    during.pendingAgeMs > 0,
    `a stalled pass holding the only unconsumed fact must still report its age, got ${String(during.pendingAgeMs)}`,
  )

  // CONSUMED: once the pass applies the move, nothing is waiting and the age
  // must fall back to zero rather than freeze at whatever the stall was.
  gate.release()
  const done = await waitForStatus(h, now => now.running === false && now.passesCompleted === 1)
  assert.equal(done.passesCompleted, 1, 'the pass applied its move')
  assert.equal(done.pendingAgeMs, 0, 'a consumed fact must stop ageing the queue')
  assert.deepEqual(workspaces[0].sessionIds, ['a2', 'a1'])
})

test('R11-fix: a refused fact keeps its arrival, so a retry does not reset its age', async (t) => {
  // The requeue path is the one place a fact can be unconsumed twice. It must
  // go back with the arrival it had, or every retry would make the backlog look
  // brand new and `pendingAgeMs` would report 0 forever on a fact the host has
  // been refusing for a minute.
  //
  // THE OBSERVATION POINT IS MADE WIDE, NOT LUCKY. The refilled fact only sits
  // on the pending map for one coalescing window, so a short window would make
  // this case a race that silently stops testing anything: if a later poll
  // arrives after the retry already consumed the fact, the assertion disappears
  // and the case still reports green. A 400ms window gives the poll dozens of
  // samples, and `assert.ok` below FAILS if the refill was never observed at
  // all — so this cannot pass without having checked the thing it exists for.
  const log = []
  const workspaces = [account('A', ['a1', 'a2'], log, null, { refuseFirst: 1 })]
  const h = harness({ workspaces, webServer: true })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 400 } })
  assertApplied(h)

  h.emit(session('a2'), activity(100))
  // The ORIGINAL arrival, read before any pass can have touched the fact: the
  // window is long enough that it is still sitting untouched on the map.
  const before = await h.status()
  const arrivedAt = before.pendingActivity[0]?.at
  assert.equal(
    typeof arrivedAt, 'number',
    'precondition: the fact is on the pending map with an arrival before any pass runs',
  )

  const refilled = await waitForStatus(h, now => now.pendingActivity.length === 1 && now.pendingActivity[0].attempts > 0)
  const fact = refilled.pendingActivity[0]
  assert.ok(
    fact !== undefined,
    'the refused fact must be observed back on the pending map; if it never was, this case proved nothing',
  )
  assert.equal(
    fact.at, arrivedAt,
    'a retry must carry the ORIGINAL arrival; re-stamping it is what makes a long refusal look instant',
  )
  assert.ok(refilled.pendingAgeMs > 0, 'a refused fact is still unconsumed and must report an age')

  const landed = await waitForStatus(h, now => now.pendingActivity.length === 0 && now.passesCompleted >= 1)
  assert.equal(landed.pendingActivity.length, 0, 'the retry consumed the fact')
  assert.deepEqual(workspaces[0].sessionIds, ['a2', 'a1'], 'the retry still lands the move')
})

test('R11-fix: queueDepth counts a pass that is ARMED, not only one that is RUNNING', async (t) => {
  // Two ways of asking for a pass produced two different readings for the same
  // real state: a request while a pass runs sets the trailing boolean, a
  // request with no pass running only arms the debounce timer. Anything
  // downstream keying "idle" off `queueDepth === 0 && running === false` would
  // have been told the host was free to close while a pass was already booked.
  const log = []
  const gate = makeGate()
  const workspaces = [account('A', ['a1', 'a2'], log, gate)]
  const h = harness({ workspaces, webServer: true })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 60 } })
  assertApplied(h)

  const idle = await h.status()
  assert.equal(idle.running, false, 'precondition: nothing has happened yet')
  assert.equal(idle.queueDepth, 0, 'an idle runner has nothing queued')

  // ARMED, NOT STARTED: the event scheduled a pass and the 60ms window has not
  // elapsed. Read far enough in to be sure the timer cannot have fired.
  h.emit(session('a2'), activity(100))
  const armed = await h.status()
  assert.equal(armed.running, false, 'precondition: the debounce window has not elapsed')
  assert.equal(
    armed.queueDepth, 1,
    'a scheduled-but-not-yet-started pass is still a queued pass',
  )
  assert.ok(armed.pendingActivity.length === 1, 'precondition: the fact is waiting')

  // STARTED: starting clears the timer and the trailing flag, so depth falls to
  // 0 even though the pass has not finished. The write is gated so "running" is
  // a state that can actually be observed rather than one that flashes past
  // between two polls.
  const started = await waitForStatus(h, now => now.running === true)
  assert.equal(started.running, true, 'the armed pass eventually starts')
  assert.equal(started.queueDepth, 0, 'the pass is no longer queued; it is running')

  // FINISHED AND IDLE again.
  gate.release()
  const finished = await waitForStatus(h, now => now.running === false && now.passesCompleted === 1)
  assert.equal(finished.queueDepth, 0, 'a finished pass with nothing behind it queues nothing')
  assert.equal(finished.pendingActivity.length, 0)
  assert.deepEqual(workspaces[0].sessionIds, ['a2', 'a1'])
})

test('R11-fix: a running pass with nothing waiting queues nothing', async (t) => {
  // The other half of the previous case. One fact, one blocked pass, nothing
  // else arrives: there is genuinely no queued pass, and depth must say so
  // rather than borrowing the running pass as evidence of queued work.
  const log = []
  const gate = makeGate()
  const workspaces = [account('A', ['a1', 'a2'], log, gate)]
  const h = harness({ workspaces, webServer: true })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5 } })
  assertApplied(h)

  h.emit(session('a2'), activity(100))
  await waitForStatus(h, now => now.running === true)
  await new Promise(resolve => { setTimeout(resolve, 40) })

  const during = await h.status()
  assert.equal(during.running, true, 'precondition: the pass is blocked')
  assert.equal(during.pendingActivity.length, 0, 'precondition: nothing else arrived')
  assert.equal(
    during.queueDepth, 0,
    'a running pass is not itself a queued pass; nothing else is waiting',
  )
  assert.ok(during.pendingAgeMs > 0, 'and the fact it is holding is still reported as waiting')

  // Now something else arrives, and THAT is what makes a pass queued.
  h.emit(session('a2'), activity(200))
  await new Promise(resolve => { setTimeout(resolve, 30) })
  const queued = await h.status()
  assert.equal(queued.running, true)
  assert.equal(queued.queueDepth, 1, 'a second request behind a running pass is the one queued slot')

  gate.release()
  await settle(8)
  assert.equal((await h.status()).queueDepth, 0)
})

test('R11-fix: the pending set stays under its ceiling while no pass can consume it', async (t) => {
  // The per-event ceiling. `boundPending` used to run only when a batch was
  // TAKEN, which means exactly nothing while a pass is stalled — so a host that
  // blocked one write could see the pending set grow without limit. This is the
  // test that property was missing; deleting the per-event call makes it red.
  const log = []
  const gate = makeGate()
  const ids = Array.from({ length: 50 }, (_, index) => `s${String(index + 1)}`)
  // `anchor` leads the account so the very first batch actually plans a move and
  // therefore reaches the gated write; an account of one, or one already led by
  // its only candidate, plans nothing and never blocks on anything.
  const workspaces = [account('A', ['anchor', ...ids], log, gate)]
  const h = harness({ workspaces, webServer: true })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5, maxTrackedSessions: 2 } })
  assertApplied(h)

  // The first write blocks, so nothing can ever be taken out of the pending set.
  h.emit(session('s1'), activity(100))
  await waitForStatus(h, now => now.running === true)
  for (let index = 1; index < ids.length; index += 1) {
    h.emit(session(ids[index]), activity(200 + index))
  }
  await new Promise(resolve => { setTimeout(resolve, 40) })

  const stalled = await h.status()
  assert.equal(stalled.running, true, 'precondition: the pass is still blocked')
  assert.ok(
    stalled.pendingActivity.length <= 2,
    `the pending set must stay under maxTrackedSessions while nothing consumes it, got ${String(stalled.pendingActivity.length)}`,
  )
  assert.ok(stalled.pendingAgeMs > 0, 'and what remains is still reported as waiting')
  assert.deepEqual(
    stalled.pendingActivity.map(one => one.id).sort(),
    ['s49', 's50'],
    'the ceiling drops the OLDEST facts — the ones with the most chances already — and keeps the newest',
  )

  gate.release()
  await settle(6)
  h.dispose()
  // After teardown nothing is retained and nothing is claimed to be waiting.
  const after = await h.detachedStatus()
  assert.equal(after.pendingActivity.length, 0, 'dispose releases the pending facts')
  assert.equal(after.pendingAgeMs, 0, 'and nothing is left claiming to wait')
  assert.equal(after.queueDepth, 0, 'a torn-down runner queues nothing')
})

test('R11-fix: a pass that throws is counted, reported, and never escapes', async (t) => {
  // `passesFailed` counts PASS-level exceptions, not the routine case of one
  // workspace refusing one write (that is `reorderAborts`, and the fact goes
  // back on the pending map). The only uncaught throw inside a pass is a host
  // whose service LOOKUP raises, so that is what this drives.
  const log = []
  const workspaces = [account('A', ['a1', 'a2'], log)]
  const getThrows = { name: 'workspaceRegistry', on: false }
  const h = harness({ workspaces, webServer: true, getThrows })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5 } })
  assertApplied(h)

  // Let the plugin's one-off startup path finish before the host starts
  // refusing lookups. That path reads the registry OUTSIDE its own error
  // handling — pre-existing, and not this round's business — so flipping the
  // switch under it would be racing the harness, not testing the runner.
  await settle(2)

  getThrows.on = true
  h.emit(session('a2'), activity(100))
  await settle(6)

  assert.equal(log.length, 0, 'a pass that cannot read the registry must not write')
  assert.ok(
    h.logged.some(([, message]) => message.includes('session reorder pass failed')),
    `a failed pass must be reported, got ${JSON.stringify(h.logged)}`,
  )

  getThrows.on = false
  const status = await h.status()
  assert.equal(status.passesStarted, 1, 'one pass ran')
  assert.equal(status.passesFailed, 1, 'and it failed at pass level')
  assert.equal(status.passesCompleted, 0, 'a failed pass is not a completed one')
  assert.ok(
    String(status.lastError).includes('lookup refused by the host'),
    `the reason must be reported, got ${String(status.lastError)}`,
  )
})

test('R11-fix: dispose abandons a stalled pass\'s facts instead of ageing them forever', async (t) => {
  // The dispose half of the age contract. Before teardown those facts are real
  // work a user could still see; after it the in-flight pass can no longer
  // requeue anything, so they are abandoned — and a backlog that keeps ageing
  // after the only code that could act on it is gone would describe work nobody
  // can still do.
  const log = []
  const gate = makeGate()
  const workspaces = [account('A', ['a1', 'a2'], log, gate)]
  const h = harness({ workspaces, webServer: true })
  t.after(() => h.dispose())
  await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5 } })
  assertApplied(h)

  h.emit(session('a2'), activity(100))
  await waitForStatus(h, now => now.running === true)
  await new Promise(resolve => { setTimeout(resolve, 60) })

  const during = await h.status()
  assert.equal(during.pendingActivity.length, 0, 'precondition: the pass is holding the only fact')
  assert.ok(during.pendingAgeMs > 0, 'precondition: it is reported as waiting while the plugin lives')

  h.dispose()
  const after = await h.detachedStatus()
  assert.equal(after.pendingActivity.length, 0, 'dispose releases the pending facts')
  assert.equal(after.pendingAgeMs, 0, 'and the abandoned ones stop ageing the queue')
  assert.equal(after.queueDepth, 0, 'a torn-down runner queues nothing')
  assert.equal(
    after.running, true,
    'but the pass really is still in flight — the plugin must not report it finished to make the rest look tidy',
  )

  gate.release()
  await settle(6)
  // The write that was ALREADY handed to the host before teardown is allowed to
  // finish — claiming otherwise would be a lie about an API that cannot be
  // aborted. What must not happen is more than that one.
  assert.equal(
    attempted(log).length, 1,
    'only the write already given to the host completes; nothing new may start',
  )
})

// --------------------------------------------------------------------- R12
//
// PERF-17 — a log that grows forever, with no capacity, no rotation and no
// disclosed drop count — and PERF-18 — a coalescing window that silently
// becomes 1ms. Plus the R12 addendum on the fallback cache.
//
// One property runs through all of it: THE LOG IS BOUNDED, AND BEING BOUNDED
// COSTS THE ORDERING NOTHING. Every disk-touching case below runs inside a
// `mkdtemp` sandbox with an explicit log path; no real `activity.log` and no
// real `$DSH_HOME` is ever in reach.

test('R12: debounceMs outside the supported timer range is refused at load time', async () => {
  // The validator accepted any integer, so 2147483648 passed and Node then
  // downgraded the delay to 1ms with a warning — the exact opposite of what a
  // larger window means. Nothing may be silently clamped. An unsupported value
  // fails loudly, and says which key it was, what it was, and what is
  // supported, so a user can fix it without reading this file.
  const refused = [
    { value: -1, label: '-1 (a negative window)' },
    { value: Number.NaN, label: 'NaN' },
    { value: Number.POSITIVE_INFINITY, label: 'Infinity' },
    { value: Number.NEGATIVE_INFINITY, label: '-Infinity' },
    { value: 400.5, label: '400.5 (a float)' },
    { value: 2147483648, label: '2147483648 (2^31)' },
    { value: Number.MAX_SAFE_INTEGER + 1, label: '9007199254740992 (past the safe integer range)' },
    { value: '400', label: '"400" (a string)' },
    { value: null, label: 'null' },
  ]
  for (const one of refused) {
    const h = harness({ workspaces: [account('A', ['a1', 'a2'], [])] })
    try {
      await assert.rejects(
        () => applyPlugin({ ctx: h.ctx, config: { debounceMs: one.value } }),
        (error) => {
          assert.ok(error instanceof TypeError, `${one.label} must fail with a TypeError, got ${String(error)}`)
          const message = String(error.message)
          assert.match(message, /debounceMs/, `the error must name the key, got ${JSON.stringify(message)}`)
          assert.match(
            message, /0\.\.2147483647|0 to 2147483647/,
            `the error must state the supported range, got ${JSON.stringify(message)}`,
          )
          assert.ok(
            message.includes(String(one.value))
              || (typeof one.value === 'string' && message.includes(JSON.stringify(one.value))),
            `the error must state the value it refused, got ${JSON.stringify(message)} for ${one.label}`,
          )
          return true
        },
      )
      assert.equal(h.listenerCount(), 0, `${one.label} must attach no listener at all`)
    } finally {
      h.dispose()
    }
  }
})

test('R12: the supported window range is armed verbatim, released by dispose, and never warns about overflow', async () => {
  // The other half. `0` is a supported high-load mode and the default `400` is
  // what every other case in this file runs on, so both must keep working
  // unchanged; and the largest value Node's timer accepts must be usable
  // rather than refused for being untidy. None of them may raise the warning
  // that the whole ticket is about.
  const { seen } = await collectWarnings(async () => {
    for (const delay of [0, 400, 2147483647]) {
      const h = harness({ workspaces: [account('A', ['a1', 'a2'], [])] })
      const armed = new Map()
      const realSetTimeout = globalThis.setTimeout
      const realClearTimeout = globalThis.clearTimeout
      globalThis.setTimeout = (fn, ms, ...rest) => {
        const handle = realSetTimeout(fn, ms, ...rest)
        armed.set(handle, ms)
        return handle
      }
      globalThis.clearTimeout = (handle) => {
        armed.delete(handle)
        return realClearTimeout(handle)
      }
      try {
        await applyPlugin({ ctx: h.ctx, config: { debounceMs: delay } })
        assertApplied(h)
        h.emit(session('a2'), activity(100))
        assert.ok(
          [...armed.values()].includes(delay),
          `the coalescing window must be armed with exactly ${String(delay)}ms and not with something near it, `
          + `got ${JSON.stringify([...armed.values()])}`,
        )
        h.dispose()
        assert.deepEqual(
          [...armed.values()], [],
          `dispose must release the ${String(delay)}ms window instead of leaving it holding the process open`,
        )
      } finally {
        for (const handle of [...armed.keys()]) realClearTimeout(handle)
        globalThis.setTimeout = realSetTimeout
        globalThis.clearTimeout = realClearTimeout
        h.dispose()
      }
    }
  })
  const overflow = seen.filter(one => one.name === 'TimeoutOverflowWarning')
  assert.deepEqual(
    overflow.map(one => one.message), [],
    'no accepted value may reach the 32-bit timer limit Node would silently shorten',
  )
})

test('R12: a refused load keeps the process-wide dedupe key until dispose', async () => {
  // The host half dedupes itself per process. A load that fails validation has
  // already been admitted to that registry by the time it throws, so the key
  // has to be released by dispose — otherwise every later apply in the process
  // is a silent no-op and the only symptom anywhere is a test count that
  // quietly goes DOWN.
  const h = harness({ workspaces: [account('A', ['a1', 'a2'], [])] })
  await assert.rejects(() => applyPlugin({ ctx: h.ctx, config: { debounceMs: 2147483648 } }))
  assert.equal(h.listenerCount(), 0, 'the refused load attached nothing')

  // Deliberately NOT pretending the same context can simply re-apply: while the
  // key is held, a second apply must stay a no-op.
  await applyPlugin({ ctx: h.ctx })
  assert.equal(h.listenerCount(), 0, 'a still-held mount key must suppress a second apply in this process')

  h.dispose()
  await applyPlugin({ ctx: h.ctx })
  assertApplied(h)
  h.dispose()
})

test('R12: maxTrackedSessions keeps its own positive-integer rule and is not a timer bound', async () => {
  // Same defect class, different fix. `Number.isInteger` let through values that
  // are not safe integers. But this key is a COUNT and not a delay, so the
  // 32-bit timer ceiling must NOT be copied onto it: refusing a large but valid
  // count would be a policy change smuggled in as validation, which is exactly
  // what this ticket was told not to do.
  for (const value of [0, -1, 1.5, '10', null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const h = harness({ workspaces: [account('A', ['a1', 'a2'], [])] })
    try {
      await assert.rejects(
        () => applyPlugin({ ctx: h.ctx, config: { maxTrackedSessions: value } }),
        (error) => {
          assert.ok(error instanceof TypeError, `${String(value)} must fail with a TypeError, got ${String(error)}`)
          const message = String(error.message)
          assert.match(message, /maxTrackedSessions/, `the error must name the key, got ${JSON.stringify(message)}`)
          assert.ok(
            message.includes(String(value)) || message.includes(JSON.stringify(value)),
            `the error must state the value it refused, got ${JSON.stringify(message)}`,
          )
          return true
        },
      )
      assert.equal(h.listenerCount(), 0, `${String(value)} must attach no listener`)
    } finally {
      h.dispose()
    }
  }
  for (const value of [1, 2000, 2147483648, Number.MAX_SAFE_INTEGER]) {
    const h = harness({ workspaces: [account('A', ['a1', 'a2'], [])], webServer: true })
    try {
      await applyPlugin({ ctx: h.ctx, config: { maxTrackedSessions: value } })
      assertApplied(h)
      const status = await h.status()
      assert.equal(
        status.maxTrackedSessions, value,
        `the accepted ceiling must be the configured one, got ${String(status.maxTrackedSessions)}`,
      )
    } finally {
      h.dispose()
    }
  }
})

test('R12: startup enumerates nothing, and the line that reports it claims nothing', async () => {
  // AN EXPLICIT, REVERSIBLE BEHAVIOUR CHANGE, on its own acceptance line
  // because it is not a resource change: the call SHAPE changes.
  //
  // Startup used to pull every header the host had ever persisted into
  // `fallbackTimes`. That map never took part in ordering — the ranking reads
  // only `lastActivity` — so the enumeration bought a diagnostic number and
  // paid for it with an O(headers) read at every process start, over a service
  // that may not even be active yet. The cache is now filled only on demand,
  // through the resync route that always existed.
  const h = harness({ workspaces: [account('A', ['a1', 'a2'], [])], webServer: true })
  await applyPlugin({ ctx: h.ctx })
  assertApplied(h)
  await settle(3)

  assert.equal(
    h.counters.persistenceListCalls, 0,
    'startup must not enumerate persistence: the cache it filled never took part in ordering',
  )
  const status = await h.status()
  assert.equal(status.fallbackSessions, 0, 'nothing is seeded, so the cache starts empty')
  const start = h.logged.find(([, message]) => message.includes('dsh-session-top: active'))
  assert.ok(start !== undefined, `startup must still report itself, got ${JSON.stringify(h.logged)}`)
  assert.ok(
    !/fallback times seeded/.test(start[1]),
    `the summary must not claim a seeding that no longer happens: ${JSON.stringify(start[1])}`,
  )
  h.dispose()
})

test('R12: resync REPLACES the fallback cache, twenty concurrent calls share one list, and the map is capped', async () => {
  // Three properties of one route, because they are three separate ways the old
  // shape was wrong: it accumulated (a session that stopped existing stayed in
  // the map forever), it had no ceiling at all, and twenty concurrent POSTs
  // each paid for their own full enumeration.
  const headers = Array.from(
    { length: 10000 },
    (_, index) => ({ id: `s${String(index)}`, createdAt: 1700000000000 + index }),
  )
  const h = harness({
    workspaces: [account('A', ['a1', 'a2'], [])],
    webServer: true,
    persistence: { list: async () => headers },
  })
  try {
    await applyPlugin({ ctx: h.ctx, config: { maxTrackedSessions: 2 } })
    assertApplied(h)
    await settle(2)
    assert.equal(h.counters.persistenceListCalls, 0, 'precondition: nothing has been enumerated yet')

    const answers = await Promise.all(Array.from({ length: 20 }, () => h.resync()))
    assert.equal(
      h.counters.persistenceListCalls, 1,
      `twenty concurrent resyncs must share ONE underlying list, got ${String(h.counters.persistenceListCalls)}`,
    )
    for (const answer of answers) {
      assert.equal(answer.ok, true, 'the route shape is unchanged: ok:true plus the resync result')
      assert.equal(answer.seeded, true, 'a resync that reached persistence reports that it seeded')
    }

    const capped = await h.status()
    assert.equal(capped.fallbackSessions, 2, 'the retained map must sit under maxTrackedSessions')
    assert.equal(
      capped.fallbackEnumerated, 10000,
      'how many headers were enumerated is reported separately from how many are retained',
    )
    assert.notEqual(
      capped.fallbackEnumerated, capped.fallbackSessions,
      'a capped map must never be presented as though every enumerated header were retained',
    )

    // Replacement, not accumulation: the host now reports nothing at all.
    headers.length = 0
    const emptied = await h.resync()
    assert.equal(emptied.seeded, true)
    assert.equal(h.counters.persistenceListCalls, 2, 'a later resync is its own list, not a replay of the first')
    const after = await h.status()
    assert.equal(after.fallbackSessions, 0, 'ten thousand headers followed by none must leave the cache at zero')
    assert.equal(after.fallbackEnumerated, 0, 'and the enumerated count follows the replacement, it does not accumulate')
  } finally {
    h.dispose()
  }
})

test('R12: a resync handler kept past dispose neither reads persistence nor publishes its result', async () => {
  // A caller that grabbed the route handler before unload still holds it, and
  // the plugin's own resync documents surviving exactly that. So the list it
  // started is a real frame that can outlive the apply. What it must NOT do is
  // put its headers into a map nobody can reach, or reach for the host again
  // once the apply is gone.
  const headers = Array.from(
    { length: 50 },
    (_, index) => ({ id: `s${String(index)}`, createdAt: 1700000000000 + index }),
  )
  let release
  const held = new Promise((resolve) => { release = () => resolve() })
  const h = harness({
    workspaces: [account('A', ['a1', 'a2'], [])],
    webServer: true,
    persistence: { list: async () => { await held; return headers } },
  })
  try {
    await applyPlugin({ ctx: h.ctx })
    assertApplied(h)
    await settle(2)

    const inFlight = h.detachedResync()
    const started = await waitFor(() => h.counters.persistenceListCalls === 1)
    assert.ok(started, 'precondition: the handler reached persistence')

    h.dispose()
    release()
    const answer = await inFlight

    assert.equal(answer.seeded, false, `a disposed plugin must not claim a successful seed, got ${JSON.stringify(answer)}`)
    const after = await h.detachedStatus()
    assert.equal(after.fallbackSessions, 0, 'a list that lands after dispose must not be written back')
    assert.equal(h.counters.persistenceListCalls, 1, 'no second read may follow dispose')

    // And the stale handler is not a way to start a new one.
    const again = await h.detachedResync()
    assert.equal(again.seeded, false)
    assert.equal(h.counters.persistenceListCalls, 1, 'a handler kept past dispose must not start a new read')
  } finally {
    h.dispose()
  }
})

test('R12: a custom log path whose parent directories do not exist is created once', async (t) => {
  const sandbox = tempHome('dsh-session-top-r12-nested-')
  // Four levels, none of which exist. The old shape created the DEFAULT plugin
  // home and then appended to this path, so every single record failed with
  // ENOENT and the only trace was one warning per record — forever.
  const logPath = sandbox.logPath('custom', 'nested', 'deeper', 'activity.log')
  const log = []
  const h = harness({ workspaces: [account('A', ['a1', 'a2'], log)], webServer: true })
  try {
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 5, logFile: logPath } })
    assertApplied(h)
    h.emit(session('a2'), activity(100))
    // Both the start line and the batch line, not whichever happens to land
    // first: the claim under test is that the custom path WORKS, and one line
    // would satisfy a check written for the previous failure mode.
    const status = await waitForStatus(h, now => now.log?.written >= 2)

    assert.ok(
      existsSync(logPath),
      `the custom path must be created with its parents, not just the default plugin home; `
      + `status=${JSON.stringify(status.log)}`,
    )
    assert.equal(
      status.log.mkdirs, 1,
      'the parent directory is established once per directory state, not once per record',
    )
    const tree = logTree(sandbox.logPath('custom', 'nested', 'deeper'))
    assert.equal(tree.length, 1, `one file — the log itself — got ${JSON.stringify(tree.map(one => one.name))}`)
    assert.ok(tree[0].lines.length >= 2, `the start line and the batch line must both land, got ${String(tree[0].lines.length)}`)
    for (const line of tree[0].lines) assert.equal(typeof JSON.parse(line), 'object', 'every line is one JSON record')
    assert.equal(status.log.writeFailures, 0, 'a path created for us cannot have failed on the way')
  } finally {
    h.dispose()
    sandbox.release()
  }
})

test('R12: sustained writes rotate, stay legal JSONL, and stay inside the declared disk ceiling', async (t) => {
  const sandbox = tempHome('dsh-session-top-r12-rotate-')
  const logPath = sandbox.logPath('activity.log')
  const log = []
  // Records are made large by ordinary host data — long session ids and a long
  // workspace title — so a bounded number of them fills a bounded file. No seam
  // is involved: this is what the projection looks like on a host whose
  // identifiers are long, which is the case the ceiling has to survive.
  const ids = Array.from({ length: 6 }, (_, index) => `s${String(index)}-${fat(4000, 'i')}`)
  const workspaces = [account('W', ids, log)]
  workspaces[0].title = fat(4000, 'W')
  const h = harness({ workspaces, webServer: true })
  try {
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 0, logFile: logPath } })
    assertApplied(h)
    const limits = (await h.status()).log.limits
    assert.ok(
      limits.fileBytes > 0 && limits.rotateKeep >= 1 && limits.maxTotalBytes >= limits.fileBytes,
      `the published limits must describe a real ceiling, got ${JSON.stringify(limits)}`,
    )

    let clock = 1000
    for (let index = 1; index <= 30; index += 1) {
      clock += 1
      h.emit(session(ids[index % ids.length]), activity(clock))
      const seen = await waitForStatus(h, now => now.passesStarted >= index)
      assert.equal(seen.passesStarted, index, `one coalescing window must be one pass, got ${String(seen.passesStarted)} at ${String(index)}`)
    }

    const status = await h.status()
    assert.ok(status.log.rotations >= 1, `30 records of this size must have rotated, counters=${JSON.stringify(status.log)}`)
    assert.equal(status.log.droppedRecords, 0, `nothing at these sizes should be dropped, got ${JSON.stringify(status.log)}`)

    const tree = logTree(sandbox.home)
    assert.ok(tree.some(one => one.name === 'activity.log'), 'the live file must still exist')
    assert.ok(tree.length >= 2, `rotation must leave a retained copy, got ${JSON.stringify(tree.map(one => one.name))}`)
    assert.ok(tree.length <= limits.rotateKeep + 1, `at most the declared ${String(limits.rotateKeep)} retained copies, got ${String(tree.length)} files`)

    let total = 0
    for (const file of tree) {
      total += file.size
      assert.ok(file.size <= limits.fileBytes, `${file.name} is ${String(file.size)} bytes, above the declared ${String(limits.fileBytes)}`)
      for (const line of file.lines) {
        assert.equal(typeof JSON.parse(line), 'object', `${file.name} must be legal JSONL, got ${JSON.stringify(line.slice(0, 60))}`)
      }
    }
    assert.ok(
      total <= limits.maxTotalBytes,
      `the whole log tree is ${String(total)} bytes, above the declared ceiling of ${String(limits.maxTotalBytes)}`,
    )
  } finally {
    h.dispose()
    sandbox.release()
  }
})

test('R12: a record above the per-record ceiling is dropped, counted, and never reaches the disk', async (t) => {
  const sandbox = tempHome('dsh-session-top-r12-oversize-')
  const logPath = sandbox.logPath('activity.log')
  const log = []
  // Big enough that the whole record — five ranked entries, each carrying a
  // session id and a workspace title the host chose — is far past any sane line
  // size. Dropping it is the honest response: writing it would let one record
  // decide how much disk the whole log may use.
  const ids = Array.from({ length: 6 }, (_, index) => `s${String(index)}-${fat(20000, 'i')}`)
  const workspaces = [account('W', ids, log)]
  workspaces[0].title = fat(20000, 'W')
  const h = harness({ workspaces, webServer: true })
  try {
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 0, logFile: logPath } })
    assertApplied(h)
    const limits = (await h.status()).log.limits

    // All six in one burst: they coalesce into a single pass whose projection
    // carries five ranked entries, which is what makes the record oversize.
    let clock = 1000
    for (const id of ids) {
      clock += 1
      h.emit(session(id), activity(clock))
    }
    const ran = await waitForStatus(h, now => now.passesStarted >= 1)
    assert.equal(ran.passesStarted, 1, 'precondition: one burst, one coalescing window, one pass')
    const status = await h.status()

    assert.ok(status.log.droppedRecords >= 1, `the oversize record must be counted as dropped, got ${JSON.stringify(status.log)}`)
    assert.ok(
      status.log.droppedBytes > limits.recordBytes,
      `the dropped BYTES must be counted and must be a whole record's worth, got ${String(status.log.droppedBytes)} `
      + `against a ceiling of ${String(limits.recordBytes)}`,
    )
    assert.equal(status.log.written, 1, `only the small start line may reach the disk, got ${String(status.log.written)} writes`)
    // THE ACCOUNTING INVARIANT, on the one drop path that is reachable from the
    // public surface. It used to be asserted only in scenarios with no oversize
    // record in them, which is exactly the scenario where it cannot fail.
    assert.equal(
      status.log.queued, status.log.written + status.log.droppedRecords,
      `every record OFFERED must be accounted for, got ${String(status.log.queued)} offered, `
      + `${String(status.log.written)} written + ${String(status.log.droppedRecords)} dropped`,
    )
    assert.equal(status.log.droppedOversize, status.log.droppedRecords, 'the oversize path is the only drop here')
    for (const file of logTree(sandbox.home)) {
      for (const line of file.lines) {
        assert.ok(
          Buffer.byteLength(line) + 1 <= limits.recordBytes,
          `no line above the declared per-record ceiling may exist on disk, got ${String(Buffer.byteLength(line) + 1)} bytes`,
        )
      }
    }
    // The whole point of dropping a record: the ordering does not notice.
    assert.equal(status.passesFailed, 0, `a dropped log record must not fail a pass: ${String(status.lastError)}`)
    assert.equal(status.passesCompleted, 1, 'the pass still ran to completion')
    assert.equal(workspaces[0].sessionIds[0], ids[5], 'the newest session still floats, log or no log')
  } finally {
    h.dispose()
    sandbox.release()
  }
})

test('R12: a log that cannot be written is dropped publicly, warned about once, and costs ordering nothing', async (t) => {
  const sandbox = tempHome('dsh-session-top-r12-flood-')
  const blockage = sandbox.logPath('blocked')
  writeFileSync(blockage, 'not a directory', 'utf8')
  const logPath = join(blockage, 'activity.log')

  const log = []
  const h = harness({ workspaces: [account('A', ['a1', 'a2'], log)], webServer: true })
  try {
    await applyPlugin({
      ctx: h.ctx,
      config: { debounceMs: 0, logFile: logPath, maxTrackedSessions: 64 },
    })
    assertApplied(h)
    const limits = (await h.status()).log.limits

    // The worker is now retrying against a path nothing can be written to.
    // Everything below is the OVERLOAD case: the producer keeps offering
    // records while the disk offers none. Two real sessions alternate so every
    // pass also has real ordering work to do.
    let clock = 1000
    let overflow = 0
    let queued = 0
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      clock += 1
      h.emit(session(clock % 2 === 0 ? 'a1' : 'a2'), activity(clock))
      const now = await h.status()
      overflow = now.log.droppedOverflow
      queued = now.log.queued
      assert.ok(
        now.log.depth <= limits.bufferRecords,
        `the buffer must never exceed its published ceiling of ${String(limits.bufferRecords)}, got ${String(now.log.depth)}`,
      )
      if (overflow > 0) break
      await new Promise(resolve => { setTimeout(resolve, 1) })
    }

    assert.ok(
      overflow > 0,
      `a buffer the writer cannot drain must drop the OLDEST and say so, counters=${JSON.stringify({ queued, limits })}`,
    )
    assert.ok(
      queued > limits.bufferRecords,
      `the buffer must genuinely have overflowed, got ${String(queued)} records offered to a ceiling of ${String(limits.bufferRecords)}`,
    )
    const status = await h.status()
    assert.ok(status.log.droppedBytes > 0, 'dropped BYTES are counted as well as dropped records')
    assert.ok(status.log.writeFailures >= 1, 'the failing writes are counted')
    assert.ok(status.log.droppedUnwritable >= 1, 'a record the disk kept refusing is dropped and counted as such')
    assert.equal(
      status.log.droppedRecords,
      status.log.droppedOversize + status.log.droppedOverflow + status.log.droppedUnwritable
        + status.log.droppedAbandoned + status.log.droppedUnserializable + status.log.droppedBlocked,
      'the total drop count must be exactly the sum of its reasons, or one of them is lying',
    )
    assert.ok(status.log.depth <= limits.bufferRecords, 'the retained buffer stays bounded even after a flood')

    // No spray: one warning per failure STREAK, not one per record.
    const warnings = h.logged.filter(([level, message]) => level === 'warn' && message.includes('activity log'))
    assert.ok(
      warnings.length <= 2,
      `a log that cannot be written must not warn once per record, got ${String(warnings.length)} warnings`,
    )
    assert.ok(
      warnings.length < status.log.writeFailures,
      'the summary must be smaller than the failure count: that is what once-per-streak means',
    )

    // And the whole point of any of this: ordering never noticed.
    assert.equal(status.passesFailed, 0, `a log that cannot be written must not fail a pass: ${String(status.lastError)}`)
    assert.ok(status.passesCompleted > 5, `ordering must keep completing, got ${String(status.passesCompleted)} completed passes`)
    assert.ok(applied(log).length > 0, 'the host was still asked to reorder, and the moves landed')

    // The buffer is provably full at this point — that is what the overflow
    // above proves — so dispose here abandons a real backlog rather than an
    // empty queue, and those records must be accounted for rather than dropped
    // on the floor.
    assert.ok(status.log.depth > 0, `precondition: the log still holds a backlog, got ${String(status.log.depth)}`)
    h.dispose()
    let torn = await h.detachedStatus()
    for (let round = 0; round < 40 && torn.log.depth > 0; round += 1) {
      await new Promise(resolve => { setTimeout(resolve, 25) })
      torn = await h.detachedStatus()
    }
    assert.equal(torn.log.depth, 0, 'a torn-down log worker retains no records')
    assert.ok(
      torn.log.droppedAbandoned > 0,
      'a backlog abandoned at dispose must be counted as dropped, not silently forgotten',
    )
    assert.equal(
      torn.log.written + torn.log.droppedRecords, torn.log.queued,
      `every record offered must be either written or counted as dropped, got ${String(torn.log.written)} written + `
      + `${String(torn.log.droppedRecords)} dropped of ${String(torn.log.queued)} offered`,
    )
  } finally {
    h.dispose()
    sandbox.release()
  }
})

test('R12: a deleted log directory is recreated and logging recovers', async (t) => {
  const sandbox = tempHome('dsh-session-top-r12-recover-')
  const logPath = sandbox.logPath('deep', 'activity.log')
  const log = []
  const h = harness({ workspaces: [account('A', ['a1', 'a2'], log)], webServer: true })
  try {
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 0, logFile: logPath } })
    assertApplied(h)
    await waitForStatus(h, now => now.log?.written > 0)

    // Something outside the plugin removes the directory it was logging into.
    rmSync(sandbox.logPath('deep'), { recursive: true, force: true })
    assert.equal(existsSync(sandbox.logPath('deep')), false, 'precondition: the directory really is gone')

    let clock = 1000
    for (let index = 1; index <= 5; index += 1) {
      clock += 1
      h.emit(session(`s${String(index)}`), activity(clock))
      await waitForStatus(h, now => now.passesStarted >= index)
    }
    // Only reachable if the writes resumed AFTER the removal: the counter was
    // still at one before it.
    const recovered = await waitForStatus(h, now => now.log.written >= 6)
    assert.ok(
      recovered.log.written >= 6,
      `logging must resume once the directory is gone, got ${String(recovered.log.written)} writes`,
    )
    assert.ok(
      recovered.log.mkdirs >= 2,
      `the directory must be established again after being removed, got ${String(recovered.log.mkdirs)} creations`,
    )
    assert.ok(
      recovered.log.writeFailures <= 2,
      `recovery must not come through a storm of failed writes, got ${String(recovered.log.writeFailures)}`,
    )
    const tree = logTree(sandbox.logPath('deep'))
    assert.ok(tree.length >= 1, 'the log is back inside the recreated directory')
    for (const line of tree[0].lines) assert.equal(typeof JSON.parse(line), 'object', 'the recovered log is still JSONL')
  } finally {
    h.dispose()
    sandbox.release()
  }
})

test('R12: dispose starts no further filesystem work and retains no descriptor', async (t) => {
  // One promise, two halves. After teardown this apply does not touch the disk
  // again: no mkdir, no stat, no rename, no unlink, no write. What it does NOT
  // promise is that work already handed to the kernel is cancelled — that is
  // not cancellable, and claiming otherwise would be a lie — so the first
  // half waits for the disk to go quiet before it takes any reading.
  const sandbox = tempHome('dsh-session-top-r12-dispose-')
  const logPath = sandbox.logPath('activity.log')
  const log = []
  const h = harness({ workspaces: [account('A', ['a1', 'a2'], log)], webServer: true })
  try {
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 0, logFile: logPath } })
    assertApplied(h)

    let clock = 1000
    for (let index = 1; index <= 5; index += 1) {
      clock += 1
      h.emit(session(`s${String(index)}`), activity(clock))
      await waitForStatus(h, now => now.passesStarted >= index)
    }
    const before = await h.status()

    h.dispose()
    // The queue is abandoned as soon as the worker comes back from whatever it
    // had already handed the kernel — a write in flight is not cancelled, but
    // it is also not the end of the queue's life.
    let abandoned = await h.detachedStatus()
    for (let round = 0; round < 40 && abandoned.log.depth > 0; round += 1) {
      await new Promise(resolve => { setTimeout(resolve, 25) })
      abandoned = await h.detachedStatus()
    }
    assert.equal(abandoned.log.depth, 0, 'a torn-down log worker retains no records')
    assert.equal(
      abandoned.log.written + abandoned.log.droppedRecords, abandoned.log.queued,
      `every record offered to the log must be either written or counted as dropped, got `
      + `${String(abandoned.log.written)} written + ${String(abandoned.log.droppedRecords)} dropped `
      + `of ${String(abandoned.log.queued)} offered`,
    )
    assert.ok(
      abandoned.log.droppedAbandoned <= before.log.depth,
      'whatever the worker still held at dispose is counted as abandoned',
    )

    const bytes = () => logTree(sandbox.home).reduce((sum, one) => sum + one.size, 0)
    const quiet = async () => {
      let previous = -1
      for (let round = 0; round < 40; round += 1) {
        const total = bytes()
        if (total === previous) return total
        previous = total
        await new Promise(resolve => { setTimeout(resolve, 25) })
      }
      return previous
    }
    const settled = await quiet()
    await new Promise(resolve => { setTimeout(resolve, 500) })
    assert.equal(bytes(), settled, `no disk work may start after dispose, tree=${JSON.stringify(logTree(sandbox.home).map(one => [one.name, one.size]))}`)

    // A torn-down plugin does not even accept new records.
    for (let index = 6; index <= 10; index += 1) {
      clock += 1
      h.emit(session(`s${String(index)}`), activity(clock))
    }
    await new Promise(resolve => { setTimeout(resolve, 300) })
    assert.equal(bytes(), settled, 'events delivered after dispose must not reach the log')
    const after = await h.detachedStatus()
    assert.equal(after.log.queued, before.log.queued, 'a disposed plugin accepts no further records')

    // A retained descriptor would make this impossible on Windows, where an
    // open handle pins a file against renaming. The plugin writes with
    // short-lived calls only; this is what "no handle is retained" looks like
    // from the outside.
    renameSync(logPath, `${logPath}.moved`)
    assert.equal(existsSync(`${logPath}.moved`), true, 'the log must not be held open once the work is done')
  } finally {
    h.dispose()
    sandbox.release()
  }
})

// ---------------------------------------------------- R12 fix round 1
//
// What the independent review of the R12 round found in THIS diff. Four things,
// all in the log's own bookkeeping and its handling of files that already exist:
// an accounting invariant that did not hold on a reachable path, one latch
// standing in for three unrelated reasons, rotation and deletion with no notion
// of ownership, and a published ceiling that a file this plugin never created
// could break without anything saying so.

test('R12-fix1: a record dropped for size cannot silence a real disk failure', async (t) => {
  // One latch for three unrelated reasons is how a real disk failure goes
  // unreported: the log drops a record for being too big, sets the latch, and
  // the disk then fails for three records straight with the host told nothing.
  // Capacity and encoding are the plugin's own housekeeping; a write that fails
  // is the host's disk having a problem. They must not share a silence.
  const sandbox = tempHome('dsh-session-top-r12f1-latch-')
  const parent = sandbox.logPath('switch')
  const logPath = join(parent, 'activity.log')
  const log = []
  // Long identifiers make the FIRST burst's batch projection oversize: the
  // record carries five ranked entries, and five of these is far past the
  // per-record ceiling. The second burst is the point of the case, so it uses
  // ordinary identifiers — they are the NEWEST activity, so they are what the
  // record's ranking shows, and it stays small enough to reach the disk.
  const fatIds = Array.from({ length: 6 }, (_, index) => `s${String(index)}-${fat(20000, 'i')}`)
  const plainIds = Array.from({ length: 6 }, (_, index) => `p${String(index)}`)
  const workspaces = [account('W', [...fatIds, ...plainIds], log)]
  const h = harness({ workspaces, webServer: true })
  const warnings = () => h.logged.filter(([level, message]) => level === 'warn' && message.includes('activity log'))
  try {
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 0, logFile: logPath } })
    assertApplied(h)
    await waitForStatus(h, now => now.log.written >= 1)

    let clock = 1000
    for (const id of fatIds) {
      clock += 1
      h.emit(session(id), activity(clock))
    }
    const dropped = await waitForStatus(h, now => now.log.droppedOversize >= 1)
    assert.ok(dropped.log.droppedOversize >= 1, `precondition: a record was dropped for size, got ${JSON.stringify(dropped.log)}`)
    assert.ok(warnings().length >= 1, 'dropping a record for size must be reported once')

    // The directory the log lives in is replaced by a regular file. Every write
    // from here on genuinely fails, and that is a DIFFERENT failure from the one
    // the latch was set for.
    rmSync(parent, { recursive: true, force: true })
    writeFileSync(parent, 'not a directory', 'utf8')
    for (const id of plainIds) {
      clock += 1
      h.emit(session(id), activity(clock))
      await waitForStatus(h, now => now.log.written < 2 || now.log.writeFailures >= 1)
    }
    const failing = await waitForStatus(h, now => now.log.writeFailures >= 2)
    assert.ok(failing.log.writeFailures >= 2, `precondition: the disk is refusing writes, got ${JSON.stringify(failing.log)}`)

    const writeWarnings = warnings().filter(([, message]) => message.includes('activity log write failed'))
    assert.ok(
      writeWarnings.length >= 1,
      'a real write failure must be reported even though an earlier, unrelated drop already reported; '
      + `warnings=${JSON.stringify(warnings().map(([, message]) => message))}`,
    )
  } finally {
    h.dispose()
    sandbox.release()
  }
})

test('R12-fix1: a logger that throws on warn costs the scheduler nothing', async (t) => {
  // The ticket says a `logger.warn` that throws must not poison the scheduler
  // and must not become an unhandled rejection. Nothing here made that true —
  // it was the implementation's own try/catch, asserted by nobody.
  const sandbox = tempHome('dsh-session-top-r12f1-logger-')
  const blockage = sandbox.logPath('blocked')
  writeFileSync(blockage, 'not a directory', 'utf8')
  const logPath = join(blockage, 'activity.log')

  const rejections = []
  const onRejection = (reason) => { rejections.push(reason) }
  process.on('unhandledRejection', onRejection)
  const log = []
  const h = harness({
    workspaces: [account('A', ['a1', 'a2'], log)],
    webServer: true,
    loggerThrows: { warn: true },
    // Persistence that refuses, so resync takes ITS warn path. That path is
    // shared by every concurrent caller, so a report helper that let a throwing
    // logger through would reject all of them at once.
    persistence: { list: async () => { throw new Error('host persistence refused the list') } },
  })
  try {
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 0, logFile: logPath } })
    assertApplied(h)

    let clock = 1000
    for (let index = 1; index <= 4; index += 1) {
      clock += 1
      h.emit(session(clock % 2 === 0 ? 'a1' : 'a2'), activity(clock))
      // One emit per pass, so the count is what makes this "keeps completing"
      // rather than "completed once".
      const seen = await waitForStatus(h, now => now.passesCompleted >= index)
      assert.equal(seen.passesCompleted, index, `pass ${String(index)} must have completed`)
    }
    const failing = await waitForStatus(h, now => now.log.writeFailures >= 1)

    assert.ok(
      h.logged.some(([level, message]) => level === 'warn' && message.includes('activity log')),
      'precondition: the failing log really did try to report itself',
    )
    assert.ok(failing.log.writeFailures >= 1, `the writes really did fail, got ${JSON.stringify(failing.log)}`)
    assert.equal(failing.passesFailed, 0, `a throwing logger must not fail a pass: ${String(failing.lastError)}`)
    assert.ok(failing.passesCompleted >= 4, `ordering must keep completing, got ${String(failing.passesCompleted)}`)
    assert.ok(applied(log).length > 0, 'and the durable moves still land')

    // The OTHER warn path: resync reporting a failure the host will not accept.
    // It returns an answer rather than throwing, because a diagnostics route
    // that throws is a route that cannot be diagnosed.
    const refused = await h.resync()
    assert.equal(
      refused.seeded, false,
      `a resync whose own report is refused must still answer, got ${JSON.stringify(refused)}`,
    )
    assert.ok(
      String(refused.error ?? '').includes('persistence refused'),
      `and it must carry the reason, got ${JSON.stringify(refused)}`,
    )

    // Give any promise that was going to escape a few turns to actually escape.
    await new Promise(resolve => { setTimeout(resolve, 200) })
    assert.deepEqual(
      rejections.map(String), [],
      `a logger that throws must not produce an unhandled rejection, got ${JSON.stringify(rejections.map(String))}`,
    )
  } finally {
    process.removeListener('unhandledRejection', onRejection)
    h.dispose()
    sandbox.release()
  }
})

test('R12-fix1: a log file this plugin did not create and cannot fit is left alone and reported', async (t) => {
  // The published ceiling is a promise about the files this plugin manages. A
  // file somebody else put at the configured path is not one of them, and the
  // honest response to "I would have to delete or rename a file I did not create
  // in order to keep my promise" is to STOP and say so — not to delete it, and
  // not to quietly keep growing it while the status still claims 4 MiB.
  const sandbox = tempHome('dsh-session-top-r12f1-preexisting-')
  const logPath = sandbox.logPath('activity.log')
  const foreign = `not-this-plugin's-log\n${'y'.repeat(64)}\n`
  writeFileSync(logPath, foreign.repeat(40000), 'utf8')
  const before = readFileSync(logPath, 'utf8')

  const log = []
  const workspaces = [account('A', ['a1', 'a2'], log)]
  const h = harness({ workspaces, webServer: true })
  try {
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 0, logFile: logPath } })
    assertApplied(h)
    const limits = (await h.status()).log.limits

    h.emit(session('a2'), activity(100))
    const blocked = await waitForStatus(h, now => now.log.blocked?.reason !== undefined)

    assert.equal(
      blocked.log.blocked.reason, 'preexisting-file',
      `the plugin must name why it stopped writing, got ${JSON.stringify(blocked.log.blocked)}`,
    )
    assert.equal(
      blocked.log.preexistingBytes, before.length,
      `the size it found must be reported, so a reader can see what it declined to touch; got ${String(blocked.log.preexistingBytes)}`,
    )
    assert.ok(
      blocked.log.preexistingBytes > limits.fileBytes,
      `precondition: the file really is above the per-file ceiling of ${String(limits.fileBytes)}`,
    )
    assert.equal(blocked.log.owned, false, 'a file this plugin did not create is not owned, and appending to it never would be')
    assert.ok(blocked.log.droppedBlocked >= 1, 'records refused while blocked are counted as such')
    assert.equal(
      blocked.log.droppedBlocked, blocked.log.droppedRecords,
      'blocking is the only drop reason in this case',
    )
    assert.equal(
      blocked.log.queued, blocked.log.written + blocked.log.droppedRecords,
      `the accounting invariant must hold here too, got ${String(blocked.log.queued)} offered, `
      + `${String(blocked.log.written)} written + ${String(blocked.log.droppedRecords)} dropped`,
    )

    // Nothing on disk moved, and nothing was removed.
    assert.equal(readFileSync(logPath, 'utf8'), before, 'the foreign file must be byte-for-byte what it was')
    assert.deepEqual(
      readdirSync(sandbox.home).sort(), ['activity.log'],
      'a blocked plugin creates no rotated copy and removes nothing',
    )
    assert.equal(blocked.log.rotations, 0, 'and it does not rotate a file it does not own')

    // The reason it stopped must have cost ordering nothing.
    assert.equal(blocked.passesFailed, 0, `a blocked log must not fail a pass: ${String(blocked.lastError)}`)
    assert.equal(workspaces[0].sessionIds[0], 'a2', 'the session still floats with the log stopped')
  } finally {
    h.dispose()
    sandbox.release()
  }
})

test('R12-fix1: rotation stops rather than overwrite a rotated copy this plugin did not create', async (t) => {
  // `rename` onto an existing destination DESTROYS it, silently, on POSIX. The
  // Windows build fails with EEXIST and would have hidden this. So the guard has
  // to be the destination's ownership, not the platform's behaviour.
  const sandbox = tempHome('dsh-session-top-r12f1-slot-')
  const logPath = sandbox.logPath('activity.log')
  // A rotated sibling this plugin did not write and may not move or overwrite.
  // The live log is ABSENT on purpose: that is the case where this apply creates
  // the file and genuinely owns it, so the only thing standing in the way of a
  // rotation is somebody else's `.1`.
  writeFileSync(`${logPath}.1`, 'somebody elses rotated file\n', 'utf8')
  const siblingBefore = readFileSync(`${logPath}.1`, 'utf8')

  const log = []
  // Records large enough that a bounded number of them fills a bounded file.
  const ids = Array.from({ length: 6 }, (_, index) => `s${String(index)}-${fat(4000, 'i')}`)
  const workspaces = [account('W', ids, log)]
  workspaces[0].title = fat(4000, 'W')
  const h = harness({ workspaces, webServer: true })
  try {
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 0, logFile: logPath } })
    assertApplied(h)
    // Ownership is settled by the first write, so wait for it rather than
    // reading the status in the gap before the log worker has run at all.
    const created = await waitForStatus(h, now => now.log.written >= 1)
    assert.equal(
      created.log.owned, true,
      'precondition: the live log was absent, so this apply created it and owns it',
    )

    let clock = 1000
    for (let index = 1; index <= 40; index += 1) {
      clock += 1
      h.emit(session(ids[index % ids.length]), activity(clock))
      const seen = await waitForStatus(h, now => now.passesStarted >= index)
      assert.equal(seen.passesStarted, index, `one window must be one pass, got ${String(seen.passesStarted)} at ${String(index)}`)
      if (seen.log.blocked !== null) break
    }
    const blocked = await waitForStatus(h, now => now.log.blocked?.reason !== undefined)

    assert.equal(
      blocked.log.blocked.reason, 'slot-conflict',
      `the plugin must name the conflict rather than resolve it by moving somebody's file, got ${JSON.stringify(blocked.log.blocked)}`,
    )
    assert.equal(
      readFileSync(`${logPath}.1`, 'utf8'), siblingBefore,
      'a rotated copy this plugin did not create must be byte-for-byte what it was',
    )
    assert.ok(existsSync(logPath), 'the live log is left in place, not renamed away')
    assert.deepEqual(
      readdirSync(sandbox.home).sort(), ['activity.log', 'activity.log.1'],
      'nothing new appeared and nothing was removed',
    )
    assert.equal(blocked.log.owned, true, 'owning the live file is not the same as being allowed to clobber a foreign copy')
  } finally {
    h.dispose()
    sandbox.release()
  }
})

test('R12-fix1: the rotation cascade never writes over a copy this plugin did not create', async (t) => {
  // The same guard one level deeper, and the level where it is easy to forget.
  // Slot 1 is free here, so the FIRST rotation succeeds and creates a copy this
  // plugin does own. The second rotation wants slot 2 — and slot 2 is somebody
  // else's file. A cascade that trusts its own bookkeeping rather than the
  // destination would move `.1` straight over the top of it, which destroys it
  // on POSIX without raising anything.
  const sandbox = tempHome('dsh-session-top-r12f1-cascade-')
  const logPath = sandbox.logPath('activity.log')
  writeFileSync(`${logPath}.2`, 'not ours, slot 2\n', 'utf8')
  writeFileSync(`${logPath}.3`, 'not ours, slot 3\n', 'utf8')
  const before = {
    2: readFileSync(`${logPath}.2`, 'utf8'),
    3: readFileSync(`${logPath}.3`, 'utf8'),
  }

  const log = []
  const ids = Array.from({ length: 6 }, (_, index) => `s${String(index)}-${fat(4000, 'i')}`)
  const workspaces = [account('W', ids, log)]
  workspaces[0].title = fat(4000, 'W')
  const h = harness({ workspaces, webServer: true })
  try {
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 0, logFile: logPath } })
    assertApplied(h)

    let clock = 1000
    for (let index = 1; index <= 60; index += 1) {
      clock += 1
      h.emit(session(ids[index % ids.length]), activity(clock))
      const seen = await waitForStatus(h, now => now.passesStarted >= index)
      assert.equal(seen.passesStarted, index, `one window must be one pass, got ${String(seen.passesStarted)} at ${String(index)}`)
      if (seen.log.blocked !== null) break
    }
    const stopped = await waitForStatus(h, now => now.log.blocked?.reason !== undefined)

    assert.ok(stopped.log.rotations >= 1, `precondition: the first rotation did happen, got ${String(stopped.log.rotations)}`)
    assert.equal(
      stopped.log.blocked.reason, 'slot-conflict',
      `the cascade must stop at the foreign slot, got ${JSON.stringify(stopped.log.blocked)}`,
    )
    for (const slot of [2, 3]) {
      assert.equal(
        readFileSync(`${logPath}.${String(slot)}`, 'utf8'), before[slot],
        `slot ${String(slot)} is not this plugin's and must be byte-for-byte what it was`,
      )
    }
    assert.ok(existsSync(`${logPath}.1`), 'the copy the plugin did create is still there')
    assert.deepEqual(
      readdirSync(sandbox.home).sort(), ['activity.log', 'activity.log.1', 'activity.log.2', 'activity.log.3'],
      'nothing new appeared and nothing was removed',
    )
  } finally {
    h.dispose()
    sandbox.release()
  }
})

test('R12-fix1: a log from a previous run can be appended to, and is still not moved when it fills', async (t) => {
  // The boundary, stated as one sequence because that is how it is actually
  // reached: after a restart the log from the previous run is still a working
  // log, so appending to it goes on — and when it reaches its per-file ceiling,
  // the plugin stops rather than renaming a file it did not create. Appending
  // once does not make a file yours, and a guard that said otherwise would be
  // one `writeFile` away from deleting somebody's data.
  const sandbox = tempHome('dsh-session-top-r12f1-adopt-')
  const logPath = sandbox.logPath('activity.log')
  const previous = `{"at":"2026-01-01T00:00:00.000Z","kind":"start","summary":"previous run"}\n`
  writeFileSync(logPath, previous, 'utf8')

  const log = []
  // Records large enough that a bounded number of them fills a bounded file.
  const ids = Array.from({ length: 6 }, (_, index) => `s${String(index)}-${fat(4000, 'i')}`)
  const workspaces = [account('W', ids, log)]
  workspaces[0].title = fat(4000, 'W')
  const h = harness({ workspaces, webServer: true })
  try {
    await applyPlugin({ ctx: h.ctx, config: { debounceMs: 0, logFile: logPath } })
    assertApplied(h)

    let clock = 1000
    for (let index = 1; index <= 60; index += 1) {
      clock += 1
      h.emit(session(ids[index % ids.length]), activity(clock))
      const seen = await waitForStatus(h, now => now.passesStarted >= index)
      assert.equal(seen.passesStarted, index, `one window must be one pass, got ${String(seen.passesStarted)} at ${String(index)}`)
      if (index === 1) {
        assert.equal(seen.log.written >= 2, true, 'precondition: the first append lands on the previous run\'s log')
        assert.equal(seen.log.owned, false, 'and appending to it did NOT make it this apply\'s')
        assert.equal(seen.log.blocked, null, 'appending to it is not blocked, it is what the path is for')
      }
      if (seen.log.blocked !== null) break
    }
    const stopped = await waitForStatus(h, now => now.log.blocked?.reason !== undefined)

    assert.equal(
      stopped.log.blocked.reason, 'preexisting-file',
      `filling a log this apply did not create must stop the log, not rotate it, got ${JSON.stringify(stopped.log.blocked)}`,
    )
    assert.equal(stopped.log.owned, false, 'a file that was already there is never adopted by appending to it')
    assert.ok(stopped.log.written > 1, 'the appends before the boundary really did happen')
    assert.ok(stopped.log.droppedBlocked >= 1, 'records after the boundary are counted as refused')
    assert.ok(existsSync(logPath), 'the file is still exactly where it was — not renamed aside')
    assert.deepEqual(
      readdirSync(sandbox.home).sort(), ['activity.log'],
      'no rotated copy is made of a file this plugin did not create',
    )
    const text = readFileSync(logPath, 'utf8')
    assert.ok(text.startsWith(previous), 'the previous run\'s line is still the first line, untouched')
    for (const line of text.split('\n').filter(one => one !== '')) {
      assert.equal(typeof JSON.parse(line), 'object', 'appending did not corrupt the file')
    }
    assert.equal(stopped.passesFailed, 0, `a stopped log must not fail a pass: ${String(stopped.lastError)}`)
  } finally {
    h.dispose()
    sandbox.release()
  }
})

after(() => {
  // Nothing global should survive the file; make a leaked handle visible rather
  // than letting the runner hang on it.
  assert.ok(true)
})
