/**
 * Official-count integration: the footer badge and the pinned panel another
 * plugin renders off slot entries must count and list what the OFFICIAL
 * workspace pin set holds, not that plugin's private store.
 *
 * The seam under test is the shadow registration this plugin adds over the
 * third-party `sidebar.footer.action` / `shell.overlay` entries: same cell,
 * same id, one priority lower, original component and original `inject`
 * untouched.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PRIVATE = ['p1', 'p2']
const OFFICIAL = ['o1', 'o2', 'o3', 'o4', 'o5']
const SHADOW_REGISTRANT = 'dsh-session-top: official pin count'

/** Auto-stub DOM node: any unknown member becomes a no-op callable. */
function autoEl(tag = 'div') {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    childNodes: [],
    attrs: {},
    style: new Proxy({ props: {} }, { get: (t, p) => (p in t ? t[p] : () => {}) }),
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    dataset: {},
  }
  return new Proxy(node, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === Symbol.toPrimitive || prop === 'toString') return () => '[el]'
      if (prop === 'querySelectorAll') return () => []
      if (prop === 'querySelector') return () => null
      if (prop === 'getAttribute') return () => null
      if (prop === 'matches' || prop === 'closest') return () => false
      if (prop === 'contains') return () => false
      if (prop === 'textContent' || prop === 'innerHTML' || prop === 'id') return ''
      return (...args) => node.setAttribute?.(...args)
    },
  })
}

function installDom() {
  const body = autoEl('body')
  const head = autoEl('head')
  const document = new Proxy({
    body,
    head,
    documentElement: autoEl('html'),
    createElement: tag => autoEl(tag),
    createTextNode: () => autoEl('#text'),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  }, { get: (t, p) => (p in t ? t[p] : undefined) })
  globalThis.document = document
  globalThis.window = new Proxy({
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: fn => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    location: { href: 'http://localhost/' },
  }, { get: (t, p) => (p in t ? t[p] : undefined) })
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return [] } }
  globalThis.Element = autoEl
  globalThis.KeyboardEvent = class { constructor(type) { this.type = type } }
  globalThis.getComputedStyle = globalThis.window.getComputedStyle
  return document
}

/** The official workspace controller, with the live contract this file reads. */
function officialWorkspaces(ids = OFFICIAL) {
  let snapshot = {
    phase: 'ready',
    pinnedSessionIds: [...ids],
    items: [{ workspaceId: 'ws-a', title: 'Alpha', sessionIds: ['o1'] }],
  }
  const listeners = new Set()
  const rpc = []
  const notify = () => { for (const cb of [...listeners]) cb() }
  return {
    rpc,
    list: {
      getSnapshot: () => snapshot,
      subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
    },
    pinSession: async (id) => {
      rpc.push(['pin', id])
      snapshot = { ...snapshot, pinnedSessionIds: [...snapshot.pinnedSessionIds, id] }
      notify()
      return { ok: true }
    },
    unpinSession: async (id) => {
      rpc.push(['unpin', id])
      snapshot = { ...snapshot, pinnedSessionIds: snapshot.pinnedSessionIds.filter(x => x !== id) }
      notify()
      return { ok: true }
    },
    set(ids) { snapshot = { ...snapshot, pinnedSessionIds: [...ids] }; notify() },
  }
}

/** The third-party pin controller: private store, 2 pinned, public surface. */
class PrivatePinController {
  constructor() {
    this.snapshot = { pinned: [...PRIVATE], workspacePinned: ['ws-a'], colors: { p1: 'red' }, maxPins: 20 }
    this.listeners = new Set()
    this.touched = []
  }

  subscribe = (listener) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getPinned() { return this.snapshot.pinned }
  isPinned(id) { return this.snapshot.pinned.includes(id) }
  getWorkspacePinned() { return this.snapshot.workspacePinned }
  getWorkspacePinnedAt() { return this.snapshot.workspacePinned }
  getMaxPins() { return this.snapshot.maxPins }
  getColor(id) { return this.snapshot.colors[id] }
  getWorkspaceColor() { return undefined }
  getTags() { return { p1: ['board'] } }
  setPinned(id, next) { this.touched.push(['setPinned', id, next]); return Promise.resolve({ ok: true }) }
  toggle(id) { this.touched.push(['toggle', id]); return Promise.resolve({ ok: true }) }
  notify() { for (const cb of [...this.listeners]) cb() }
}

