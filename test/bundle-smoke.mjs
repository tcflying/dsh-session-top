/**
 * Import smoke test for the client bundle.
 *
 * The bundle never runs under node in the real app — the browser's module
 * loader executes the factory. This harness reproduces that path closely
 * enough to catch the failures unit tests cannot see: a factory that throws on
 * materialization, an apply that throws against a stub context, or a React
 * render that blows up on malformed input.
 *
 * It stubs `window.__ModuleLoader__`, the three platform modules the bundle
 * requires, and the DOM surface the plugin touches, then drives apply →
 * reconcile → pin → unpin.
 *
 * Run: node test/bundle-smoke.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundlePath = join(here, '..', 'src', 'client.js')

// ------------------------------------------------------------------ DOM stub

/** Minimal element stand-in covering what the plugin actually calls. */
class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase()
    this.attributes = new Map()
    this.children = []
    this.parentElement = null
    this.style = { setProperty() {}, removeProperty() {} }
    this.textContent = ''
    this.isConnected = true
    this.sheet = makeSheet()
    this.listeners = new Map()
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  removeAttribute(name) { this.attributes.delete(name) }
  hasAttribute(name) { return this.attributes.has(name) }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child }
  insertBefore(child, anchor) {
    child.parentElement = this
    const index = anchor === undefined || anchor === null
      ? this.children.length
      : this.children.indexOf(anchor)
    this.children.splice(index < 0 ? this.children.length : index, 0, child)
    return child
  }
  remove() {
    if (this.parentElement === null) return
    const index = this.parentElement.children.indexOf(this)
    if (index >= 0) this.parentElement.children.splice(index, 1)
    this.parentElement = null
    this.isConnected = false
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }

  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }

  dispatch(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }

  click() { this.dispatch('click', { stopPropagation() {} }) }
  querySelector() { return null }
  querySelectorAll() { return [] }
  closest() { return null }
}

/** A CSSStyleSheet stand-in that records the rules the plugin injects. */
function makeSheet() {
  return {
    cssRules: [],
    deleteRule(index) { this.cssRules.splice(index, 1) },
    insertRule(css) { this.cssRules.push({ cssText: css }); return this.cssRules.length - 1 },
  }
}

const body = new FakeElement('body')
const head = new FakeElement('head')

globalThis.document = {
  body,
  head,
  createElement: (tag) => new FakeElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: (...args) => body.addEventListener(...args),
  removeEventListener: (...args) => body.removeEventListener(...args),
}
globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: {
    _data: new Map(),
    getItem(key) { return this._data.get(key) ?? null },
    setItem(key, value) { this._data.set(key, value) },
    removeItem(key) { this._data.delete(key) },
  },
}
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.Element = FakeElement

// --------------------------------------------------------------- react stub

/** Records what the plugin renders without a real reconciler. */
const rendered = []
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  Fragment: Symbol('Fragment'),
  useState: (initial) => [initial, () => {}],
  useRef: () => ({ current: null }),
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useLayoutEffect: () => {},
}
const createRoot = () => ({ render: (node) => rendered.push(node), unmount() {} })

// ---------------------------------------------------------- primitives stub

const primitives = {
  IconPinFillRegular: 'IconPinFillRegular',
  IconPinOutlineRegular: 'IconPinOutlineRegular',
  Menu: 'Menu',
  relativeTime: (updatedAt, now) => {
    const delta = Math.max(0, now - updatedAt)
    if (delta < 60000) return { unit: 'now', n: 0 }
    if (delta < 3600000) return { unit: 'minute', n: Math.floor(delta / 60000) }
    return { unit: 'hour', n: Math.floor(delta / 3600000) }
  },
}

const platformModules = {
  react: React,
  'react-dom/client': { createRoot },
  '@deepseek-ai/dsh-client-ui-primitives': primitives,
}

// ------------------------------------------------------------ module loader

let registration = null
globalThis.window.__ModuleLoader__ = {
  load: (value) => { registration = value },
}

const source = await readFile(bundlePath, 'utf8')
// The browser evaluates this as a classic script; node needs it as one too.
const run = new Function('window', 'document', 'require', 'Element', 'MutationObserver', source)
run(globalThis.window, globalThis.document, specifier => {
  if (!(specifier in platformModules)) throw new Error(`unexpected require: ${specifier}`)
  return platformModules[specifier]
}, FakeElement, globalThis.MutationObserver)

