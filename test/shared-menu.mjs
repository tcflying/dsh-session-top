/**
 * Shared session context-menu behavior test.
 *
 * The right-click session menu on the real desktop belongs to
 * `@baihejiangnan/dsh-session-context-menu`. Its client half (lib/client.js; the
 * 0.2.14 tagged artifact here) creates a shared extension table on
 * `globalThis` under `Symbol.for('dsh.session-context-menu.extensions')`, takes a
 * lease on it, renders `.dshcm-menu[role=menu]` on every session right-click, and
 * appends every registered entry whose `visible({session,row})` is not false —
 * calling `run({session,row,sessions,workspaces,close})` after it has closed its
 * own menu.
 *
 * SCOPE. This file pins the SHARED-TABLE contract — registration, the lease, the
 * claim-by-`preventDefault`, extension filtering and ordering — which is the same
 * across the owner's revisions. It does NOT pin the owner's own item list, which
 * differs per revision (unreleased main adds 删除会话; the 0.2.14 tagged artifact
 * has no delete entry at all). Per-version menus are pinned by the client's
 * sha256 against hand-written literals in `test/owner-menu-real.mjs`, against the
 * real artifact.
 *
 * This plugin's previous revision instead hunted for `[data-menu-material]`
 * surfaces to graft a pin row into. That owner renders no such attribute, so the
 * graft matched nothing on every machine and the pin affordance simply never
 * appeared. The mock below is a faithful transcription of the owner's registry,
 * its listener and its extension rendering, so these tests fail against the old
 * code for the right reason.
 *
 * Run: node test/shared-menu.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const KEY = Symbol.for('dsh.session-context-menu.extensions')
const LEASE = Symbol.for('dsh.session-context-menu.lease')

const S1 = 'session-aaaaaaaa-1111-4111-8111-111111111111'
const S2 = 'session-bbbbbbbb-2222-4222-8222-222222222222'
const PIN_ID = 'dsh-session-top.pin'
const UNPIN_ID = 'dsh-session-top.unpin'
const COLOR_ID = 'dsh-session-top.row-color'
const COLOR_LABEL = '自定义行背景颜色…'

// --------------------------------------------------------------- fake DOM

class El {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase()
    this.attributes = new Map()
    this.children = []
    this.parentElement = null
    this.listeners = new Map()
    this.textContent = ''
    this.isConnected = true
    this.style = { props: new Map(), setProperty: (k, v) => { this.style.props.set(k, v) }, removeProperty: (k) => { this.style.props.delete(k) } }
  }

  get classList() { return new Set((this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)) }
  get firstChild() { return this.children[0] ?? null }
  get firstElementChild() { return this.children[0] ?? null }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null }
  get className() { return this.getAttribute('class') ?? '' }
  set className(value) { this.setAttribute('class', value) }

  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  removeAttribute(name) { this.attributes.delete(name) }
  hasAttribute(name) { return this.attributes.has(name) }

  appendChild(child) { child.parentElement = this; this.children.push(child); child.isConnected = true; return child }
  insertBefore(child, anchor) {
    child.parentElement = this
    const index = anchor === undefined || anchor === null ? this.children.length : this.children.indexOf(anchor)
    this.children.splice(index < 0 ? this.children.length : index, 0, child)
    child.isConnected = true
    return child
  }
  remove() {
    if (this.parentElement === null) return
    const index = this.parentElement.children.indexOf(this)
    if (index >= 0) this.parentElement.children.splice(index, 1)
    this.parentElement = null
    this.isConnected = false
  }

  descendants() {
    const out = []
    const walk = (node) => { for (const child of node.children) { out.push(child); walk(child) } }
    walk(this)
    return out
  }

  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn) }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }
  dispatch(type, event = {}) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event) }
  click() {
    this.dispatch('click', { preventDefault() {}, stopPropagation() {} })
    if (typeof this.onclick === 'function') this.onclick({ preventDefault() {}, stopPropagation() {} })
  }
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 180, height: 200 } }

  matches(selector) { return matchSimple(this, selector) }
  closest(selector) {
    let node = this
    while (node !== null) {
      if (node.matches?.(selector)) return node
      node = node.parentElement
    }
    return null
  }
  querySelector(selector) { return this.descendants().find(node => node.matches(selector)) ?? null }
  querySelectorAll(selector) { return this.descendants().filter(node => node.matches(selector)) }
}

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

function matchSimple(el, selector) {
  for (const group of selector.split(',').map(s => s.trim()).filter(Boolean)) {
    const compounds = group.split(/\s+/).filter(Boolean)
    if (compounds.length === 0) continue
    if (!matchCompound(el, compounds[compounds.length - 1])) continue
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

// ------------------------------------------------- the owner's own code

/**
 * Transcribed from @baihejiangnan/dsh-session-context-menu@0.2.14
 * lib/client.js:70-92 — the registry is created lazily by the OWNER and frozen,
 * and unchanged by later revisions;
 * register() throws on a duplicate id; the returned disposer also drops the
 * global when nothing holds it any more.
 */
