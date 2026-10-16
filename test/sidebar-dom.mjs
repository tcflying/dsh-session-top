/**
 * Sidebar-flavor DOM test.
 *
 * The plugin's whole visible surface is DOM work against a sidebar it does not
 * own, and the real machine runs @michengai/dsh-codex-ui rather than the stock
 * ui-sidebar. A release shipped official-only selectors and rendered nothing at
 * all on that machine — invisible, because "renders nothing" is also what a
 * disabled feature looks like.
 *
 * This test builds a minimal but faithful skeleton of EACH rendering, drives the
 * real bundle against it, and asserts the four DOM behaviors: pin rules emitted
 * for the right rows, region anchored above the list, group fold driven through
 * the header's own toggle, and right-click producing a pin affordance.
 *
 * Run: node test/sidebar-dom.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const S1 = 'session-aaaaaaaa-1111-4111-8111-111111111111'
const S2 = 'session-bbbbbbbb-2222-4222-8222-222222222222'
const S9 = 'session-99999999-3333-4333-8333-333333333333'

// --------------------------------------------------------------- fake DOM

/**
 * The harness's OWN timer, captured at module load — before `runBundle` ever
 * wraps the globals.
 *
 * Every wait in this file (settle, the post-dispatch flush, a run's opening
 * settle, the fake hosts' delayed toggles) goes through this one, so it can
 * never be mistaken for something the bundle armed. The per-run live-timer set
 * is evidence about the bundle; the bundle is not what makes a test wait.
 */
const harnessSetTimeout = globalThis.setTimeout.bind(globalThis)

/**
 * Registered mutation observers, so the harness delivers real
 * MutationRecords instead of pretending the API does not exist.
 *
 * The self-feeding reconcile loop this file now guards against was invisible to
 * a no-op stub: with `observe(){}`, the plugin's own DOM edits can never reach
 * it, so a loop cannot form and a test cannot catch one either.
 */
const observers = new Set()
let mutationLog = { records: 0, deliveries: 0 }

/**
 * Exceptions a listener callback threw, recorded by `El.dispatch` the way the
 * DOM reports them (see the method). Read-only for tests:
 * `reportedListenerErrors()`.
 *
 * This is a LOG, not a control channel. Nothing in the bundle may see it, and
 * nothing in the bundle does — a reported exception is invisible to the
 * caller of `dispatch()`, which is exactly the guarantee these cases check.
 *
 * @returns {readonly {type: string, tag: string, error: string}[]} everything reported so far.
 */
const reportedListenerErrorLog = []
const reportedListenerErrors = () => [...reportedListenerErrorLog]

/** Report one childList change the way the DOM does: target plus added/removed. */
function emitMutation(target, added = [], removed = []) {
  const record = { type: 'childList', target, addedNodes: added, removedNodes: removed }
  mutationLog.records += 1
  for (const observer of [...observers]) {
    observer.pending.push(record)
    observer.schedule()
  }
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.pending = []
    this.scheduled = false
  }

  observe() { observers.add(this) }
  disconnect() { observers.delete(this) }

  schedule() {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.pending.length === 0) return
      const batch = this.pending
      this.pending = []
      mutationLog.deliveries += 1
      this.callback(batch, null)
    })
  }
}

class FakeClassList {
  constructor(el) { this.el = el }
  add(...n) { this.el.classList.add(...n) }
}

class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase()
    this.attributes = new Map()
    this.children = []
    this.parentElement = null
    this.listeners = new Map()
    this._text = ''
    this.isConnected = true
    this.style = {
      props: new Map(),
      setProperty: (k, v) => { this.style.props.set(k, v) },
      removeProperty: (k) => { this.style.props.delete(k) },
    }
    this.sheet = { cssRules: [], deleteRule(i) { this.cssRules.splice(i, 1) }, insertRule(c) { this.cssRules.push(c); return 0 } }
  }

  get classList() { return new Set() }
  /** Real DOM nodes expose this; the plugin inserts relative to it. */
  get firstChild() { return this.children[0] ?? null }
  get lastChild() { return this.children[this.children.length - 1] ?? null }

  set textContent(value) { this._text = String(value); emitMutation(this, [], []) }
  get textContent() { return this._text ?? '' }

  // Attribute writes ARE mutations, and only when they change something: the
  // real DOM records an attribute MutationRecord for a write that differs, and
  // this plugin's observer is configured for attributes precisely so a
  // self-inflicted edit cannot restart its own reconcile. Without this the
  // harness silently under-counted, and "an idle second writes nothing" proved
  // less than it claimed to.
  setAttribute(n, v) {
    const next = String(v)
    if (this.attributes.get(n) === next) return
    this.attributes.set(n, next)
    emitMutation(this, [], [])
  }
  getAttribute(n) { return this.attributes.has(n) ? this.attributes.get(n) : null }
  removeAttribute(n) {
    if (!this.attributes.has(n)) return
    this.attributes.delete(n)
    emitMutation(this, [], [])
  }
  hasAttribute(n) { return this.attributes.has(n) }
  get className() { return this.attributes.get('class') ?? '' }
  set className(v) { this.setAttribute('class', v) }

  appendChild(c) { c.parentElement = this; this.children.push(c); emitMutation(this, [c], []); return c }

  /**
   * DOM `insertBefore`, with the SPEC's pre-insert move semantics: a node that
   * already has a parent is REMOVED from it first, and only then inserted before
   * the reference child.
   *
   * The previous fake only spliced, so inserting a node that was already a child
   * duplicated it. That is invisible for append-a-new-row and wrong for every
   * "move an existing row" path — which made this harness answer
   * "DUPLICATE / order incorrect" for reorders a real browser gets right, and
   * would have pushed anyone adding a reorder case into "fixing" the production
   * code to match a fake.
   */
  insertBefore(c, a) {
    // Pre-insert, step one: a node with a parent is REMOVED from it — including
    // when that parent is this very list. Skipping the same-parent case is
    // exactly the old bug in a narrower form: the row is spliced in a second
    // time and the region ends up holding it twice.
    if (c.parentElement !== null) {
      const at = c.parentElement.children.indexOf(c)
      if (at >= 0) c.parentElement.children.splice(at, 1)
    }
    c.parentElement = this
    // Pre-insert, step two: the reference child is resolved AFTER the removal,
    // because that removal shifts every later index in the same list.
    const at = a === undefined || a === null ? -1 : this.children.indexOf(a)
    this.children.splice(at < 0 ? this.children.length : at, 0, c)
    emitMutation(this, [c], [])
    return c
  }

  remove() {
    if (!this.parentElement) return
    const parent = this.parentElement
    const i = parent.children.indexOf(this)
    if (i >= 0) parent.children.splice(i, 1)
    emitMutation(parent, [], [this])
    this.parentElement = null
    this.isConnected = false
  }

  descendants() {
    const out = []
    const walk = (n) => { for (const c of n.children) { out.push(c); walk(c) } }
    walk(this)
    return out
  }

  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(fn) }
  removeEventListener(t, fn) { const l = this.listeners.get(t) ?? []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1) }
  /**
   * Dispatch, with the SPEC's exception handling.
   *
   * DOM Standard, "inner invoke": when a listener callback throws, the
   * exception is REPORTED — surfaced as an uncaught error — and SWALLOWED.
   * Dispatch carries on and returns normally, so `click()` cannot rethrow it
   * to its caller.
   *
   * That matters because the fold code reads the outcome of `header.click()`.
   * No browser ever hands it a thrown listener: `HTMLElement.click()`
   * (HTML, interaction) fires a synthetic click and returns. The previous fake
   * called the callback bare, so the harness invented an outcome the platform
   * does not have, and the branch built on it looked exercised when it was
   * unreachable in production.
   *
   * The exception is still recorded — see `reportedListenerErrors()` — because
   * "the host's own handler blew up" is worth asserting on. It is just not a
   * return value the caller can branch on, which is the whole point.
   */
  dispatch(type, event = {}) {
    const e = { preventDefault() {}, stopPropagation() {}, ...event }
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      try {
        fn(e)
      } catch (error) {
        // "Report exception", then continue with the next listener.
        reportedListenerErrorLog.push({ type, tag: this.tagName, error: String(error) })
      }
    }
  }

  click() { this.dispatch('click') }

  matches(sel) { return matchSimple(this, sel) }

  closest(sel) {
    let n = this
    while (n !== null) {
      if (n.matches?.(sel)) return n
      n = n.parentElement
    }
    return null
  }

  querySelector(sel) {
    for (const d of this.descendants()) if (d.matches(sel)) return d
    return null
  }

  querySelectorAll(sel) {
    return this.descendants().filter(d => d.matches(sel))
  }
}

/**
 * Match one compound selector: `tag`, `.class` chains and `[attr]` / `[attr=v]`
 * / `[attr^=v]`. Descendant combinators are handled by matches() below.
 */
