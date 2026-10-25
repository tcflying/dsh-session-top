/**
 * Client lifecycle regressions: R02, R04 and R05.
 *
 * All three are the same family of failure wearing different clothes — an
 * instance that should have stopped, kept working; an instance that should have
 * started, refused to. So they are tested together, against counts rather than
 * against pictures: how many regions the document holds, how many observers are
 * connected, how many document listeners are registered, what the shared
 * stylesheet actually contains.
 *
 * The DOM here is purpose-built for this file rather than shared with the other
 * DOM suites. Extracting one harness out of three independently written fakes is
 * real work that belongs to the test-engineering item, not to a behavioural fix;
 * folding that into this round would put a large, untested refactor of already
 * accepted suites in the same diff as the fix it is supposed to guard.
 *
 * R02 runs against the REAL cordis resolved exactly as cordis-activation.mjs
 * resolves it, so "the service was revoked and published again" means the host
 * actually did it, not that a stub called a callback.
 *
 * Run: node test/client-lifecycle.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const S1 = 'session-aaaaaaaa-1111-4111-8111-111111111111'
const S2 = 'session-bbbbbbbb-2222-4222-8222-222222222222'

// --------------------------------------------------------------- fake DOM

/** Match one compound selector (no combinators) against a node. */
function matchCompound(el, part) {
  const tokens = part.match(/(^[a-zA-Z][\w-]*)|(#[\w-]+)|(\.[\w-]+)|(\[[^\]]+\])|(\*)/g) ?? []
  for (const token of tokens) {
    if (token === '*') continue
    if (token.startsWith('#')) {
      if (el.getAttribute('id') !== token.slice(1)) return false
      continue
    }
    if (token.startsWith('.')) {
      if (!String(el.getAttribute('class') ?? '').split(/\s+/).includes(token.slice(1))) return false
      continue
    }
    if (token.startsWith('[')) {
      const body = token.slice(1, -1)
      const m = /^([\w-]+)(?:([~^$*|]?=)"?'?([^"'[\]]*)"?'?(?:\s+i)?)?$/.exec(body)
      if (m === null) return false
      const [, name, op, want] = m
      const value = el.getAttribute(name)
      if (value === null) return false
      if (op === undefined) continue
      if (op === '=' && value !== want) return false
      if (op === '^=' && !value.startsWith(want)) return false
      if (op === '*=' && !value.includes(want)) return false
      if (op === '$=' && !value.endsWith(want)) return false
      continue
    }
    if (el.tagName !== token.toUpperCase()) return false
  }
  return true
}

/** Match a selector list of descendant combinators. */
function matchSimple(el, selector) {
  return selector.split(',').some(one => {
    const parts = one.trim().split(/\s+/)
    if (!matchCompound(el, parts[parts.length - 1])) return false
    let ancestor = el.parentElement
    for (let i = parts.length - 2; i >= 0; i -= 1) {
      let found = false
      while (ancestor !== null) {
        if (matchCompound(ancestor, parts[i])) { found = true; ancestor = ancestor.parentElement; break }
        ancestor = ancestor.parentElement
      }
      if (!found) return false
    }
    return true
  })
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
  }

  get className() { return this.attributes.get('class') ?? '' }
  set className(v) { this.attributes.set('class', v) }
  get firstChild() { return this.children[0] ?? null }
  set textContent(value) { this._text = String(value) }
  get textContent() { return this._text ?? '' }

  setAttribute(n, v) { this.attributes.set(n, String(v)) }
  getAttribute(n) { return this.attributes.has(n) ? this.attributes.get(n) : null }
  removeAttribute(n) { this.attributes.delete(n) }
  hasAttribute(n) { return this.attributes.has(n) }

  appendChild(c) { c.parentElement = this; this.children.push(c); return c }
  insertBefore(c, a) {
    c.parentElement = this
    const i = a === undefined || a === null ? this.children.length : this.children.indexOf(a)
    this.children.splice(i < 0 ? this.children.length : i, 0, c)
    return c
  }

  remove() {
    if (!this.parentElement) return
    const i = this.parentElement.children.indexOf(this)
    if (i >= 0) this.parentElement.children.splice(i, 1)
    this.parentElement = null
    this.isConnected = false
  }

  descendants() {
    const out = []
    for (const child of this.children) {
      out.push(child)
      out.push(...child.descendants())
    }
    return out
  }

  matches(sel) { return matchSimple(this, sel) }
  closest(sel) {
    let node = this
    while (node !== null) {
      if (node instanceof El && node.matches(sel)) return node
      node = node.parentElement
    }
    return null
  }

  querySelector(sel) { return this.descendants().find(node => node.matches(sel)) ?? null }
  querySelectorAll(sel) { return this.descendants().filter(node => node.matches(sel)) }
  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, [])
    this.listeners.get(t).push(fn)
  }

  removeEventListener(t, fn) {
    const list = this.listeners.get(t) ?? []
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }

  focus() {}
  click() {}
}