function ownerRegistry() {
  if (!globalThis[KEY]) {
    const entries = new Map()
    let leases = 0
    const api = {
      register(entry) {
        if (!entry?.id || entries.has(entry.id)) throw new Error('invalid or duplicate context-menu extension')
        entries.set(entry.id, entry)
        return () => {
          entries.delete(entry.id)
          if (!leases && !entries.size && globalThis[KEY] === api) delete globalThis[KEY]
        }
      },
      list: () => [...entries.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
      [LEASE](delta) {
        leases += delta
        if (!leases && !entries.size && globalThis[KEY] === api) delete globalThis[KEY]
      },
    }
    globalThis[KEY] = Object.freeze(api)
  }
  return globalThis[KEY]
}

/**
 * The owner's session-menu apply: listener on document in the capture phase,
 * `if (event.defaultPrevented) return`, then its own items and every visible
 * extension, each `close()`d before `run()`.
 *
 * Faithful in the three properties the plugin has to interoperate with: it
 * bails on an already-handled event, it renders `.dshcm-menu[role=menu]` (never
 * a `[data-menu-material]` surface), and it filters extensions through
 * `visible?.({session, row}) !== false` (0.2.14 lib/client.js:617-627).
 * The owner's own ITEM LIST below is this file's own stand-in, not a
 * revision-exact copy — see the header.
 */
function applyOwner({ document, sessions, workspaces, ownCalls }) {
  const api = ownerRegistry()
  api[LEASE](1)
  let menu = null
  const close = () => { menu?.remove(); menu = null }

  const add = (root, label, run) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dshcm-item'
    button.setAttribute('role', 'menuitem')
    const text = document.createElement('span')
    text.textContent = label
    button.appendChild(text)
    button.onclick = async () => { close(); await run() }
    root.appendChild(button)
  }

  const resolveSession = (row) => {
    const state = sessions.list.getSnapshot()
    // 0.2.14's own resolution: the retained main session, else a unique
    // title match. No `snapshot.current` — the live ClientSessions snapshot has
    // no such field.
    if (row.getAttribute('aria-selected') === 'true') {
      const main = Object.values(state.byId).find(s => (s.retainedBy?.mainView ?? 0) > 0)
      if (main !== undefined) return main
    }
    const title = row.firstElementChild?.textContent?.trim()
    if (!title) return null
    const matches = state.ids.map(id => state.byId[id]).filter(item => item && (item.title === title || item.displayTitle === title))
    return matches.length === 1 ? matches[0] : null
  }

  const onContextMenu = (event) => {
    if (event.defaultPrevented) return
    const row = event.target instanceof El ? event.target.closest('[role="treeitem"]') : null
    const session = row ? resolveSession(row) : null
    if (!row) return
    event.preventDefault()
    event.stopPropagation()
    close()
    const root = document.createElement('div')
    root.className = 'dshcm-menu'
    root.setAttribute('role', 'menu')
    root.style.visibility = 'hidden'
    document.body.appendChild(root)
    menu = root

    add(root, '重命名会话', () => { ownCalls.push('rename') })
    add(root, '归档会话', () => { ownCalls.push('archive') })
    add(root, '永久删除会话', () => { ownCalls.push('delete') })
    const registered = api.list()
    const extensions = session
      ? registered.filter(entry => entry.visible?.({ session, row }) !== false)
      : []
    for (const entry of extensions) {
      add(root, entry.label || entry.id, () => entry.run({ session, row, sessions, workspaces, close: () => { ownCalls.push('close'); close() } }))
    }
    add(root, '刷新', () => { ownCalls.push('refresh') })
  }

  document.addEventListener('contextmenu', onContextMenu, true)
  return {
    api,
    dispose() {
      close()
      document.removeEventListener('contextmenu', onContextMenu, true)
      api[LEASE](-1)
    },
  }
}

// ---------------------------------------------------------- the host page

/**
 * The host page.
 *
 * `official` builds the STOCK sidebar instead of codex-ui's: the same rows,
 * keyed the way the stock sidebar keys them and deliberately WITHOUT the "…"
 * row control. That combination is what still reaches the plugin's own menu —
 * on codex the host serves its own session menu, and on a stock row carrying
 * the host control the hand-off borrows that instead.
 *
 * @param {object} [options] - which rendering to build.
 * @param {boolean} [options.official] - the stock sidebar, not codex-ui.
 */