function matchCompound(el, part) {
  const m = part.match(/^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/)
  if (!m) return false
  const [, tag, classes, attrs] = m
  if (tag !== undefined && el.tagName !== tag.toUpperCase()) return false
  if (classes !== undefined && classes.length > 0) {
    const list = (el.getAttribute('class') ?? '').split(/\s+/)
    if (!classes.split('.').filter(Boolean).every(c => list.includes(c))) return false
  }
  if (attrs !== undefined && attrs.length > 0) {
    // EVERY attribute group must match, not just the first: the plugin locates
    // its stylesheets with two-attribute selectors such as
    // `style[data-plugin='x'][data-stp-sheet='dynamic']`, and checking only the
    // first made the dynamic tag alias the static one.
    // Both quote styles are valid CSS.
    const ATTR = /\[([\w-]+)(?:([~^$*|]?=)(?:"([^"]*)"|'([^']*)'))?\]/g
    let groups = 0
    for (const am of attrs.matchAll(ATTR)) {
      groups += 1
      const [, name, op, dq, sq] = am
      const actual = el.getAttribute(name)
      if (actual === null) return false
      if (op !== undefined) {
        const expected = dq ?? sq
        if (op === '=' && actual !== expected) return false
        if (op === '^=' && !actual.startsWith(expected)) return false
      }
    }
    if (groups === 0) return false
  }
  return true
}

/** Selector match with optional descendant combinators (e.g. `[role=tree] [data-x]`). */
function matchSimple(el, sel) {
  for (const group of sel.split(',').map(s => s.trim()).filter(Boolean)) {
    const compounds = group.split(/\s+/).filter(Boolean)
    if (compounds.length === 0) continue
    if (!matchCompound(el, compounds[compounds.length - 1])) continue
    // Every preceding compound must match some ancestor, left to right.
    let node = el.parentElement
    let ok = true
    for (let i = compounds.length - 2; i >= 0; i--) {
      let found = false
      while (node !== null) {
        if (matchCompound(node, compounds[i])) { found = true; node = node.parentElement; break }
        node = node.parentElement
      }
      if (!found) { ok = false; break }
    }
    if (ok) return true
  }
  return false
}

// ------------------------------------------------------------------ scaffold

function makeTree() {
  const body = new El('body')
  const head = new El('head')
  // listArea > treeBody > tree  (region is inserted above treeBody)
  const listArea = new El('div')
  const treeBody = new El('div')
  const tree = new El('div')
  tree.setAttribute('role', 'tree')
  treeBody.appendChild(tree)
  listArea.appendChild(treeBody)
  body.appendChild(listArea)
  // Deliberately NO `aria-label` and no host class: this is the skeleton used
  // both for the stock sidebar (where officialScaffold adds the label the real
  // AnimatedRows list always carries) and for "no sidebar at all". Flavor
  // identification now falls back to those host containers, so a scaffold that
  // claims to be a host tree would defeat the point of the unknown-sidebar case.
  return { body, head, listArea, treeBody, tree }
}

function officialScaffold() {
  const s = makeTree()
  s.tree.setAttribute('aria-label', 'sessions')
  s.tree.setAttribute('data-official', '')
  const head = new El('div')
  head.setAttribute('role', 'treeitem')
  head.setAttribute('data-row-key', 'workspace:w1')
  head.setAttribute('aria-expanded', 'true')
  head.onclickCount = 0
  head.addEventListener('click', () => { head.onclickCount++; head.setAttribute('aria-expanded', head.getAttribute('aria-expanded') === 'true' ? 'false' : 'true') })
  const row = new El('div')
  row.setAttribute('role', 'treeitem')
  row.setAttribute('data-row-key', `session:${S1}`)
  const inner = new El('span')
  row.appendChild(inner)
  s.tree.appendChild(head)
  s.tree.appendChild(row)
  return { ...s, head, row, inner }
}

function codexScaffold() {
  const s = makeTree()
  // The host container codex-ui keeps mounted whatever the groups inside it are
  // doing — this is what identifies the sidebar once the last session row
  // unmounts because every group was folded.
  s.tree.className = 'dcu-wb-tree'
  const project = new El('div')
  project.className = 'dcu-wb-project'
  const head = new El('div')
  head.className = 'dcu-wb-project-head'
  head.setAttribute('role', 'treeitem')
  head.setAttribute('aria-expanded', 'true')
  head.addEventListener('click', () => { head.setAttribute('aria-expanded', head.getAttribute('aria-expanded') === 'true' ? 'false' : 'true') })
  const body2 = new El('div')
  body2.className = 'dcu-wb-project-body'
  const row = new El('div')
  row.className = 'dcu-wb-session dcu-wb-session-time'
  row.setAttribute('role', 'treeitem')
  row.setAttribute('data-dcu-session', S1)
  const title = new El('span')
  title.className = 'dcu-wb-session-title'
  row.appendChild(title)
  body2.appendChild(row)
  project.appendChild(head)
  project.appendChild(body2)
  s.tree.appendChild(project)
  return { ...s, project, head, row, title }
}

// -------------------------------------------------------------------- drive

/**
 * Dispose the previous run before starting a new one.
 *
 * The real page has one owner per document (that is what the document lease is
 * for), so a second `runBundle` supersedes the first. Several cases here never
 * disposed their mount, which was harmless while a mount armed nothing that
 * outlived it - but an undisposed mount keeps re-arming the shared-menu retry on
 * its 250 ms timer, and those timers would otherwise land in the NEXT run's
 * live-timer set and make a disposal assertion meaningless.
 */
let previousRunDispose = null

/**
 * Timers armed by the bundle of THIS run and not yet released.
 *
 * Per run, not one set for the file. `runBundle` disposes the previous mount
 * before it installs its own wrappers, so:
 *
 *   - a bundle timer can only be created through the wrapper that is in place
 *     while THAT generation is mounted, and lands in THAT run's set;
 *   - a handle the previous generation left behind stays in the previous run's
 *     set, where the current run's assertions cannot see it — so an older
 *     generation can no longer pollute the count;
 *   - and because the set is never emptied on the way in, a timer armed while
 *     the bundle was MOUNTING — which is where arming happens — stays visible
 *     for the whole life of the run. The previous version called
 *     `pluginLiveTimers.clear()` right after the opening settle, which is
 *     precisely the window it needed to keep watching: a 45-second orphan armed
 *     at mount was invisible, and the disposal assertion passed anyway.
 *
 * A timer that fires removes itself, so the fake hosts' delayed toggles never
 * linger. The harness's own waits never enter the set at all: they use
 * `harnessSetTimeout`, captured before any wrapping.
 */
async function runBundle(scaffold, { pinned, mutable = false, locale = undefined, items = undefined }) {
  // The previous generation goes first, so its bundle can no longer arm
  // anything into the set this run is about to start counting.
  if (previousRunDispose !== null) previousRunDispose()
  const listeners = new Map()

  /**
   * The bundle is evaluated with `new Function`, so it resolves `setTimeout`
   * through the same globals this replaces; the plugin needs no cooperation.
   */
  const liveTimerHandles = new Set()
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const wrappedSetTimeout = (fn, ms, ...rest) => {
    let handle
    handle = realSetTimeout(() => {
      liveTimerHandles.delete(handle)
      fn(...rest)
    }, ms)
    liveTimerHandles.add(handle)
    handle.__delay = ms
    handle.__site = String(new Error().stack.split(String.fromCharCode(10))[3] ?? String()).trim()
    return handle
  }
  const wrappedClearTimeout = (handle) => {
    liveTimerHandles.delete(handle)
    return realClearTimeout(handle)
  }
  globalThis.setTimeout = wrappedSetTimeout
  globalThis.clearTimeout = wrappedClearTimeout
  /**
   * @returns {readonly unknown[]} handles the plugin has armed and not released.
   *
   * Deliberately NOT emptied by `dispose()`: the whole point is that whatever
   * the plugin failed to release is still visible here afterwards.
   */
  const liveTimers = () => [...liveTimerHandles]
  globalThis.document = {
    body: scaffold.body,
    head: scaffold.head,
    documentElement: new El('html'),
    createElement: (tag) => new El(tag),
    querySelector: (sel) => scaffold.body.querySelector(sel) ?? scaffold.head.querySelector(sel),
    querySelectorAll: (sel) => [...scaffold.body.querySelectorAll(sel), ...scaffold.head.querySelectorAll(sel)],
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn) },
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} }
  globalThis.MutationObserver = FakeMutationObserver
  globalThis.Element = El
  globalThis.KeyboardEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init) } }

  let registration = null
  globalThis.window.__ModuleLoader__ = { load: (v) => { registration = v } }

  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  // The bundle requires no module and takes no require parameter, so the
  // factory is invoked with none — exactly as the shell's loader does it.
  new Function('window', 'document', 'Element', 'MutationObserver', 'KeyboardEvent', source)(
    globalThis.window, globalThis.document, El, globalThis.MutationObserver, globalThis.KeyboardEvent,
  )
  assert.ok(registration, 'bundle did not register')

  const pinCalls = []
  const opened = []
  const panels = []
  // Captured list subscribers, so a test can reproduce what the host does on
  // every render: the plugin reconciles off the list subscriptions (the
  // MutationObserver it also installs is a no-op in this harness).
  const nudges = []
  const subscribe = (fn) => {
    nudges.push(fn)
    return () => { const i = nudges.indexOf(fn); if (i >= 0) nudges.splice(i, 1) }
  }
  const services = {}
  // The mutable form is what a real store is: a test that has to observe a pin
  // change, a title change or a selection change has to be able to MAKE one.
  // The immutable form is kept for every test that only needs a fixed set.
  const live = {
    pinned: [...pinned],
    // The workspace projection, mutable for the tests that drive group folds.
    // The default is the one every pre-existing case expects.
    items: items ?? [{ workspaceId: 'w1', title: 'W1', sessionIds: [S1, S2] }],
    byId: {
      [S1]: { id: S1, displayTitle: 'one', updatedAt: 2 },
      [S2]: { id: S2, displayTitle: 'two', updatedAt: 1 },
    },
    mainSessionId: undefined,
    unpin: undefined,
  }
  for (const [name, value] of Object.entries({
    workspaces: {
      list: {
        getSnapshot: () => ({ items: live.items, pinnedSessionIds: live.pinned }),
        subscribe,
      },
      pinSession: async (id) => { pinCalls.push(['pin', id]); live.pinned = [...new Set([...live.pinned, id])] },
      unpinSession: async (id) => {
        pinCalls.push(['unpin', id])
        if (typeof live.unpin === 'function') return live.unpin(id)
        live.pinned = live.pinned.filter(one => one !== id)
      },
    },
    sessions: {
      // The live ClientSessions snapshot shape: {ids, byId, phase,
      // projectionsBySession}. No `current` — see test/shared-menu.mjs.
      list: {
        getSnapshot: () => ({
          ids: Object.keys(live.byId),
          byId: live.byId,
          phase: 'ready',
          projectionsBySession: {},
        }),
        subscribe,
      },
    },
    uiWorkspace: {
      openSession: (id) => { opened.push(id) },
      // The main view's own reference handle — how the host's sidebar knows
      // which session is selected (UiWorkspaceService.replaceMain).
      get mainReference() {
        return live.mainSessionId === undefined ? undefined : { sessionId: live.mainSessionId, release() {} }
      },
    },
    layout: { selectPanel: (id) => { panels.push(id) } },
    locale,
  })) services[name] = value

  // Model cordis faithfully: the fiber activates NOW with nothing provided, and
  // `ctx.inject(deps, cb)` defers the callback until the dependency shows up.
  // `deferPublication` reproduces the real bug this revision fixes — apply
  // running before the controller is published.
  const pending = []
  const effectDisposers = []
  const ctx = {
    get: (name) => services[name],
    logger: { warn: (m) => { throw new Error(`plugin warned: ${m}`) }, info: () => {} },
    effect: (fn) => { const dispose = fn(); effectDisposers.push(dispose); return dispose },
    inject: (deps, cb) => {
      pending.push(() => {
        if (deps.every(d => services[d] !== undefined)) cb(ctx)
      })
      return { dispose() {} }
    },
  }
  const logs = []
  const realInfo = console.info
  const realWarn = console.warn
  console.info = (...a) => { logs.push(['info', a.join(' ')]) }
  console.warn = (...a) => { logs.push(['warn', a.join(' ')]) }

  registration.factory().apply(ctx)

  // apply must have logged BEFORE the controller exists — that is the whole
  // point: it must not have gone silent.
  const afterApply = [...logs]

  // Now the controller publishes, exactly as the host would.
  for (const run of pending) run()

  // Drive one reconcile past the debounce. This wait belongs to the harness,
  // not to the bundle, so it never goes through the counting wrapper.
  await new Promise(r => { harnessSetTimeout(r, 150) })
  // NOTE: the live-timer set is deliberately NOT cleared here. It was, and that
  // single line made the disposal assertion blind to every timer the bundle
  // armed while mounting — see the note above.
  console.info = realInfo
  console.warn = realWarn
  const dispose = () => {
      for (const one of effectDisposers.splice(0)) one()
      // `pending` holds the DEFERRED MOUNT CALLBACKS, not disposers. Running them
      // here mounted a FRESH generation after teardown, which is exactly how a live
      // timer used to survive disposal — the leak looked like the plugin's fault
      // and was the harness's.
      pending.splice(0)
    // Put the globals back so a later run is not wrapped twice — but only if
    // this run is still the wrapper in place, and WITHOUT emptying the set:
    // what the plugin failed to release must stay visible to the assertions.
    if (globalThis.setTimeout === wrappedSetTimeout) globalThis.setTimeout = realSetTimeout
    if (globalThis.clearTimeout === wrappedClearTimeout) globalThis.clearTimeout = realClearTimeout
  }
  /** Reproduce a host re-render: the plugin reconciles off its list subscriptions. */
  const nudge = () => { for (const fn of [...nudges]) fn() }
  previousRunDispose = dispose
  return { listeners, registration, logs, afterApply, dispose, services, pinCalls, nudge, live, opened, panels, liveTimers }
}

/**
 * Run the plugin's deferred right-click fallback to completion.
 *
 * The plugin decides OWNERSHIP by what the event DID, not by asking whether the
 * shared owner is loaded — so its own menu opens one microtask after the
 * dispatch, once every document-capture listener has had its turn. A test that
 * asserts synchronously after invoking the handler is asserting before the
 * plugin has decided anything, and used to pass/fail on that race.
 */
function afterDispatch() {
  return new Promise(resolve => { queueMicrotask(() => { harnessSetTimeout(resolve, 0) }) })
}

/**
 * The dynamic pin rules, read the way the plugin writes them: plain
 * `textContent` on a dedicated <style> element, never the CSSOM.
 */
function sheetRules(scaffold) {
  const tag = scaffold.head.querySelector('style[data-stp-sheet="dynamic"]')
  return (tag?.textContent ?? '').split('\n').filter(Boolean)
}

/** The static look, which must survive every reconcile untouched. */
function staticCss(scaffold) {
  const tag = scaffold.head.querySelector('style[data-stp-sheet="static"]')
  return tag?.textContent ?? ''
}

// ---------------------------------------------------------------- the tests

// --- official flavor
{
  const sc = officialScaffold()
  await runBundle(sc, { pinned: [S1] })
  const rules = sheetRules(sc)
  assert.ok(
    rules.some(r => r.includes('data-row-key') && r.includes(S1)),
    `official flavor must emit a hide rule for the pinned session; got ${JSON.stringify(rules)}`,
  )
  assert.ok(
    rules.some(r => r.includes("role='tree'")),
    'the hide rule must be scoped to the tree so plugin-owned rows survive',
  )
  console.log('✔ official flavor: pin hide rule targets data-row-key="session:<id>"')

  const region = sc.body.querySelector('[data-stp-region]')
  assert.ok(region !== null, 'region element must be mounted')
  assert.equal(region.parentElement, sc.listArea, 'region must be inserted above the tree body')
  // The region is a SIBLING of treeBody, preceding it, so "Pinned" stays
  // anchored at the sidebar top instead of scrolling with the list.
  assert.ok(
    sc.listArea.children.indexOf(region) < sc.listArea.children.indexOf(sc.treeBody),
    'region must precede the tree body',
  )
  console.log('✔ official flavor: pinned region anchored above the session list')
}