/** Minimal faithful slot registry: same cell + same id, lowest priority wins. */
function makeSlots() {
  const records = new Map()
  const subs = new Map()
  const list = (name) => {
    if (!records.has(name)) records.set(name, [])
    return records.get(name)
  }
  const notify = (name) => {
    for (const cb of [...(subs.get(name) ?? [])]) cb()
  }
  return {
    entries(name) { return [...list(name)] },
    entriesOfSlot(name) {
      const winners = new Map()
      for (const entry of list(name)) {
        const cell = entry.options.key ?? entry.options.id
        const priority = entry.options.priority ?? 0
        const current = winners.get(cell)
        if (current === undefined || priority < (current.options.priority ?? 0)) winners.set(cell, entry)
      }
      return [...winners.values()]
    },
    spec(name) { return list(name).length > 0 || records.has(name) ? { kind: 'list', name } : undefined },
    subscribe(name, cb) {
      if (!subs.has(name)) subs.set(name, new Set())
      subs.get(name).add(cb)
      return () => { subs.get(name)?.delete(cb) }
    },
    register(options, component) {
      const stored = list(options.name)
      const cell = options.key ?? options.id
      const priority = options.priority ?? 0
      const occupant = stored.find(e => (e.options.key ?? e.options.id) === cell && (e.options.priority ?? 0) === priority)
      if (occupant !== undefined) {
        throw new Error(`list slot "${options.name}" already has an entry with id "${cell}" at priority ${priority}`)
      }
      const entry = { options, component, inject: options.inject, registrant: options.registrant }
      stored.push(entry)
      notify(options.name)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        const index = stored.indexOf(entry)
        if (index >= 0) stored.splice(index, 1)
        notify(options.name)
      }
    },
    listenersFor(name) { return (subs.get(name) ?? new Set()).size },
  }
}

/** Fiber-shaped ctx: effects run immediately, teardown runs what they returned. */
function makeCtx(services) {
  const cleanups = []
  const ctx = {
    get: name => services[name],
    set() {},
    on() { return () => {} },
    inject(deps, callback) { callback(ctx); return () => {} },
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
  }
  return {
    ctx,
    dispose() { for (const off of cleanups.splice(0)) off?.() },
  }
}

async function loadBundle() {
  let registration = null
  globalThis.window.__ModuleLoader__ = { load: value => { registration = value } }
  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  new Function('window', 'document', 'Element', 'MutationObserver', 'KeyboardEvent', source)(
    globalThis.window, globalThis.document, autoEl, globalThis.MutationObserver, globalThis.KeyboardEvent,
  )
  assert.ok(registration, 'bundle did not register')
  return registration
}

/** Register the third-party entries exactly as the installed plugin does. */
function registerForeignEntries(slots, pin) {
  const ui = { open: true }
  const t = key => `t:${key}`
  const sessionsFace = { getSnapshot: () => ({ phase: 'ready', ids: [...PRIVATE, ...OFFICIAL], byId: {} }) }
  const workspacesFace = { getSnapshot: () => ({ phase: 'ready', items: [] }) }
  const openSession = () => {}
  const openWorkspace = () => {}
  const FooterComponent = () => null
  const PanelComponent = () => null
  const releases = [
    slots.register({ name: 'sidebar.footer.action', id: 'dsh-session-pin', order: 50, inject: () => ({ pin, ui, t }) }, FooterComponent),
    slots.register({
      name: 'shell.overlay',
      id: 'dsh-session-pin-panel',
      order: 50,
      inject: () => ({ pin, ui, sessions: sessionsFace, workspaces: workspacesFace, t, openSession, openWorkspace }),
    }, PanelComponent),
  ]
  return {
    releases,
    components: { FooterComponent, PanelComponent },
    faces: { ui, t, sessionsFace, workspacesFace, openSession, openWorkspace },
  }
}

const checks = []
const check = (name, fn) => checks.push({ name, fn })

/** How many of the entries in a cell are this plugin's own shadows. */
const shadowsIn = (slots, name) => slots.entries(name)
  .filter(entry => entry.registrant === SHADOW_REGISTRANT).length

check('footer and panel run on official pins, not the private store', () => {
  const footer = slots.entriesOfSlot('sidebar.footer.action')[0]
  const panel = slots.entriesOfSlot('shell.overlay')[0]
  assert.equal(footer.registrant, SHADOW_REGISTRANT, 'footer winner is not the official-count shadow')
  assert.equal(panel.registrant, SHADOW_REGISTRANT, 'panel winner is not the official-count shadow')

  const footerPin = footer.inject().pin
  const panelPin = panel.inject().pin
  assert.deepEqual(footerPin.getPinned(), OFFICIAL, 'footer membership is not the official set')
  assert.deepEqual(panelPin.getPinned(), OFFICIAL, 'panel membership is not the official set')
  assert.deepEqual(pin.getPinned(), PRIVATE, 'the private store was written')

  // Footer badge = sessions + workspaces; the footer counts sessions only.
  const count = footerPin.getPinned().length + footerPin.getWorkspacePinned().length
  assert.equal(count, 5, 'footer badge is not the official count')
  assert.deepEqual(footerPin.getWorkspacePinned(), [], 'footer still counts private workspaces')
  assert.equal(footerPin.getWorkspacePinned(), footerPin.getWorkspacePinned(), 'footer workspace list is not reference-stable')

  // Panel keeps its workspace section and the untouched methods.
  assert.equal(panelPin.getWorkspacePinned(), pin.getWorkspacePinned(), 'panel lost its workspace section')
  assert.equal(panelPin.getColor('p1'), 'red', 'row colours stopped resolving')
  assert.deepEqual(panelPin.getTags(), { p1: ['board'] }, 'tags stopped resolving')
  assert.equal(panelPin.getMaxPins(), 20, 'maxPins stopped resolving')
  assert.equal(footerPin.isPinned(OFFICIAL[0]), true, 'isPinned ignores the official set')
  assert.equal(footerPin.isPinned(PRIVATE[0]), false, 'isPinned still answers from the private store')
})