/** Registered observers, so a test can count what is actually connected. */
const observers = new Set()

class CountingObserver {
  constructor(callback) {
    this.callback = callback
    this.target = undefined
  }

  observe(target) { this.target = target; observers.add(this) }
  disconnect() { observers.delete(this); this.target = undefined }
}

/**
 * A codex-flavored page: the workspace tree the plugin anchors on, plus one
 * host session row so the flavor is positively identified.
 *
 * `official` keys the rows the way the STOCK sidebar keys them and gives them
 * no "…" row control. That is the rendering where a right-click still reaches
 * the plugin's own menu — on codex the host serves its own session menu — so
 * the cases that need a pin RPC genuinely in flight are built on it.
 *
 * The stock list element also carries `aria-label`, because that is the pair
 * the host's own AnimatedRows writes and half of the plugin's tree selector
 * (`[role="tree"][aria-label]`). A bare `role="tree"` is a different contract:
 * `findTree` returns null, the region is never attached, and a check written
 * against it fails as "the region is missing" rather than as the thing it is
 * actually about.
 *
 * @param {object} [options] - which rendering to build.
 * @param {boolean} [options.official] - the stock sidebar, not codex-ui.
 */
function page({ official = false } = {}) {
  const body = new El('body')
  const head = new El('head')
  const workspace = new El('div')
  workspace.className = 'dcu-wb-project'
  const head2 = new El('div')
  head2.className = 'dcu-wb-project-head'
  const listBody = new El('div')
  listBody.className = 'dcu-wb-project-body'
  const tree = new El('div')
  tree.setAttribute('role', 'tree')
  if (official === true) tree.setAttribute('aria-label', 'Sessions')
  const row = new El('div')
  const row2 = new El('div')
  for (const [node, id] of [[row, S1], [row2, S2]]) {
    node.setAttribute('role', 'treeitem')
    if (official === true) {
      node.setAttribute('data-row-key', `session:${id}`)
    } else {
      node.className = 'dcu-wb-session'
      node.setAttribute('data-dcu-session', id)
    }
  }
  if (official !== true) tree.className = 'dcu-wb-tree'
  tree.appendChild(row)
  tree.appendChild(row2)
  listBody.appendChild(tree)
  workspace.appendChild(head2)
  workspace.appendChild(listBody)
  body.appendChild(workspace)
  return { body, head, tree, row, row2 }
}

/** Install the globals the bundle reads, and report what is still registered. */
function installGlobals(scaffold) {
  const documentListeners = new Map()
  const document = {
    body: scaffold.body,
    head: scaffold.head,
    documentElement: new El('html'),
    createElement: tag => new El(tag),
    querySelector: sel => scaffold.body.querySelector(sel) ?? scaffold.head.querySelector(sel),
    querySelectorAll: sel => [...scaffold.body.querySelectorAll(sel), ...scaffold.head.querySelectorAll(sel)],
    addEventListener: (t, fn) => {
      if (!documentListeners.has(t)) documentListeners.set(t, [])
      documentListeners.get(t).push(fn)
    },
    removeEventListener: (t, fn) => {
      const list = documentListeners.get(t) ?? []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
  }
  const windowListeners = new Map()
  globalThis.document = document
  globalThis.window = {
    addEventListener: (t, fn) => {
      if (!windowListeners.has(t)) windowListeners.set(t, [])
      windowListeners.get(t).push(fn)
    },
    removeEventListener: (t, fn) => {
      const list = windowListeners.get(t) ?? []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
  }
  globalThis.MutationObserver = CountingObserver
  globalThis.Element = El
  globalThis.KeyboardEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init) } }
  const count = map => [...map.values()].reduce((total, list) => total + list.length, 0)
  return {
    document,
    listeners: () => count(documentListeners) + count(windowListeners),
    handlersFor: type => [...(documentListeners.get(type) ?? [])],
    regions: () => scaffold.body.querySelectorAll('[data-stp-region]').length,
    anchors: () => scaffold.body.querySelectorAll('[data-stp-anchor]').length,
    observers: () => observers.size,
    sheet: name => scaffold.head.querySelector(`style[data-plugin='dsh-session-top'][data-stp-sheet='${name}']`)?.textContent ?? null,
    /**
     * The theme-token block, read off the element that actually holds it.
     *
     * `applyStpTokens` writes to `document.documentElement`, not to anything the
     * scaffold returns, so this is the only place a test can observe it. An
     * assertion that reaches for some other node and defaults its way to a
     * passing comparison proves nothing at all.
     */
    tokens: () => document.documentElement.style.props,
  }
}

/** Materialize the real bundle exactly as the shell's module loader does. */
async function loadBundle() {
  let registration = null
  globalThis.window.__ModuleLoader__ = { load: value => { registration = value } }
  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  // No `require` is bound: the bundle must materialize with nothing but DOM
  // globals, and a factory that reached for a module would throw right here.
  new Function('window', 'document', 'Element', 'MutationObserver', 'KeyboardEvent', source)(
    globalThis.window, globalThis.document, El, CountingObserver, globalThis.KeyboardEvent,
  )
  assert.ok(registration, 'bundle did not register')
  return registration
}