// --- codex flavor
{
  const sc = codexScaffold()
  await runBundle(sc, { pinned: [S1] })
  const rules = sheetRules(sc)
  assert.ok(
    rules.some(r => r.includes('data-dcu-session') && r.includes(S1)),
    `codex flavor must emit a hide rule keyed on data-dcu-session; got ${JSON.stringify(rules)}`,
  )
  console.log('✔ codex flavor: pin hide rule targets data-dcu-session="<id>"')

  const region = sc.body.querySelector('[data-stp-region]')
  assert.ok(region !== null, 'region element must be mounted in the codex sidebar too')
  assert.equal(region.parentElement, sc.listArea)
  console.log('✔ codex flavor: pinned region anchored above the session list')

  // Theme tokens must have been bound to codex-ui's custom properties.
  const root = globalThis.document.documentElement
  assert.equal(root.style.props.get('--stp-token-hover'), 'var(--dcu-sidebar-hover)')
  assert.equal(root.style.props.get('--stp-token-primary'), 'var(--dcu-sidebar-primary)')
  console.log('✔ codex flavor: theme tokens bound to --dcu-sidebar-*')

  // Group fold: pinning a member folds the group via the header's own toggle.
  // Reach the header the same way the plugin does — by DOM ancestry from a
  // member row — so this also proves the resolution path works.
  const resolved = (() => {
    const project = sc.row.closest('.dcu-wb-project')
    if (project === null) return null
    return [...project.children].find(c => typeof c.matches === 'function' && c.matches('.dcu-wb-project-head'))
  })()
  assert.ok(resolved !== null, 'the plugin must be able to reach .dcu-wb-project-head from a member row')
  assert.equal(
    resolved.getAttribute('aria-expanded'),
    'false',
    'a group holding a pinned session must end up folded',
  )
  console.log('✔ codex flavor: group folded through .dcu-wb-project-head toggle')
}

// --- right-click on a codex row while NO shared context-menu owner exists.
// The owner (@baihejiangnan/dsh-session-context-menu) is what renders the menu on
// the real desktop; with it absent the plugin offers its own — but only on a
// positively identified host row, and it must never go looking for someone
// else's menu surface to graft into.
{
  const sc = codexScaffold()
  const { listeners, pinCalls } = await runBundle(sc, { pinned: [] })
  const handlers = listeners.get('contextmenu') ?? []
  assert.ok(handlers.length > 0, 'a contextmenu listener must be installed')

  const rootSentinel = []
  sc.tree.addEventListener('contextmenu', (e) => { rootSentinel.push(e) })

  const ev = {
    target: sc.title,
    clientX: 100,
    clientY: 200,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    stopImmediatePropagation() { this.propagationStopped = true },
  }
  handlers[0](ev)
  await afterDispatch()
  assert.equal(ev.defaultPrevented, true, 'with no owner, the plugin must claim the row it resolved')
  assert.equal(rootSentinel.length, 0, 'and the event must not also reach a host listener')

  const own = sc.body.querySelector('[data-stp-menu]')
  assert.ok(own !== null, "the plugin's own menu must open on a real host session row")
  const item = own.querySelector('[data-stp-pin-item]')
  assert.ok(item !== null, 'the own menu must offer the pin action')
  assert.match(item.textContent, /置顶该会话/, 'an unpinned session offers Pin')
  console.log('✔ codex flavor with no menu owner: own menu on a real session row')

  // A foreign surface appearing afterwards must stay untouched.
  const foreign = new El('div')
  foreign.setAttribute('data-menu-material', 'translucent')
  foreign.setAttribute('role', 'menu')
  const foreignRow = new El('button')
  foreignRow.setAttribute('role', 'menuitem')
  foreign.appendChild(foreignRow)
  sc.body.appendChild(foreign)
  await new Promise(r => { harnessSetTimeout(r, 120) })
  assert.equal(
    foreign.querySelector('[data-stp-pin-item]'),
    null,
    'the plugin must never write into a menu surface it does not own',
  )
  assert.ok(foreignRow.isConnected, 'the host must keep its own menu rows')
  console.log('✔ no DOM graft: a foreign menu surface is never touched')

  // Clicking the item must write through the official pin RPC.
  item.click()
  await new Promise(r => { harnessSetTimeout(r, 20) })
  assert.deepEqual(pinCalls, [['pin', S1]], 'the own menu must pin through workspaces.pinSession')
  console.log('✔ own menu item pins through the official workspace RPC')
}

// --- the graft must NOT touch a menu that was already open before the click
{
  const sc = codexScaffold()
  const { listeners } = await runBundle(sc, { pinned: [] })
  const handlers = listeners.get('contextmenu') ?? []
  // A pre-existing, unrelated menu (a settings popover, say).
  const unrelated = new El('div')
  unrelated.setAttribute('data-menu-material', 'translucent')
  unrelated.setAttribute('role', 'menu')
  const unrelatedRow = new El('button')
  unrelatedRow.setAttribute('role', 'menuitem')
  unrelated.appendChild(unrelatedRow)
  sc.body.appendChild(unrelated)

  handlers[0]({ target: sc.title, clientX: 1, clientY: 2, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() {} })
  await new Promise(r => { harnessSetTimeout(r, 120) })
  assert.equal(
    unrelated.querySelector('[data-stp-pin-item]'),
    null,
    'a menu that was already open belongs to someone else and must not be grafted into',
  )
  console.log('✔ codex flavor: never grafts into a pre-existing, unrelated menu')
}