check('original component, inject faces and props survive the shadow', () => {
  const footer = slots.entriesOfSlot('sidebar.footer.action')[0]
  const panel = slots.entriesOfSlot('shell.overlay')[0]
  assert.equal(footer.component, foreign.components.FooterComponent, 'footer component was replaced')
  assert.equal(panel.component, foreign.components.PanelComponent, 'panel component was replaced')
  assert.deepEqual(footer.options.order, 50, 'footer order changed')
  const panelProps = panel.inject()
  assert.equal(panelProps.ui, foreign.faces.ui, 'panel ui face replaced')
  assert.equal(panelProps.sessions, foreign.faces.sessionsFace, 'panel sessions face replaced')
  assert.equal(panelProps.workspaces, foreign.faces.workspacesFace, 'panel workspaces face replaced')
  assert.equal(panelProps.t, foreign.faces.t, 'panel translator replaced')
  assert.equal(panelProps.openSession, foreign.faces.openSession, 'panel navigation replaced')
  assert.equal(panelProps.openWorkspace, foreign.faces.openWorkspace, 'panel workspace navigation replaced')
  assert.equal(typeof panelProps.pin.getColor, 'function', 'colour methods were not preserved')
})

check('membership arrays are reference-stable until the official set moves', () => {
  const footerPin = slots.entriesOfSlot('sidebar.footer.action')[0].inject().pin
  const first = footerPin.getPinned()
  assert.equal(footerPin.getPinned(), first, 'a second read allocated a new array')
  workspaces.list.getSnapshot()
  assert.equal(footerPin.getPinned(), first, 'an unrelated snapshot read allocated a new array')
  workspaces.set([...OFFICIAL, 'o6'])
  const second = footerPin.getPinned()
  assert.notEqual(second, first, 'a changed set kept the old reference')
  assert.deepEqual(second, [...OFFICIAL, 'o6'])
  workspaces.set(OFFICIAL)
})

check('both the official list and the private store still notify subscribers', () => {
  const footerPin = slots.entriesOfSlot('sidebar.footer.action')[0].inject().pin
  let fired = 0
  const stop = footerPin.subscribe(() => { fired += 1 })
  workspaces.set([...OFFICIAL, 'o9'])
  assert.equal(fired, 1, 'an official pin change did not reach the subscriber')
  pin.notify()
  assert.equal(fired, 2, 'a private change did not reach the subscriber')
  stop()
  workspaces.set([...OFFICIAL, 'o10'])
  pin.notify()
  assert.equal(fired, 2, 'the merged subscription was not fully released')
})

check('writes go through the official RPC, never the private controller', async () => {
  const footerPin = slots.entriesOfSlot('sidebar.footer.action')[0].inject().pin
  await footerPin.setPinned('o7', true)
  assert.deepEqual(workspaces.rpc.at(-1), ['pin', 'o7'], 'pin did not use the official RPC')
  assert.deepEqual(pin.touched, [], 'the private setPinned was called')
  await footerPin.toggle('o1')
  assert.deepEqual(workspaces.rpc.at(-1), ['unpin', 'o1'], 'toggle did not use the official RPC')
  assert.deepEqual(pin.touched, [], 'the private toggle was called')
})

check('a late third-party registration is shadowed, a removal restores the original', () => {
  // remove the originals, then re-register them late
  for (const release of foreign.releases.splice(0)) release()
  assert.equal(shadowsIn(slots, 'sidebar.footer.action'), 0, 'the shadow outlived its target')
  assert.equal(shadowsIn(slots, 'shell.overlay'), 0, 'the panel shadow outlived its target')
  const late = registerForeignEntries(slots, pin)
  assert.equal(slots.entriesOfSlot('sidebar.footer.action')[0].registrant, SHADOW_REGISTRANT, 'the late footer entry was not shadowed')
  assert.equal(slots.entriesOfSlot('shell.overlay')[0].registrant, SHADOW_REGISTRANT, 'the late panel entry was not shadowed')
  assert.equal(shadowsIn(slots, 'sidebar.footer.action'), 1, 'the shadow stacked itself')
  for (const release of late.releases.splice(0)) release()
  assert.equal(shadowsIn(slots, 'sidebar.footer.action'), 0, 'the shadow was not released with its target')
})