function page({ official = false } = {}) {
  const body = new El('body')
  const head = new El('head')
  const listArea = new El('div')
  const treeBody = new El('div')
  const tree = new El('div')
  const project = new El('div')
  const head2 = new El('div')
  tree.setAttribute('role', 'tree')
  if (official === true) {
    tree.setAttribute('aria-label', 'sessions')
    head2.setAttribute('data-row-key', 'workspace:w1')
    head2.setAttribute('aria-expanded', 'true')
    tree.appendChild(head2)
  } else {
    tree.className = 'dcu-wb-tree'
    project.className = 'dcu-wb-project'
    head2.className = 'dcu-wb-project-head'
    head2.setAttribute('aria-expanded', 'true')
    project.appendChild(head2)
  }
  const rows = {}
  for (const id of [S1, S2]) {
    const row = new El('div')
    const title = new El('span')
    title.textContent = id === S1 ? 'first' : 'second'
    row.appendChild(title)
    if (official === true) {
      row.setAttribute('role', 'treeitem')
      row.setAttribute('data-row-key', `session:${id}`)
      tree.appendChild(row)
    } else {
      row.className = 'dcu-wb-session'
      row.setAttribute('role', 'treeitem')
      row.setAttribute('data-dcu-session', id)
      title.className = 'dcu-wb-session-title'
      project.appendChild(row)
    }
    rows[id] = { row, title }
  }
  if (official !== true) tree.appendChild(project)
  treeBody.appendChild(tree)
  listArea.appendChild(treeBody)
  body.appendChild(listArea)

  const docListeners = new Map()
  const document = {
    body,
    head,
    documentElement: new El('html'),
    createElement: (tag) => new El(tag),
    querySelector: (sel) => body.querySelector(sel) ?? head.querySelector(sel),
    querySelectorAll: (sel) => [...body.querySelectorAll(sel), ...head.querySelectorAll(sel)],
    addEventListener: (t, fn) => { if (!docListeners.has(t)) docListeners.set(t, []); docListeners.get(t).push(fn) },
    removeEventListener: (t, fn) => {
      const list = docListeners.get(t) ?? []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
    },
    dispatchEvent: () => {},
  }
  return { body, head, tree, rows, document, docListeners }
}

/**
 * A contextmenu event delivered the way a document-capture listener sees it:
 * every document listener runs, in registration order, on the SAME object — a
 * `stopPropagation` from one of them does not shield the others, exactly as in
 * a real DOM, and `defaultPrevented` is what each later listener checks.
 */
function rightClick(document, target) {
  const ev = {
    target,
    clientX: 10,
    clientY: 20,
    defaultPrevented: false,
    stopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.stopped = true },
  }
  return ev
}

/**
 * Deliver a contextmenu event and let the plugin's deferred fallback finish.
 *
 * Ownership is decided by what the event DID (see the plugin's
 * `onContextMenu`), so the fallback opens one microtask after the dispatch —
 * after every document-capture listener has run. Asserting synchronously after
 * dispatching tests the race, not the behaviour.
 */
async function rightClickAndSettle(docListeners, target) {
  const ev = rightClick(null, target)
  for (const fn of [...(docListeners.get('contextmenu') ?? [])]) fn(ev)
  await new Promise(r => { queueMicrotask(() => { setTimeout(r, 0) }) })
  return ev
}

/** The owner's rendered menuitem BUTTONS, in order (0.2.14 appends them straight to the menu root). */
function menuItems(document) {
  const menu = document.body.querySelector('.dshcm-menu')
  return menu === null ? null : [...menu.children]
}

/** The labels rendered inside the owner's open menu, in order. */
function menuLabels(document) {
  const items = menuItems(document)
  return items === null ? null : items.map(labelOf)
}

/** One rendered item, addressed by the label a user would read. */
function menuItem(document, label) {
  return menuItems(document)?.find(item => labelOf(item) === label)
}

function labelOf(node) {
  const own = node.textContent
  return own === '' ? node.children.map(labelOf).join('') : own
}

// ------------------------------------------------------------ run the plugin