// --- official flavor owns the gesture (it has no context menu at all)
{
  const sc = officialScaffold()
  const { listeners } = await runBundle(sc, { pinned: [] })
  const handlers = listeners.get('contextmenu') ?? []
  const ev = { target: sc.inner, clientX: 10, clientY: 20, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
  handlers[0](ev)
  await afterDispatch()
  assert.equal(ev.defaultPrevented, true, 'official flavor must own the context menu')
  console.log('✔ official flavor: right-click opens the plugin menu (stock sidebar has no context menu)')
}

// --- neither flavor present: degrade to inert
{
  const s = makeTree()
  await runBundle(s, { pinned: [S1] })
  assert.equal(s.body.querySelector('[data-stp-region]'), null, 'no region without a recognized sidebar')
  console.log('✔ unrecognized sidebar degrades to inert')
}

// --- the real machine's failure: apply runs BEFORE the controller publishes
{
  const sc = codexScaffold()
  const { afterApply, logs } = await runBundle(sc, { pinned: [S1] })

  // Before publication the plugin must already be talking, not silent. This is
  // the symptom that shipped: zero console output, zero DOM, forever.
  assert.ok(afterApply.length > 0, 'apply must log before the controller is published')
  assert.ok(
    afterApply.some(([, m]) => m.includes('waiting for the workspaces controller')),
    `apply must announce it is waiting; got ${JSON.stringify(afterApply)}`,
  )
  assert.ok(
    !afterApply.some(([level]) => level === 'warn'),
    'waiting is normal, not a degradation — it must not warn',
  )
  console.log('✔ plugin announces it is waiting instead of going silent at apply time')

  // After publication it must report itself active with its capabilities.
  const active = logs.find(([level, m]) => level === 'info' && m.includes('active'))
  assert.ok(active !== undefined, `plugin must log "active" once mounted; got ${JSON.stringify(logs)}`)
  assert.ok(active[1].includes('pin ok'), 'the summary must state whether the pin RPC is usable')
  assert.ok(active[1].includes('pinned 1'), 'the summary must state the pinned count')
  console.log('✔ plugin logs an explicit capability line once mounted')
}

// --- UNRECOGNISED sidebar: observe only, and prove no menu DOM appears
{
  const s = makeTree()
  const { listeners } = await runBundle(s, { pinned: [] })
  const handlers = listeners.get('contextmenu') ?? []
  const rootSentinel = []
  s.tree.addEventListener('contextmenu', (e) => { rootSentinel.push(e) })

  // A row that looks like neither flavor.
  const alien = new El('div')
  alien.setAttribute('data-something-else', 'x')
  s.tree.appendChild(alien)

  const ev = {
    target: alien,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    stopImmediatePropagation() { this.propagationStopped = true },
  }
  handlers[0](ev)
  if (!ev.propagationStopped) s.tree.dispatch('contextmenu', ev)

  assert.equal(ev.propagationStopped, false, 'an unknown sidebar must never have its event interrupted')
  assert.equal(ev.defaultPrevented, false, 'an unknown sidebar must never be preventDefault-ed')
  assert.equal(rootSentinel.length, 1, 'the event must still reach the host root listener')
  await new Promise(r => { harnessSetTimeout(r, 120) })
  assert.equal(
    s.body.querySelector('[data-stp-pin-item]'),
    null,
    'an unknown sidebar must not produce a menu of ours',
  )
  console.log('✔ unrecognized sidebar: contextmenu is observed only, no interference, no menu')
}

// --- the plugin's OWN rows must not make the sidebar look like the stock one.
// This is the bug that killed codex-ui's menu twice: the region rows used to
// carry `data-row-key="session:<id>"`, so on codex (when its own rows were not
// mounted) detection flipped to the stock flavor and right-click took the
// own-menu branch, whose stopPropagation killed the host menu.
{
  const sc = codexScaffold()
  const { listeners } = await runBundle(sc, { pinned: [S1] })

  // Walk the region the plugin actually built. The region is plain DOM now
  // (the bundle requires no module, so there is no renderer and no virtual
  // tree to inspect), so the region element itself is the render product.
  const region = sc.body.querySelector('[data-stp-region]')
  assert.ok(region !== null, 'region element must be mounted')
  const rows = region.querySelectorAll('[data-stp-row]')
  assert.equal(rows.length, 1, 'one pinned session must produce exactly one row')

  for (const row of rows) {
    assert.equal(
      row.getAttribute('data-row-key'),
      null,
      'region rows must not carry data-row-key: that makes them look like the stock sidebar',
    )
    assert.equal(
      row.getAttribute('data-dcu-session'),
      null,
      'region rows must not carry data-dcu-session: that makes them look like codex-ui',
    )
    assert.equal(row.getAttribute('data-stp-session'), S1, 'region rows carry their own session id attribute')
    // NOT `role="treeitem"`. The shared owner recognises a session row by
    // `closest('[role="treeitem"]')` PLUS an `aria-selected` attribute or a
    // "会话操作" button (dsh-session-context-menu lib/client.js:104-109); a row
    // wearing that role is a session row to the owner, and `resolveSession`
    // would answer with the CURRENT session instead of the one clicked. The
    // region also sits outside the sidebar's `[role="tree"]`, where a treeitem
    // is not valid ARIA anyway.
    assert.equal(row.getAttribute('role'), 'button', 'a region row is a button, never a treeitem')
    assert.equal(
      row.getAttribute('aria-selected'),
      null,
      'a region row must never borrow aria-selected to steer the shared owner',
    )
  }
  // The title must be real content in the row, not an attribute-only stub.
  const title = rows[0].querySelector('[data-stp-row-title]')
  assert.ok(title !== null, 'the row must carry a title element')
  assert.equal(title.textContent, 'one', 'the title element must hold the session display title')
  console.log('✔ own region rows carry no host flavor marker')

  // With the host's own rows gone, detection must be "none", not "official".
  sc.tree.querySelectorAll('[data-dcu-session]').forEach(r => r.remove())
  // Wait out the flavor memoization window so the next probe really re-reads
  // the DOM. The cache is module-private; sleeping is the honest way to test it.
  await new Promise(r => { harnessSetTimeout(r, 320) })
  const handlers = listeners.get('contextmenu') ?? []
  const rootSentinel = []
  sc.tree.addEventListener('contextmenu', (e) => { rootSentinel.push(e) })
  const ev = {
    target: sc.tree,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    stopImmediatePropagation() { this.propagationStopped = true },
  }
  handlers[0](ev)
  if (!ev.propagationStopped) sc.tree.dispatch('contextmenu', ev)
  assert.equal(ev.propagationStopped, false, 'no host rows + only our own region rows must not be mistaken for the stock sidebar')
  console.log('✔ our own rows alone can never be mistaken for a host sidebar')
}

// --- LATE SIDEBAR: the sidebar renders AFTER the plugin mounted.
// A mount-time probe returned `none` on the real machine while eighteen
// `[data-dcu-session]` rows were already there by the first right-click, and
// the plugin never re-evaluated — so the wrong branch killed the host menu.
{
  const bare = makeTree()
  const { listeners } = await runBundle(bare, { pinned: [] })
  const handlers = listeners.get('contextmenu') ?? []

  // Right-click before any host row exists: must be inert.
  const alien = new El('div')
  alien.setAttribute('data-nothing', '')
  bare.tree.appendChild(alien)
  const early = {
    target: alien, defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    stopImmediatePropagation() { this.propagationStopped = true },
  }
  handlers[0](early)
  assert.equal(early.propagationStopped, false, 'before the sidebar renders, nothing may interrupt')
  assert.equal(early.defaultPrevented, false)

  // Now the codex sidebar renders into the very same tree.
  const project = new El('div')
  project.className = 'dcu-wb-project'
  const head = new El('div')
  head.className = 'dcu-wb-project-head'
  head.setAttribute('role', 'treeitem')
  head.setAttribute('aria-expanded', 'true')
  head.addEventListener('click', () => { head.setAttribute('aria-expanded', 'false') })
  const row = new El('div')
  row.className = 'dcu-wb-session'
  row.setAttribute('data-dcu-session', S1)
  project.appendChild(head)
  project.appendChild(row)
  bare.tree.className = 'dcu-wb-tree'
  bare.tree.appendChild(project)

  // Wait out the memoization window so the next probe really re-reads the DOM.
  await new Promise(r => { harnessSetTimeout(r, 320) })

  // Right-click the now-rendered codex row. No shared context-menu owner exists
  // in this harness, so the plugin owns the row it positively resolved — and
  // still nothing of anyone else's may be touched.
  const late = {
    target: row, defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    stopImmediatePropagation() { this.propagationStopped = true },
  }
  handlers[0](late)
  await afterDispatch()
  assert.equal(late.defaultPrevented, true, 'with no owner, a resolved codex row is the plugin\'s to serve')
  assert.ok(
    bare.body.querySelector('[data-stp-menu]') !== null,
    'the late-rendered sidebar must be detected and served by the plugin\'s own menu',
  )

  const surface = new El('div')
  surface.setAttribute('data-menu-material', 'translucent')
  surface.setAttribute('role', 'menu')
  surface.appendChild(new El('button'))
  bare.body.appendChild(surface)
  await new Promise(r => { harnessSetTimeout(r, 120) })
  assert.equal(
    surface.querySelector('[data-stp-pin-item]'),
    null,
    'no menu surface is ever grafted into — not even for a late-rendered sidebar',
  )
  console.log('✔ a sidebar that renders after mount is detected and handled as codex')
}

// --- FOLDED GROUPS: the Pinned region must survive its own host rows leaving.
// Folding every group unmounted the last `session:` row, flavor detection
// returned `none`, and the reconcile tore the Pinned region off the sidebar —
// destroying the one surface the user needed at that exact moment.
{
  const sc = codexScaffold()
  const { dispose, nudge } = await runBundle(sc, { pinned: [S1] })
  assert.ok(sc.body.querySelector('[data-stp-region]') !== null, 'region mounted first')

  // Fold every group: the host rows go, the host container stays.
  for (const row of sc.tree.querySelectorAll('[data-dcu-session]')) row.remove()
  sc.head.setAttribute('aria-expanded', 'false')
  nudge()
  await new Promise(r => { harnessSetTimeout(r, 200) })
  const region = sc.body.querySelector('[data-stp-region]')
  assert.ok(region !== null, 'the Pinned region must NOT delete itself once every group is folded')
  assert.equal(region.parentElement, sc.listArea, 'and it must stay anchored above the session list')
  const rows = region.querySelectorAll('[data-stp-row]')
  assert.equal(rows.length, 1, 'the pinned session must still be listed')
  assert.equal(rows[0].getAttribute('data-stp-session'), S1)
  console.log('✔ folded groups: the Pinned region survives the unmount of every host session row')

  // The stock sidebar's own list element is its anchor, and it behaves the same.
  const off = officialScaffold()
  const offRun = await runBundle(off, { pinned: [S1] })
  assert.ok(off.body.querySelector('[data-stp-region]') !== null)
  for (const row of off.tree.querySelectorAll('[data-row-key^="session:"]')) row.remove()
  offRun.nudge()
  await new Promise(r => { harnessSetTimeout(r, 200) })
  assert.ok(off.body.querySelector('[data-stp-region]') !== null, 'official flavor: folded groups keep the region')
  offRun.dispose()
  console.log('✔ folded groups: same behavior on the stock sidebar rendering')

  // An UNRECOGNISED / removed sidebar must still tear the region down: the
  // anchor is a host node, so it stops matching the moment the host goes away.
  for (const node of [...sc.tree.children]) node.remove()
  sc.tree.className = ''
  sc.tree.removeAttribute('role')
  nudge()
  await new Promise(r => { harnessSetTimeout(r, 200) })
  assert.equal(
    sc.body.querySelector('[data-stp-region]'),
    null,
    'a removed sidebar must take the region with it — the anchor is never cached forever',
  )
  dispose()
  console.log('✔ a removed sidebar still detaches the region')
}

// --- SIDEBAR COMES BACK. Pin → sidebar unmounts → the SAME sidebar returns.
// The render memo records the projection it drew, not the DOM that drawing
// produced. The reconcile that finds no sidebar clears the region's children,
// so a memo left describing those (now absent) nodes made the returning sidebar
// — with the identical pin set, titles and selection — short-circuit
// `renderRegion` and stay permanently blank. The user pinned a session, the
// sidebar re-rendered, and Pinned never came back: no header, no rows, no error.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  assert.ok(region !== null, 'region mounted first')
  assert.equal(region.querySelectorAll('[data-stp-row]').length, 1)
  const titleBefore = region.querySelector('[data-stp-row-title]').textContent
  assert.equal(titleBefore, 'one', 'the header row carries the session title')

  // Take the host sidebar away entirely: no tree, no host class, no rows.
  const savedTree = sc.tree
  for (const node of [...savedTree.children]) node.remove()
  savedTree.className = ''
  savedTree.removeAttribute('role')
  run.nudge()
  await new Promise(r => { harnessSetTimeout(r, 200) })
  assert.equal(
    sc.body.querySelector('[data-stp-region]'),
    null,
    'with no sidebar the region must be torn down',
  )

  // The SAME sidebar comes back — same tree element, same host class, same
  // session row. Nothing about the projection changed while it was gone.
  const head = new El('div')
  head.className = 'dcu-wb-project-head'
  head.setAttribute('role', 'treeitem')
  head.setAttribute('aria-expanded', 'true')
  head.addEventListener('click', () => { head.setAttribute('aria-expanded', 'false') })
  const restored = new El('div')
  restored.className = 'dcu-wb-session dcu-wb-session-time'
  restored.setAttribute('role', 'treeitem')
  restored.setAttribute('data-dcu-session', S1)
  restored.appendChild(new El('span'))
  const project = new El('div')
  project.className = 'dcu-wb-project'
  project.appendChild(head)
  project.appendChild(restored)
  savedTree.className = 'dcu-wb-tree'
  // codex's anchor is `.dcu-wb-tree[role="tree"]` — BOTH the class and the role,
  // so the restored host has to carry both again.
  savedTree.setAttribute('role', 'tree')
  savedTree.appendChild(project)

  // Wait out the flavor memo so the probe genuinely re-reads the DOM.
  await new Promise(r => { harnessSetTimeout(r, 320) })
  run.nudge()
  await new Promise(r => { harnessSetTimeout(r, 200) })

  const back = sc.body.querySelector('[data-stp-region]')
  assert.ok(
    back !== null,
    'a returning sidebar must bring the Pinned region back with it, '
    + 'even though the pin set, titles and selection never changed',
  )
  const restoredRows = back.querySelectorAll('[data-stp-row]')
  assert.equal(restoredRows.length, 1, 'the pinned session must be listed again')
  assert.equal(
    restoredRows[0].getAttribute('data-stp-session'),
    S1,
    'and it must be the same session',
  )
  assert.equal(
    restoredRows[0].querySelector('[data-stp-row-title]').textContent,
    titleBefore,
    'the title must be re-rendered, not restored from a memo',
  )
  assert.ok(
    back.querySelector('[data-stp-region-header]') !== null,
    'the Pinned header must come back too — an empty shell is not a restore',
  )
  assert.equal(
    back.querySelector('[data-stp-region-count]').textContent,
    '1',
    'with the correct count',
  )
  console.log('✔ a sidebar that unmounts and returns brings the Pinned region back intact')

  // And the restored region must not re-enter the loop.
  const quiet = { ...mutationLog }
  await new Promise(r => { harnessSetTimeout(r, 1000) })
  assert.equal(
    mutationLog.records - quiet.records,
    0,
    'the restored region must be as loop-free as the original one',
  )
  console.log('✔ the restored region is loop-free')

  // A click on the re-rendered row navigates: it is a real row, not a ghost.
  restoredRows[0].click()
  await new Promise(r => { harnessSetTimeout(r, 20) })
  assert.deepEqual(run.opened, [S1], 'the restored row must navigate like any other')
  run.dispose()
}

// --- THE SELF-FEEDING LOOP. This is the measured failure, not a hypothetical.
// The plugin's own MutationObserver fed the plugin's own DOM edits back into
// reconcile, which rewrote the same children again 60ms later: an unbounded
// ~16Hz rebuild. Two consequences were visible in the real UI — the region rows
// were destroyed and recreated forever, and a row replaced BETWEEN a gesture's
// pointerdown and its pointerup never receives the click, because the browser
// dispatches `click` on the nearest common ancestor of the two targets. That is
// why "click Pinned, nothing happens" happened while the row was plainly there.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  assert.ok(region !== null, 'region mounted')

  // Let the loop get going, then measure it on a genuinely idle document.
  await new Promise(r => { harnessSetTimeout(r, 200) })
  const firstRow = region.querySelectorAll('[data-stp-row]')[0]
  const before = { ...mutationLog }
  await new Promise(r => { harnessSetTimeout(r, 1000) })
  const ownMutations = mutationLog.records - before.records
  assert.equal(
    ownMutations,
    0,
    `one idle second must produce zero DOM mutations; got ${ownMutations}. `
    + 'A non-zero count here is the self-feeding reconcile loop.',
  )
  assert.equal(
    region.querySelectorAll('[data-stp-row]')[0],
    firstRow,
    'an idle second must leave the very same row node in place — identity is load-bearing',
  )
  console.log('✔ an idle second produces zero mutations and preserves row node identity')

  // A gesture split across a pointerdown/pointerup pair must still land: the
  // node the user pressed is the node the browser will dispatch click on.
  const stillThere = region.querySelectorAll('[data-stp-row]')[0]
  assert.equal(stillThere, firstRow, 'the node identity must survive up to the pointerup')
  stillThere.click()
  await new Promise(r => { harnessSetTimeout(r, 20) })
  assert.deepEqual(run.opened, [S1], 'a click on an unchanged pinned row must navigate')
  console.log('✔ a click on a row that was never rebuilt reaches its handler')

  // A real pin change must still propagate — the memo must not be a freeze.
  run.live.pinned = [S1, S2]
  run.nudge()
  await new Promise(r => { harnessSetTimeout(r, 200) })
  const rows = region.querySelectorAll('[data-stp-row]')
  assert.equal(rows.length, 2, 'pinning a second session must add a row')
  assert.equal(rows[1].getAttribute('data-stp-session'), S2, 'in pin order')

  // A title change must update the row in place rather than leave it stale.
  run.live.byId[S2] = { id: S2, displayTitle: 'renamed', updatedAt: 5 }
  run.nudge()
  await new Promise(r => { harnessSetTimeout(r, 200) })
  const renamed = [...region.querySelectorAll('[data-stp-row]')]
    .find(row => row.getAttribute('data-stp-session') === S2)
  assert.equal(
    renamed.querySelector('[data-stp-row-title]').textContent,
    'renamed',
    'a changed summary title must reach the rendered row',
  )

  // The active session is the main model's own field, nothing invented.
  assert.equal(
    region.querySelectorAll('[data-stp-row][aria-current="true"]').length,
    0,
    'with no main session there is no selected row',
  )
  run.live.mainSessionId = S2
  run.nudge()
  await new Promise(r => { harnessSetTimeout(r, 200) })
  const selected = region.querySelectorAll('[data-stp-row][aria-current="true"]')
  assert.equal(selected.length, 1, 'uiWorkspace.mainReference must light exactly one row')
  assert.equal(selected[0].getAttribute('data-stp-session'), S2)
  assert.equal(
    region.querySelectorAll('[data-stp-row][aria-selected]').length,
    0,
    'selection is aria-current: aria-selected is the shared owner\'s steering input',
  )
  console.log('✔ pin, title and active-session changes all propagate; only the main model marks selection')

  // Unpinning the last session takes the region back down and stops the loop.
  run.live.pinned = []
  run.nudge()
  await new Promise(r => { harnessSetTimeout(r, 200) })
  assert.equal(sc.body.querySelector('[data-stp-region]'), null, 'an empty pin set detaches the region')

  const quiescent = { ...mutationLog }
  await new Promise(r => { harnessSetTimeout(r, 1000) })
  assert.equal(mutationLog.records - quiescent.records, 0, 'detaching must not start the loop either')
  console.log('✔ tearing the region down is also loop-free')
  run.dispose()
}