/** Store-shaped services with the live contract this plugin reads. */
function services({ pinned = [S1], hold = null } = {}) {
  const live = { pinned: [...pinned] }
  const nudges = []
  const subscribe = fn => {
    nudges.push(fn)
    return () => { const i = nudges.indexOf(fn); if (i >= 0) nudges.splice(i, 1) }
  }
  return {
    live,
    nudge: () => { for (const fn of [...nudges]) fn() },
    subscriptionCount: () => nudges.length,
    value: {
      workspaces: {
        list: {
          getSnapshot: () => ({ items: [{ workspaceId: 'w1', title: 'W1', sessionIds: [S1, S2] }], pinnedSessionIds: live.pinned }),
          subscribe,
        },
        pinSession: async id => { live.pinned = [...new Set([...live.pinned, id])] },
        // The gate is what makes "dispose while the RPC is in flight" real.
        unpinSession: async id => {
          if (hold !== null) await hold.wait()
          live.pinned = live.pinned.filter(one => one !== id)
        },
      },
      sessions: {
        list: {
          getSnapshot: () => ({ ids: [S1, S2], byId: { [S1]: { id: S1 }, [S2]: { id: S2 } }, phase: 'ready' }),
          subscribe,
        },
      },
      uiWorkspace: { openSession: () => {}, get mainReference() { return undefined } },
    },
  }
}

/** A promise gate holding one RPC open. */
function makeGate() {
  let release
  const opened = new Promise(resolve => { release = resolve })
  return { wait: () => opened, release: () => release() }
}

/** Let the debounce and the reconcile drain. */
const settle = async (ms = 160) => { await new Promise(resolve => { setTimeout(resolve, ms) }) }

/** A minimal cordis-shaped context, for the cases that do not need the real one. */
function fakeCtx(value) {
  const effects = []
  const pending = []
  const ctx = {
    get: name => value[name],
    logger: { info: () => {}, warn: () => {} },
    effect: fn => { effects.push(fn()); return () => {} },
    inject: (deps, cb) => {
      pending.push(() => { if (deps.every(d => value[d] !== undefined)) cb(ctx) })
      return { dispose() {} }
    },
    /** Run the deferred inject callbacks, as publishing the service would. */
    flush() { for (const run of pending.splice(0)) run() },
    /** Run every registered effect cleanup, as disposing the fiber would. */
    dispose() { for (const cleanup of effects.splice(0).reverse()) { try { cleanup?.() } catch { /* gone */ } } },
  }
  return ctx
}

const logs = []
{
  const info = console.info
  const warn = console.warn
  console.info = (...a) => { logs.push(a.join(' ')) }
  console.warn = (...a) => { logs.push(a.join(' ')) }
  globalThis.__restoreConsole = () => { console.info = info; console.warn = warn }
}

// ------------------------------------------------------------------ real cordis

/**
 * The cordis build these assertions actually run against. Recorded, because a
 * lifecycle result is only as good as the version that produced it: the
 * package declares a peer range, and the machine's installed build is what any
 * desktop session would actually load.
 */
const CORDIS_CANDIDATES = [
  join(here, '..', 'vendor', 'cordis', 'lib', 'index.js'),
  join(here, '..', '..', '..', 'deepseek-harness', 'vendor', 'cordis', 'lib', 'index.js'),
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
]
const cordisPath = CORDIS_CANDIDATES.find(candidate => existsSync(candidate))
if (cordisPath === undefined) {
  throw new Error(`client-lifecycle: no cordis found. Looked in:\n  ${CORDIS_CANDIDATES.join('\n  ')}`)
}
const { Context } = await import(pathToFileURL(cordisPath).href)
const CORDIS_VERSION = JSON.parse(readFileSync(join(dirname(cordisPath), '..', 'package.json'), 'utf8')).version

// ----------------------------------------------------------------------- R02