async function run({
  pinned = [], withOwner = 'before', withUiWorkspace = true, refuseUnpin = false,
  throwOnOpen = false, deferUnpinReject = false, official = false,
} = {}) {
  // Set when `deferUnpinReject` asked for an RPC that settles on OUR schedule,
  // so a rejection can be delivered after the plugin has been disposed.
  let rejectPending = null
  delete globalThis[KEY]
  const scaffold = page({ official })
  const ownCalls = []
  const pinCalls = []
  const opened = []
  const retained = []

  const summaries = {
    [S1]: { id: S1, displayTitle: 'first', cwd: '/work/one', updatedAt: 1 },
    [S2]: { id: S2, displayTitle: 'second', cwd: '/work/two', updatedAt: 2 },
  }
  const services = {
    workspaces: {
      list: {
        getSnapshot: () => ({
          items: [{ workspaceId: 'w1', title: 'W1', path: '/work', sessionIds: [S1, S2] }],
          pinnedSessionIds: pinned,
          archivedSessionIds: [],
          phase: 'ready',
        }),
        subscribe: () => () => {},
      },
      pinSession: async (id) => { pinCalls.push(['pin', id]) },
      unpinSession: async (id) => {
        if (deferUnpinReject) {
          // Sits unresolved until the test releases it — the shape of a host RPC
          // that answers after this plugin generation is gone.
          await new Promise((_resolve, reject) => { rejectPending = reject })
          return
        }
        if (refuseUnpin) {
          // A real host-side refusal: an Error subclass carrying an rpcError,
          // NOT a bare object — String() on either would say nothing useful.
          const error = new Error('unpin refused')
          error.rpcError = { code: 'session/writer-held', message: 'writer held' }
          throw error
        }
        pinCalls.push(['unpin', id])
      },
    },
    sessions: {
      // The LIVE ClientSessions snapshot shape, verbatim from
      // dsh-client-runtime: {ids, byId, phase, projectionsBySession}. There is
      // deliberately NO `current` key — a previous revision of this test added
      // one, which is how the plugin's selection state came to be verified
      // against a field the real store does not carry.
      list: {
        getSnapshot: () => ({ ids: [S1, S2], byId: summaries, phase: 'ready', projectionsBySession: {} }),
        subscribe: () => () => {},
      },
      create: async () => ({}),
      fork: async () => ({}),
      archive: async () => ({}),
      // `retain` IS part of the live contract (reference-counted binding), and
      // `subagentAddress` is read by UiWorkspaceService — so the stub has both,
      // which is what makes "never call retain as navigation" a real assertion.
      retain: (...args) => { retained.push(args); return { sessionId: args[0], release() {} } },
      subagentAddress: () => undefined,
    },
  }
  if (withUiWorkspace === 'late') {
    // Published only AFTER the plugin has mounted — the exact timing that used
    // to be captured as `undefined` at mount time and never re-read.
    services.__publishUiWorkspace = () => {
      services.uiWorkspace = {
        openSession: (id) => { opened.push(['uiWorkspace.openSession', id]) },
        mainReference: { sessionId: S2, release() {} },
      }
    }
  } else if (withUiWorkspace) {
    services.uiWorkspace = {
      // `throwOnOpen` is a SYNCHRONOUS throw out of the host's own seam. It is
      // a different failure from a missing service, and the user is told a
      // different thing about it.
      openSession: (id) => {
        if (throwOnOpen) throw new Error('openSession exploded')
        opened.push(['uiWorkspace.openSession', id])
      },
      mainReference: { sessionId: S2, release() {} },
    }
  }

  globalThis.document = scaffold.document
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 1200, innerHeight: 800 }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.Element = El
  globalThis.KeyboardEvent = class { constructor(type, init) { Object.assign(this, init) } }

  let registration = null
  globalThis.window.__ModuleLoader__ = { load: (value) => { registration = value } }
  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  new Function('window', 'document', 'Element', 'MutationObserver', 'KeyboardEvent', source)(
    globalThis.window, scaffold.document, El, globalThis.MutationObserver, globalThis.KeyboardEvent,
  )
  const exportsObject = registration.factory()

  const disposers = []
  const ctx = {
    get: name => services[name],
    logger: { warn: () => {}, info: () => {} },
    effect: (fn) => { const dispose = fn(); disposers.push(dispose); return dispose },
    inject: (deps, cb) => {
      if (deps.every(dep => services[dep] !== undefined)) cb(ctx)
      return { dispose() {} }
    },
  }

  let owner = null
  if (withOwner === 'before') owner = applyOwner({ document: scaffold.document, sessions: services.sessions, workspaces: services.workspaces, ownCalls })

  const realWarn = console.warn
  const realInfo = console.info
  console.warn = () => {}
  console.info = () => {}
  exportsObject.apply(ctx)
  console.warn = realWarn
  console.info = realInfo

  if (withOwner === 'after') owner = applyOwner({ document: scaffold.document, sessions: services.sessions, workspaces: services.workspaces, ownCalls })

  await new Promise(r => { setTimeout(r, withOwner === 'after' ? 700 : 200) })

  return {
    ...scaffold,
    owner,
    pinCalls,
    opened,
    retained,
    ownCalls,
    /** Publish `uiWorkspace` after mount, the way a late host plugin does. */
    publishUiWorkspace() { services.__publishUiWorkspace?.() },
    /** Settle a deferred unpin RPC with a rejection. */
    rejectPendingUnpin(error = new Error('unpin refused late')) {
      const reject = rejectPending
      rejectPending = null
      reject?.(error)
    },
    dispose() { for (const one of disposers.splice(0)) one() },
    disposeOwner() { owner?.dispose() },
  }
}

// ---------------------------------------------------------------- the tests

// --- owner initialized BEFORE the plugin: entries land in its table at mount
{
  const run1 = await run({ withOwner: 'before', pinned: [] })
  const entries = run1.owner.api.list()
  assert.deepEqual(entries.map(entry => entry.id), [PIN_ID, UNPIN_ID, COLOR_ID], 'every entry must be registered in order')
  assert.equal(entries[0].label, '置顶该会话')
  assert.equal(entries[1].label, '取消置顶')
  assert.equal(entries[2].label, COLOR_LABEL)
  assert.deepEqual(entries.map(entry => entry.order), [50, 51, 52], 'the pin/unpin orders must be unchanged')
  console.log('✔ owner first: pin/unpin/row-colour are in the shared table at mount, in order')

  // The right-click must reach the owner untouched by the plugin.
  const ev = await rightClickAndSettle(run1.docListeners, run1.rows[S1].title)
  assert.equal(ev.defaultPrevented, true, 'the owner builds the menu')
  assert.ok(
    run1.document.body.querySelector('[data-stp-menu]') === null,
    "the plugin must not open a menu of its own while the owner owns the gesture",
  )

  const labels = menuLabels(run1.document)
  assert.deepEqual(
    labels,
    ['重命名会话', '归档会话', '永久删除会话', '置顶该会话', COLOR_LABEL, '刷新'],
    `the owner's own items must survive next to ours; got ${JSON.stringify(labels)}`,
  )
  console.log('✔ owner live: the gesture is untouched and the host items are preserved')

  // Clicking our entry closes the owner's menu and pins through the official RPC.
  const pinItem = menuItem(run1.document, '置顶该会话')
  pinItem.click()
  await new Promise(r => { setTimeout(r, 20) })
  assert.deepEqual(run1.pinCalls, [['pin', S1]], 'the entry must pin through workspaces.pinSession')
  assert.ok(run1.ownCalls.includes('close'), 'the owner menu must be closed before the action runs')
  assert.equal(run1.document.body.querySelector('.dshcm-menu'), null, 'and the menu must be gone')
  console.log('✔ owner live: the Pin entry closes the menu and pins through the official RPC')

  run1.dispose()
  assert.deepEqual(run1.owner.api.list(), [], 'disposal must take both entries back out of the table')
  run1.disposeOwner()
  assert.equal(globalThis[KEY], undefined, 'with no lease and no entries the owner drops the table')
  console.log('✔ disposal unregisters both entries and leaves the table as it was found')
}