/** The visible text of the region's header: this harness's El keeps text per node. */
function headerTextOf(region) {
  const header = region.querySelector('[data-stp-region-header]')
  return header === null ? '' : [...header.children].map(node => node.textContent).join('')
}

// --- LOCALE: a missing entry commonly comes back AS THE KEY. That is a miss,
//     not a translation, and printing it would put the literal string
//     "region.pinned" above the user's sessions — a second, differently-labelled
//     thing that LOOKS like this plugin's region.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, {
    pinned: [S1],
    locale: { bind: () => (key) => key },
  })
  const region = sc.body.querySelector('[data-stp-region]')
  assert.ok(region !== null, 'region must render')
  const headerText = headerTextOf(region)
  assert.ok(
    !headerText.includes('region.pinned'),
    `the raw key must never reach the header; got ${JSON.stringify(headerText)}`,
  )
  assert.match(headerText, /已置顶/, 'a key-echoing locale must fall back to the built-in label')
  assert.equal(region.getAttribute('aria-label'), '已置顶', 'the group name is the same readable label')
  console.log('✔ a locale that echoes the key back falls back to the built-in label')
  run.dispose()
}

// --- LOCALE: a real translation is used, and an empty answer is a miss.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, {
    pinned: [S1],
    locale: { bind: () => (key) => (key === 'region.pinned' ? '已固定会话' : '') },
  })
  const region = sc.body.querySelector('[data-stp-region]')
  assert.match(headerTextOf(region), /已固定会话/, 'a real translation must win over the built-in label')
  assert.equal(region.getAttribute('aria-label'), '已固定会话', 'the group name follows the translation too')
  console.log('✔ a real locale translation is used, and an empty answer falls back')
  run.dispose()
}

// =================================================================== R19
// TRUSTED IDENTITY. Everything above proves the plugin works when the host
// sidebar is real. Everything below proves it stays OUT of a page that merely
// happens to contain an `[role="tree"][aria-label]`.
//
// The measured failure (1015.md §2 R19): with neither real sidebar present,
// `detectFlavor` accepted ANY labelled tree — a file tree is enough — and
// `findTree` accepted a lone candidate without asking what was inside it. The
// region was then injected into the unrelated tree's ancestor:
// `UNRELATED_TREE_ANCHOR {"hasHostSessionRows":false,"hasWorkspaceRows":false,
// "regionInsideUnrelatedTreeHost":true}`.
//
// What counts as PROOF of the host sidebar, and why each one is real:
//   - a `session:` row and a `workspace:` group header are the STOCK sidebar's
//     own `data-row-key` vocabulary (src/core.js, restated as literals in the
//     bundle and locked by test/core.test.js). The group header stays mounted
//     while every group is folded, which is what keeps an all-folded stock
//     sidebar identifiable.
//   - `.dcu-wb-tree[role="tree"]` is codex-ui's OWN container class.
// No "official container" selector is invented here: an empty stock sidebar has
// no provable marker, so it stays unknown and observe-only.

/** A contextmenu event shaped like the ones the harness already uses. */
function rawContextMenu(target) {
  return {
    target,
    clientX: 30,
    clientY: 40,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    stopImmediatePropagation() { this.propagationStopped = true },
  }
}

// --- R19 (1) ONE unrelated labelled tree: zero region, zero hide rules, zero claim.
{
  const s = makeTree()
  // A file tree. It answers the stock flavor's `treeSelector` AND its former
  // `anchorSelector` — and carries no word of the host's vocabulary.
  s.tree.setAttribute('aria-label', 'Files')
  const fileRow = new El('div')
  fileRow.setAttribute('role', 'treeitem')
  fileRow.setAttribute('data-path', '/repo/src/client.js')
  s.tree.appendChild(fileRow)

  const run = await runBundle(s, { pinned: [S1] })
  assert.equal(
    s.body.querySelector('[data-stp-region]'),
    null,
    'a lone unrelated aria-label tree must never receive the pinned region',
  )
  assert.deepEqual(
    sheetRules(s),
    [],
    'and must never receive a hide rule for somebody else\'s rows',
  )

  const ev = rawContextMenu(fileRow)
  const handlers = run.listeners.get('contextmenu') ?? []
  assert.ok(handlers.length > 0, 'the contextmenu listener stays installed — observe-only')
  handlers[0](ev)
  await afterDispatch()
  assert.equal(ev.defaultPrevented, false, 'an unknown sidebar must not be preventDefault-ed')
  assert.equal(ev.propagationStopped, false, 'and its events must not be interrupted')
  assert.equal(
    s.body.querySelector('[data-stp-menu]'),
    null,
    'and no menu of ours may appear over it',
  )
  run.dispose()
  console.log('✔ R19: one unrelated aria-label tree is observed only — no region, no rules, no claim')
}

// --- R19 (2) SEVERAL unrelated labelled trees: same answer, and none of them is
// picked. "Take the first" is exactly what the failure was.
{
  const s = makeTree()
  s.tree.setAttribute('aria-label', 'Files')
  const files = new El('div')
  files.setAttribute('role', 'treeitem')
  files.setAttribute('data-path', '/repo/README.md')
  s.tree.appendChild(files)

  // A second labelled tree, structurally identical in the ways that used to
  // matter: a role, a label, and nothing this plugin recognises.
  const search = new El('div')
  search.setAttribute('role', 'tree')
  search.setAttribute('aria-label', 'Search')
  const hit = new El('div')
  hit.setAttribute('role', 'treeitem')
  hit.setAttribute('data-path', '/repo/hit.md')
  search.appendChild(hit)
  s.listArea.appendChild(search)

  const run = await runBundle(s, { pinned: [S1] })
  assert.equal(
    s.body.querySelector('[data-stp-region]'),
    null,
    'several unrelated trees must be treated exactly like one: unknown',
  )
  assert.deepEqual(sheetRules(s), [], 'and must produce no hide rules either')
  assert.equal(
    s.tree.children.indexOf(files),
    0,
    "an unrelated tree's own children must be left exactly where they were",
  )
  assert.equal(search.parentElement, s.listArea, 'the second tree is not re-parented either')
  assert.equal(search.children.indexOf(hit), 0, 'and neither are its children')
  run.dispose()
  console.log('✔ R19: several unrelated aria-label trees are equally unknown, none of them chosen')
}

// --- R19 (3) PRESERVATION: an unrelated labelled tree must not HIDE the real
// sidebar. This one is green before and after the fix and is here to prove the
// stricter rule did not cost us the search-view case: when a genuine host
// marker IS present, the plugin still resolves, and still resolves to the tree
// that carries it rather than to whichever tree came first.
{
  const s = makeTree()
  const files = new El('div')
  files.setAttribute('role', 'tree')
  files.setAttribute('aria-label', 'Files')
  s.listArea.insertBefore(files, s.listArea.firstChild)

  // The real codex sidebar, mounted into the existing skeleton.
  s.tree.className = 'dcu-wb-tree'
  const project = new El('div')
  project.className = 'dcu-wb-project'
  const head = new El('div')
  head.className = 'dcu-wb-project-head'
  head.setAttribute('role', 'treeitem')
  head.setAttribute('aria-expanded', 'true')
  head.addEventListener('click', () => { head.setAttribute('aria-expanded', 'false') })
  const row = new El('div')
  row.className = 'dcu-wb-session'
  row.setAttribute('data-dcu-session', S1)
  row.appendChild(new El('span'))
  project.appendChild(head)
  project.appendChild(row)
  s.tree.appendChild(project)

  const run = await runBundle(s, { pinned: [S1] })
  const region = s.body.querySelector('[data-stp-region]')
  assert.ok(region !== null, 'the real sidebar must still be detected and served')
  assert.equal(
    region.parentElement,
    s.listArea,
    'and the region anchors on the real tree\'s host, not on the unrelated tree',
  )
  assert.equal(
    files.querySelector('[data-stp-region]'),
    null,
    'the unrelated tree must be left completely alone',
  )
  // The region is prepended to the real tree's host, which is the designed
  // anchor; what must hold is that the unrelated tree keeps its OWN place in
  // that host — same parent, same order relative to the host content it had.
  assert.equal(files.parentElement, s.listArea, 'the unrelated tree is not re-parented')
  assert.ok(
    s.listArea.children.indexOf(files) < s.listArea.children.indexOf(s.treeBody),
    'the unrelated tree keeps its place ahead of the host list body it was mounted before',
  )
  run.dispose()
  console.log('✔ R19: an unrelated labelled tree neither hides nor displaces the real sidebar')
}

// =================================================================== R08
// KEYED ROW REUSE. The region is rebuilt wholesale whenever the global
// signature moves, and the signature contains every pin's raw `updatedAt`,
// `displayTitle` and the current selection. One session's timestamp changing
// therefore used to `clearChildren` the whole region: measured at P=1000 that
// created 4004 nodes and 2000 listeners and retained zero old rows.
//
// Node identity is what makes a click land at all. The browser dispatches
// `click` on the nearest common ancestor of the pointerdown and pointerup
// targets, so a row replaced mid-gesture silently swallows the click, and
// keyboard focus is lost with it. These cases therefore assert IDENTITY, not
// text: what has to stay put is the node.

/** Wait past the reconcile debounce (60ms) for a 1000-row region. */
function settle(ms = 250) {
  return new Promise(resolve => { harnessSetTimeout(resolve, ms) })
}

/** Total listener registrations across a set of fake rows. */
function listenersOf(rows) {
  let total = 0
  for (const row of rows) {
    for (const handlers of row.listeners.values()) total += handlers.length
  }
  return total
}

/** A per-row snapshot of everything the plugin sets as an attribute. */
function attributeShape(rows) {
  return rows.map(row => [...row.attributes.entries()].map(([k, v]) => `${k}=${v}`).sort().join('|'))
}