async function testServiceLifecycle() {
  const scaffold = page()
  const probe = installGlobals(scaffold)
  const registration = await loadBundle()
  const plugin = registration.factory()
  const store = services()

  const root = new Context()
  const fiber = root.extend({}).plugin(plugin)
  await fiber.await()
  assert.equal(fiber.state, 2, `parent fiber must be ACTIVE (2), got ${String(fiber.state)}`)

  // The controller publishes late, exactly as a host that is still booting does.
  let disposeService = root.provide('workspaces', store.value.workspaces)
  root.provide('sessions', store.value.sessions)
  await settle()
  const mountedOnce = probe.regions()
  assert.equal(mountedOnce, 1, `the Pinned region must mount once, got ${String(mountedOnce)}`)
  const mountedListeners = probe.listeners()
  assert.ok(mountedListeners > 0, 'the right-click listener must be registered')

  // The controller is revoked: its dependant fiber is disposed by cordis, and
  // every plugin-owned resource must go with it.
  disposeService()
  await settle()
  assert.equal(probe.regions(), 0, `revoking the controller must remove the region, got ${String(probe.regions())}`)
  assert.equal(probe.observers(), 0, 'the observer must be disconnected on revoke')
  assert.equal(probe.listeners(), 0, `every document listener must be released, got ${String(probe.listeners())}`)
  assert.equal(
    fiber.state, 2,
    'the parent fiber must stay ACTIVE while its optional dependency is absent',
  )

  // And published again. This is the case a one-shot mount flag could not pass.
  root.provide('workspaces', store.value.workspaces)
  await settle()
  assert.equal(probe.regions(), 1, `the region must come back after the controller returns, got ${String(probe.regions())}`)
  assert.equal(probe.observers(), 1, `exactly one observer group may be live, got ${String(probe.observers())}`)
  assert.ok(
    (probe.sheet('dynamic') ?? '').length > 0,
    'the pinned row must be hidden again after the controller returns',
  )

  fiber.dispose()
  await settle()
  assert.equal(probe.regions(), 0, 'disposing the plugin removes the region')
  assert.equal(probe.observers(), 0, 'disposing the plugin disconnects the observer')
  assert.equal(probe.listeners(), 0, 'disposing the plugin releases the listeners')
  return { version: CORDIS_VERSION, mountedListeners }
}

async function testMountFailureRecovery() {
  // A mount that throws must leave nothing behind that could refuse the next
  // activation. This is a different failure from a clean revoke: the first
  // activation dies halfway, so a flag set BEFORE the work rather than after it
  // would leave the page permanently inert.
  const scaffold = page()
  const probe = installGlobals(scaffold)
  const registration = await loadBundle()
  const store = services()

  // Provoke the failure from the page, not from the plugin: element creation is
  // the first thing a mount does.
  const realCreate = probe.document.createElement
  probe.document.createElement = tag => {
    if (tag === 'div') throw new Error('host DOM refused to create an element')
    return realCreate(tag)
  }

  const root = new Context()
  const fiber = root.extend({}).plugin(registration.factory())
  await fiber.await()
  const disposeService = root.provide('workspaces', store.value.workspaces)
  await settle()

  assert.equal(fiber.state, 2, 'a failed mount must not wedge the fiber out of ACTIVE')
  assert.equal(probe.regions(), 0, 'a mount that threw must not leave a region behind')

  // The page recovers, and so does the controller.
  probe.document.createElement = realCreate
  disposeService()
  await settle()
  root.provide('workspaces', store.value.workspaces)
  await settle()

  assert.equal(probe.regions(), 1, `the region must mount on the next activation, got ${String(probe.regions())}`)
  assert.ok((probe.sheet('dynamic') ?? '').length > 0, 'the pinned row must be hidden again after recovery')
  assert.equal(probe.observers(), 1, 'exactly one observer group may be live after recovery')
  fiber.dispose()
  await settle()
  assert.equal(probe.regions(), 0, 'disposing after recovery removes the region')
}