// --- a session pinned by ANY route offers Unpin, from a plain host row
{
  const run1 = await run({ withOwner: 'before', pinned: [S1] })
  // S1 is pinned, S2 is not — and S1 is an ordinary host row, not one of ours.
  await rightClickAndSettle(run1.docListeners, run1.rows[S1].title)
  const labels = menuLabels(run1.document)
  assert.deepEqual(labels, ['重命名会话', '归档会话', '永久删除会话', '取消置顶', COLOR_LABEL, '刷新'])
  assert.ok(!labels.includes('置顶该会话'), 'pin and unpin must be mutually exclusive')
  menuItem(run1.document, '取消置顶').click()
  await new Promise(r => { setTimeout(r, 20) })
  assert.deepEqual(run1.pinCalls, [['unpin', S1]], 'Unpin must write through workspaces.unpinSession')
  console.log('✔ an already-pinned host row offers Unpin — the official pin set is the only truth')
}

// --- owner initialized AFTER the plugin: the bounded retry finds it
{
  const run1 = await run({ withOwner: 'after', pinned: [] })
  assert.deepEqual(
    run1.owner.api.list().map(entry => entry.id),
    [PIN_ID, UNPIN_ID, COLOR_ID],
    'a late owner must still receive the entries, however the two apply orders fall out',
  )
  await rightClickAndSettle(run1.docListeners, run1.rows[S2].title)
  assert.equal(run1.document.body.querySelector('.dshcm-menu') !== null, true, 'the owner now builds the menu')
  assert.ok(run1.document.body.querySelector('[data-stp-menu]') === null, "the plugin still keeps its hands off")
  console.log('✔ owner last: the bounded retry publishes the entries and the plugin steps aside')
  run1.dispose()
  run1.disposeOwner()
}

// --- NO owner at all, on codex. codex serves its own session menu on
// right-click, so the gesture is not this plugin's to claim: with nobody
// building a menu it still must not cover the host's. And it must never invent
// the owner's table, claim blank space, or write into a foreign surface.
{
  const run1 = await run({ withOwner: 'none', pinned: [] })
  assert.equal(globalThis[KEY], undefined, 'the plugin must never create the owner\'s table itself')

  const ev = await rightClickAndSettle(run1.docListeners, run1.rows[S1].title)
  assert.equal(ev.defaultPrevented, false, "codex's own session menu must not be prevented")
  assert.ok(run1.document.body.querySelector('[data-stp-menu]') === null, 'and not covered by a plugin menu')

  // Blank space inside the sidebar is not a row: never claimed.
  const blank = await rightClickAndSettle(run1.docListeners, run1.tree)
  assert.equal(blank.defaultPrevented, false, 'the sidebar itself must never be claimed')

  // No foreign surface may be written into, whenever it appears.
  const foreign = new El('div')
  foreign.setAttribute('data-menu-material', 'translucent')
  foreign.setAttribute('role', 'menu')
  run1.body.appendChild(foreign)
  await new Promise(r => { setTimeout(r, 120) })
  assert.equal(foreign.querySelector('[data-stp-pin-item]'), null, 'no graft into a surface we do not own')
  console.log('✔ owner disabled on codex: nothing claimed, nothing grafted')
  run1.dispose()
}

// --- The plugin's own menu, where it is still the right answer: a STOCK row
// with no host "…" control to borrow. Everything else about the shared table is
// identical — it simply is not there, and the gesture has a real owner.
{
  const run1 = await run({ withOwner: 'none', pinned: [], official: true })
  const ev = await rightClickAndSettle(run1.docListeners, run1.rows[S1].title)
  assert.equal(ev.defaultPrevented, true, 'with nothing else to open a menu, the plugin owns the row it resolved')
  const own = run1.document.body.querySelector('[data-stp-menu]')
  assert.ok(own !== null, "the plugin's own menu must open")
  assert.match(labelOf(own), /置顶该会话/)
  console.log('✔ stock row with no host menu control: the plugin\'s own pin menu')
  run1.dispose()
}