{
  const MANY = 1000
  const many = Array.from(
    { length: MANY },
    (_, i) => `session-${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
  )
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: many })
  const region = sc.body.querySelector('[data-stp-region]')
  assert.ok(region !== null, 'the region mounts for a 1000-session pin set')
  assert.equal(region.querySelectorAll('[data-stp-row]').length, MANY)

  // The summaries arrive after the rows do, which is the real order: the pin
  // registry is durable, the session list is not.
  const summaries = {}
  for (const [i, id] of many.entries()) summaries[id] = { id, displayTitle: `title-${i}`, updatedAt: 1 }
  Object.assign(run.live.byId, summaries)
  run.nudge()
  await settle()

  const nodes = [...region.querySelectorAll('[data-stp-row]')]
  const listenersBefore = listenersOf(nodes)
  assert.equal(listenersBefore, MANY * 2, 'each row registers its own click and keydown pair')
  const titlesBefore = nodes.map(row => row.querySelector('[data-stp-row-title]').textContent)

  // ---- (1) ONE summary moves. Everything else must not be touched.
  run.live.byId[many[500]] = { ...summaries[many[500]], updatedAt: 2 }
  run.nudge()
  await settle()
  const afterSummary = [...region.querySelectorAll('[data-stp-row]')]
  assert.equal(afterSummary.length, MANY, 'the row count does not move')
  let rebuilt = -1
  for (let i = 0; i < MANY; i += 1) {
    if (afterSummary[i] !== nodes[i]) { rebuilt = i; break }
  }
  assert.equal(
    rebuilt,
    -1,
    `every row must survive a single summary change; row ${rebuilt} was recreated`,
  )
  assert.equal(
    listenersOf(afterSummary),
    listenersBefore,
    'an in-place update must not add a single listener',
  )
  const titlesAfter = afterSummary.map(row => row.querySelector('[data-stp-row-title]').textContent)
  assert.deepEqual(titlesAfter, titlesBefore, 'and it must not rewrite unrelated titles')
  console.log(`✔ R08: one summary change in ${MANY} pinned rows rebuilds nothing and adds no listener`)

  // ---- (2) CURRENT moves. Exactly two rows may change, and nothing else.
  run.live.mainSessionId = many[10]
  run.nudge()
  await settle()
  // Snapshot BETWEEN the two switches, so the row that was current and the row
  // that becomes current are both visible as changes.
  const shapeBefore = attributeShape(nodes)
  run.live.mainSessionId = many[700]
  run.nudge()
  await settle()
  const afterCurrent = [...region.querySelectorAll('[data-stp-row]')]
  for (let i = 0; i < MANY; i += 1) {
    assert.equal(afterCurrent[i], nodes[i], `row ${i} must keep its node across a current switch`)
  }
  const shapeAfter = attributeShape(afterCurrent)
  const changed = []
  for (let i = 0; i < MANY; i += 1) {
    if (shapeBefore[i] !== shapeAfter[i]) changed.push(i)
  }
  assert.deepEqual(
    changed,
    [10, 700],
    'only the row that was current and the row that became current may change',
  )
  const selected = region.querySelectorAll('[data-stp-row][aria-current="true"]')
  assert.equal(selected.length, 1, 'exactly one row is the active session')
  assert.equal(selected[0].getAttribute('data-stp-session'), many[700])
  console.log('✔ R08: switching current touches exactly the two rows involved')

  // ---- (3) A gesture and a keypress spanning an update still land.
  const pressed = nodes[7]
  run.live.byId[many[7]] = { ...summaries[many[7]], updatedAt: 3 }
  run.nudge()
  await settle()
  assert.equal(
    region.querySelectorAll('[data-stp-row]')[7],
    pressed,
    'the node the pointer went down on must still be there at pointerup',
  )
  pressed.click()
  await settle(30)
  assert.equal(run.opened[run.opened.length - 1], many[7], 'the split click reached its own row')

  const keyed = nodes[8]
  run.live.byId[many[8]] = { ...summaries[many[8]], updatedAt: 3 }
  run.nudge()
  await settle()
  assert.equal(
    region.querySelectorAll('[data-stp-row]')[8],
    keyed,
    'keyboard focus lives on the node, so it survives the same kind of update',
  )
  keyed.dispatch('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} })
  await settle(30)
  assert.equal(run.opened[run.opened.length - 1], many[8], 'Enter still opens that session')
  console.log('✔ R08: a click split by a re-render, and a keypress, both reach the pressed row')

  // ---- (4) Official pin add/remove: insert in the official order, keep the rest.
  const extra = 'session-ffffffff-ffff-4fff-8fff-ffffffffffff'
  run.live.byId[extra] = { id: extra, displayTitle: 'extra', updatedAt: 1 }
  run.live.pinned = [extra, ...many]
  run.nudge()
  await settle()
  const added = [...region.querySelectorAll('[data-stp-row]')]
  assert.equal(added.length, MANY + 1)
  assert.equal(
    added[0].getAttribute('data-stp-session'),
    extra,
    'the official pin sequence is the only ordering source',
  )
  for (let i = 1; i <= MANY; i += 1) {
    assert.equal(added[i], nodes[i - 1], `row ${i} must keep its node when one pin is added`)
  }
  run.live.pinned = [...many]
  run.nudge()
  await settle()
  const removed = [...region.querySelectorAll('[data-stp-row]')]
  assert.equal(removed.length, MANY, 'an unpinned session leaves the region')
  for (let i = 0; i < MANY; i += 1) assert.equal(removed[i], nodes[i], 'and the others keep their nodes')
  assert.equal(region.querySelectorAll(`[data-stp-session="${extra}"]`).length, 0)
  console.log('✔ R08: official pin add/remove inserts and drops one row, and preserves every other')

  // ---- (5) PRESERVATION: an unchanged projection still writes nothing at all.
  const beforeQuiet = { ...mutationLog }
  await settle(1000)
  assert.equal(
    mutationLog.records - beforeQuiet.records,
    0,
    'an idle second over 1000 pinned rows must still be completely silent',
  )
  run.dispose()
}

// --- R08 REORDER: the official pin sequence can also REORDER pins that already
// exist. Until the fake `insertBefore` was given the spec's pre-insert move
// semantics, this block was unanswerable — every case produced duplicate rows
// and the wrong order, which points a fixer at the production code rather than
// at the harness. These cases are what makes "the official pin order is the
// only source" a measured claim instead of a declared one.
{
  const N = 12
  const ids = Array.from(
    { length: N },
    (_, i) => `session-${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
  )
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: ids })
  const region = sc.body.querySelector('[data-stp-region]')
  assert.equal(region.querySelectorAll('[data-stp-row]').length, N, 'every pin has a row')
  const nodes = [...region.querySelectorAll('[data-stp-row]')]
  const listenersBefore = listenersOf(nodes)
  const nodeById = new Map(nodes.map(row => [row.getAttribute('data-stp-session'), row]))

  const swap = (from, to) => {
    const next = [...ids]
    const held = next[from]
    next[from] = next[to]
    next[to] = held
    return next
  }
  const cases = [
    ['reverse', [...ids].reverse()],
    ['rotate the head to the tail', [...ids.slice(1), ids[0]]],
    ['swap two distant rows', swap(1, N - 2)],
    ['interleave evens and odds', [
      ...ids.filter((_, i) => i % 2 === 0),
      ...ids.filter((_, i) => i % 2 === 1),
    ]],
  ]
  for (const [name, order] of cases) {
    run.live.pinned = [...order]
    run.nudge()
    await settle()
    const now = [...region.querySelectorAll('[data-stp-row]')]
    assert.equal(now.length, N, `${name}: a reorder must not change the row count`)
    assert.deepEqual(
      now.map(row => row.getAttribute('data-stp-session')),
      order,
      `${name}: the DOM order must be the official pin order`,
    )
    assert.equal(
      new Set(now.map(row => row.getAttribute('data-stp-session'))).size,
      N,
      `${name}: every row appears exactly once`,
    )
    // Identity is per SESSION, not per position: after a reorder the row at
    // index i is whichever row the pin sequence put there.
    for (const row of now) {
      const id = row.getAttribute('data-stp-session')
      assert.equal(row, nodeById.get(id), `${name}: the row for ${id} keeps its own node`)
    }
    assert.equal(listenersOf(now), listenersBefore, `${name}: a reorder adds no listener`)
  }
  run.dispose()
  console.log(`✔ R08: official pin reorder (${cases.length} shapes) follows the pin sequence and reuses every node`)
}

// --- R08b INCREMENT: the compact relative-time label follows its OWN display
// bucket. The label is derived from Date.now(), so with nothing else changing
// the projection signature never moves and the row keeps printing the label it
// rendered minutes ago. The refresh must not be a periodic full re-render —
// that is the wholesale rebuild R08 removed — so it is armed on the bucket
// edges and writes the label text only.
//
// The harness is NOT faked to make this fast: the summary is placed one bucket
// edge away (`now - 59.6s`) and the test waits for the real timer. What this
// cannot prove is real browser behavior: no real clock skew, no background-tab
// throttling, no real font/layout.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  const row = region.querySelectorAll('[data-stp-row]')[0]
  // 400 ms short of the "just now" → "1 minute" edge.
  run.live.byId[S1] = { id: S1, displayTitle: 'one', updatedAt: Date.now() - 59_600 }
  run.nudge()
  await settle()
  const cell = row.querySelector('[data-stp-row-time]')
  assert.ok(cell !== null, 'a loaded summary renders a time cell')
  assert.equal(cell.textContent, '刚刚', '400ms before the edge the label is still "just now"')

  // No nudge, no host event: the plugin refreshes on its own.
  await settle(1500)
  const refreshed = region.querySelectorAll('[data-stp-row]')[0]
  assert.equal(refreshed, row, 'the label refresh must not rebuild the row')
  assert.equal(
    refreshed.querySelector('[data-stp-row-time]').textContent,
    '1分钟',
    'and it must have crossed the bucket edge',
  )
  assert.equal(listenersOf([refreshed]), 2, 'no listener was added on the way')
  run.dispose()
  console.log('✔ R08: the compact time label crosses its bucket on its own low-frequency timer')
}

// --- R08b DISPOSAL: the refresh timer belongs to the mount that armed it.
//
// The earlier version of this case argued from the process: "an unreleased
// self-rearming one-minute timer would keep the event loop busy, so a clean exit
// IS the assertion". That argument was wrong, and so was the source comment
// beside `unref()`: `unref()` detaches the timer from the loop's refcount, so an
// uncleared timer cannot hold Node open at all — deleting the `clearTimeout`
// left the whole suite green. A process that exits is NOT evidence that a timer
// was released.
//
// The evidence here is the harness's own live-timer set: every `setTimeout` the
// plugin creates is recorded, `clearTimeout` removes it, and a timer that fires
// removes itself. The harness's own waits therefore never linger in the set, so
// what is left after dispose is the plugin's, and only the plugin's.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  run.live.byId[S1] = { id: S1, displayTitle: 'one', updatedAt: Date.now() - 59_600 }
  run.nudge()
  await settle()
  assert.equal(region.querySelector('[data-stp-row-time]').textContent, '刚刚')
  assert.ok(
    run.liveTimers().length > 0,
    'the mount really did arm a timer, so "none left" can mean something',
  )
  run.dispose()
  assert.deepEqual(
    run.liveTimers(),
    [],
    `disposal must leave no live timer behind; still armed: ${run.liveTimers().length}`,
  )
  assert.equal(region.children.length, 0, 'disposal takes the rows with it')
  await settle(1200)
  assert.equal(
    region.querySelector('[data-stp-row-time]'),
    null,
    'a disposed generation must not keep writing labels',
  )
  console.log('✔ R08: disposal releases the label refresh (proven by the live-timer set, not by exit)')
}

// --- LOCALE, READ-ONLY ASSESSMENT. Is switching the language service a defect
// in this build? Nothing is changed here on the strength of it: this case only
// records what the shipped code does when the locale's answers change under a
// plugin that is already mounted.
{
  const sc = codexScaffold()
  const answers = { 'region.pinned': '已固定会话', 'time.minute': '分钟', 'menu.pin': '顶置' }
  let lang = 'zh'
  const run = await runBundle(sc, {
    pinned: [S1],
    locale: { bind: () => (key) => answers[`${lang}:${key}`] ?? answers[key] },
  })
  const region = sc.body.querySelector('[data-stp-region]')
  assert.match(headerTextOf(region), /已固定会话/, 'the header uses the locale answer')

  // The user switches language. The host republishes its list, which is what
  // drives a reconcile.
  lang = 'en'
  answers['en:region.pinned'] = 'Pinned sessions'
  run.nudge()
  await settle()
  const afterSwitch = sc.body.querySelector('[data-stp-region]')
  const label = afterSwitch === null ? '' : headerTextOf(afterSwitch)
  console.log(
    `  · locale switch with an unchanged projection → header reads ${JSON.stringify(label)}`,
  )
  // Recorded, not asserted either way: the finding belongs in the report, and
  // the coordinates of the defect (a projection-keyed memo that carries no
  // locale in it) are visible from this one line.
  run.dispose()
}

// =================================================================== R07
// THE FOLD CONTRACT. Three independent failures live here, and they are
// asserted separately because they have separate fixes:
//
//   S3  a group seen for the first time with no pin was unconditionally
//       EXPANDED, undoing a workspace the user had kept folded for good
//       (`GROUP_ZERO_PINS_INITIAL {"before":"false","after":"true"}`).
//   S4  the signature was a positional bitmap of the group's session list, so
//       re-ordering two sessions looked like a pin change and re-folded a group
//       the user had opened by hand
//       (`GROUP_ORDER_ONLY_CHANGE {"manuallyExpanded":"true", …}`).
//   S5  the signature was recorded BEFORE the header was found and clicked, so a
//       late header, an ineffective click or a throwing click was remembered as
//       done and never retried (`GROUP_HEADER_LATE`, `GROUP_TOGGLE_RETRY`).
//
// The scaffold counts BOTH clicks and real state transitions: acceptance 3 is
// about the final state having been toggled once, not about how many times
// `click()` was called.

