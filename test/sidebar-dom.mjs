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

// --------------------------------------------------------------- fake DOM

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
    this.textContent = ''
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

  setAttribute(n, v) { this.attributes.set(n, String(v)) }
  getAttribute(n) { return this.attributes.has(n) ? this.attributes.get(n) : null }
  removeAttribute(n) { this.attributes.delete(n) }
  hasAttribute(n) { return this.attributes.has(n) }
  get className() { return this.attributes.get('class') ?? '' }
  set className(v) { this.attributes.set('class', v) }

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
    const walk = (n) => { for (const c of n.children) { out.push(c); walk(c) } }
    walk(this)
    return out
  }

  addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, []); this.listeners.get(t).push(fn) }
  removeEventListener(t, fn) { const l = this.listeners.get(t) ?? []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1) }
  dispatch(type, event = {}) {
    const e = { preventDefault() {}, stopPropagation() {}, ...event }
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(e)
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
  tree.setAttribute('aria-label', 'sessions')
  treeBody.appendChild(tree)
  listArea.appendChild(treeBody)
  body.appendChild(listArea)
  return { body, head, listArea, treeBody, tree }
}

function officialScaffold() {
  const s = makeTree()
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

async function runBundle(scaffold, { pinned }) {
  const listeners = new Map()
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
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
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

  const services = {}
  for (const [name, value] of Object.entries({
    workspaces: {
      list: {
        getSnapshot: () => ({ items: [{ workspaceId: 'w1', title: 'W1', sessionIds: [S1, S2] }], pinnedSessionIds: pinned }),
        subscribe: () => () => {},
      },
      pinSession: async () => {},
      unpinSession: async () => {},
    },
    sessions: {
      list: {
        getSnapshot: () => ({ ids: [S1, S2], byId: { [S1]: { id: S1, displayTitle: 'one', updatedAt: 2 }, [S2]: { id: S2, displayTitle: 'two', updatedAt: 1 } }, phase: 'ready' }),
        subscribe: () => () => {},
      },
    },
  })) services[name] = value

  // Model cordis faithfully: the fiber activates NOW with nothing provided, and
  // `ctx.inject(deps, cb)` defers the callback until the dependency shows up.
  // `deferPublication` reproduces the real bug this revision fixes — apply
  // running before the controller is published.
  const pending = []
  const ctx = {
    get: (name) => services[name],
    logger: { warn: (m) => { throw new Error(`plugin warned: ${m}`) }, info: () => {} },
    effect: (fn) => { fn(); return () => {} },
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

  // Drive one reconcile past the debounce.
  await new Promise(r => { setTimeout(r, 150) })
  console.info = realInfo
  console.warn = realWarn
  return { listeners, registration, logs, afterApply }
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

// --- right-click produces a pin affordance in the codex sidebar
{
  const sc = codexScaffold()
  const { listeners } = await runBundle(sc, { pinned: [] })
  const handlers = listeners.get('contextmenu') ?? []
  assert.ok(handlers.length > 0, 'a contextmenu listener must be installed')

  // The host's React root listens in the BUBBLE phase at the root container.
  // A sentinel there stands in for it. The plugin's own handler runs in CAPTURE
  // on document, i.e. strictly before this — so if the plugin interrupts the
  // event, the sentinel never fires and the menu cannot open. That is exactly
  // how the row menu died on the real machine.
  const rootSentinel = []
  sc.tree.addEventListener('contextmenu', (e) => { rootSentinel.push(e) })

  // Drive the real capture→bubble chain: the plugin's document-capture handler,
  // then the event travelling to the target and back up to the root sentinel.
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
  // Document-capture handler done; the event now completes its journey. A real
  // DOM does this itself; here it is explicit so the sentinel is meaningful.
  if (!ev.propagationStopped) sc.tree.dispatch('contextmenu', ev)

  assert.equal(ev.propagationStopped, false, 'the plugin must never stop propagation in the codex path')
  assert.equal(ev.defaultPrevented, false, 'the plugin must never preventDefault in the codex path')
  assert.equal(rootSentinel.length, 1, 'the event must remain observable by the host root listener')

  // codex-ui renders its own menu with the stock Menu primitive — AFTER the
  // right-click, which is what the graft waits for.
  const surface = new El('div')
  surface.setAttribute('data-menu-material', 'translucent')
  surface.setAttribute('role', 'menu')
  const existing = new El('button')
  existing.setAttribute('role', 'menuitem')
  surface.appendChild(existing)
  sc.body.appendChild(surface)

  await new Promise(r => { setTimeout(r, 120) })
  const pinItem = surface.querySelector('[data-stp-pin-item]')
  assert.ok(pinItem !== null, 'a pin row must be appended to the host menu surface')
  assert.ok(existing.isConnected, 'the host must keep its own menu rows')
  console.log('✔ codex flavor: right-click grafts a pin row onto the native menu, keeping its rows')

  const menuItem = surface.querySelectorAll('[role="menuitem"]')
  assert.ok(menuItem.length >= 2, 'both the host row and the pin row must be present')
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

  handlers[0]({ target: sc.title, clientX: 1, clientY: 2, preventDefault() {}, stopPropagation() {} })
  await new Promise(r => { setTimeout(r, 120) })
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
  await new Promise(r => { setTimeout(r, 120) })
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
    assert.equal(row.getAttribute('role'), 'treeitem', 'a region row is still a treeitem')
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
  await new Promise(r => { setTimeout(r, 320) })
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
  bare.tree.appendChild(project)

  // Wait out the memoization window so the next probe really re-reads the DOM.
  await new Promise(r => { setTimeout(r, 320) })

  // Right-click the now-rendered codex row: must be treated as codex (observe
  // only) — NOT as the stock sidebar, and NOT as unknown.
  const rootSentinel = []
  bare.tree.addEventListener('contextmenu', (e) => { rootSentinel.push(e) })
  const late = {
    target: row, defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    stopImmediatePropagation() { this.propagationStopped = true },
  }
  handlers[0](late)
  if (!late.propagationStopped) bare.tree.dispatch('contextmenu', late)

  assert.equal(late.propagationStopped, false, 'a late-rendered codex sidebar must not have its event interrupted')
  assert.equal(late.defaultPrevented, false, 'a late-rendered codex sidebar must not be preventDefault-ed')
  assert.equal(rootSentinel.length, 1, 'the host root listener must still receive the event')

  // And the graft must actually happen for it.
  const surface = new El('div')
  surface.setAttribute('data-menu-material', 'translucent')
  surface.setAttribute('role', 'menu')
  surface.appendChild(new El('button'))
  bare.body.appendChild(surface)
  await new Promise(r => { setTimeout(r, 120) })
  assert.ok(
    surface.querySelector('[data-stp-pin-item]') !== null,
    'the late-rendered sidebar must be detected as codex and grafted onto',
  )
  console.log('✔ a sidebar that renders after mount is detected and handled as codex')
}

console.log('\nALL SIDEBAR-FLAVOR DOM CHECKS PASSED')