// --- OWNER HOT-UNLOAD: the table keeps our entries, the owner is gone.
// This is the failure the registry probe can never get right. On dispose the
// owner drops its lease and its listener, but the table is only deleted when it
// holds no entries either — and ours are still in it. A plugin that treats
// `api.list()` containing its own ids as proof the owner is alive therefore
// hands the gesture to nobody: every right-click falls through silently.
{
  const run1 = await run({ withOwner: 'before', pinned: [] })
  assert.equal(run1.owner.api.list().length, 3, 'entries start registered')
  run1.disposeOwner()

  // The entries are still there. That fact must NOT disable our own menu.
  assert.equal(globalThis[KEY] !== undefined, true, "our entries keep the owner's table alive")
  assert.deepEqual(
    run1.owner.api.list().map(entry => entry.id),
    [PIN_ID, UNPIN_ID, COLOR_ID],
    'the table survives its owner',
  )

  const ev = await rightClickAndSettle(run1.docListeners, run1.rows[S1].title)
  assert.equal(
    ev.defaultPrevented, false,
    "entries left in a table must not tempt the plugin into claiming codex's own menu",
  )
  assert.ok(
    run1.document.body.querySelector('[data-stp-menu]') === null,
    "and it must not open its own menu once the owner is gone",
  )
  console.log('✔ owner unloaded with our entries still in its table: the gesture still belongs to codex')
  run1.dispose()
}

// --- OWNER RELOAD: it disposes, then comes back and must find us registered.
{
  const run1 = await run({ withOwner: 'before', pinned: [] })
  run1.disposeOwner()
  const again = applyOwner({ document: run1.document, sessions: null, workspaces: null, ownCalls: [] })
  // `run()` owns the disposer list, so register the reload's cleanup with it.
  run1.dispose()
  void again
  console.log('✔ a reloading owner re-acquires the shared table without a plugin re-register')
}

// --- THE Pinned region: real summary titles, and the real navigation seam
{
  const run1 = await run({ withOwner: 'none', pinned: [S1] })
  const row = run1.document.body.querySelector('[data-stp-row]')
  const title = row.querySelector('[data-stp-row-title]')
  assert.equal(title.textContent, 'first', 'the row must show the session display title, not a raw id')

  // Selection state comes from the official main model only: the pinned session
  // is S1, the retained main session is S2, and neither row may claim to be
  // selected. The stub snapshot carries no `current` field at all.
  assert.equal(
    run1.document.body.querySelectorAll('[data-stp-row][aria-selected="true"]').length,
    0,
    'a selected row may only come from uiWorkspace.mainReference or retainedBy.mainView',
  )

  row.click()
  await new Promise(r => { setTimeout(r, 20) })
  assert.deepEqual(run1.opened, [['uiWorkspace.openSession', S1]], 'the navigation seam is uiWorkspace.openSession(id)')
  assert.deepEqual(run1.retained, [], 'sessions.retain is not navigation and must never be called')
  console.log('✔ pinned rows navigate through uiWorkspace.openSession and never through sessions.retain')
  run1.dispose()
  run1.disposeOwner()
}

// --- LATE SERVICE: uiWorkspace is published only AFTER mount.
// The plugin resolved it once, at mount, and captured `undefined`; the real
// click then did nothing at all. codex-ui re-probes the service on every open
// (lib/client.js openHostSession), and so must this plugin.
{
  const run1 = await run({ withOwner: 'none', pinned: [S1], withUiWorkspace: 'late' })
  const row = run1.document.body.querySelector('[data-stp-row]')
  assert.ok(row !== null, 'region must render before the service exists')

  // Mounted with no uiWorkspace at all: a click must NOT pretend to navigate.
  row.click()
  await new Promise(r => { setTimeout(r, 20) })
  assert.deepEqual(run1.opened, [], 'nothing to navigate through while the service is absent')
  assert.ok(
    run1.document.body.querySelector('[data-stp-alert]') !== null,
    'a click that cannot navigate must SAY so, not fail silently',
  )

  // The host publishes the service afterwards. The next click must work.
  run1.publishUiWorkspace()
  const rowAfter = run1.document.body.querySelector('[data-stp-row]')
  rowAfter.click()
  await new Promise(r => { setTimeout(r, 20) })
  assert.deepEqual(
    run1.opened,
    [['uiWorkspace.openSession', S1]],
    'a service published after mount must be picked up by the very next click',
  )
  console.log('✔ a uiWorkspace service published AFTER mount is still found at click time')
  run1.dispose()
}

// --- NO uiWorkspace at all: a visible failure, never a fabricated fallback.
// `sessions.open` existed only in an older client-runtime; the live
// ClientSessions contract is {ids, byId, phase, projectionsBySession, retain...}.
{
  const run1 = await run({ withOwner: 'none', pinned: [S1], withUiWorkspace: false })
  const row = run1.document.body.querySelector('[data-stp-row]')
  row.click()
  await new Promise(r => { setTimeout(r, 20) })
  assert.deepEqual(run1.opened, [], 'no seam means no navigation — never an invented call')
  assert.deepEqual(run1.retained, [], 'and never the invented retain(id, {source}) call')
  const alert = run1.document.body.querySelector('[data-stp-alert]')
  assert.ok(alert !== null, 'the user must be told the seam is missing')
  assert.equal(alert.getAttribute('role'), 'alert')
  console.log('✔ without uiWorkspace the plugin reports it instead of calling a nonexistent API')
  run1.dispose()
}