/** Late right-column services and their child fibers must follow real Cordis lifetimes. */
async function testRightSidebarLifecycle() {
  const scaffold = page()
  installGlobals(scaffold)
  const registration = await loadBundle()
  const store = services()
  const source = initial => {
    let value = initial
    const listeners = new Set()
    return {
      getSnapshot: () => value,
      subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) },
      set(next) { value = next; for (const fn of [...listeners]) fn() },
      listeners,
    }
  }
  const mounted = source(S1)
  const inventory = source([])
  const registry = source(true)
  const calls = []
  let active = { id: 'start', kind: 'guide' }
  let expanded = false
  const right = {
    mounted, openTabs: inventory,
    active: () => active,
    isExpanded: () => expanded,
    toggleExpanded() { expanded = !expanded },
    openTab(kind, options) {
      calls.push([mounted.getSnapshot(), kind, options])
      active = { id: 'task', kind }
      expanded = true
    },
  }
  const root = new Context()
  const fiber = root.extend({}).plugin(registration.factory())
  try {
    await fiber.await()
    root.provide('workspaces', store.value.workspaces)
    root.provide('sessions', store.value.sessions)
    await settle()
    assert.equal(fiber.state, 2, 'missing optional right-column services must not delay boot')
    let disposeRight = root.provide('sidebarRight', right)
    await settle()
    let disposeTabs = root.provide('sidebarRightTabs', {
      get: kind => kind === 'subagent' && registry.getSnapshot() ? { kind } : undefined,
      subscribe: registry.subscribe,
    })
    await settle()
    assert.deepEqual(calls, [[S1, 'subagent', { replaceTab: 'start' }]], 'late service publication applies the default without a list pulse')
    assert.equal(mounted.listeners.size, 1)
    assert.equal(inventory.listeners.size, 1)
    assert.equal(registry.listeners.size, 1)
    disposeRight()
    await settle()
    assert.equal(mounted.listeners.size, 0)
    assert.equal(inventory.listeners.size, 0)
    const beforeRevoke = calls.length
    active = { id: 'start', kind: 'guide' }
    expanded = false
    mounted.set(S2)
    await settle()
    assert.equal(calls.length, beforeRevoke, 'a revoked service cannot act')
    disposeRight = root.provide('sidebarRight', right)
    await settle()
    assert.deepEqual(calls.at(-1), [S2, 'subagent', { replaceTab: 'start' }])
    assert.equal(mounted.listeners.size, 1, 're-providing must attach exactly one subscriber')
    assert.equal(registry.listeners.size, 1)
    active = { id: 'file', kind: 'editor' }
    expanded = false
    disposeTabs()
    await settle()
    registry.set(true)
    const beforeProviderReturns = calls.length
    disposeTabs = root.provide('sidebarRightTabs', {
      get: kind => kind === 'subagent' ? { kind } : undefined,
      subscribe: registry.subscribe,
    })
    await settle()
    assert.equal(calls.length, beforeProviderReturns, 'same-session registry re-publication must preserve the user choice')
    assert.equal(active.kind, 'editor')
    assert.equal(expanded, false)
    disposeRight()
    await settle()
    disposeRight = root.provide('sidebarRight', right)
    await settle()
    assert.equal(calls.length, beforeProviderReturns, 'same-session controller re-publication must preserve the user choice')
    assert.equal(active.kind, 'editor')
    assert.equal(expanded, false)
    mounted.set(S1)
    mounted.set(S2)
    await settle()
    assert.equal(calls.length, beforeProviderReturns + 1, 'a brief switch still starts a new entry')
    mounted.set(S1)
    fiber.dispose()
    await settle()
    assert.equal(calls.length, beforeProviderReturns + 1, 'dispose cancels the pending default')
    assert.equal(mounted.listeners.size, 0)
    assert.equal(inventory.listeners.size, 0)
    assert.equal(registry.listeners.size, 0)
  } finally {
    fiber.dispose()
  }
}

// ----------------------------------------------------------------------- R03-minor

/**
 * A mount that dies AFTER claiming the document lease.
 *
 * The lease is claimed at the top of `mount`, so a failure between there and
 * the end leaves an owner that cannot be torn down the normal way. When the
 * next instance takes the document over it calls the old owner's teardown — and
 * if that teardown reaches for a binding that does not exist yet, it throws a
 * TDZ ReferenceError instead of cleaning up. The symptom is a warning on a
 * healthy instance and an old generation that quietly never cleaned up.
 */
async function testTakeoverAfterFailedMount() {
  const scaffold = page()
  const probe = installGlobals(scaffold)
  const registration = await loadBundle()
  const store = services()

  // The failure lands after the lease is claimed: `injectStyles` is the first
  // thing `mount` does once it owns the document.
  const realQuery = probe.document.querySelector
  probe.document.querySelector = sel => {
    if (String(sel).includes('style[data-plugin')) throw new Error('host DOM refused a stylesheet lookup')
    return realQuery(sel)
  }

  const warned = []
  const realWarn = console.warn
  console.warn = (...a) => { warned.push(a.join(' ')) }

  const root = new Context()
  const fiber = root.extend({}).plugin(registration.factory())
  // Every context this check creates is released whatever the outcome. The file
  // shares one `document` and one observer set across checks, so a check that
  // bailed out early would otherwise make the NEXT one fail for the wrong
  // reason — and a cascade reads like two defects where there is one.
  const second = { ctx: null, fiber: null }
  const release = () => {
    console.warn = realWarn
    for (const one of [second.fiber, fiber]) {
      try { one?.dispose() } catch { /* already gone */ }
    }
  }
  try {
  await fiber.await()
  root.provide('workspaces', store.value.workspaces)
  await settle()

  assert.equal(fiber.state, 2, 'a mount that threw must not wedge the fiber out of ACTIVE')
  assert.equal(probe.regions(), 0, 'a mount that threw must leave no region')
  assert.equal(probe.observers(), 0, 'a mount that threw must leave no observer')
  assert.equal(probe.listeners(), 0, `a mount that threw must leave no listener, got ${String(probe.listeners())}`)

  // The page recovers, and a NEW instance takes the document over. This is the
  // call that used to throw.
  probe.document.querySelector = realQuery
  const secondCtx = new Context()
  second.fiber = secondCtx.extend({}).plugin(registration.factory())
  await second.fiber.await()
  secondCtx.provide('workspaces', store.value.workspaces)
  await settle()

  console.warn = realWarn
  const takeoverWarnings = warned.filter(one => one.includes('could not retire the previous instance'))
  assert.deepEqual(
    takeoverWarnings, [],
    `taking over a failed mount must not warn about failing to retire it: ${JSON.stringify(takeoverWarnings)}`,
  )
  assert.equal(probe.regions(), 1, `the new owner must render exactly one region, got ${String(probe.regions())}`)
  assert.equal(probe.observers(), 1, 'the new owner brings its own observer group')
  assert.ok((probe.sheet('dynamic') ?? '').length > 0, 'the new owner owns the shared pin rules')

  // And the failed instance disposing afterwards must not withdraw anything the
  // new owner holds: it was superseded, so it never owned any of it.
  const listenersOwnedByB = probe.listeners()
  fiber.dispose()
  await settle()
  assert.equal(probe.regions(), 1, 'the new owner keeps its region')
  assert.ok((probe.sheet('dynamic') ?? '').length > 0, 'the new owner keeps the shared pin rules')
  assert.ok(probe.tokens().size > 0, 'the new owner keeps the shared theme tokens')
  assert.equal(
    probe.listeners(), listenersOwnedByB,
    'a late dispose by the failed instance must not touch the live owner listeners',
  )

  second.fiber.dispose()
  await settle()
  assert.equal(probe.listeners(), 0, 'the last owner out leaves no listener behind')
  assert.equal(probe.regions(), 0, 'the last owner out leaves no region behind')
  return { takeoverWarnings: takeoverWarnings.length }
  } finally {
    probe.document.querySelector = realQuery
    release()
  }
}