/**
 * A stock sidebar with one foldable header per workspace.
 *
 * `mode` decides what the host's own toggle does when the plugin clicks it:
 *
 *   `normal`       toggles synchronously (the real thing);
 *   `inert`        accepts the click and changes nothing;
 *   `late:<ms>`    accepts the click and applies the toggle only AFTER that delay;
 *   `throw-listener`  the host's own handler throws — which `El.dispatch`
 *                  reports and swallows, exactly as the DOM does, so the
 *                  plugin's `click()` call returns normally and learns nothing;
 *   `no-click`     `click` itself is not usable, so nothing is dispatched at
 *                  all. This is the only shape `toggleGroupHeader`'s catch can
 *                  see in a real browser, and it is the only one where
 *                  "nothing was toggled" is actually true.
 *
 * `late` is the case that matters for the double-toggle rule: a real host's
 * state lands on its own schedule (React commit, long task, throttled
 * background tab), and the plugin cannot tell "not applied yet" from "never
 * applied". A harness that only has `normal` and `inert` cannot see that
 * difference at all — under `inert` a retry is simply the correct behavior,
 * so a double toggle is indistinguishable from a recovery.
 *
 * There is deliberately NO mode in which a click appears to be "refused"
 * because a listener threw: no browser reports one back to the caller.
 */
function foldScaffold() {
  const s = makeTree()
  s.tree.setAttribute('aria-label', 'sessions')
  const heads = new Map()
  const makeGroup = (key, expanded, mode = 'normal') => {
    const head = new El('div')
    head.setAttribute('role', 'treeitem')
    head.setAttribute('data-row-key', `workspace:${key}`)
    head.setAttribute('aria-expanded', String(expanded))
    head.clicks = 0
    head.transitions = 0
    head.attempts = 0
    head.mode = mode
    if (head.mode === 'no-click') {
      // The defensive shape: the method the plugin calls does not exist / does
      // not dispatch. Nothing reached the host, so nothing could have toggled.
      head.click = () => {
        head.attempts += 1
        throw new TypeError('header.click is not a function')
      }
    }
    head.addEventListener('click', () => {
      head.clicks += 1
      if (head.mode === 'throw-listener') throw new Error("the host's own toggle handler blew up")
      // A real toggle handler reads the state WHEN IT RUNS, not when the click
      // was delivered. That is what makes a second click undo the first instead
      // of repeating it.
      const apply = () => {
        const before = head.getAttribute('aria-expanded')
        head.setAttribute('aria-expanded', before === 'true' ? 'false' : 'true')
        if (head.getAttribute('aria-expanded') !== before) head.transitions += 1
      }
      if (head.mode === 'inert') return
      if (head.mode.startsWith('late:')) {
        harnessSetTimeout(apply, Number(head.mode.slice('late:'.length)))
        return
      }
      apply()
    })
    s.tree.appendChild(head)
    heads.set(key, head)
    return head
  }
  return { ...s, heads, makeGroup }
}

const TWO_GROUPS = [
  { workspaceId: 'wA', title: 'A', sessionIds: [S1, S2] },
  { workspaceId: 'wB', title: 'B', sessionIds: [S2] },
]

/**
 * A STORE-BACKED host, which `foldScaffold` cannot be.
 *
 * `foldScaffold` keeps the truth in the header node's own attribute, so that
 * host has nothing to redraw from — the node IS the state, and a replacement
 * would mean a state change. A real sidebar keeps the truth in a store and
 * DERIVES each header from it, which means it can hand the plugin a brand-new
 * element for the same workspace at any moment, carrying the value the store
 * holds right now — which, mid-flight, is still the old value.
 *
 * So this scaffold can express the failure mode the element-identity gate
 * created: a click whose commit is still pending, on a header that has since
 * been re-rendered. Clicks and transitions are counted per WORKSPACE and
 * survive every replacement, because the question is how many times the group
 * was toggled, not how many nodes existed along the way.
 */
function storeFoldScaffold() {
  const s = makeTree()
  s.tree.setAttribute('aria-label', 'sessions')
  const store = new Map()
  const delays = new Map()
  const totals = new Map()
  const nodes = new Map()
  const stat = (key) => {
    if (!totals.has(key)) totals.set(key, { clicks: 0, transitions: 0 })
    return totals.get(key)
  }
  const draw = (key) => {
    const t = stat(key)
    const head = new El('div')
    head.setAttribute('role', 'treeitem')
    head.setAttribute('data-row-key', `workspace:${key}`)
    head.setAttribute('aria-expanded', String(store.get(key)))
    head.addEventListener('click', () => {
      t.clicks += 1
      // The host commits on its own schedule and then repaints whichever node
      // is current: the store-backed shape of a delayed host.
      harnessSetTimeout(() => {
        store.set(key, !store.get(key))
        t.transitions += 1
        const current = nodes.get(key)
        if (current !== undefined) current.setAttribute('aria-expanded', String(store.get(key)))
      }, delays.get(key) ?? 0)
    })
    nodes.set(key, head)
    return head
  }
  const mount = (key, expanded, delayMs = 0) => {
    store.set(key, expanded)
    delays.set(key, delayMs)
    const head = draw(key)
    s.tree.appendChild(head)
    return head
  }
  /** A re-render: same workspace, brand-new node, the store's current value. */
  const rebuild = (key) => {
    const previous = nodes.get(key)
    const head = draw(key)
    const at = s.tree.children.indexOf(previous)
    s.tree.insertBefore(head, at < 0 ? undefined : s.tree.children[at + 1])
    previous.remove()
    return head
  }
  return {
    ...s,
    mount,
    rebuild,
    clicks: (key) => stat(key).clicks,
    transitions: (key) => stat(key).transitions,
    expanded: (key) => store.get(key),
    // NOT named `head`: makeTree returns the document's `<head>` element under
    // that name, and `document.head` is what the bundle resolves stylesheets
    // against. A local accessor of the same name silently replaced it with a
    // function, every reconcile threw inside the plugin's own catch, and the
    // fold simply never happened.
    headerOf: (key) => nodes.get(key),
  }
}

// --- S3: a group seen for the first time with NO pin is left exactly as the
// user has it, on first mount and again after the plugin is torn down and
// re-applied (the "service reload" shape).
{
  const sc = foldScaffold()
  sc.makeGroup('wA', false)
  sc.makeGroup('wB', false)
  const run = await runBundle(sc, { pinned: [], items: TWO_GROUPS })
  await settle()
  for (const key of ['wA', 'wB']) {
    assert.equal(
      sc.heads.get(key).getAttribute('aria-expanded'),
      'false',
      `${key} was folded before the plugin ever touched it, and must stay folded`,
    )
    assert.equal(sc.heads.get(key).clicks, 0, `${key} must not be clicked on first sight`)
  }
  // Later notifications change nothing either.
  run.nudge()
  run.nudge()
  await settle()
  assert.equal(sc.heads.get('wA').clicks + sc.heads.get('wB').clicks, 0, 'and never afterwards')
  run.dispose()

  // A second instance over the SAME document — what a reload of the plugin
  // looks like to the sidebar — starts with the same respect.
  const again = await runBundle(sc, { pinned: [], items: TWO_GROUPS })
  await settle()
  assert.equal(
    sc.heads.get('wA').getAttribute('aria-expanded'),
    'false',
    'a re-applied plugin must not expand a group it never folded',
  )
  assert.equal(sc.heads.get('wA').clicks + sc.heads.get('wB').clicks, 0, 'and must not click it')
  again.dispose()
  console.log('✔ R07/S3: a first sighting with no pin leaves the user\'s fold exactly as it was')
}

// --- S4: the signature is the SET of pinned members. Re-ordering, or adding a
// session that is not pinned, is not a pin change and must not re-touch a group
// the user opened by hand.
{
  const sc = foldScaffold()
  const a = sc.makeGroup('wA', 'true')
  sc.makeGroup('wB', 'true')
  const run = await runBundle(sc, { pinned: [S1], items: TWO_GROUPS })
  await settle()
  assert.equal(a.getAttribute('aria-expanded'), 'false', 'a group holding a pin folds on load')
  assert.equal(a.clicks, 1, 'exactly one click')

  // The user opens it again by hand.
  a.setAttribute('aria-expanded', 'true')
  const clicksBefore = a.clicks

  run.live.items = [
    { workspaceId: 'wA', title: 'A', sessionIds: [S2, S1] },
    { workspaceId: 'wB', title: 'B', sessionIds: [S2] },
  ]
  run.nudge()
  await settle()
  assert.equal(a.clicks, clicksBefore, 'a pure re-order must not click the header again')
  assert.equal(a.getAttribute('aria-expanded'), 'true', 'and must not re-fold what the user opened')

  run.live.items = [
    { workspaceId: 'wA', title: 'A', sessionIds: [S2, S1, S9] },
    { workspaceId: 'wB', title: 'B', sessionIds: [S2] },
  ]
  run.nudge()
  await settle()
  assert.equal(a.clicks, clicksBefore, 'adding an UNPINNED session is not a pin change either')
  assert.equal(a.getAttribute('aria-expanded'), 'true')
  run.dispose()
  console.log('✔ R07/S4: the fold signature is the pinned member SET — order and non-pin churn are ignored')
}

// --- S5a LATE HEADER: the workspace exists, its header has not rendered yet.
// Nothing is recorded as done while the header is unreachable.
{
  const sc = foldScaffold()
  sc.makeGroup('wA', 'false')          // present: this is what proves the sidebar
  const run = await runBundle(sc, { pinned: [S2], items: TWO_GROUPS })
  await settle()
  assert.equal(
    sc.tree.querySelectorAll('[data-row-key="workspace:wB"]').length,
    0,
    'the second group has not rendered its header yet',
  )

  const late = sc.makeGroup('wB', 'true')
  run.nudge()
  await settle()
  assert.equal(
    late.getAttribute('aria-expanded'),
    'false',
    'a header that arrives late must still be folded once the pin is known',
  )
  assert.equal(late.clicks, 1, 'and it must take exactly one click')
  run.dispose()
  console.log('✔ R07/S5a: a late group header is retried, not written off')
}

// --- S5b INEFFECTIVE CLICK, under the safety-first ruling.
//
// The host accepted the click and has NOT changed anything, and there is no ack
// to tell that apart from "not applied yet". The ruling for this round is that
// ONE unconfirmed intent gets exactly ONE click: an ordinary notification is not
// evidence of anything, so it must never produce a second toggle. What this case
// therefore asserts is the LIMIT, not a recovery — and the limit is real: before
// the rule, this same host got a second click and ended up toggled back.
{
  const sc = foldScaffold()
  sc.makeGroup('wA', 'false')
  const run = await runBundle(sc, { pinned: [S2], items: TWO_GROUPS })
  const b = sc.makeGroup('wB', 'true', 'inert')
  run.nudge()
  await settle()
  assert.equal(b.clicks, 1, 'the first notification issues the click')

  // The plugin schedules its own read-back. That pass may READ, never click.
  await settle()
  assert.equal(b.clicks, 1, 'the pass that verifies the click must not click again')

  // Ordinary notifications are not evidence. None of them may re-toggle.
  for (let i = 0; i < 5; i += 1) {
    run.nudge()
    await settle(80)
  }
  assert.equal(b.clicks, 1, 'five unrelated notifications must not produce a second click')
  assert.equal(b.transitions, 0, 'and the group was never toggled twice')

  // The guarantee that this host will eventually be folded is WITHDRAWN: nothing
  // observable distinguishes it from a host that is merely slow. What is still
  // guaranteed is that the plugin never fights it: no pin change, no notification
  // and no passage of time produces a second toggle on its own.
  assert.equal(
    b.getAttribute('aria-expanded'),
    'true',
    'the state stays exactly as the host left it',
  )
  run.dispose()
  console.log('✔ R07/S5b: a click with no acknowledgement is issued once and never repeated')
}