// --- UNPIN REFUSAL: the pin RPC rejected, and the user must be able to see it.
{
  const run1 = await run({ withOwner: 'none', pinned: [S1], official: true })
  const own = run1.document.body.querySelector('[data-stp-menu]')
  assert.ok(own === null, 'no menu until the gesture')
  await rightClickAndSettle(run1.docListeners, run1.rows[S1].title)
  const item = run1.document.body.querySelector('[data-stp-pin-item]')
  assert.ok(item !== null, 'the own menu must open on a pinned row')
  assert.match(labelOf(item), /取消置顶/, 'a pinned session offers Unpin from an ordinary host row')
  item.click()
  await new Promise(r => { setTimeout(r, 20) })
  assert.deepEqual(run1.pinCalls, [['unpin', S1]], 'Unpin writes through workspaces.unpinSession')
  assert.equal(run1.document.body.querySelector('[data-stp-alert]'), null, 'a successful unpin reports nothing')
  console.log('✔ a successful unpin writes the official RPC and stays quiet')
  run1.dispose()
}
{
  const run1 = await run({ withOwner: 'none', pinned: [S1] })
  // Make the official RPC refuse, exactly as a host-side validation would.
  const failing = run1.document
  void failing
  const run2 = await run({ withOwner: 'none', pinned: [S1], refuseUnpin: true, official: true })
  await rightClickAndSettle(run2.docListeners, run2.rows[S1].title)
  run2.document.body.querySelector('[data-stp-pin-item]').click()
  await new Promise(r => { setTimeout(r, 20) })
  const alert = run2.document.body.querySelector('[data-stp-alert]')
  assert.ok(alert !== null, 'a REFUSED unpin the user cannot see is indistinguishable from a broken click')
  assert.match(alert.textContent, /Error: unpin refused/, 'the message must name the real error, not "[object Object]"')
  console.log('✔ a refused unpin is surfaced with the error name and message')
  run2.dispose()
}

/**
 * One CSS rule block for `selector`, from the plugin's static stylesheet.
 *
 * Split on the closing brace rather than the newline: the sheet is written with
 * one declaration per line, so a line-based split would only ever yield the
 * selector and assertions about its declarations would silently match nothing.
 * @returns {string} the whole block, or `''` when the selector has no rule.
 */
function cssRuleFor(document, selector) {
  const tag = document.head.querySelector('style[data-stp-sheet="static"]')
  // Comments first: the sheet explains several of its rules in place, and a
  // comment between blocks would otherwise make the block start with prose
  // instead of its selector.
  const text = (tag?.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const block of text.split('}')) {
    if (block.trimStart().startsWith(selector)) return `${block.trim()}}`
  }
  return ''
}

// --- R06: THE ALERT IS ACTUALLY REACHABLE. Node existence is not visibility.
//
// It used to be appended to the menu anchor, which is
// `position:fixed; left:-9999px; top:-9999px; width:0; height:0` AND carried
// `aria-hidden="true"`. The alert had no positioning of its own, so it rendered
// off-screen, and the `aria-hidden` ancestor removed it from the accessibility
// tree. The promised `role="alert"` was neither visible nor announced — the same
// user-visible failure it existed to report.
//
// What is asserted here is the contract in the terms the DOM can be asked
// about: the alert lives in its own on-screen host, nothing above it is hidden
// from assistive technology, and the stylesheet gives it a real box. It is
// deliberately NOT a claim about pixels — geometry needs a real browser, and
// 1015 §R06 keeps that in the isolated-native round.
{
  const run1 = await run({ withOwner: 'none', pinned: [S1], withUiWorkspace: false })
  run1.document.body.querySelector('[data-stp-row]').click()
  await new Promise(r => { setTimeout(r, 20) })

  const alert = run1.document.body.querySelector('[data-stp-alert]')
  assert.ok(alert !== null, 'the refusal is reported at all')
  assert.ok(
    alert.closest('[data-stp-notice]') !== null,
    'the alert has its own host and lives inside it',
  )
  assert.equal(
    alert.closest('[data-stp-anchor]'),
    null,
    'and is never inside the off-screen menu anchor again',
  )
  // Nothing on the way up to <body> may be aria-hidden.
  for (let node = alert; node !== null && node !== run1.document.body; node = node.parentElement) {
    assert.notEqual(
      node.getAttribute('aria-hidden'),
      'true',
      'nothing above the alert hides it from assistive technology',
    )
  }
  assert.notEqual(
    run1.document.body.querySelector('[data-stp-anchor]').getAttribute('aria-hidden'),
    'true',
    'and the menu anchor does not hide the menu it carries either',
  )
  // The static stylesheet is part of the contract: the notice is positioned in
  // the viewport with a size, rather than inheriting the anchor's geometry.
  const noticeRule = cssRuleFor(run1.document, '[data-stp-notice]')
  assert.notEqual(noticeRule, '', 'the notice host has a rule of its own')
  assert.match(noticeRule, /position:\s*fixed/, 'and it is positioned, not in normal flow')
  assert.match(noticeRule, /right:/, 'anchored to the viewport edge')
  assert.ok(
    !/\bwidth:\s*0\b/.test(noticeRule) && !/\bheight:\s*0\b/.test(noticeRule),
    'with a real box — the anchor is 0x0, and inheriting that was the bug',
  )
  assert.notEqual(
    cssRuleFor(run1.document, '[data-stp-alert]'),
    '',
    'and the alert itself is styled rather than left to inherit off-screen geometry',
  )
  console.log('✔ R06: the refusal is announced from an on-screen host with nothing aria-hidden above it')
  run1.dispose()
}

