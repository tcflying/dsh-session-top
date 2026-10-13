/**
 * Real-cordis activation test.
 *
 * The stub smoke test (bundle-smoke.mjs) fakes cordis, so it cannot catch the
 * failure mode this package actually shipped with: the bundle registers its
 * factory, the loader materializes it, and the resulting fiber never leaves
 * FiberState.LOADING — reported as "web boot: 1 entry did not activate".
 *
 * This test runs our factory's real return value through the REAL cordis
 * (vendor/cordis, the same version the desktop profile resolves) and asserts
 * the fiber reaches ACTIVE. It is the closest thing to a boot rehearsal that
 * does not need a browser.
 *
 * Run: node test/cordis-activation.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const CORDIS = pathToFileURL(
  join(here, '..', '..', '..', 'deepseek-harness', 'vendor', 'cordis', 'lib', 'index.js'),
).href

const { Context } = await import(CORDIS)

// ------------------------------------------------------------------ DOM stub

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase()
    this.attributes = new Map()
    this.children = []
    this.parentElement = null
    this.style = { setProperty() {}, removeProperty() {} }
    this.textContent = ''
    this.isConnected = true
    this.sheet = {
      cssRules: [],
      deleteRule(i) { this.cssRules.splice(i, 1) },
      insertRule(css) { this.cssRules.push({ cssText: css }); return this.cssRules.length - 1 },
    }
    this.listeners = new Map()
  }

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

  addEventListener(t, fn) {
    if (!this.listeners.has(t)) this.listeners.set(t, [])
    this.listeners.get(t).push(fn)
  }

  removeEventListener(t, fn) {
    const l = this.listeners.get(t) ?? []
    const i = l.indexOf(fn)
    if (i >= 0) l.splice(i, 1)
  }

  querySelector() { return null }
  querySelectorAll() { return [] }
  closest() { return null }
  click() {}
}

globalThis.document = {
  body: new FakeElement('body'),
  head: new FakeElement('head'),
  createElement: (tag) => new FakeElement(tag),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} }
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.Element = FakeElement

// ------------------------------------------------------------ react + modules

const rendered = []
const React = { createElement: (t, p, ...c) => ({ t, p, c }), Fragment: Symbol('Fragment') }
const platformModules = {
  react: React,
  'react-dom/client': { createRoot: () => ({ render: (n) => rendered.push(n), unmount() {} }) },
  '@deepseek-ai/dsh-client-ui-primitives': {
    IconPinFillRegular: 'IconPinFillRegular',
    IconPinOutlineRegular: 'IconPinOutlineRegular',
    Menu: 'Menu',
    relativeTime: () => ({ unit: 'now', n: 0 }),
  },
}

let registration = null
globalThis.window.__ModuleLoader__ = { load: (v) => { registration = v } }

const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
new Function('window', 'document', 'require', 'Element', 'MutationObserver', source)(
  globalThis.window,
  globalThis.document,
  spec => {
    if (!(spec in platformModules)) throw new Error(`unexpected require: ${spec}`)
    return platformModules[spec]
  },
  FakeElement,
  globalThis.MutationObserver,
)

assert.ok(registration, 'bundle did not register')

// The factory must produce a plugin object cordis accepts, and cordis must be
// able to bring that fiber all the way to ACTIVE.
const plugin = registration.factory(spec => platformModules[spec])
assert.equal(plugin.name, 'dsh-session-top', 'plugin name must equal the package name')
assert.deepEqual(plugin.inject, [], 'no service may be required; a missing one stalls the fiber')
assert.equal(typeof plugin.apply, 'function')

// Minimal services the plugin reads, provided on the test root context.
const services = {
  workspaces: {
    list: { getSnapshot: () => ({ items: [], pinnedSessionIds: [] }), subscribe: () => () => {} },
  },
  sessions: {
    list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }), subscribe: () => () => {} },
  },
}

const root = new Context()
for (const [name, value] of Object.entries(services)) root.provide(name, value)

// Deliberately NOT mirrored as plain properties: cordis contexts are Proxies,
// and reading an undeclared `ctx.<name>` throws. The plugin must therefore
// resolve services with `ctx.get`, which is what this test exercises.
const ctx = root.extend({})

const fiber = ctx.plugin(plugin)
await fiber.await()

// 2 === FiberState.ACTIVE (numeric mirror of cordis's const enum).
assert.equal(
  fiber.state,
  2,
  `fiber must reach ACTIVE (2), got state ${String(fiber.state)} — a non-ACTIVE state here is exactly the `
  + '"web boot: 1 entry did not activate" failure',
)
console.log('✔ factory output activates in real cordis 4.0.4 with workspaces+sessions present')

// The stronger case: NOTHING is provided. A bare `ctx.<service>` read throws
// "cannot get property ... without inject" from the context Proxy, escapes
// apply(), and strands the fiber in LOADING. This is the exact production
// failure — `uiWorkspace` and `locale` are never provided to this plugin,
// because it injects nothing. With the fix, the plugin degrades to inert.
const bare = new Context()
const bareFiber = bare.extend({}).plugin(plugin)
await bareFiber.await()
assert.equal(
  bareFiber.state,
  2,
  `plugin must still activate with no services at all, got state ${String(bareFiber.state)}`,
)
console.log('✔ plugin degrades to inert and still reaches ACTIVE with zero services')

// The plugin leaves a 20s diagnostic timer behind when the controller never
// arrives. Dispose both fibers so the harness does not sit on that timer.
fiber.dispose()
bareFiber.dispose()

console.log('\nALL CORDIS ACTIVATION CHECKS PASSED')