check('dispose hands the cells back and leaves the other plugin alone', () => {
  const before = JSON.stringify(pin.snapshot)
  fiber.dispose()
  assert.equal(shadowsIn(slots, 'sidebar.footer.action'), 0, 'the footer shadow outlived dispose')
  assert.equal(shadowsIn(slots, 'shell.overlay'), 0, 'the panel shadow outlived dispose')
  assert.equal(slots.listenersFor('sidebar.footer.action'), 0, 'the slot subscription outlived dispose')
  const restored = registerForeignEntries(slots, pin)
  assert.equal(slots.entriesOfSlot('sidebar.footer.action')[0].registrant, undefined, 'the cell is still occupied')
  assert.equal(slots.entriesOfSlot('shell.overlay')[0].registrant, undefined, 'the panel cell is still occupied')
  for (const release of restored.releases.splice(0)) release()
  assert.equal(JSON.stringify(pin.snapshot), before, 'the private store was written')
  assert.deepEqual(pin.touched, [], 'the private controller was written')
})

check('a missing slot service stays inert instead of stranding boot', () => {
  const slots2 = makeSlots()
  const workspaces2 = officialWorkspaces()
  const pin2 = new PrivatePinController()
  const fiber2 = makeCtx({ workspaces: workspaces2 })
  const err = console.error
  console.error = () => {}
  try {
    bundle.factory().apply(fiber2.ctx)
  } catch {
    console.error = err
    throw new Error('a host with no slot registry must not throw out of apply')
  } finally {
    console.error = err
  }
  assert.equal(slots2.entries('sidebar.footer.action').length, 0)
  assert.equal(workspaces2.rpc.length, 0, 'the private store was written')
  fiber2.dispose()
  assert.ok(pin2)
})

check('an unpublished pin snapshot reads as an empty list, never as null', () => {
  const slots3 = makeSlots()
  const pin3 = new PrivatePinController()
  registerForeignEntries(slots3, pin3)
  // A controller whose list has not published yet: getSnapshot() is undefined,
  // which is also the cache's own "nothing seen" sentinel.
  const workspaces3 = {
    list: { getSnapshot: () => undefined, subscribe: () => () => {} },
    pinSession: async () => ({ ok: true }),
    unpinSession: async () => ({ ok: true }),
  }
  const fiber3 = makeCtx({ workspaces: workspaces3, slots: slots3 })
  bundle.factory().apply(fiber3.ctx)
  const footerPin = slots3.entriesOfSlot('sidebar.footer.action')[0].inject().pin
  const pinned = footerPin.getPinned()
  assert.ok(Array.isArray(pinned), `getPinned returned ${pinned}, which is not an array`)
  assert.equal(pinned.length, 0, 'an unpublished snapshot must read as no pins')
  assert.equal(footerPin.isPinned('o1'), false, 'isPinned must answer, not throw, before publication')
  fiber3.dispose()
})

check('a slot watch that fails to release does not strand the shadows', () => {
  const slots4 = makeSlots()
  const pin4 = new PrivatePinController()
  registerForeignEntries(slots4, pin4)
  const watch = slots4.subscribe
  slots4.subscribe = (name, callback) => {
    watch(name, callback)
    return () => { throw new Error('the watch is already gone') }
  }
  const fiber4 = makeCtx({ workspaces: officialWorkspaces(), slots: slots4 })
  bundle.factory().apply(fiber4.ctx)
  assert.equal(shadowsIn(slots4, 'sidebar.footer.action'), 1, 'the shadow was never registered')
  assert.doesNotThrow(() => fiber4.dispose(), 'a refused watch release aborted teardown')
  assert.equal(shadowsIn(slots4, 'sidebar.footer.action'), 0, 'the footer shadow outlived a refused watch release')
  assert.equal(shadowsIn(slots4, 'shell.overlay'), 0, 'the panel shadow outlived a refused watch release')
})

installDom()
const slots = makeSlots()
const workspaces = officialWorkspaces()
const pin = new PrivatePinController()
const foreign = registerForeignEntries(slots, pin)
const services = { workspaces, sessions: { list: { getSnapshot: () => ({ phase: 'ready', ids: [], byId: {} }), subscribe: () => () => {} } }, slots }
const fiber = makeCtx(services)
const bundle = await loadBundle()

console.warn = () => {}
bundle.factory().apply(fiber.ctx)

let failed = 0
for (const { name, fn } of checks) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${name}\n      ${error?.message ?? error}`)
  }
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed === 0 ? 0 : 1)