/**
 * A mount that dies INSIDE the effect body, after it has registered resources.
 *
 * The effect body registers a document listener, the shared-menu registration,
 * two subscriptions and the observer before it returns. Anything that throws in
 * between leaves those on the document with nothing to remove them — the next
 * instance's takeover has no teardown to call, so the old generation's
 * `contextmenu` listener stays on the page forever, counting towards every
 * future handler tally.
 *
 * The counts below are the real ones this file measures elsewhere: registered
 * document+window listeners, connected observers, live store subscriptions.
 */
async function testFailureInsideEffectBody() {
  const scaffold = page()
  const probe = installGlobals(scaffold)
  const registration = await loadBundle()
  const store = services()

  // The observer refuses to observe: a realistic mid-body failure that lands
  // after the listener and the subscriptions are already in place.
  const realObserve = globalThis.MutationObserver.prototype.observe
  globalThis.MutationObserver.prototype.observe = function observe() {
    throw new Error('host refused to observe the document')
  }

  const warned = []
  const realWarn = console.warn
  console.warn = (...a) => { warned.push(a.join(' ')) }

  const root = new Context()
  const fiber = root.extend({}).plugin(registration.factory())
  const second = { ctx: null, fiber: null }
  try {
    await fiber.await()
    root.provide('workspaces', store.value.workspaces)
    await settle()

    assert.equal(fiber.state, 2, 'a mount that threw must not wedge the fiber out of ACTIVE')
    assert.equal(probe.regions(), 0, 'a mount that threw must leave no region')

    // Whatever the dead generation registered is still on the page right now:
    // that is the residue this check is about.
    const residueBeforeTakeover = {
      listeners: probe.listeners(),
      observers: probe.observers(),
      subscriptions: store.subscriptionCount(),
    }
    assert.ok(
      residueBeforeTakeover.listeners > 0,
      'precondition: the effect body had already registered its document listener',
    )

    // A new instance takes the document over. Taking over must reclaim the dead
    // generation's residue, not merely stop caring about it.
    globalThis.MutationObserver.prototype.observe = realObserve
    const secondCtx = new Context()
    second.fiber = secondCtx.extend({}).plugin(registration.factory())
    await second.fiber.await()
    secondCtx.provide('workspaces', store.value.workspaces)
    await settle()

    console.warn = realWarn
    assert.deepEqual(
      warned.filter(one => one.includes('could not retire the previous instance')), [],
      'reclaiming a half-registered mount must not warn about failing to retire it',
    )

    const live = { listeners: probe.listeners(), observers: probe.observers(), subscriptions: store.subscriptionCount() }
    assert.equal(live.observers, 1, `the new owner owns the only observer group, got ${String(live.observers)}`)
    assert.equal(live.subscriptions, 2, `the dead subscriptions must be released, got ${String(live.subscriptions)} live`)
    // The new owner registers contextmenu + pointerdown + keydown + blur + resize.
    // The dead generation's contextmenu must not be on top of them.
    assert.equal(
      probe.handlersFor('contextmenu').length, 1,
      `exactly one contextmenu handler may remain, got ${String(probe.handlersFor('contextmenu').length)}`,
    )

    // And the dead instance disposing later must still change nothing.
    const beforeLateDispose = { listeners: probe.listeners(), observers: probe.observers() }
    fiber.dispose()
    await settle()
    assert.equal(probe.listeners(), beforeLateDispose.listeners, 'a late dispose must not touch the live owner')
    assert.equal(probe.observers(), beforeLateDispose.observers, 'a late dispose must not disconnect the live owner')
    assert.equal(probe.regions(), 1, 'the live owner keeps its region')

    second.fiber.dispose()
    await settle()
    assert.equal(probe.listeners(), 0, `the last owner out leaves no listener, got ${String(probe.listeners())}`)
    assert.equal(probe.observers(), 0, 'the last owner out leaves no observer')
    assert.equal(store.subscriptionCount(), 0, 'the last owner out leaves no subscription')
    return { residueBeforeTakeover, live }
  } finally {
    console.warn = realWarn
    globalThis.MutationObserver.prototype.observe = realObserve
    for (const one of [second.fiber, fiber]) {
      try { one?.dispose() } catch { /* already gone */ }
    }
  }
}