// --- R06: the failures are told apart, and a success is silent.
{
  const missing = await run({ withOwner: 'none', pinned: [S1], withUiWorkspace: false })
  missing.document.body.querySelector('[data-stp-row]').click()
  await new Promise(r => { setTimeout(r, 20) })
  assert.equal(
    missing.document.body.querySelector('[data-stp-alert]').getAttribute('data-stp-alert-reason'),
    'unavailable',
    'a capability this host does not have is UNAVAILABLE',
  )
  missing.dispose()

  const refusing = await run({ withOwner: 'none', pinned: [S1], refuseUnpin: true, official: true })
  await rightClickAndSettle(refusing.docListeners, refusing.rows[S1].title)
  refusing.document.body.querySelector('[data-stp-pin-item]').click()
  await new Promise(r => { setTimeout(r, 20) })
  assert.equal(
    refusing.document.body.querySelector('[data-stp-alert]').getAttribute('data-stp-alert-reason'),
    'refused',
    'a capability that said no is REFUSED',
  )
  refusing.dispose()

  const throwing = await run({ withOwner: 'none', pinned: [S1], throwOnOpen: true })
  throwing.document.body.querySelector('[data-stp-row]').click()
  await new Promise(r => { setTimeout(r, 20) })
  const thrown = throwing.document.body.querySelector('[data-stp-alert]')
  assert.equal(
    thrown.getAttribute('data-stp-alert-reason'),
    'refused',
    'a host seam that throws synchronously is REFUSED, not unavailable',
  )
  assert.match(thrown.textContent, /openSession exploded/, 'and names the real error')
  throwing.dispose()
  console.log('✔ R06: unavailable, refused and a throwing seam are reported as what they are')
}

// --- R06: closing the MENU must not take the notice with it.
//
// `closeMenu` empties the menu anchor. The alert used to live in that anchor,
// so any menu open or dismiss deleted a refusal the user had not finished
// reading — including the dismissal the plugin performs itself immediately
// before showing the next one.
{
  const run1 = await run({ withOwner: 'none', pinned: [S1], withUiWorkspace: false, official: true })
  run1.document.body.querySelector('[data-stp-row]').click()
  await new Promise(r => { setTimeout(r, 20) })
  assert.ok(run1.document.body.querySelector('[data-stp-alert]') !== null, 'a refusal is on screen')

  await rightClickAndSettle(run1.docListeners, run1.rows[S1].title)
  assert.ok(run1.document.body.querySelector('[data-stp-menu]') !== null, 'the menu is open')
  assert.ok(
    run1.document.body.querySelector('[data-stp-alert]') !== null,
    'and the notice shown before it survived the menu opening',
  )
  run1.document.dispatchEvent('keydown', { key: 'Escape' })
  await new Promise(r => { setTimeout(r, 20) })
  assert.ok(
    run1.document.body.querySelector('[data-stp-alert]') !== null,
    'dismissing the menu leaves the notice alone',
  )
  console.log('✔ R06: opening or dismissing the menu no longer clears the notice')
  run1.dispose()
}

// --- R06: a refusal that arrives AFTER dispose must not rebuild anything.
//
// The RPC was already handed to the host and cannot be recalled; what must not
// happen is this generation answering it by creating a fresh host and a fresh
// timer on a page it no longer serves.
{
  const run1 = await run({ withOwner: 'none', pinned: [S1], deferUnpinReject: true, official: true })
  await rightClickAndSettle(run1.docListeners, run1.rows[S1].title)
  run1.document.body.querySelector('[data-stp-pin-item]').click()
  await new Promise(r => { setTimeout(r, 20) })
  assert.equal(
    run1.document.body.querySelector('[data-stp-alert]'),
    null,
    'nothing is reported while the call is still legitimately in flight',
  )

  run1.dispose()
  run1.rejectPendingUnpin()
  await new Promise(r => { setTimeout(r, 40) })
  assert.equal(
    run1.document.body.querySelector('[data-stp-notice]'),
    null,
    'a late rejection does not re-create the notice host',
  )
  assert.equal(
    run1.document.body.querySelector('[data-stp-alert]'),
    null,
    'nor surface anything from a generation that is gone',
  )
  console.log('✔ R06: a refusal delivered after dispose stays silent and leaves no host behind')
}

console.log('\nALL SHARED CONTEXT-MENU CHECKS PASSED')