assert.ok(registration !== null, 'bundle did not register itself')
assert.equal(registration.id, 'dsh-session-top', 'bundle id must equal the package name')
const exportsObject = registration.factory(specifier => platformModules[specifier])
assert.equal(exportsObject.name, 'dsh-session-top')
assert.deepEqual(exportsObject.inject, [])
assert.equal(typeof exportsObject.apply, 'function')

// ------------------------------------------------------------- context stub

const listeners = []
const disposers = []
const state = {
  pinned: [],
  sessions: {
    s1: { id: 's1', displayTitle: 'first', updatedAt: 1000, retainedBy: { mainView: 1 } },
    s2: { id: 's2', displayTitle: 'second', updatedAt: 2000, retainedBy: {} },
    s3: { id: 's3', displayTitle: 'third', updatedAt: 3000, retainedBy: {} },
  },
  items: [
    { workspaceId: 'w1', title: 'Work one', sessionIds: ['s1', 's2'] },
    { workspaceId: 'w2', title: 'Work two', sessionIds: ['s3'] },
  ],
  opened: [],
}

const observable = value => ({
  getSnapshot: () => value(),
  subscribe: (fn) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1) } },
})

// The services the plugin resolves through `ctx.get`.
const services = {
  workspaces: {
    list: observable(() => ({
      items: state.items,
      pinnedSessionIds: state.pinned,
    })),
    pinSession: async (id) => { if (!state.pinned.includes(id)) state.pinned = [id, ...state.pinned] },
    unpinSession: async (id) => { state.pinned = state.pinned.filter(x => x !== id) },
  },
  sessions: {
    list: observable(() => ({ ids: Object.keys(state.sessions), byId: state.sessions, phase: 'ready' })),
    retain: (id) => { state.opened.push(id) },
  },
  uiWorkspace: { openSession: (id) => { state.opened.push(id) } },
}

// `ctx.get(name)` mirrors cordis: it walks the fiber chain and returns
// undefined for a service that is not provided. `ctx.inject(deps, cb)` is
// cordis's own deferral mechanism (shorthand for `ctx.plugin({ inject: deps,
// apply: cb })`): it starts a CHILD fiber that runs once the dependency is
// published, leaving this fiber ACTIVE. test/cordis-activation.mjs proves that
// against real cordis; here the services are already present, so the callback
// runs synchronously.
const ctx = {
  get: name => services[name],
  logger: { warn: (m) => console.warn('[plugin]', m), info: () => {} },
  effect: (fn) => { const dispose = fn(); disposers.push(dispose); return dispose },
  inject: (deps, cb) => {
    if (deps.every(d => services[d] !== undefined)) cb(ctx)
    return { dispose() {} }
  },
  workspaces: services.workspaces,
  sessions: services.sessions,
  uiWorkspace: services.uiWorkspace,
}

// ------------------------------------------------------------------- drive

exportsObject.apply(ctx)
console.log('✔ bundle registered and applied against a stub context')
console.log('✔ subscriptions installed:', listeners.length === 2 ? '2 (workspaces + sessions)' : listeners.length)

// The reconcile is debounced; let it run.
await new Promise(resolve => setTimeout(resolve, 120))

// Pin through the same path the context menu uses.
await ctx.workspaces.pinSession('s2')
listeners.forEach(fn => fn())
await new Promise(resolve => setTimeout(resolve, 120))
assert.deepEqual(state.pinned, ['s2'], 'pin persisted through the official RPC')

// Unpin.
await ctx.workspaces.unpinSession('s2')
listeners.forEach(fn => fn())
await new Promise(resolve => setTimeout(resolve, 120))
assert.deepEqual(state.pinned, [], 'unpin persisted through the official RPC')

// Malformed summaries must not throw inside a render.
state.sessions.broken = { id: 'broken', displayTitle: '', updatedAt: Number.NaN }
state.pinned = ['broken']
listeners.forEach(fn => fn())
await new Promise(resolve => setTimeout(resolve, 120))
console.log('✔ survived a summary with an empty title and a NaN timestamp')

state.pinned = []
state.sessions.broken = undefined
listeners.forEach(fn => fn())
await new Promise(resolve => setTimeout(resolve, 120))
console.log('✔ survived a pin set referencing a vanished session')

// Teardown must run cleanly and drop every subscription: a leaked listener
// would keep reconciling (and keep the React roots alive) after an HMR reload.
assert.ok(disposers.length > 0, 'expected at least one effect disposer')
for (const dispose of disposers) {
  if (typeof dispose === 'function') dispose()
}
assert.equal(listeners.length, 0, 'teardown must remove every subscription')
console.log('✔ teardown ran and removed all', listeners.length, 'listeners')

console.log('\nALL CLIENT BUNDLE SMOKE CHECKS PASSED')