// ----------------------------------------------------------------------- R04

async function testAsyncCompletionAfterDispose() {
  const scaffold = page({ official: true })
  const probe = installGlobals(scaffold)
  const registration = await loadBundle()
  const gate = makeGate()
  const store = services({ pinned: [S1], hold: gate })
  const ctx = fakeCtx(store.value)
  const fiber = registration.factory()
  fiber.apply(ctx)
  ctx.flush()
  await settle()

  // This check reads the module-level observer set that every other check in
  // this file also reads. Bailing out before the release below would leave one
  // observer and one document listener behind, and the NEXT check would report
  // them as its own duplicates — a cascade that reads like two defects where
  // there is one.
  try {
  assert.equal(probe.regions(), 1, 'precondition: the region is mounted')
  const rulesAtDispose = probe.sheet('dynamic')
  assert.ok((rulesAtDispose ?? '').length > 0, 'precondition: the pin rule is written')

  // Right-click the real host row so the plugin opens its own menu, then click
  // its item: the RPC goes out and we take the instance down while it is open.
  await openMenuAndClickPin(probe, scaffold)

  // The RPC is now pending. Tear the instance down underneath it.
  ctx.dispose()
  await settle()
  assert.equal(probe.regions(), 0, 'dispose must remove the region')
  const rulesAfterDispose = probe.sheet('dynamic')

  // Let the in-flight RPC finish. The host's pin set moves — that is not
  // undoable and is not pretended away — but nothing on the page may change.
  gate.release()
  await settle(260)
  assert.equal(
    probe.regions(), 0,
    'a pending RPC that resolves after dispose must not resurrect the region',
  )
  assert.equal(probe.observers(), 0, 'no observer may come back')
  assert.equal(probe.sheet('dynamic'), rulesAfterDispose, 'the stylesheet must not be rewritten by a dead generation')
  assert.equal(probe.sheet('dynamic'), '', 'the last owner cleared the shared rules exactly once')
  assert.equal(probe.anchors(), 0, 'no anchor host may be recreated')
  assert.equal(probe.listeners(), 0, 'no document listener may come back')
  assert.equal(store.live.pinned.includes(S1), false, 'the host pin set did change, and is not rolled back here')
  } finally {
    ctx.dispose()
  }
}

/**
 * Open the plugin's own fallback menu on a host row and activate its item, so a
 * real pin/unpin RPC is genuinely in flight when the caller tears down.
 */
async function openMenuAndClickPin(probe, scaffold) {
  // The plugin listens for `contextmenu` in the capture phase on `document`;
  // replaying through the registered handler keeps this a test of the plugin's
  // own menu path rather than of an internal function.
  for (const handler of probe.handlersFor('contextmenu')) {
    handler({
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() {},
      target: scaffold.row,
      clientX: 12,
      clientY: 24,
    })
  }
  await new Promise(resolve => { queueMicrotask(() => { setTimeout(resolve, 0) }) })
  const anchor = scaffold.body.querySelector('[data-stp-anchor]')
  const item = anchor?.querySelector('[data-stp-pin-item]')
  assert.ok(item !== null, 'the plugin must offer its own pin affordance when no owner is present')
  for (const fn of item.listeners.get('click') ?? []) {
    fn({ preventDefault() {}, stopPropagation() {} })
  }
  await settle(10)
}

// ----------------------------------------------------------------------- R05