// --- S5d LATE HOST: the toggle lands on the HOST's schedule, not ours.
//
// This is the case `inert` and `throw` cannot see. There the retry is correct by
// construction; here the first click was accepted and is merely still in flight,
// so a retry is a double toggle. Each row drives a host that applies after a
// delay, with a different number of unrelated notifications arriving while the
// window is open.
for (const [delayMs, notifications] of [[250, 0], [250, 1], [250, 3], [1000, 2]]) {
  const sc = foldScaffold()
  sc.makeGroup('wA', 'false')
  const run = await runBundle(sc, { pinned: [S2], items: TWO_GROUPS })
  const b = sc.makeGroup('wB', 'true', `late:${delayMs}`)
  const tag = `late ${delayMs}ms / ${notifications} notification(s)`

  run.nudge()
  // Just past the reconcile debounce: the click is out, and the host's own
  // window is still open.
  await settle(120)
  assert.equal(b.clicks, 1, `${tag}: one click is issued`)

  for (let i = 0; i < notifications; i += 1) {
    run.nudge()
    // Well inside the host's window, and spaced past the 60ms reconcile
    // debounce so each notification really does produce its own pass.
    await settle(Math.max(90, Math.floor(delayMs / 5)))
  }
  // Wait past the host's own delay so its toggle has landed.
  await settle(delayMs + 400)
  assert.equal(
    b.getAttribute('aria-expanded'),
    'false',
    `${tag}: the group must end in the state the plugin wanted`,
  )
  assert.equal(b.transitions, 1, `${tag}: the group must be toggled exactly once`)
  assert.equal(b.clicks, 1, `${tag}: one unconfirmed intent is exactly one click`)
  run.dispose()
}
console.log('✔ R07/S5d: a host that applies late is toggled once, whatever arrives in the window')

// --- S5e HEADER CHURN: the host REPLACES the header element while a delayed
// click is still in flight.
//
// Same shape as S5d — a click the host has accepted but not committed — with
// one difference that the node-backed scaffold cannot express: between the
// click and the commit, the host re-renders its rows, so the plugin resolves a
// DIFFERENT element for the same workspace, carrying the unchanged store value.
//
// That is what an element-identity gate mistakes for a new request. Before the
// fix, every one of these rows came out at 2 clicks / 2 transitions with the
// group ending back at `expanded`, because "the header node changed" was read
// as "the previous click is someone else's problem now".
//
// Aggregate counters, asserted per workspace: one click, one real transition,
// and the state the plugin wanted. The plugin must NOT try to recover an
// ineffective click by watching the DOM — it has no way to tell this host from
// one that merely is slow.
// Table-driven, and each row's failure is COLLECTED rather than thrown at the
// first one: four delays that fail the same way are four pieces of evidence, and
// a run that stops at the first only ever shows one.
const churnFailures = []
for (const delayMs of [300, 400, 600, 1000]) {
  try {
    const sc = storeFoldScaffold()
    sc.mount('wA', false)
    const run = await runBundle(sc, { pinned: [S2], items: TWO_GROUPS })
    sc.mount('wB', true, delayMs)
    const tag = `header churn / host applies after ${delayMs}ms`

    run.nudge()
    // Past the reconcile debounce, well inside the host's own window: the click
    // is out and its commit has not landed.
    await settle(120)
    assert.equal(sc.clicks('wB'), 1, `${tag}: one click is issued`)

    const previous = sc.headerOf('wB')
    const replacement = sc.rebuild('wB')
    assert.notEqual(replacement, previous, `${tag}: the header element really was replaced`)
    assert.equal(sc.expanded('wB'), true, `${tag}: and the store has not moved yet`)

    for (let i = 0; i < 2; i += 1) {
      run.nudge()
      await settle(Math.max(90, Math.floor(delayMs / 4)))
    }
    await settle(delayMs + 400)
    assert.equal(
      sc.expanded('wB'),
      false,
      `${tag}: the group must end in the state the plugin wanted`,
    )
    assert.equal(sc.transitions('wB'), 1, `${tag}: the group must be toggled exactly once`)
    assert.equal(sc.clicks('wB'), 1, `${tag}: a re-rendered header is the SAME request, not a new one`)
    run.dispose()
  } catch (error) {
    churnFailures.push(`${delayMs}ms → ${String(error.message).split('\n')[0]}`)
  }
}
assert.deepEqual(
  churnFailures,
  [],
  `the host re-rendering its header must not re-toggle a click still in flight — ${churnFailures.join(' | ')}`,
)
console.log('✔ R07/S5e: the host re-rendering its header does not re-issue a click still in flight')

// --- S5f: the pending intent is INHERITED across a header replacement.
//
// The other half of the rule, stated on its own: same workspace, same wanted
// state, new element — and the pending simply follows. If identity were still
// keyed on the node, this would be the case that reopened the double toggle;
// if identity were keyed on the signature alone, adding a pin elsewhere in the
// group (which changes the signature but not what the group is being asked for)
// would re-issue instead of waiting.
{
  const sc = storeFoldScaffold()
  sc.mount('wA', false)
  const run = await runBundle(sc, { pinned: [S2], items: TWO_GROUPS })
  sc.mount('wB', true, 0)
  const inertTag = 'an unchanged wanted state survives a re-render and a signature change'

  run.nudge()
  await settle(150)
  assert.equal(sc.clicks('wB'), 1, 'the first notification issues the click')

  sc.rebuild('wB')
  // The signature moves — a second pinned member joins the SAME group — while
  // the wanted state is still "fold". The request has not changed.
  run.live.pinned = [S1, S2]
  run.live.items = [
    { workspaceId: 'wA', title: 'A', sessionIds: [S1] },
    { workspaceId: 'wB', title: 'B', sessionIds: [S2, S1] },
  ]
  run.nudge()
  await settle(150)
  assert.equal(sc.clicks('wB'), 1, `${inertTag}, so no second click is issued`)

  // And once it does land, the group is booked — still without ever being
  // clicked twice.
  sc.headerOf('wB').setAttribute('aria-expanded', 'false')
  run.nudge()
  await settle(150)
  assert.equal(sc.clicks('wB'), 1, 'and the landing confirms it rather than re-issuing')
  assert.equal(sc.transitions('wB'), 1, 'with exactly one toggle')
  run.dispose()
  console.log('✔ R07/S5f: a pending fold is inherited across a header replacement and a signature change')
}

// --- S5g UNPIN WHILE A FOLD IS STILL IN FLIGHT.
//
// The defect this pins down is not about time at all: it is that the "already
// in the state we wanted" test ran BEFORE the in-flight check. Unpinning while
// our own fold is still pending makes the wanted state equal the CURRENT
// reading, so the plugin booked the group as done, dropped the intent, and
// stopped watching — and the toggle that was already on its way then landed on
// a group the plugin had written off, leaving it folded after its last pin is
// gone. Measured before the fix, at a 400ms host: `final expanded=false`.
//
// The rule this encodes needs no acknowledgement and no timeout: an intent owns
// the group until the reading MOVES from the value it was issued against.
{
  const sc = storeFoldScaffold()
  sc.mount('wA', false)
  const run = await runBundle(sc, { pinned: [S2], items: TWO_GROUPS })
  sc.mount('wB', true, 400)
  run.nudge()
  await settle(120)
  assert.equal(sc.clicks('wB'), 1, 'mount folds the group that holds the pin')
  assert.equal(sc.expanded('wB'), true, 'and the host has not committed it yet')

  // The user unpins while that toggle is still in flight. The click cannot be
  // recalled — what must not happen is forgetting it.
  run.live.pinned = []
  run.nudge()
  await settle(120)
  assert.equal(sc.clicks('wB'), 1, 'the opposite request waits instead of adding a click')

  await settle(1200)
  assert.equal(
    sc.expanded('wB'),
    true,
    'the group must end EXPANDED: losing its last pin re-opens it',
  )
  assert.equal(
    sc.transitions('wB'),
    2,
    'the spent fold and the unfold it made necessary, and nothing after that',
  )
  assert.equal(sc.clicks('wB'), 2, 'exactly one click for each request')
  run.dispose()
  console.log('✔ R07/S5g: unpinning while a fold is in flight re-opens the group instead of writing it off')
}

// --- S5c THE HOST'S OWN HANDLER THROWS. That is NOT an acknowledgement, and
// the plugin must not treat it as one.
//
// The previous version of this block drove a host whose click "refused" by
// throwing, and read the throw as the one signal the host could not hide. That
// signal does not exist. HTML's `HTMLElement.click()` fires a synthetic click
// and returns; DOM's "inner invoke" REPORTS a listener exception and swallows
// it, so it never propagates back out of `dispatch()` — and therefore never out
// of `click()`. The harness used to invent it by calling listener callbacks
// bare; `El.dispatch` now reports-and-swallows like the spec, and the case
// below pins the behaviour that actually ships:
//
//   the plugin sees a normal, successful `click()` return;
//   the exception is visible only to the harness's log;
//   and NO amount of notifications turns that into another click.
//
// A host whose handler is broken therefore gets one click and is left alone —
// the same limit as S5b, arrived at for a different reason.
{
  const before = reportedListenerErrors().length
  const sc = foldScaffold()
  sc.makeGroup('wA', 'false')
  const run = await runBundle(sc, { pinned: [S2], items: TWO_GROUPS })
  const b = sc.makeGroup('wB', 'true', 'throw-listener')
  run.nudge()
  await settle()
  assert.equal(b.clicks, 1, 'the click was delivered')
  assert.ok(
    reportedListenerErrors().length > before,
    "the host's handler really did throw, and the harness reported it",
  )

  for (let i = 0; i < 8; i += 1) {
    run.nudge()
    await settle(80)
  }
  assert.equal(
    b.clicks,
    1,
    'a listener exception is invisible to the caller, so it can never unlock a second click',
  )
  assert.equal(b.transitions, 0, 'and nothing was ever toggled')
  assert.equal(b.getAttribute('aria-expanded'), 'true', 'the group is left exactly as the host had it')
  run.dispose()
  console.log("✔ R07/S5c(1): a listener that throws is reported and swallowed — not an ack, no retry")
}

// --- S5c(2) THE ONLY REAL `catch`: `click` ITSELF cannot be delivered.
//
// This is the one shape a browser can actually produce — a header whose `click`
// is missing or replaced — and here nothing was dispatched, so "nothing was
// toggled" is true and a bounded retry is safe. The budget is asserted so the
// branch stays a bounded defence rather than a new way to click forever.
{
  const sc = foldScaffold()
  sc.makeGroup('wA', 'false')
  const run = await runBundle(sc, { pinned: [S2], items: TWO_GROUPS })
  const b = sc.makeGroup('wB', 'true', 'no-click')
  run.nudge()
  await settle()
  assert.equal(b.attempts, 1, 'the undeliverable click is a real attempt')
  for (let i = 0; i < 8; i += 1) {
    run.nudge()
    await settle(80)
  }
  assert.equal(
    b.attempts,
    2,
    'an undeliverable click buys one bounded retry, then stops — it is not a new retry loop',
  )
  assert.equal(b.transitions, 0, 'and nothing was ever toggled')
  run.dispose()
  console.log('✔ R07/S5c(2): a click that cannot be delivered at all is retried once, then stops')
}

// --- Acceptance 4 + 5: a group already in the wanted state is not clicked, and
// a real pin/unpin pair still folds and unfolds exactly once each.
{
  const sc = foldScaffold()
  const a = sc.makeGroup('wA', 'false')
  const run = await runBundle(sc, { pinned: [S1], items: TWO_GROUPS })
  await settle()
  assert.equal(a.clicks, 0, 'a group that is already folded is not clicked at all')
  assert.equal(a.getAttribute('aria-expanded'), 'false')

  run.live.pinned = []
  run.nudge()
  await settle()
  assert.equal(a.getAttribute('aria-expanded'), 'true', 'unpinning re-opens the group')
  assert.equal(a.clicks, 1)
  assert.equal(a.transitions, 1)

  run.live.pinned = [S1]
  run.nudge()
  await settle()
  assert.equal(a.getAttribute('aria-expanded'), 'false', 'pinning folds it again')
  assert.equal(a.clicks, 2)
  assert.equal(a.transitions, 2)
  run.dispose()
  console.log('✔ R07: a real pin/unpin pair folds and unfolds once each, and never clicks a satisfied group')
}

console.log('\nALL SIDEBAR-FLAVOR DOM CHECKS PASSED')