async function testDuplicateApply() {
  const scaffold = page()
  const probe = installGlobals(scaffold)
  const registration = await loadBundle()

  const first = services()
  const second = services()
  const firstCtx = fakeCtx(first.value)
  const secondCtx = fakeCtx(second.value)

  registration.factory().apply(firstCtx)
  firstCtx.flush()
  await settle()
  assert.equal(probe.regions(), 1, 'precondition: the first instance owns the page')
  assert.ok((probe.sheet('dynamic') ?? '').length > 0, 'precondition: the first instance hides the pinned row')

  // A second entry for the same package reaches the same document.
  registration.factory().apply(secondCtx)
  secondCtx.flush()

  // THE HANDOVER WINDOW. The old generation has already been retired — that
  // happened inside `acquireDocumentLease`, before the new one touched the
  // shared stylesheet — and the new one has not reconciled yet. Everything this
  // plugin owns per document must be intact across it.
  //
  // Sampling here rather than after `settle()` is what makes the assertion
  // mean something: later, the new owner's own reconcile would refill the sheet
  // and republish the tokens, hiding exactly the blanking this is looking for.
  // The region is (re)attached by the new owner's first reconcile, so at this
  // instant there is none attached. What must not exist is a duplicate, and
  // what must not vanish is everything that lives on the document rather than
  // in the instance.
  assert.ok(probe.regions() <= 1, `the handover must not leave two regions, got ${String(probe.regions())}`)
  assert.ok(
    (probe.sheet('dynamic') ?? '').length > 0,
    'retiring the old instance must NOT blank the shared pin rules',
  )
  assert.ok(
    probe.tokens().size > 0,
    'retiring the old instance must NOT clear the shared theme tokens',
  )

  await settle()
  assert.equal(probe.regions(), 1, `a duplicate apply must not render a second region, got ${String(probe.regions())}`)
  assert.equal(probe.observers(), 1, `exactly one observer group may be live, got ${String(probe.observers())}`)
  assert.ok(
    (probe.sheet('dynamic') ?? '').length > 0,
    'the surviving instance must still hide the pinned host row',
  )

  // The OLD instance disposes after being superseded. Its teardown must not
  // withdraw the shared stylesheet the NEW one depends on.
  firstCtx.dispose()
  await settle()
  assert.equal(probe.regions(), 1, 'the surviving instance keeps its region')
  assert.ok(
    (probe.sheet('dynamic') ?? '').length > 0,
    'a superseded instance disposing must NOT blank the shared pin rules',
  )
  // The theme tokens live on `document.documentElement` and are gated by the
  // SAME `lease.release()` as the pin rules, so both sides of that gate have to
  // be proven, not just the stylesheet half. The false side was sampled in the
  // handover window above; this is the true side.
  assert.equal(
    probe.tokens().has('--stp-token-primary'), true,
    'the surviving owner keeps its theme tokens when the old instance disposes',
  )

  // And the last one out turns everything off.
  secondCtx.dispose()
  await settle()
  assert.equal(probe.regions(), 0, 'the last instance out removes the region')
  assert.equal(probe.anchors(), 0, 'the last instance out removes the anchor')
  assert.equal(probe.observers(), 0, 'the last instance out disconnects the observer')
  assert.equal(probe.sheet('dynamic'), '', 'the last instance out blanks the shared pin rules')
  assert.equal(
    probe.tokens().size, 0,
    'the last instance out removes the theme tokens it owned',
  )
  assert.equal(probe.listeners(), 0, 'the last instance out releases every listener')
}

// ------------------------------------------------------------------------ run

/**
 * Each check reports on its own.
 *
 * One aborted run hides every later result, which is exactly how a suite comes
 * to be trusted while covering less than it claims: a fix that only moves the
 * first failure. So each check is run, its outcome recorded, and the process
 * exits non-zero at the end if any of them failed.
 */
const checks = [
  ['R02: revoke → revive → re-provide re-mounts, in real cordis', testServiceLifecycle],
  ['R02: a mount that throws is recoverable on the next activation', testMountFailureRecovery],
  ['right sidebar: late services, revoke/re-provide, brief switch and disposal, in real cordis', testRightSidebarLifecycle],
  ['R03-minor: a takeover after a failed mount is clean, silent and complete', testTakeoverAfterFailedMount],
  // The name states the moment on purpose. The residue is reclaimed when a
  // NEW instance takes the document over — not at the moment of the failure,
  // and not by the dead fiber's own dispose (measured, see progress.md's Task 1
  // gate). An unqualified "leaves no residue" reads as "none at the failure",
  // which is false.
  ['R03-minor-2: a mount that dies inside the effect body leaves no residue once the next instance takes over', testFailureInsideEffectBody],
  ['R04: a pin RPC that resolves after dispose changes nothing on the page', testAsyncCompletionAfterDispose],
  ['R05: a duplicate apply leaves one region, one observer, one rule set', testDuplicateApply],
]

const failures = []
let cordisVersion = 'unknown'
for (const [label, check] of checks) {
  try {
    const result = await check()
    if (result?.version !== undefined) cordisVersion = result.version
    console.log(`✔ ${label}${result?.version === undefined ? '' : ` (cordis ${result.version})`}`)
  } catch (error) {
    failures.push({ label, error })
    console.log(`✖ ${label}`)
  }
}
globalThis.__restoreConsole()

if (failures.length > 0) {
  console.error(`\n${failures.length} CLIENT LIFECYCLE CHECK(S) FAILED (cordis ${cordisVersion})`)
  for (const { label, error } of failures) {
    console.error(`\n--- ${label} ---`)
    console.error(error?.stack ?? String(error))
  }
  process.exit(1)
}
console.log(`\nALL CLIENT LIFECYCLE CHECKS PASSED (cordis ${cordisVersion})`)
process.exit(0)
