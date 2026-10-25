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

/**
 * The document listeners of the run in progress, so `dispatchEvent` on an
 * element can reach the document's CAPTURE listeners the way it does in a page.
 * Set by `runBundle`, which owns the map it points at.
 */
let activeDocumentListeners = null

/**
 * `MouseEvent`, for the plugin's own re-delivery of a contextmenu.
 *
 * `cancelable` is the load-bearing part: a claim is only observable if
 * `preventDefault()` sets something, and an event that cannot be cancelled
 * cannot be claimed. The pointer travels with it, because the hand-off has to
 * re-open whatever menu the host serves at the pointer the user actually used.
 */
class MouseEvent {
  constructor(type, init = {}) {
    this.type = type
    this.bubbles = init.bubbles === true
    this.cancelable = init.cancelable === true
    this.defaultPrevented = false
    this.clientX = init.clientX ?? 0
    this.clientY = init.clientY ?? 0
    this.button = init.button ?? 0
    this.buttons = init.buttons ?? 0
    this.target = null
    this.currentTarget = null
    this.propagationStopped = false
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true }
  stopPropagation() { this.propagationStopped = true }
}

/** Deliver child changes and attribute history with the observer's requested fields. */
function emitMutation(target, added = [], removed = [], attributeName = null, oldValue = null) {
  const record = attributeName === null
    ? { type: 'childList', target, addedNodes: added, removedNodes: removed }
    : { type: 'attributes', target, attributeName }
  mutationLog.records += 1
  for (const observer of [...observers]) {
    if (attributeName !== null) {
      if (observer.options?.attributes !== true) continue
      if (observer.options.attributeFilter && !observer.options.attributeFilter.includes(attributeName)) continue
    }
    observer.pending.push(attributeName === null ? record : { ...record, oldValue: observer.options.attributeOldValue ? oldValue : null })
    observer.schedule()
  }
}

class FakeMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.pending = []
    this.scheduled = false
  }

  observe(_target, options = {}) { this.options = options; observers.add(this) }
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

/**
 * Sum the `translate()` offsets on an element's ancestor chain, including its
 * own inline style — the browser composes them for every descendant's box.
 * @param {object} el - the fake element.
 * @returns {[number, number]} the accumulated [dx, dy].
 */
function translateChain(el) {
  let dx = 0
  let dy = 0
  for (let node = el; node != null; node = node.parentElement) {
    const raw = node.style?.props?.get?.('transform')
    if (typeof raw !== 'string') continue
    const m = raw.match(/translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/)
    if (m === null) continue
    dx += Number(m[1])
    dy += Number(m[2])
  }
  return [dx, dy]
}

const translateOf = (el) => translateChain(el)[0]
const translateYOf = (el) => translateChain(el)[1]

/** The box a real browser reports for an element it is not rendering. */
const EMPTY_BOX = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }

/**
 * Is `display: none` in force on this element?
 *
 * Two sources, and only the two the anchor hand-off can actually meet:
 *
 *  - an INLINE `display`, which is what the anchor writes on the row and on
 *    `.rowActions` to put the "…" button on screen before it measures it. The
 *    plugin's own pin hide rule lands in a stylesheet this fake does not
 *    evaluate, so the inline half is the one that has to be modelled exactly.
 *  - the host's own `.rowActions { display: none }`, which
 *    `.sessionRow.menuOpen .rowActions` reveals (Rows.module.css:256-269).
 *
 * Without the second one the fake reports a laid-out box for a container the
 * browser has not rendered: `getBoundingClientRect` hands back `ELLIPSIS_BOX`
 * where the page would hand back zeros, so an anchor that never put the button
 * on screen still "measures" a real rect and the offset this whole path exists
 * to prevent goes untested.
 *
 * Ancestors count, because a child of an unrendered box has no box either.
 * @param {object} el - the fake element.
 * @returns {boolean} true when the element renders nothing.
 */
function isDisplayNone(el) {
  for (let node = el; node != null; node = node.parentElement) {
    const inline = node.style?.getPropertyValue?.('display') ?? ''
    if (inline === 'none') return true
    // An inline declaration outranks the stylesheet rule for the same
    // property, `!important` and all. The anchor relies on exactly that: it
    // writes `display: inline-flex !important` on `.rowActions` to put the "…"
    // button on screen BEFORE the host's click has put `menuOpen` on the row.
    if (inline !== '') continue
    const name = typeof node.className === 'string' ? node.className : ''
    if (!name.split(/\s+/).includes('Rows_rowActions__x1y2z')) continue
    // `.sessionRow.menuOpen .rowActions` — the host reveals the strip itself
    // once its menu is open, and that is what keeps it up after the anchor is
    // handed back.
    let revealed = false
    for (let up = node.parentElement; up != null; up = up.parentElement) {
      const upName = typeof up.className === 'string' ? up.className : ''
      if (upName.split(/\s+/).some(one => one.includes('menuOpen'))) { revealed = true; break }
    }
    if (!revealed) return true
  }
  return false
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
      // The priority argument is RECORDED, because the plugin's temporary
      // anchor styles depend on it: an inline `display:block !important` is the
      // only declaration that beats the plugin's own `display:none !important`
      // hide rule in a real browser. A fake that dropped it would make the
      // un-hide look effective in tests and inert on the page.
      priorities: new Map(),
      setProperty: (k, v, priority) => {
        this.style.props.set(k, v)
        if (priority === undefined || priority === '') this.style.priorities.delete(k)
        else this.style.priorities.set(k, priority)
      },
      removeProperty: (k) => { this.style.props.delete(k); this.style.priorities.delete(k) },
      // Read-back is part of the contract the anchor undo depends on: it only
      // restores a property that still carries the value IT wrote.
      getPropertyValue: (k) => this.style.props.get(k) ?? '',
      getPropertyPriority: (k) => this.style.priorities.get(k) ?? '',
    }
    this.sheet = { cssRules: [], deleteRule(i) { this.cssRules.splice(i, 1) }, insertRule(c) { this.cssRules.push(c); return 0 } }
    /**
     * Layout box, for the anchor-positioning cases.
     *
     * A real browser reports the box INCLUDING any `transform` in the inline
     * style, which is exactly what the official menu measures. `transformRect`
     * replays the one transform syntax the plugin uses (`translate(dx, dy)`)
     * so a test can assert the anchor landed on the user's pointer instead of
     * on the hidden group it came from.
     */
    this._rect = { left: 0, top: 0, width: 120, height: 32, right: 120, bottom: 32 }
  }

  /** The transform currently in force, parsed back out of the inline style. */
  transformRect() {
    // Not rendered is not "at 0,0 with a width": a browser reports all zeros,
    // and every measurement the menu anchors on would be taken from that.
    if (isDisplayNone(this)) return { ...EMPTY_BOX }
    // Ancestors count: a real browser reports a descendant's box AFTER every
    // transform on its ancestor chain, which is precisely what the temporary
    // anchor styling relies on (the transform goes on the ROW, the measured
    // anchor is the "…" button inside it).
    const dx = translateOf(this)
    const dy = translateYOf(this)
    const base = this._rect
    if (dx === 0 && dy === 0) return base
    return {
      left: base.left + dx, top: base.top + dy,
      width: base.width, height: base.height,
      right: base.right + dx, bottom: base.bottom + dy,
    }
  }

  getBoundingClientRect() { return this.transformRect() }

  get classList() { return new Set() }
  /** Real DOM nodes expose this; the plugin inserts relative to it. */
  get firstChild() { return this.children[0] ?? null }
  get lastChild() { return this.children[this.children.length - 1] ?? null }
  /** Real DOM: used to place a control directly above the nav it controls. */
  get nextElementSibling() {
    if (this.parentElement === null) return null
    const at = this.parentElement.children.indexOf(this)
    return this.parentElement.children[at + 1] ?? null
  }

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
    const oldValue = this.getAttribute(n)
    this.attributes.set(n, next)
    emitMutation(this, [], [], n, oldValue)
  }
  getAttribute(n) { return this.attributes.has(n) ? this.attributes.get(n) : null }
  removeAttribute(n) {
    if (!this.attributes.has(n)) return
    const oldValue = this.getAttribute(n)
    this.attributes.delete(n)
    emitMutation(this, [], [], n, oldValue)
  }
  hasAttribute(n) { return this.attributes.has(n) }
  get className() { return this.attributes.get('class') ?? '' }
  set className(v) { this.setAttribute('class', v) }

  /**
   * DOM `appendChild`, which is `insertBefore(node, null)` and therefore
   * carries the SPEC's pre-insert MOVE step, like every other insertion: a node
   * that already has a parent is REMOVED from it first.
   *
   * It did not, and `officialUiScaffold` puts `listArea` through it right after
   * `body.insertBefore(root, listArea)`. So `listArea` stayed a child of `body`
   * AND of `root`, `descendants()` walked it twice, and every node inside it was
   * reported twice by `querySelectorAll`. That was invisible while every control
   * lived outside `listArea`; a control placed directly above the directory body
   * does not, and "exactly one control" counted one control as two.
   */
  appendChild(c) { return this.insertBefore(c, null) }

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

  contains(node) {
    for (let up = node; up != null; up = up.parentElement) if (up === this) return true
    return false
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
   *
   * Two additions, both faithful to the platform rather than convenient for the
   * plugin:
   *
   *  - `target` is the node the event was delivered to. A browser always sets
   *    it, and the plugin's own key handling reads it to tell "the row was
   *    activated" from "a control INSIDE the row was".
   *  - `{ bubble: true }` walks the ancestor chain and honours
   *    `stopPropagation()`. It is OPT-IN: every pre-existing case dispatches on
   *    one node and relies on that, so turning it on by default would silently
   *    change what they exercise. Only the cases that need to prove a gesture
   *    on a child never reaches its row ask for it.
   *
   * @returns {object} the event object the listeners saw.
   */
  dispatch(type, event = {}, options = {}) {
    const e = {
      type,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() { this.defaultPrevented = true },
      stopPropagation() { this.propagationStopped = true },
      stopImmediatePropagation() { this.propagationStopped = true },
      ...event,
    }
    if (e.target === undefined || e.target === null) e.target = this
    let node = this
    for (;;) {
      for (const fn of [...(node.listeners.get(type) ?? [])]) {
        try {
          fn(e)
        } catch (error) {
          // "Report exception", then continue with the next listener.
          reportedListenerErrorLog.push({ type, tag: node.tagName, error: String(error) })
        }
      }
      if (options.bubble !== true || e.propagationStopped === true) break
      node = node.parentElement
      if (node === null || node === undefined) break
    }
    return e
  }

  click() { this.dispatch('click') }

  /**
   * `focus()`, counted.
   *
   * The colour dialog claims focus for its own field and hands focus back to
   * whatever opened it; without a focus() to call, both halves of that contract
   * would be unobservable here.
   */
  focus() { this.focusCalls = (this.focusCalls ?? 0) + 1 }

  /**
   * `element.dispatchEvent`, with the order the platform gives it.
   *
   * The DOCUMENT's capture listeners run first, in registration order, and only
   * then this node's own listeners. `stopPropagation()` sets a flag that stops
   * the event moving on to the NEXT node in the path — it does not unregister a
   * listener from the node it fired on (that is `stopImmediatePropagation()`), so
   * a capture loop keeps running after one of its own listeners called it, and
   * what it stops is this node: a target listener is then never invoked.
   *
   * This exists because the plugin's own hand-off (`redispatchContextMenu`) is a
   * real `dispatchEvent` on a real host row. Without it that hand-off could not
   * run at all — `typeof MouseEvent !== 'function'` — so every case that
   * "proved the host serves this gesture" proved only that the hand-off bailed
   * out early and never got the chance to be wrong.
   *
   * @param {object} event - a cancelable event object.
   * @returns {boolean} false when the event was cancelled, as the platform says.
   */
  dispatchEvent(event) {
    if (event.target === undefined || event.target === null) event.target = this
    event.currentTarget = this
    const invoke = (list) => {
      for (const fn of [...list]) {
        try {
          fn(event)
        } catch (error) {
          reportedListenerErrorLog.push({ type: event.type, tag: this.tagName, error: String(error) })
        }
      }
    }
    invoke(activeDocumentListeners?.get(event.type) ?? [])
    if (event.propagationStopped !== true) invoke(this.listeners.get(event.type) ?? [])
    return event.defaultPrevented !== true
  }

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
  // The universal selector. `deepestTextMatch` sweeps `querySelectorAll('*')`
  // and the plugin's own identification depends on it, so a fake that quietly
  // matched NOTHING for `*` made the pinned footer entry look absent in tests
  // while a real browser finds it.
  if (part === '*') return true
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
        // `[class*="panelList"]`. The host's CSS-module class names are hashed
        // but KEEP the readable segment (`IQEYQa_panelList`), so a substring
        // attribute selector is how the panel region and the collapsed rail are
        // identified without inventing a selector the host does not emit.
        if (op === '*=' && !actual.includes(expected)) return false
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
  // The hashed-but-readable class the host really puts on the seat that holds
  // the workspace directories AND their sessions (`WorkspaceBrowser.tsx:669`,
  // `HoverCardGroup className={clsx(css.treeBody, css.wide)}`). It is recorded
  // because it is what the host emits, not because anything selects on it: the
  // directory body is reached from the PROVEN tree, never searched for by name.
  treeBody.className = '_8WIE4q_treeBody _8WIE4q_wide'
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

/**
 * The stock sidebar with the two surfaces the new work actually reads: the
 * panels nav above the session list, and a session row carrying the HOST's own
 * "…" button menu.
 *
 * Shapes are taken from the shipped host, not invented:
 *
 *   - `SidebarRoot.tsx:280` — `<nav class="panelList" aria-label="全局面板">`
 *     holding one `panelRow` button per panel, inside the sidebar ROOT, above
 *     `regionArea`. Class names carry the hashed-but-readable segment the real
 *     build emits (`IQEYQa_panelList`), because that is what
 *     `[class*="panelList"]` has to match.
 *   - `Rows.tsx:667-690` / `ui-workspace/lib/client.js:2328-2350` — the row's
 *     `rowActions` span wrapping `button[aria-label="会话“<title>”的操作"]`
 *     whose click toggles `menuOpen`, and the portalled `[role="menu"]` it
 *     opens.
 *   - `WorkspaceBrowser.tsx:484` — `childRows = group.expanded ? … : []`: a
 *     FOLDED group renders NO session rows. `folded` reproduces that by
 *     unmounting the row when the header is clicked shut, which is the case
 *     the pinned hand-off has to survive.
 *
 * @param {object} [options] - which parts to render.
 * @param {boolean} [options.rail] - the whole sidebar collapsed to its 56px rail.
 * @param {boolean} [options.folded] - start with the group folded (rows unmounted),
 *   and keep unmounting them on every further fold, as the real host does.
 * @param {boolean} [options.hostRowMenu] - give the host row a real "…" button.
 * @param {boolean} [options.panels] - render the panels nav at all.
 * @returns {object} the scaffold, with the interesting nodes hung off it.
 */
/**
 * Where the host row and its "…" button sit before any temporary styling.
 * Deep in the sidebar on purpose: a menu that anchored there instead of on the
 * user's pointer would be several hundred pixels from where the click happened,
 * which is the failure the hand-off has to rule out.
 */
const ROW_BOX = { left: 24, top: 420, width: 232, height: 32, right: 256, bottom: 452 }
const ELLIPSIS_BOX = { left: 232, top: 428, width: 20, height: 16, right: 252, bottom: 444 }

function officialUiScaffold({ rail = false, folded = false, hostRowMenu = true, panels = true, footer = false } = {}) {
  const s = makeTree()
  s.tree.setAttribute('aria-label', 'sessions')
  const root = new El('div')
  root.className = rail ? 'IQEYQa_root IQEYQa_collapsed' : 'IQEYQa_root'
  s.body.insertBefore(root, s.listArea)

  let panelNav = null
  if (panels) {
    panelNav = new El('nav')
    panelNav.className = 'IQEYQa_panelList'
    panelNav.setAttribute('aria-label', '全局面板')
    for (const label of ['插件', '自动化任务', '待办', 'MCP连接器']) {
      const panelRow = new El('button')
      panelRow.type = 'button'
      panelRow.className = 'IQEYQa_panelRow'
      panelRow.textContent = label
      panelNav.appendChild(panelRow)
    }
    root.appendChild(panelNav)
  }
  s.listArea.className = 'IQEYQa_regionArea'
  root.appendChild(s.listArea)

  const footerParts = footer ? attachSidebarFooter(root) : null

  const head = new El('div')
  head.setAttribute('role', 'treeitem')
  head.setAttribute('data-row-key', 'workspace:w1')
  head.setAttribute('aria-expanded', 'true')
  head.onclickCount = 0

  const makeRow = () => {
    const row = new El('div')
    row.className = 'Rows_sessionRow__x1y2z'
    row.setAttribute('role', 'treeitem')
    row.setAttribute('data-row-key', `session:${S1}`)
    row._rect = { ...ROW_BOX }
    const inner = new El('span')
    inner.className = 'Rows_title__x1y2z'
    inner.textContent = 'one'
    row.appendChild(inner)
    if (hostRowMenu) attachHostRowMenu(row, s)
    return row
  }

  // The host commits the fold by re-rendering: expanded renders the children,
  // folded renders none of them. That is the whole reason a pinned row's
  // official row can be MISSING while its group exists.
  head.addEventListener('click', () => {
    head.onclickCount += 1
    const next = head.getAttribute('aria-expanded') === 'true' ? 'false' : 'true'
    head.setAttribute('aria-expanded', next)
    for (const row of [...s.tree.querySelectorAll('[data-row-key^="session:"]')]) {
      if (next === 'true') s.tree.appendChild(row)
      else row.remove()
    }
    if (next === 'true' && s.tree.querySelector(`[data-row-key="session:${S1}"]`) === null) {
      s.tree.appendChild(makeRow())
    }
  })

  s.tree.appendChild(head)
  const row = makeRow()
  s.tree.appendChild(row)
  if (folded) {
    head.setAttribute('aria-expanded', 'false')
    row.remove()
  }
  return {
    ...s,
    root,
    panelNav,
    head,
    row,
    makeRow,
    footerParts,
    /**
     * The session row as it is MOUNTED right now.
     *
     * Not `row`: pinning folds the group, which unmounts it, and re-expanding
     * renders a NEW element with a NEW "…" button — exactly what the real host
     * does, and exactly why a test that kept a handle on the old node would be
     * asserting about a detached one.
     */
    liveRow: () => s.tree.querySelector(`[data-row-key="session:${S1}"]`),
  }
}

/**
 * The user's own opening of the directory, after the plugin's one-time
 * first-sight fold.
 *
 * Every case about a surface that lives INSIDE a workspace group is written
 * past that fold: the plugin closes a directory the first time it sees it, the
 * host unmounts its rows, and the user opens it again — three real steps, in
 * that order. Calling this after `runBundle` performs the third; the first two
 * have already happened for real. A case that skips it is asserting about a row
 * the host no longer renders, which is a different thing entirely.
 *
 * @param {object} sc - an `officialUiScaffold` result.
 */
function openWorkspace(sc) {
  assert.equal(
    sc.head.getAttribute('aria-expanded'), 'false',
    'precondition: the plugin folded this directory on first sight',
  )
  assert.equal(sc.tree.querySelector('[data-row-key^="session:"]'), null, 'precondition: the host unmounted its rows')
  sc.head.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  assert.equal(sc.head.getAttribute('aria-expanded'), 'true', 'the user opened it, and the host remounted its rows')
  return sc
}

/**
 * The sidebar's own footer, at the shape the running app renders it (measured
 * on http://127.0.0.1:3082/ and read back off the live DOM):
 *
 *   footerActions
 *     └ (display:contents wrappers) balance region + the import control
 *   accountRoot
 *     └ span > button[aria-label=账号菜单]
 *
 * The identification the plugin uses is what this scaffolds on purpose: two
 * stable `aria-label`s, their nearest common ancestor, and the deepest element
 * whose own text starts with 已置顶. Nothing here is a hashed class.
 *
 * @param {Element} root - the sidebar root to hang it under.
 * @returns {object} the nodes a case asserts on.
 */
function attachSidebarFooter(root) {
  const actions = new El('div')
  actions.className = 'IQEYQa_footerActions'

  // `display:contents` on the wrappers, because that is what the live page
  // emits: the footer control's own box IS its box, and a wrapper that
  // generated one would let a marker land on a box that is not on screen.
  const balanceWrap = new El('div')
  balanceWrap.className = 'cm-wrap'
  balanceWrap.style.setProperty('display', 'contents')
  const balance = new El('section')
  balance.setAttribute('role', 'region')
  balance.setAttribute('aria-label', '简化侧栏显示')
  balance.className = 'cm-footer-stack simple'
  for (const cls of ['cm-simple-summary', 'cm-foot clickable', 'cm-peak-strip weekend']) {
    const cell = new El('div')
    cell.className = cls
    balance.appendChild(cell)
  }
  balanceWrap.appendChild(balance)

  // The pinned-count entry, carrying the live page's own `aria-label` and the
  // `display:contents` parent it renders inside. The label is what the plugin
  // identifies it by FIRST: on the live page the visible text alone matched
  // nothing, because the text sits on a CHILD of this button.
  const pinnedWrap = new El('div')
  pinnedWrap.style.setProperty('display', 'contents')
  const pinnedEntry = new El('button')
  pinnedEntry.className = '__dsh-session-pin-footer__'
  pinnedEntry.setAttribute('role', 'button')
  pinnedEntry.setAttribute('aria-label', '已置顶的会话')
  pinnedEntry.setAttribute('title', '已置顶的会话')
  const pinnedLabel = new El('span')
  pinnedLabel.textContent = '已置顶 5'
  pinnedEntry.appendChild(pinnedLabel)

  const importWrap = new El('div')
  importWrap.className = 'cm-wrap'
  importWrap.style.setProperty('display', 'contents')
  const importer = new El('button')
  importer.setAttribute('aria-label', '导入会话')
  importer.textContent = '导入会话'
  importWrap.appendChild(importer)

  actions.appendChild(balanceWrap)
  actions.appendChild(pinnedWrap)
  pinnedWrap.appendChild(pinnedEntry)
  actions.appendChild(importWrap)
  root.appendChild(actions)

  const accountRoot = new El('div')
  accountRoot.className = 'hR2WGG_root'
  const accountSpan = new El('span')
  const account = new El('button')
  account.setAttribute('aria-label', '账号菜单')
  account.className = 'hR2WGG_trigger'
  account.textContent = '账号'
  accountSpan.appendChild(account)
  accountRoot.appendChild(accountSpan)
  root.appendChild(accountRoot)

  return {
    actions, balance, balanceWrap, importer, importWrap, pinnedEntry, account, accountRoot,
  }
}

/**
 * The host's own row menu: `rowActions` > `button[aria-label="会话“<title>”的操作"]`,
 * whose click toggles the row's `menuOpen` class and opens a portalled menu
 * carrying the host's own items (置顶/取消置顶、重命名、分叉会话、归档会话、复制
 * Session ID — `sidebar.workspaces.session.menu.item`). Nothing the plugin does
 * may replace, reorder or graft into that surface.
 */
function attachHostRowMenu(row, scaffold) {
  const actions = new El('span')
  actions.className = 'Rows_rowActions__x1y2z'
  // The host measures the anchor WRAPPER, which spans the row's trailing
  // cells. Positioned inside the row's box like the real one.
  actions._rect = { left: 190, top: 424, width: 66, height: 24, right: 256, bottom: 448 }
  const ellipsis = new El('button')
  ellipsis.type = 'button'
  ellipsis.className = 'Rows_iconButton__x1y2z'
  ellipsis.setAttribute('aria-label', '会话“one”的的操作')
  ellipsis._rect = { ...ELLIPSIS_BOX }
  ellipsis.clicks = 0
  let menu = null
  ellipsis.addEventListener('click', () => {
    ellipsis.clicks += 1
    const open = row.className.includes('menuOpen')
    row.className = open
      ? row.className.replace(/\s*\S*menuOpen\S*/g, '').trim()
      : `${row.className} Rows_menuOpen__x1y2z`
    if (open) {
      menu?.remove()
      menu = null
      return
    }
    // The portal list, positioned by the host from the anchor rect. Its
    // geometry is recorded so a test can prove the anchor it measured was the
    // one under the pointer.
    menu = new El('div')
    menu.setAttribute('role', 'menu')
    menu.anchorRect = actions.getBoundingClientRect()
    for (const label of ['置顶', '重命名', '分叉会话', '归档会话', '复制 Session ID']) {
      const item = new El('button')
      item.setAttribute('role', 'menuitem')
      item.textContent = label
      menu.appendChild(item)
    }
    scaffold.body.appendChild(menu)
  })
  actions.appendChild(ellipsis)
  row.appendChild(actions)
  row.hostMenu = () => menu
  row.ellipsis = ellipsis
}

/**
 * codex-ui's own session menu, as `Menu` renders it into a portal — the zh
 * labels behind its `sessions.*` keys (installed codex-ui 1.1.35,
 * lib/client.js:9182-9212). Transcribed because it is what the row's own
 * handler opens, and a case has to be able to tell codex's menu apart from a
 * plugin one rather than only counting nodes.
 */
const CODEX_SESSION_MENU = [
  '重命名会话', '归档会话', '删除会话', '在新会话中继续',
  '在资源管理器中打开', '复制工作目录', '复制会话标题', '复制会话 ID',
]

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

  /**
   * codex-ui's OWN session-row right-click handler (lib/client.js:4617-4626),
   * transcribed: React serves it at the row, so a right-click on the row is
   * claimed synchronously with `preventDefault()` + `stopPropagation()` and the
   * host opens its own session menu at the pointer.
   *
   * It is the thing that makes "codex serves this gesture" an OBSERVATION
   * rather than an assumption about which rows are mounted: `nativeClaims`
   * records that this handler really received the gesture, so a case may prove
   * the plugin stood down for a claim it can also see was made.
   */
  const nativeClaims = []
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    event.stopPropagation()
    nativeClaims.push({ id: S1, x: event.clientX, y: event.clientY })
    s.body.querySelector('.dcu-host-menu')?.remove()
    const menu = new El('div')
    menu.className = 'dcu-host-menu'
    menu.setAttribute('role', 'menu')
    for (const label of CODEX_SESSION_MENU) {
      const item = new El('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.textContent = label
      menu.appendChild(item)
    }
    s.body.appendChild(menu)
  })

  const title = new El('span')
  title.className = 'dcu-wb-session-title'
  row.appendChild(title)
  body2.appendChild(row)
  project.appendChild(head)
  project.appendChild(body2)
  s.tree.appendChild(project)
  return { ...s, project, head, row, title, nativeClaims }
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
/**
 * One origin's Storage, as the browser models it: a single map of key/value,
 * one call log, one refusal mode.
 *
 * Two windows on the same origin share ONE Storage object — that is not a
 * convenience, it is the whole reason a local preference can conflict at all.
 * `newStorageFixture()` twice gives two INDEPENDENT origins (the previous
 * behaviour, where every mount got its own private store); passing ONE fixture
 * to two `runBundle` calls gives two windows on the same origin.
 *
 * `foreignWrites` is kept separate from `writes` on purpose. `writes` is what
 * THIS harness observed a mounted bundle do through `setItem`, and several cases
 * assert on its length to prove a bundle wrote nothing. A write made on behalf
 * of another window (`writeFromOtherWindow`) lands in `foreignWrites` so it
 * cannot be counted as the bundle's own — otherwise "this window wrote nothing
 * in response to a foreign write" could not be asserted at all.
 *
 * @param {object} [options] - the fixture's shape.
 * @param {string} [options.mode] - 'ok' or 'throw' (a browser refusing storage).
 * @param {object} [options.seed] - the keys already present.
 * @returns {{map: Map<string, string>, calls: {reads: string[], writes: [string, string][]}, foreignWrites: [string, string][], mode: string}}
 */
function newStorageFixture({ mode = 'ok', seed = {} } = {}) {
  return {
    map: new Map(Object.entries(seed)),
    calls: { reads: [], writes: [] },
    foreignWrites: [],
    mode,
  }
}

async function runBundle(scaffold, {
  pinned, mutable = false, locale = undefined, items = undefined,
  // 'ok' (default) is a working localStorage; 'throw' is a browser that
  // refuses storage entirely (private mode, disabled site data, quota). The
  // plugin must degrade to its default state and keep working either way.
  storage = 'ok',
  storageSeed = {},
  // Hand this mount an EXISTING origin instead of a private one, so two mounts
  // are two windows on the same origin reading and writing one Storage.
  storageFixture = null,
  // Keep the previous generation mounted rather than retiring it, so a test can
  // hold two live windows at the same time. The test owns both disposes.
  alongside = false,
  // The official slot registry, when this mount is to take part in a slot. It is
  // `undefined` for every other case, which is exactly what `ctx.get('slots')`
  // answers on a host that publishes none.
  slots = undefined,
  // Optional right-column services; the shipped bundle must also work without them.
  rightSidebar = {},
} = {}) {
  // The previous generation goes first, so its bundle can no longer arm
  // anything into the set this run is about to start counting.
  if (!alongside && previousRunDispose !== null) previousRunDispose()
  const listeners = new Map()

  const fixture = storageFixture ?? newStorageFixture({ mode: storage, seed: storageSeed })
  const store = fixture.map
  const storageCalls = fixture.calls
  const fakeStorage = {
    getItem(key) {
      storageCalls.reads.push(key)
      if (fixture.mode === 'throw') throw new Error('storage denied')
      return store.has(key) ? store.get(key) : null
    },
    setItem(key, value) {
      storageCalls.writes.push([key, value])
      if (fixture.mode === 'throw') throw new Error('storage denied')
      store.set(key, String(value))
    },
    removeItem(key) {
      if (fixture.mode === 'throw') throw new Error('storage denied')
      store.delete(key)
    },
  }

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

  /**
   * `window` listeners, RECORDED FOR REAL.
   *
   * This used to be `addEventListener: () => {}`, which made every claim about
   * window-level listeners unfalsifiable: a bundle that registered a `storage`
   * handler and never removed it, or one that ignored the event, produced the
   * same observable nothing. Recording them, and removing them on the real
   * `removeEventListener`, is what lets a case assert both that a delivery
   * happened and that dispose left none behind. `dispatchWindowEvent` below is
   * the delivery half.
   */
  const windowListeners = new Map()
  const addWindowListener = (t, fn) => {
    if (!windowListeners.has(t)) windowListeners.set(t, [])
    windowListeners.get(t).push(fn)
  }
  const removeWindowListener = (t, fn) => {
    const handlers = windowListeners.get(t)
    if (handlers === undefined) return
    const index = handlers.indexOf(fn)
    if (index >= 0) handlers.splice(index, 1)
    if (handlers.length === 0) windowListeners.delete(t)
  }

  globalThis.document = {
    body: scaffold.body,
    head: scaffold.head,
    documentElement: new El('html'),
    createElement: (tag) => new El(tag),
    querySelector: (sel) => scaffold.body.querySelector(sel) ?? scaffold.head.querySelector(sel),
    querySelectorAll: (sel) => [...scaffold.body.querySelectorAll(sel), ...scaffold.head.querySelectorAll(sel)],
    addEventListener: (t, fn) => { if (!listeners.has(t)) listeners.set(t, []); listeners.get(t).push(fn) },
    removeEventListener: (type, fn) => {
      const handlers = listeners.get(type)
      const index = handlers?.indexOf(fn) ?? -1
      if (index >= 0) handlers.splice(index, 1)
      if (handlers?.length === 0) listeners.delete(type)
    },
    dispatchEvent: () => {},
  }
  globalThis.window = {
    addEventListener: addWindowListener,
    removeEventListener: removeWindowListener,
    dispatchEvent: () => false,
  }
  globalThis.localStorage = fakeStorage
  globalThis.MutationObserver = FakeMutationObserver
  globalThis.Element = El
  globalThis.KeyboardEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init) } }
  // The plugin's hand-off needs a real constructor to build its re-delivery with
  // and a real document to deliver it into.
  globalThis.MouseEvent = MouseEvent
  activeDocumentListeners = listeners

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
    slots,
  })) services[name] = value
  Object.assign(services, rightSidebar)

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
  if (!alongside) previousRunDispose = dispose
  return {
    listeners, registration, logs, afterApply, dispose, services, pinCalls, nudge, live,
    opened, panels, liveTimers, store, storageCalls, storageFixture: fixture, windowListeners,
  }
}

/**
 * Deliver one event to the listeners this mount actually registered on `window`.
 *
 * This is the browser half of the cross-window contract: it calls the very
 * functions the bundle passed to `addEventListener`, with the event object it
 * would have been handed. Nothing about the bundle is stubbed, re-implemented
 * or bypassed.
 *
 * @param {object} run - a `runBundle` result.
 * @param {string} type - the event type.
 * @param {object} event - the event to deliver.
 * @returns {number} how many listeners were delivered to.
 */
function dispatchWindowEvent(run, type, event) {
  const handlers = [...(run.windowListeners.get(type) ?? [])]
  for (const fn of handlers) fn(event)
  return handlers.length
}

/**
 * What a write in ANOTHER window on the same origin does to this one: the
 * shared Storage changes, and THIS window alone is told about it.
 *
 * Two properties are modelled rather than assumed, because both are what the
 * browser guarantees and neither is a property of the bundle:
 *
 *   - the writing window is NOT told (no event at the writer), so this cannot
 *     be folded into `setItem` without also faking the plugin's own read-back;
 *   - the event carries the NEW value, and the store already holds it, in that
 *     order — a listener that reads Storage and a listener that trusts
 *     `newValue` must agree.
 *
 * @param {object} run - the window being told.
 * @param {string} key - the storage key the other window wrote.
 * @param {unknown} value - the raw value it wrote.
 * @returns {number} how many listeners were delivered to.
 */
function writeFromOtherWindow(run, key, value) {
  const fixture = run.storageFixture
  const raw = String(value)
  fixture.foreignWrites.push([key, raw])
  fixture.map.set(key, raw)
  return dispatchWindowEvent(run, 'storage', {
    key,
    newValue: raw,
    oldValue: null,
    storageArea: null,
  })
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

// Per-session entry defaults use the right column even when the left sidebar is unknown.
for (const makeScaffold of [officialUiScaffold, codexScaffold, makeTree]) {
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
  const registry = source(false)
  const inventory = source([])
  const states = new Map()
  const calls = []
  let adopted = false
  const state = () => {
    const id = mounted.getSnapshot()
    if (!states.has(id)) states.set(id, { expanded: false, active: { id: 'start', kind: 'guide' } })
    return states.get(id)
  }
  const right = {
    mounted,
    openTabs: inventory,
    isExpanded: () => state().expanded,
    active: () => state().active,
    toggleExpanded() {
      if (!adopted) throw new Error('sidebarRight: no session surface is mounted')
      calls.push(['expand', mounted.getSnapshot()])
      state().expanded = !state().expanded
    },
    openTab(kind, options = {}) {
      if (!adopted) throw new Error('sidebarRight: no session surface is mounted')
      assert.equal(registry.getSnapshot(), true, 'never open an unregistered task page')
      calls.push(['open', mounted.getSnapshot(), kind, options])
      state().expanded = true
      state().active = { id: 'task', kind }
      inventory.set([...inventory.getSnapshot()])
    },
  }
  const sc = makeScaffold()
  const run = await runBundle(sc, {
    pinned: [], mutable: true,
    rightSidebar: {
      sidebarRight: right,
      sidebarRightTabs: {
        get: kind => kind === 'subagent' && registry.getSnapshot() ? { id: 'dsh-better-sidebar:subagent', kind } : undefined,
        subscribe: registry.subscribe,
      },
    },
  })
  assert.equal(calls.length, 0, 'selection before store adoption must not mutate another session')
  adopted = true
  inventory.set([{ sessionId: S1, tabId: 'start', kind: 'guide' }])
  await settle()
  assert.equal(state().expanded, true, 'open the right column before the optional task provider arrives')
  assert.equal(state().active.kind, 'guide')
  registry.set(true)
  await settle()
  assert.equal(state().active.kind, 'subagent', 'late Task Management registration must become the first displayed page')
  assert.deepEqual(calls, [['expand', S1], ['open', S1, 'subagent', { replaceTab: 'start' }]], 'replace only the blank guide')
  state().active = { id: 'file', kind: 'editor' }
  state().expanded = false
  const afterDefault = calls.length
  registry.set(true)
  inventory.set([])
  run.nudge()
  await settle()
  assert.equal(calls.length, afterDefault, 'list, tab and registry pulses must preserve the user choice within the session')
  assert.equal(state().expanded, false)
  assert.equal(state().active.kind, 'editor')
  mounted.set(S2)
  await settle()
  assert.equal(state().expanded, true, 'every newly selected session opens its right column')
  assert.equal(state().active.kind, 'subagent')
  mounted.set(S1)
  await settle()
  assert.equal(state().expanded, true, 'returning to a session reapplies its entry default')
  assert.deepEqual(calls.at(-1), ['open', S1, 'subagent', {}], 'an existing editor must never be replaced or closed')
  mounted.set(undefined)
  registry.set(true)
  inventory.set([])
  await settle()
  const noSessionCalls = calls.length
  assert.equal(noSessionCalls, 4, 'global panels must not write to a retained session')
  mounted.set(S2)
  run.dispose()
  await settle()
  assert.equal(calls.length, noSessionCalls, 'dispose cancels a pending default open')
  assert.equal(mounted.listeners.size, 0)
  assert.equal(registry.listeners.size, 0)
  assert.equal(inventory.listeners.size, 0)
  assert.equal(run.liveTimers().length, 0)
}
console.log('✔ right sidebar: every session enters expanded on Tasks; late adoption/provider, user choice and disposal are covered')

// Runtime indicators must use Host execution, including children of idle parents.
for (const makeScaffold of [officialScaffold, codexScaffold]) {
  const sc = makeScaffold()
  const run = await runBundle(sc, { pinned: [S1], mutable: true })
  run.live.byId[S1] = { ...run.live.byId[S1], running: true }
  run.live.byId[S2] = { ...run.live.byId[S2], running: false }
  run.live.byId.child = { id: 'child', parentId: S2, origin: 'subagent', running: true }
  run.nudge()
  await settle()
  const region = sc.body.querySelector('[data-stp-region]')
  const first = region.querySelector(`[data-stp-session="${S1}"]`)
  const second = region.querySelector(`[data-stp-session="${S2}"]`)
  assert.equal(first.getAttribute('data-stp-runtime'), 'running')
  assert.equal(second?.getAttribute('data-stp-runtime'), 'children', 'an idle parent must float while children execute')
  assert.equal(second.querySelector('[data-stp-runtime-label]').textContent, '子代理运行 1')
  assert.equal(sc.body.querySelector('[data-stp-runtime-summary]').textContent, '运行会话 1 · 子代理 1')
  assert.match(staticCss(sc), /data-stp-runtime='running'[\s\S]*?#22c55e/)
  assert.match(staticCss(sc), /data-stp-runtime='children'[\s\S]*?#eab308/)
  const hidden = sheetRules(sc).join('\n')
  assert.ok(hidden.includes(S2), 'a floated session must not be duplicated in its workspace')
  run.live.byId.child.running = false
  run.live.byId[S1].running = false
  run.nudge()
  await settle()
  assert.equal(first.hasAttribute('data-stp-runtime'), false)
  assert.equal(region.querySelector(`[data-stp-session="${S2}"]`), null)
  assert.equal(sc.body.querySelector('[data-stp-runtime-summary]').textContent, '运行会话 0 · 子代理 0')
  run.dispose()
  assert.equal(sc.body.querySelector('[data-stp-runtime-summary]'), null)
  assert.equal(sc.body.querySelector('[data-stp-runtime-label]'), null)
  console.log('✔ runtime: real execution colors, idle-parent child counts, float-up and cleanup')
}


// Connection notifications must clear stale execution even when the session list is unchanged.
{
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
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1], mutable: true })
  const state = source('connected')
  const generation = source({ id: 1, host: { home: 'fixture' } })
  run.services.connection = { state, generation }
  run.live.byId[S1].running = true
  run.nudge()
  await settle()
  const row = sc.body.querySelector('[data-stp-row]')
  assert.equal(row.getAttribute('data-stp-runtime'), 'running')
  assert.equal(state.listeners.size, 1)
  assert.equal(generation.listeners.size, 1)
  state.set('disconnected')
  await settle()
  assert.equal(row.hasAttribute('data-stp-runtime'), false, 'disconnect clears the cached running flag without a list change')
  assert.equal(sc.body.querySelector('[data-stp-runtime-summary]').textContent, '运行状态暂不可用')
  generation.set(undefined)
  state.set('connected')
  await settle()
  assert.equal(row.hasAttribute('data-stp-runtime'), false, 'connected alone cannot establish a host generation')
  generation.set({ id: 2, host: { home: 'fixture' } })
  await settle()
  assert.equal(row.getAttribute('data-stp-runtime'), 'running', 'generation publication must trigger its own reconcile')
  const replacement = { state: source('disconnected'), generation: source(undefined) }
  run.services.connection = replacement
  run.nudge()
  await settle()
  assert.equal(state.listeners.size, 0)
  assert.equal(generation.listeners.size, 0)
  assert.equal(replacement.state.listeners.size, 1)
  assert.equal(replacement.generation.listeners.size, 1)
  assert.equal(row.hasAttribute('data-stp-runtime'), false, 'replacement connection controls availability')
  run.dispose()
  assert.equal(replacement.state.listeners.size, 0)
  assert.equal(replacement.generation.listeners.size, 0)
  assert.equal(sc.body.querySelector('[data-stp-runtime-summary]'), null)
  console.log('✔ runtime: independent connection signals, replacement and subscription teardown')
}

const absoluteKey = 'dsh-session-top:absolute-pins'
const idsInRegion = sc => [...sc.body.querySelectorAll('[data-stp-row]')].map(row => row.getAttribute('data-stp-session'))
const doubleClick = (run, target) => {
  const event = { target, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} }
  for (const fn of [...(run.listeners.get('dblclick') ?? [])]) fn(event)
}

// Coalesced snapshots must rank by the Host timestamp, never object insertion order.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1, S2], mutable: true })
  run.live.byId[S1] = { ...run.live.byId[S1], running: true, updatedAt: 200 }
  run.live.byId[S2] = { ...run.live.byId[S2], running: true, updatedAt: 100 }
  run.nudge()
  await settle()
  assert.deepEqual(idsInRegion(sc), [S1, S2], 'newer activity wins within one snapshot')
  run.live.byId[S1].updatedAt = 300
  run.live.byId[S2].updatedAt = 250
  run.nudge()
  await settle()
  assert.deepEqual(idsInRegion(sc), [S1, S2], 'coalescing notifications cannot reverse recency')
  const getSnapshot = run.services.sessions.list.getSnapshot
  run.services.sessions.list.getSnapshot = () => ({ ...getSnapshot(), phase: 'error' })
  run.nudge()
  await settle()
  assert.equal(sc.body.querySelector('[data-stp-runtime]'), null, 'unavailable snapshots cannot claim execution')
  assert.equal(sc.body.querySelector('[data-stp-runtime-summary]').textContent, '运行状态暂不可用')
  run.services.sessions.list.getSnapshot = () => ({ ...getSnapshot(), ids: [S2] })
  run.nudge()
  await settle()
  assert.equal(sc.body.querySelector('[data-stp-runtime-summary]').textContent, '运行会话 1 · 子代理 0')
  assert.equal(sc.body.querySelector('[data-stp-session="' + S1 + '"]').hasAttribute('data-stp-runtime'), false, 'retained summaries do not establish execution')
  run.dispose()
  console.log('✔ runtime: batched recency, unavailable snapshots and retained fallback')
}

// Absolute priority remains ahead of later activity, survives remount and syncs across windows.
for (const makeScaffold of [officialScaffold, codexScaffold]) {
  const sc = makeScaffold()
  const run = await runBundle(sc, { pinned: [S1], mutable: true })
  const row = sc.body.querySelector('[data-stp-row]')
  const star = row.querySelector('[data-stp-absolute-button]')
  star.dispatch('click', {}, { bubble: true })
  await settle()
  assert.equal(run.store.get(absoluteKey), JSON.stringify([S1]))
  assert.deepEqual(run.opened, [], 'priority control cannot open the session')
  assert.equal(star.getAttribute('aria-pressed'), 'true')
  run.live.byId[S2].running = true
  run.nudge()
  await settle()
  assert.deepEqual(idsInRegion(sc), [S1, S2], 'new execution stays below the absolute pin')
  row.querySelector('[data-stp-absolute-button]').click()
  await settle()
  assert.deepEqual(idsInRegion(sc), [S2, S1], 'releasing absolute priority restores latest activity order')
  writeFromOtherWindow(run, absoluteKey, JSON.stringify([S1]))
  await settle()
  assert.deepEqual(idsInRegion(sc), [S1, S2], 'foreign priority writes update this window')
  run.dispose()
  assert.equal(sc.body.querySelector('[data-stp-absolute-button]'), null)
  assert.equal(run.listeners.has('dblclick'), false, 'dispose releases the rename listener')
  const restored = makeScaffold()
  const next = await runBundle(restored, { pinned: [S1], storageFixture: run.storageFixture })
  assert.equal(restored.body.querySelector('[data-stp-row]').hasAttribute('data-stp-absolute'), true)
  next.dispose()
  console.log('✔ absolute priority: latest activity, cross-window sync, persistence and cleanup')
}

// An ordinary host row can be made absolute through the official pin API.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [], mutable: true })
  const button = sc.row.querySelector('[data-stp-absolute-button]')
  button.click()
  await settle()
  assert.deepEqual(run.pinCalls, [['pin', S1]])
  assert.deepEqual(idsInRegion(sc), [S1])
  run.live.pinned = []
  run.nudge()
  await settle()
  assert.equal(idsInRegion(sc).length, 0, 'official unpin still removes an absolute pin')
  run.services.workspaces.pinSession = async () => ({ ok: false, error: { message: 'refused' } })
  sc.row.querySelector('[data-stp-absolute-button]').click()
  await settle()
  assert.equal(idsInRegion(sc).length, 0, 'refused official pins cannot become absolute')
  assert.match(sc.body.querySelector('[role="alert"]').textContent, /refused/)
  run.dispose()
}

// Inline rename uses the retained Host session, keeps edits through reorders and releases resources.
for (const makeScaffold of [officialUiScaffold, codexScaffold]) {
  const sc = makeScaffold()
  const run = await runBundle(sc, { pinned: [S2, S1], mutable: true })
  const calls = []
  let releases = 0
  let refused = false
  run.services.sessions.using = async (id, reason, fn) => {
    assert.equal(reason.source, 'controllerOperation')
    try {
      return await fn({ ready: Promise.resolve(), binding: { session: { rename: async title => {
        calls.push([id, title])
        if (refused) return { ok: false, error: { message: 'rename refused' } }
        run.live.byId[id].displayTitle = title
        run.nudge()
        return { ok: true }
      } } } })
    } finally { releases += 1 }
  }
  const row = [...sc.body.querySelectorAll('[data-stp-row]')].find(one => one.getAttribute('data-stp-session') === S1)
  const title = row.querySelector('[data-stp-row-title]')
  doubleClick(run, title)
  let input = row.querySelector('[data-stp-rename-input]')
  assert.ok(input !== null, 'double click opens an inline field')
  input.value = '  中文新名字  '
  input.dispatch('keydown', { key: 'Enter', isComposing: true })
  assert.equal(calls.length, 0, 'IME confirmation cannot submit a rename')
  const region = row.parentElement
  const insertBefore = region.insertBefore
  // Chromium blurs an editor when insertBefore detaches its containing row.
  region.insertBefore = function (node, before) {
    if (node === row && input.parentElement === row) input.dispatch('blur')
    return insertBefore.call(this, node, before)
  }
  const focusCalls = input.focusCalls
  input.selectionStart = 2
  input.selectionEnd = 5
  assert.deepEqual(idsInRegion(sc), [S2, S1])
  run.live.byId[S1].running = true
  run.nudge()
  await settle()
  assert.deepEqual(idsInRegion(sc), [S1, S2], 'activity really changes the edited row position')
  assert.equal(row.querySelector('[data-stp-rename-input]'), input, 'actual reorder preserves the editor')
  assert.equal(input.value, '  中文新名字  ', 'actual reorder preserves the draft')
  assert.equal(input.focusCalls, focusCalls, 'reordering keeps focus without restarting composition')
  assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 5])
  region.insertBefore = insertBefore
  input.dispatch('keydown', { key: 'Enter' }, { bubble: true })
  await settle()
  assert.deepEqual(calls, [[S1, '中文新名字']])
  assert.equal(releases, 1)
  assert.equal(row.querySelector('[data-stp-rename-input]'), null)
  assert.equal(title.textContent, '中文新名字')
  assert.deepEqual(run.opened, [])
  doubleClick(run, title)
  input = row.querySelector('[data-stp-rename-input]')
  input.value = '   '
  input.dispatch('keydown', { key: 'Enter' })
  assert.equal(calls.length, 1)
  assert.equal(input.getAttribute('aria-invalid'), 'true')
  input.dispatch('keydown', { key: 'Escape' })
  assert.equal(row.querySelector('[data-stp-rename-input]'), null)
  doubleClick(run, title)
  input = row.querySelector('[data-stp-rename-input]')
  refused = true
  input.value = '拒绝的名字'
  input.dispatch('keydown', { key: 'Enter' })
  await settle()
  assert.equal(row.querySelector('[data-stp-rename-input]'), input, 'failure keeps the draft')
  assert.equal(input.disabled, false)
  assert.equal(title.textContent, '中文新名字', 'refusal never paints a successful rename')
  assert.equal(releases, 2)
  input.dispatch('keydown', { key: 'Escape' })
  run.dispose()
  console.log('✔ inline rename: Chinese input, Enter/Escape, refusal, stable draft and release')
}

// A temporary active row stays editable after execution ends, then leaves on save or cancel.
for (const makeScaffold of [officialUiScaffold, codexScaffold]) {
  for (const finish of ['save', 'escape', 'blur']) {
    const sc = makeScaffold()
    const run = await runBundle(sc, { pinned: [], mutable: true })
    const calls = []
    run.services.sessions.using = async (id, reason, fn) => fn({
      ready: Promise.resolve(),
      binding: { session: { rename: async title => {
        calls.push([id, title])
        run.live.byId[id].displayTitle = title
        run.nudge()
        return { ok: true }
      } } },
    })
    run.live.byId[S1].running = finish !== 'escape'
    if (finish === 'escape') {
      run.live.byId.child = { id: 'child', parentId: S1, origin: 'subagent', running: true }
    }
    run.nudge()
    await settle()
    const row = sc.body.querySelector('[data-stp-row]')
    const title = row.querySelector('[data-stp-row-title]')
    doubleClick(run, title)
    const input = row.querySelector('[data-stp-rename-input]')
    input.value = '  执行结束后仍能改名  '
    run.live.byId[S1].running = false
    if (run.live.byId.child) run.live.byId.child.running = false
    run.nudge()
    await settle()
    assert.deepEqual(idsInRegion(sc), [S1], 'execution ending cannot retire the edited temporary row')
    assert.equal(row.querySelector('[data-stp-rename-input]'), input)
    assert.equal(input.value, '  执行结束后仍能改名  ')
    assert.equal(row.hasAttribute('data-stp-runtime'), false, 'an edited idle row has no running color')
    assert.equal(sc.body.querySelector('[data-stp-runtime-summary]').textContent, '运行会话 0 · 子代理 0')
    if (finish === 'blur') input.dispatch('blur')
    else input.dispatch('keydown', { key: finish === 'save' ? 'Enter' : 'Escape' })
    await settle()
    assert.deepEqual(calls, finish === 'save' ? [[S1, '执行结束后仍能改名']] : [])
    assert.deepEqual(idsInRegion(sc), [], 'closing the editor releases an ended temporary row')
    assert.equal(input.parentElement, null)
    assert.equal(sheetRules(sc).some(rule => rule.includes(S1)), false, 'closing the editor restores the workspace row')
    assert.deepEqual(run.pinCalls, [], 'retaining a draft never pins the session')
    assert.deepEqual(run.opened, [])
    run.dispose()
  }
  console.log('✔ inline rename: ended temporary rows stay editable until save, Escape or blur')
}

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
  // The dynamic sheet is three optional halves joined with '\n', and the last
  // owner must blank it to EXACTLY the empty string — a teardown that leaves a
  // stray newline behind would show up as a live-looking sheet, and the string
  // comparison in the disposal cases would still call it equal to `''` only by
  // accident. `filter(Boolean)` on the source side is what keeps the join free
  // of empty halves, and this reads the RAW text: `sheetRules` filters empty
  // lines out before the test ever sees them, so it cannot see this at all.
  const rawCss = sc.head.querySelector('style[data-stp-sheet="dynamic"]')?.textContent ?? ''
  assert.equal(
    /\n\s*\n|^\n|\n$/.test(rawCss), false,
    `the dynamic sheet must carry no blank line; got ${JSON.stringify(rawCss)}`,
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

// --- right-click on a codex row. codex-ui SERVES ITS OWN session menu on
// right-click, with its own actions in it, so the gesture is not this plugin's
// to claim: preventing it, or opening a plugin menu over it, would cost the user
// the host's menu and gain them exactly one entry. Pin on this rendering comes
// from the shared menu owner (@baihejiangnan/dsh-session-context-menu), which
// renders into the menu codex already opens.
//
// What must still hold: the plugin never goes looking for someone else's menu
// surface to graft into, and it never stops a listener downstream from seeing
// the event.
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
  assert.equal(
    ev.defaultPrevented, false,
    "codex's own session menu must be neither prevented nor covered",
  )
  assert.equal(
    sc.body.querySelector('[data-stp-menu]'), null,
    'and no plugin menu may open on top of it',
  )
  assert.equal(rootSentinel.length, 0, 'the event must not also reach a host listener')
  console.log('✔ codex flavor: the native session menu and its actions are left alone')

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
}

// --- The plugin's own menu, where it is still the right answer: an OFFICIAL
// row that carries no host "…" control to borrow. Its single action must write
// through the official pin RPC, not through anything of its own.
{
  const sc = officialUiScaffold({ hostRowMenu: false })
  const { listeners, pinCalls } = await runBundle(sc, { pinned: [] })
  const handlers = listeners.get('contextmenu') ?? []
  handlers[0]({
    target: sc.row,
    clientX: 100,
    clientY: 200,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() {},
  })
  await afterDispatch()
  const own = sc.body.querySelector('[data-stp-menu]')
  assert.ok(own !== null, 'a row with no host menu control still gets the pin fallback')
  const item = own.querySelector('[data-stp-pin-item]')
  assert.ok(item !== null, 'the fallback must offer the pin action')
  assert.match(item.textContent, /置顶该会话/, 'an unpinned session offers Pin')
  item.click()
  await new Promise(r => { harnessSetTimeout(r, 20) })
  assert.deepEqual(pinCalls, [['pin', S1]], 'the pin must go through workspaces.pinSession')
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

  // Right-click the now-rendered codex row. Its menu is codex's own, so the
  // gesture stays the host's — and still nothing of anyone else's menu surface
  // may be touched.
  const late = {
    target: row, defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.propagationStopped = true },
    stopImmediatePropagation() { this.propagationStopped = true },
  }
  handlers[0](late)
  await afterDispatch()
  assert.equal(
    late.defaultPrevented, false,
    "a late-rendered codex row's native menu is the host's, not the plugin's to replace",
  )
  assert.equal(
    bare.body.querySelector('[data-stp-menu]'), null,
    'and no plugin menu may appear on top of it',
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

/**
 * Wait until `ready()` holds, or fail loudly when it does not.
 *
 * A fixed `setTimeout(40)` after an async action is a GUESS at how long the
 * round-trip takes, and a guess is a flake: it passes on a quiet machine and
 * fails on a busy one with an unrelated-looking error. Polling for the actual
 * state keeps the assertion identical and removes the timing assumption; the
 * deadline is generous and its failure message says what was still missing.
 *
 * @param {() => boolean} ready - the condition to wait for.
 * @param {string} what - named in the failure message.
 * @param {number} deadlineMs - how long to keep trying.
 */
async function waitUntil(ready, what, deadlineMs = 1000) {
  const step = 10
  for (let waited = 0; waited <= deadlineMs; waited += step) {
    if (ready() === true) return
    await settle(step)
  }
  assert.ok(ready() === true, `timed out after ${deadlineMs}ms waiting for ${what}`)
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

// Opening a top row must not leave its project expanded by host navigation.
for (const makeScaffold of [officialUiScaffold, codexScaffold]) {
  const sc = makeScaffold()
  const run = await runBundle(sc, { pinned: [S1], mutable: true })
  const header = sc.tree.querySelector('[aria-expanded]')
  assert.equal(header.getAttribute('aria-expanded'), 'false')
  const navigate = run.services.uiWorkspace.openSession
  run.services.uiWorkspace.openSession = id => {
    navigate(id)
    // Both host sidebars reveal the newly selected session's workspace.
    header.setAttribute('aria-expanded', 'true')
    run.nudge()
  }
  sc.body.querySelector('[data-stp-row]').click()
  await settle()
  assert.deepEqual(run.opened, [S1])
  assert.equal(header.getAttribute('aria-expanded'), 'false', 'top-row navigation must keep the project closed')
  run.dispose()
}
console.log('✔ top-row navigation preserves closed projects on both sidebar flavors')

// Removing the final pin must not expand the project behind the top region.
{
  const sc = foldScaffold()
  const head = sc.makeGroup('wA', false)
  const run = await runBundle(sc, { pinned: [S1], items: TWO_GROUPS })
  run.live.pinned = []
  run.nudge()
  await settle()
  assert.equal(head.getAttribute('aria-expanded'), 'false', 'unpin must preserve the collapsed project')
  assert.equal(head.clicks, 0, 'unpin must not send an expansion click')
  run.dispose()
}

// Codex reveals section, collection and project together on selection.
{
  const sc = codexScaffold()
  const section = new El('section')
  section.className = 'dcu-wb-section'
  const sectionHead = new El('div')
  sectionHead.className = 'dcu-wb-section-head'
  const sectionLabel = new El('button')
  sectionLabel.className = 'dcu-wb-section-label'
  sectionLabel.setAttribute('aria-expanded', 'true')
  const collections = new El('div')
  collections.className = 'dcu-wb-collections'
  const collection = new El('div')
  collection.className = 'dcu-wb-collection'
  const collectionHead = new El('div')
  collectionHead.className = 'dcu-wb-collection-head'
  const collectionLabel = new El('button')
  collectionLabel.className = 'dcu-wb-collection-label'
  collectionLabel.setAttribute('aria-expanded', 'true')
  const title = new El('span')
  title.className = 'dcu-wb-collection-title'
  title.textContent = 'Local projects'
  collectionLabel.appendChild(title)
  for (const label of [sectionLabel, collectionLabel]) {
    label.addEventListener('click', () => label.setAttribute('aria-expanded', label.getAttribute('aria-expanded') === 'true' ? 'false' : 'true'))
  }
  sectionHead.appendChild(sectionLabel)
  section.appendChild(sectionHead)
  section.appendChild(collections)
  collections.appendChild(collection)
  collectionHead.appendChild(collectionLabel)
  collection.appendChild(collectionHead)
  collection.appendChild(sc.project)
  sc.tree.appendChild(section)
  const run = await runBundle(sc, { pinned: [S1] })
  for (const label of [sectionLabel, collectionLabel, sc.head]) {
    assert.equal(label.getAttribute('aria-expanded'), 'false', 'every codex disclosure starts folded')
  }
  sectionLabel.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  collectionLabel.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
  assert.equal(sectionLabel.getAttribute('aria-expanded'), 'true', 'native button click is a manual expansion')
  assert.equal(collectionLabel.getAttribute('aria-expanded'), 'true')
  assert.equal(sc.head.getAttribute('aria-expanded'), 'false', 'opening an ancestor does not open its projects')
  sectionLabel.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  collectionLabel.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await settle()
  for (const label of [sectionLabel, collectionLabel, sc.head]) label.setAttribute('aria-expanded', 'true')
  await settle()
  for (const label of [sectionLabel, collectionLabel, sc.head]) {
    assert.equal(label.getAttribute('aria-expanded'), 'false', 'host reveal cannot override a manual collapse')
  }
  run.dispose()
}

// Keyboard disclosure belongs to the project header; its child actions are not toggles.
{
  const sc = codexScaffold()
  sc.head.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      sc.head.setAttribute('aria-expanded', sc.head.getAttribute('aria-expanded') === 'true' ? 'false' : 'true')
    }
  })
  const run = await runBundle(sc, { pinned: [S1] })
  for (const key of ['Enter', ' ']) {
    sc.head.dispatchEvent(new KeyboardEvent('keydown', { key }))
    await settle()
    assert.equal(sc.head.getAttribute('aria-expanded'), 'true', key + ': project keyboard activation grants manual expansion')
    sc.head.dispatchEvent(new KeyboardEvent('keydown', { key }))
    await settle()
    sc.head.setAttribute('aria-expanded', 'true')
    await settle()
    assert.equal(sc.head.getAttribute('aria-expanded'), 'false', key + ': host reveal cannot undo a keyboard collapse')
  }
  for (const [tag, className] of [['button', 'dcu-wb-new'], ['span', 'dcu-wb-folder'], ['button', 'dcu-wb-more']]) {
    const action = new El(tag)
    action.className = className
    action.addEventListener('click', () => sc.head.setAttribute('aria-expanded', 'true'))
    sc.head.appendChild(action)
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    assert.equal(sc.head.getAttribute('aria-expanded'), 'false', className + ': a child action grants no disclosure permission')
    action.remove()
  }
  run.dispose()
  console.log('✔ project disclosure: Enter/Space preserve user choice; child actions cannot enable host reveals')
}

// Collection identity must survive count changes and renames on the same host root.
// The real Ungrouped label has no collection-title class; its full text includes count.
const disclosureFailures = []
for (const kind of ['ungrouped-count', 'named-rename']) {
  const sc = codexScaffold()
  const collection = new El('div')
  collection.className = kind === 'ungrouped-count' ? 'dcu-wb-ungrouped' : 'dcu-wb-collection'
  const head = new El('div')
  head.className = 'dcu-wb-collection-head'
  const label = new El('button')
  label.className = 'dcu-wb-collection-label'
  label.setAttribute('aria-expanded', 'true')
  const title = new El('span')
  if (kind === 'named-rename') title.className = 'dcu-wb-collection-title'
  title.textContent = kind === 'ungrouped-count' ? 'Ungrouped' : 'Local projects'
  const count = new El('span')
  count.className = 'dcu-wb-collection-count'
  count.textContent = '1'
  label.appendChild(title)
  label.appendChild(count)
  Object.defineProperty(label, 'textContent', { get: () => label.children.map(child => child.textContent).join('') })
  let clicks = 0
  label.addEventListener('click', () => {
    clicks += 1
    label.setAttribute('aria-expanded', label.getAttribute('aria-expanded') === 'true' ? 'false' : 'true')
  })
  head.appendChild(label)
  collection.appendChild(head)
  collection.appendChild(sc.project)
  sc.tree.appendChild(collection)
  const run = await runBundle(sc, { pinned: [S1] })
  try {
    assert.equal(label.getAttribute('aria-expanded'), 'false')
    label.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    assert.equal(label.getAttribute('aria-expanded'), 'true')
    const afterManual = clicks
    if (kind === 'ungrouped-count') {
      count.textContent = '2'
      run.live.items = [...run.live.items, { workspaceId: 'w2', title: 'Another project', sessionIds: [] }]
    } else title.textContent = 'Renamed projects'
    run.nudge()
    await settle()
    assert.equal(label.getAttribute('aria-expanded'), 'true', kind + ': display changes must preserve manual expansion')
    assert.equal(clicks, afterManual, kind + ': no corrective click after a display change')
    if (kind === 'named-rename') {
      const another = new El('div')
      another.className = 'dcu-wb-collection'
      const anotherLabel = new El('button')
      anotherLabel.className = 'dcu-wb-collection-label'
      anotherLabel.setAttribute('aria-expanded', 'false')
      const reusedTitle = new El('span')
      reusedTitle.className = 'dcu-wb-collection-title'
      reusedTitle.textContent = 'Local projects'
      anotherLabel.appendChild(reusedTitle)
      another.appendChild(anotherLabel)
      sc.tree.appendChild(another)
      run.nudge()
      await settle()
      assert.equal(label.getAttribute('aria-expanded'), 'true', 'reusing a previous group name must preserve the renamed group')
      assert.equal(clicks, afterManual, 'reused names must not trigger another fold')
    }
  } catch (error) {
    disclosureFailures.push(kind + ': ' + error.message.split('\n')[0])
  } finally { run.dispose() }
}

// A completed fold followed by a host reveal is a NEW request, even before debounce.
for (const kind of ['same-batch', 'async-before-confirm']) {
  const sc = foldScaffold()
  sc.makeGroup('wA', false)
  const run = await runBundle(sc, { pinned: [S1], items: TWO_GROUPS })
  const header = sc.makeGroup('wB', true, 'late:30')
  header.addEventListener('click', () => {
    if (header.clicks !== 1) return
    harnessSetTimeout(() => {
      if (kind === 'same-batch') header.setAttribute('aria-expanded', 'false')
      header.setAttribute('aria-expanded', 'true')
      run.nudge()
    }, kind === 'same-batch' ? 30 : 40)
  })
  try {
    run.nudge()
    await settle(350)
    assert.equal(header.getAttribute('aria-expanded'), 'false', kind + ': a confirmed fold cannot hide the next host reveal')
    assert.equal(header.clicks, 2, kind + ': exactly one close for each distinct expansion')
  } catch (error) {
    disclosureFailures.push(kind + ': ' + error.message.split('\n')[0])
  } finally { run.dispose() }
}
assert.deepEqual(disclosureFailures, [], 'disclosure state regressions: ' + disclosureFailures.join(' | '))
console.log('✔ disclosure history: count/rename preserves user choice; rapid host reveals get a fresh close')

// --- S3: a group that is ALREADY closed costs nothing — on first sight, on
// later notifications, and again after the plugin is torn down and re-applied
// (the "service reload" shape).
//
// This used to read "a group seen for the first time with NO pin is left
// exactly as the user has it". The one-time default fold has since claimed the
// first sighting of every foldable directory (S3b), so what survives it is the
// narrower invariant that still carries the weight, and it is the same defect
// the old case was written for: a group already in the state the plugin wants
// must cost ZERO clicks, and no notification may change that. A group the USER
// opened after that initialization is S3b's second half.
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
    assert.equal(sc.heads.get(key).clicks, 0, `${key} must not be clicked when it is already closed`)
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
  console.log('✔ R07/S3: an already-closed group is never clicked — not on first sight, not on churn, not after a reload')
}

// --- S3b: THE FIRST-SIGHT DEFAULT FOLD. A foldable directory the plugin has
// never seen is closed ONCE — pin or no pin — and from then on that group's
// expansion is the user's alone.
//
// Two rules make it survivable, and both are about which question the pass is
// asking:
//
//  1. THE TARGET STAYS "CLOSED" UNTIL THE USER ACTIVATES THE HEADER — whatever
//     the pin set says. A state that flipped to "expand" when the default click
//     was issued would wait for the fold to land and immediately open it again.
//     Removing the last pin grants no expansion permission either.
//  2. AFTERWARDS, A GROUP THE USER OPENS IS BOOKED AS REACHED. Otherwise every
//     idle pass, title change, reorder and unrelated pin is a reason to close
//     the group again — the `GROUP_ZERO_PINS_INITIAL` defect, still fatal under
//     the new default.
{
  const sc = foldScaffold()
  const a = sc.makeGroup('wA', true)
  const b = sc.makeGroup('wB', true)
  // Disjoint members, so a pin on one group cannot be mistaken for a pin on
  // the other.
  const run = await runBundle(sc, {
    pinned: [],
    items: [
      { workspaceId: 'wA', title: 'A', sessionIds: [S1] },
      { workspaceId: 'wB', title: 'B', sessionIds: [S2] },
    ],
  })
  await settle()
  for (const [key, head] of [['wA', a], ['wB', b]]) {
    assert.equal(
      head.getAttribute('aria-expanded'),
      'false',
      `${key} holds no pin and must still be closed the first time it is seen`,
    )
    assert.equal(head.clicks, 1, `${key} takes exactly one click to get there`)
  }
  run.nudge()
  run.nudge()
  await settle()
  assert.equal(a.clicks + b.clicks, 2, 'a closed group is never clicked again')

  // The user opens one by hand. From here nothing may close it again.
  a.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  const clicksAfterOpen = a.clicks
  run.live.byId = { ...run.live.byId, [S2]: { id: S2, displayTitle: 'two (renamed)', updatedAt: 9 } }
  run.live.items = [
    { workspaceId: 'wA', title: 'A', sessionIds: [S1] },
    { workspaceId: 'wB', title: 'B', sessionIds: [S2] },
  ]
  // A pin that belongs to the OTHER group entirely, and its removal.
  run.live.pinned = [S2]
  for (let i = 0; i < 3; i += 1) { run.nudge(); await settle() }
  run.live.pinned = []
  for (let i = 0; i < 3; i += 1) { run.nudge(); await settle() }
  assert.equal(a.clicks, clicksAfterOpen, 'no idle pass, title, reorder or foreign pin may re-close it')
  assert.equal(a.getAttribute('aria-expanded'), 'true', 'and it must stay exactly as the user left it')
  // Pin changes cannot expand a directory that was never opened by hand.
  assert.equal(b.getAttribute('aria-expanded'), 'false', 'losing its last pin leaves that group folded')
  run.dispose()
  console.log("✔ R07/S3b: a directory is closed once on first sight, and the user's own opening survives every later change")
}

// --- S3c: a DIRECTORY THAT RENDERS LATE is a first sighting like any other.
// Nothing is booked while its header is missing, so it is still closed when the
// header finally appears.
{
  const sc = foldScaffold()
  sc.makeGroup('wA', false) // present: this is what proves the sidebar
  const run = await runBundle(sc, { pinned: [], items: TWO_GROUPS })
  await settle()
  assert.equal(
    sc.tree.querySelectorAll('[data-row-key="workspace:wB"]').length,
    0,
    'the second directory has not rendered its header yet',
  )
  const late = sc.makeGroup('wB', true)
  run.nudge()
  await settle()
  assert.equal(
    late.getAttribute('aria-expanded'),
    'false',
    'a directory that arrives late is closed on first sight too',
  )
  assert.equal(late.clicks, 1, 'and it takes exactly one click')
  run.dispose()
  console.log('✔ R07/S3c: a directory that renders late is still closed on first sight')
}

// --- S3d: the default fold on a host that commits on ITS OWN schedule.
//
// Rule 1 above is only observable against a host that takes time: the default
// fold is issued, and every later pass must still be asking for "closed". A
// target that flipped to "expand" while the click was in flight would land the
// fold and open the group right behind it — the reading moved, the request was
// spent, and a second click would follow.
const defaultFoldTags = []
for (const [delayMs, notifications] of [[250, 0], [250, 1], [1000, 2]]) {
  const sc = foldScaffold()
  const a = sc.makeGroup('wA', true, `late:${delayMs}`)
  const run = await runBundle(sc, { pinned: [], items: TWO_GROUPS })
  const tag = `first-sight fold, host applies after ${delayMs}ms / ${notifications} notification(s)`
  await settle(120)
  assert.equal(a.clicks, 1, `${tag}: one click is issued`)
  for (let i = 0; i < notifications; i += 1) {
    run.nudge()
    await settle(Math.max(90, Math.floor(delayMs / 5)))
  }
  await settle(delayMs + 400)
  assert.equal(a.getAttribute('aria-expanded'), 'false', `${tag}: and it must not be opened again behind it`)
  assert.equal(a.transitions, 1, `${tag}: toggled exactly once`)
  assert.equal(a.clicks, 1, `${tag}: the intent stays the same one while the click is in flight`)
  defaultFoldTags.push(`${delayMs}ms/${notifications}`)
  run.dispose()
}
console.log(`✔ R07/S3d: the first-sight fold is never followed by the pin rule opening the group back (${defaultFoldTags.join(', ')})`)


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
  a.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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

// --- S5g: unpinning while the default fold is pending cannot reopen it.
// The same single intent survives pin churn and waits for its read-back.
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
  assert.equal(sc.clicks('wB'), 1, 'unpinning keeps the same pending fold')

  await settle(1200)
  assert.equal(
    sc.expanded('wB'),
    false,
    'the group must stay folded after its last pin is removed',
  )
  assert.equal(
    sc.transitions('wB'),
    1,
    'only the default fold lands; unpinning must not reopen it',
  )
  assert.equal(sc.clicks('wB'), 1, 'exactly one fold click despite pin churn')
  run.dispose()
  console.log('✔ R07/S5g: unpinning during a delayed fold never reopens the group')
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

// --- Pinning and unpinning never change a manually selected disclosure state.
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
  assert.equal(a.getAttribute('aria-expanded'), 'false', 'unpinning leaves the group folded')
  assert.equal(a.clicks, 0)
  assert.equal(a.transitions, 0)
  a.dispatchEvent(new MouseEvent('click', { bubbles: true }))

  run.live.pinned = [S1]
  run.nudge()
  await settle()
  assert.equal(a.getAttribute('aria-expanded'), 'true', 'pinning preserves the user opening')
  assert.equal(a.clicks, 1)
  assert.equal(a.transitions, 1)
  run.dispose()
  console.log('✔ R07: pinning and unpinning preserve the user disclosure without extra clicks')
}

// =====================================================================
// REQUIREMENT 1 — the global-panels region ("插件 / 自动化任务 / 待卡 / MCP连接器")
// starts folded, with a compact keyboard-reachable control, a remembered user
// choice, and no residue.
//
// The host has no preference of its own for this region (SidebarRoot.tsx:279-293
// renders `<nav class="panelList">` unconditionally), so "default folded" and
// "remember the user's choice" are this plugin's to implement — and to give back.
// =====================================================================

/** The control the plugin mounts above the panels nav. */
const panelsToggle = (sc) => sc.root.querySelector('[data-stp-panels-toggle]')

// --- 1a: default folded, keyboard reachable, correctly wired to the nav.
{
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [] })
  const nav = sc.panelNav
  const toggle = panelsToggle(sc)
  assert.ok(toggle !== null, 'a compact control for the panels region must be mounted')
  assert.equal(toggle.tagName, 'BUTTON', 'it must be a real button, so the keyboard reaches it')
  assert.equal(toggle.getAttribute('type'), 'button')
  assert.ok((toggle.getAttribute('aria-label') ?? '').length > 0, 'the control must name itself')
  assert.equal(nav.getAttribute('data-stp-panels'), 'collapsed', 'no stored choice means folded')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false')
  const controls = toggle.getAttribute('aria-controls')
  assert.ok(controls, 'aria-controls must point at the region it controls')
  assert.equal(nav.getAttribute('id'), controls, 'aria-controls must name the nav itself')
  assert.ok(
    sheetRules(sc).some(rule => rule.includes('data-stp-panels') && rule.includes('display:none')),
    `the fold must be a stylesheet rule from this plugin; got ${JSON.stringify(sheetRules(sc))}`,
  )
  assert.ok(staticCss(sc).includes('stp-panels-toggle'), 'the control must be styled, not bare')
  run.dispose()
  console.log('✔ panels: default folded, with a keyboard-reachable aria-wired control')
}

// --- 1b: the user's explicit choice wins, survives a reconcile, and is stored.
{
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [] })
  const toggle = panelsToggle(sc)
  toggle.click()
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'the click must expand the region')
  assert.equal(sc.panelNav.getAttribute('data-stp-panels'), 'expanded')
  assert.ok(
    !sheetRules(sc).some(rule => rule.includes('data-stp-panels') && rule.includes('display:none')),
    'expanded means no hide rule',
  )
  assert.ok(run.storageCalls.writes.length > 0, 'the explicit choice must be written to storage')
  const [key] = run.storageCalls.writes[0]
  assert.ok(
    key.startsWith('dsh-session-top'),
    `the storage key must be namespaced to this plugin; got ${key}`,
  )

  // The failure this guards: a reconcile that re-applies its own default would
  // slam the region shut again on the next host notification.
  for (let i = 0; i < 3; i += 1) {
    run.nudge()
    await settle()
  }
  assert.equal(
    toggle.getAttribute('aria-expanded'), 'true',
    'a reconcile must never re-close what the user explicitly opened',
  )
  assert.equal(panelsToggle(sc), toggle, 'and must not mount a second control')
  run.dispose()
  console.log('✔ panels: an explicit expand survives every reconcile')
}

// --- 1c: the remembered choice is read back on the NEXT mount.
{
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [], storageSeed: { 'dsh-session-top:panels-collapsed': '0' } })
  const toggle = panelsToggle(sc)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'a remembered expand must be honoured')
  assert.notEqual(sc.panelNav.getAttribute('data-stp-panels'), 'collapsed')
  run.dispose()
  console.log('✔ panels: the remembered expand is honoured on the next mount')
}

// --- 1d: a browser that refuses storage still gets a working, folded region.
{
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [], storage: 'throw' })
  const toggle = panelsToggle(sc)
  assert.ok(toggle !== null, 'a refused storage must not take the control with it')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'and the default still applies')
  toggle.click()
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'expanding still works without storage')
  assert.equal(
    run.logs.filter(([, line]) => /panel/i.test(line) && /error|fail/i.test(line)).length, 0,
    'a refused storage is not a failure to report',
  )
  run.dispose()
  console.log('✔ panels: storage refusal degrades to the default and keeps working')
}

// --- 1e: the whole-sidebar rail is the host's business, not ours.
{
  const sc = officialUiScaffold({ rail: true })
  const run = await runBundle(sc, { pinned: [] })
  assert.equal(panelsToggle(sc), null, 'the collapsed rail must not gain a panels control')
  assert.equal(
    sc.panelNav.getAttribute('data-stp-panels'), null,
    'and the host keeps rendering its rail exactly as it does without the plugin',
  )
  run.dispose()
  console.log('✔ panels: the narrow rail is left entirely to the host')
}

// --- 1f: an unrecognized sidebar keeps its nav untouched.
{
  const sc = makeTree()
  const nav = new El('nav')
  nav.className = 'IQEYQa_panelList'
  nav.setAttribute('aria-label', '全局面板')
  sc.body.appendChild(nav)
  const run = await runBundle(sc, { pinned: [] })
  assert.equal(nav.getAttribute('data-stp-panels'), null, 'an unknown sidebar must be left alone')
  assert.equal(sc.body.querySelector('[data-stp-panels-toggle]'), null)
  run.dispose()
  console.log('✔ panels: an unknown sidebar is observe-only')
}

// --- 1g: a sidebar that mounts LATE still gets the control.
{
  const sc = officialUiScaffold({ panels: false })
  const run = await runBundle(sc, { pinned: [] })
  assert.equal(sc.body.querySelector('[data-stp-panels-toggle]'), null, 'nothing to fold yet')

  const nav = new El('nav')
  nav.className = 'IQEYQa_panelList'
  nav.setAttribute('aria-label', '全局面板')
  sc.root.appendChild(nav)
  run.nudge()
  await settle()
  const toggle = panelsToggle(sc)
  assert.ok(toggle !== null, 'a panels nav that appears later must still be collapsed')
  assert.equal(nav.getAttribute('data-stp-panels'), 'collapsed')
  assert.equal(nav.getAttribute('id'), toggle.getAttribute('aria-controls'))
  run.dispose()
  console.log('✔ panels: a late sidebar gets the control on the next pass')
}

// --- 1h: dispose takes every trace of it back, and a remount does not stack.
{
  const sc = officialUiScaffold()
  const first = await runBundle(sc, { pinned: [] })
  const toggle = panelsToggle(sc)
  const navId = sc.panelNav.getAttribute('id')
  assert.ok(navId, 'the control wired an id while it was mounted')

  first.dispose()
  assert.equal(sc.body.querySelector('[data-stp-panels-toggle]'), null, 'dispose removes the control')
  assert.equal(sc.panelNav.getAttribute('data-stp-panels'), null, 'and the fold attribute')
  assert.equal(sc.panelNav.getAttribute('id'), null, 'and the id it added')

  // A second mount on the same document must not leave the first one's control.
  const second = await runBundle(sc, { pinned: [] })
  assert.equal(sc.body.querySelectorAll('[data-stp-panels-toggle]').length, 1, 'exactly one control')
  second.dispose()
  console.log('✔ panels: dispose is complete and a remount does not stack controls')
}

// =====================================================================
// REQUIREMENT 3 — the "工作区目录" master switch, between the pinned region and
// the host's own workspace directories.
//
// Two levels of fold, and only two. R07/S3b closes each directory once; this
// one control folds the whole directory region on top of that. The region is
// the body the host renders the directory headers AND their sessions into
// (`WorkspaceBrowser.tsx:669`), reached from the PROVEN tree rather than
// searched for by name — and it is folded with a stylesheet rule, never by
// removing or re-parenting a single host node, so every group's own expansion
// is still exactly where the user left it when the region comes back.
// =====================================================================

/** The control the plugin mounts above the directory body. */
const dirsToggle = (sc) => sc.body.querySelector('[data-stp-groups-toggle]')

/** The workspace title bar and its search button, as the host renders them. */
function sectionHeader(scaffold) {
  const header = new El('div')
  header.className = 'Rows_sectionHeader__x1y2z'
  const search = new El('button')
  search.setAttribute('aria-label', '搜索会话')
  header.appendChild(search)
  scaffold.root.insertBefore(header, scaffold.root.children[0])
  return { header, search }
}

/** Everything below the directory region that is none of the plugin's business. */
function sidebarFooter(scaffold) {
  const footer = new El('div')
  footer.className = 'Rows_footer__x1y2z'
  const balance = new El('button')
  balance.textContent = '余额'
  footer.appendChild(balance)
  scaffold.body.appendChild(footer)
  return { footer, balance }
}

// --- 3a: expanded by default, keyboard reachable, wired to the body it folds.
{
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [] })
  const body = sc.treeBody
  const toggle = dirsToggle(sc)
  assert.ok(toggle !== null, 'a control for the workspace directories must be mounted')
  assert.equal(toggle.tagName, 'BUTTON', 'a real button, so Enter/Space reach it natively')
  assert.equal(toggle.getAttribute('type'), 'button')
  assert.ok((toggle.getAttribute('aria-label') ?? '').length > 0, 'the control must name itself')
  assert.equal(
    toggle.getAttribute('aria-expanded'), 'true',
    'the region starts EXPANDED — only the directories inside it are folded',
  )
  assert.equal(body.getAttribute('data-stp-groups'), 'expanded')
  const controls = toggle.getAttribute('aria-controls')
  assert.ok(controls, 'aria-controls must point at the region it controls')
  assert.equal(body.getAttribute('id'), controls, 'aria-controls must name the directory body itself')
  assert.equal(toggle.nextElementSibling, body, 'the control sits directly above the directories')
  assert.equal(
    toggle.closest('._8WIE4q_treeBody'), null,
    'and never inside the body it hides — that fold would take the control with it',
  )
  assert.equal(
    sheetRules(sc).some(rule => rule.includes('data-stp-groups') && rule.includes('display:none')),
    false,
    'an expanded region emits no hide rule',
  )
  assert.ok(staticCss(sc).includes('stp-groups-toggle'), 'the control must be styled, not bare')
  run.dispose()
  console.log('✔ directories: the region starts expanded, with a keyboard-reachable aria-wired control above it')
}

// --- 3b: folding takes the DIRECTORIES and their sessions, and nothing else.
{
  const sc = officialUiScaffold()
  const { header, search } = sectionHeader(sc)
  const { footer, balance } = sidebarFooter(sc)
  const run = await runBundle(sc, { pinned: [S1] })
  const toggle = dirsToggle(sc)
  const region = sc.body.querySelector('[data-stp-region]')
  assert.ok(region !== null, 'precondition: a pinned region above the directories')
  assert.equal(region.nextElementSibling, toggle, 'the control sits BETWEEN the pinned region and the directories')
  assert.ok(sc.treeBody.querySelector('[data-row-key^="workspace:"]') !== null, 'precondition: a directory to hide')

  toggle.click()
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'the click folds the region')
  assert.equal(sc.treeBody.getAttribute('data-stp-groups'), 'collapsed')
  assert.ok(
    sheetRules(sc).some(rule => rule.includes('data-stp-groups') && rule.includes('display:none')),
    `the fold must be a stylesheet rule from this plugin; got ${JSON.stringify(sheetRules(sc))}`,
  )
  // The whole body goes, which is what "the directories AND their sessions"
  // means; a rule scoped to session rows alone would leave the directory names
  // on screen with nothing under them.
  assert.equal(
    sheetRules(sc).some(rule => rule.includes('data-stp-groups') && rule.includes('session:')), false,
    'the fold is not a per-session hide rule',
  )
  // Siblings, not children: none of these is reachable by the fold.
  assert.equal(region.parentElement, sc.listArea, 'the pinned region is a sibling of the body, not inside it')
  assert.ok(header.isConnected !== false && search.isConnected !== false, 'the workspace title bar and its search button survive')
  assert.ok(footer.isConnected !== false && balance.isConnected !== false, 'and so does the footer below')
  assert.equal(footer.getAttribute('data-stp-groups'), null, 'the fold marker is only ever on the one proven body')
  assert.ok(region.isConnected !== false, 'and the pinned region is still rendered')

  toggle.click()
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'and it comes back')
  assert.equal(sc.treeBody.getAttribute('data-stp-groups'), 'expanded')
  assert.equal(
    sheetRules(sc).some(rule => rule.includes('data-stp-groups') && rule.includes('display:none')), false,
    'expanded means no hide rule',
  )
  run.dispose()
  console.log('✔ directories: folding takes the directories and their sessions, and leaves the region above and below alone')
}

// --- 3c: only an explicit `'1'` folds. Everything else is the default.
for (const [seed, wantCollapsed] of [
  [{}, false],
  [{ 'dsh-session-top:groups-collapsed': '0' }, false],
  [{ 'dsh-session-top:groups-collapsed': 'yes' }, false],
  [{ 'dsh-session-top:groups-collapsed': '1' }, true],
]) {
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [], storageSeed: seed })
  const state = wantCollapsed ? 'collapsed' : 'expanded'
  assert.equal(sc.treeBody.getAttribute('data-stp-groups'), state, `seed ${JSON.stringify(seed)} → ${state}`)
  assert.equal(dirsToggle(sc).getAttribute('aria-expanded'), wantCollapsed ? 'false' : 'true', 'and the control agrees')
  run.dispose()
}
console.log('✔ directories: only an explicit \'1\' folds; absent, junk and \'0\' all mean expanded')

// --- 3d: the user's choice wins, survives reconciles, and writes ONE key.
{
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [] })
  const toggle = dirsToggle(sc)
  toggle.click()
  assert.deepEqual(
    run.storageCalls.writes,
    [['dsh-session-top:groups-collapsed', '1']],
    'exactly one write, under this plugin\'s own new key',
  )
  // The failure this guards: a reconcile that re-applies its own default would
  // slam the region open again on the next host notification.
  for (let i = 0; i < 3; i += 1) { run.nudge(); await settle() }
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'a reconcile must never re-expand what the user folded')
  assert.equal(dirsToggle(sc), toggle, 'and must not mount a second control')
  toggle.click()
  assert.deepEqual(run.storageCalls.writes.at(-1), ['dsh-session-top:groups-collapsed', '0'], 'unfolding is remembered the same way')
  run.dispose()
  console.log('✔ directories: an explicit fold survives every reconcile and is remembered under its own key')
}

// --- 3e: the per-directory state is exactly where the user left it when the
// region comes back — the fold is one stylesheet rule, never a state change.
{
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [] })
  const toggle = dirsToggle(sc)
  assert.equal(sc.head.getAttribute('aria-expanded'), 'false', 'precondition: the directory was closed on first sight')
  // The user opens that one directory by hand, then folds the whole region.
  sc.head.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  assert.equal(sc.head.getAttribute('aria-expanded'), 'true', 'the user opened it')
  const clicksBefore = sc.head.onclickCount
  toggle.click()
  assert.equal(sc.head.getAttribute('aria-expanded'), 'true', 'folding the region must not touch any group')
  assert.equal(sc.head.onclickCount, clicksBefore, 'which takes no header click at all')
  toggle.click()
  assert.equal(
    sc.head.getAttribute('aria-expanded'), 'true',
    'and re-expanding the region must not re-run the first-sight default',
  )
  assert.equal(sc.head.onclickCount, clicksBefore, 'which would have taken another click')
  run.dispose()
  console.log('✔ directories: re-expanding the region leaves every group exactly as the user left it')
}

// --- 3f: a browser that refuses storage still gets a working control.
{
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [], storage: 'throw' })
  const toggle = dirsToggle(sc)
  assert.ok(toggle !== null, 'a refused storage must not take the control with it')
  assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'and the default still applies')
  toggle.click()
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'folding still works without storage')
  assert.equal(
    run.logs.filter(([, line]) => /director|groups/i.test(line) && /error|fail/i.test(line)).length, 0,
    'a refused storage is not a failure to report',
  )
  run.dispose()
  console.log('✔ directories: storage refusal degrades to the default and keeps working')
}

// --- 3g: what is NOT provably a workspace-directory region is left alone.
{
  const sc = makeTree()
  const run = await runBundle(sc, { pinned: [] })
  assert.equal(sc.body.querySelector('[data-stp-groups-toggle]'), null, 'an unknown sidebar must get no control')
  assert.equal(sc.treeBody.getAttribute('data-stp-groups'), null, 'and no marker — the rules would then reach it')
  run.dispose()
}
{
  // codex-ui renders one `.dcu-wb-project` PER workspace, with no single seat
  // holding them all. Inventing one would be pretending to a host seam this
  // build cannot prove, so the master switch stays off there — while the
  // per-directory default fold, which needs no such seam, still runs.
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [] })
  await settle()
  assert.equal(sc.body.querySelector('[data-stp-groups-toggle]'), null, 'codex gets no master switch')
  assert.equal(sc.head.getAttribute('aria-expanded'), 'false', 'but the per-directory default fold still applies')
  run.dispose()
}
console.log('✔ directories: an unknown sidebar is observe-only, and codex is not given a seam that does not exist')

// --- 3h: the whole-sidebar rail is the host's business, not ours.
{
  const sc = officialUiScaffold({ rail: true })
  const run = await runBundle(sc, { pinned: [] })
  assert.equal(dirsToggle(sc), null, 'the collapsed rail must not gain a directory control')
  assert.equal(sc.treeBody.getAttribute('data-stp-groups'), null, 'and no fold on a layout the user did not choose')
  run.dispose()
  console.log('✔ directories: the narrow rail is left entirely to the host')
}

// --- 3i: only the body under the PROVEN tree is ever marked — never a
// look-alike elsewhere on the page.
//
// The look-alike goes in AHEAD of the host's own sidebar subtree, so it comes
// first in document order. Appended after it, the case would prove nothing: a
// plugin that simply grabbed the first `[class*="treeBody"]` on the page would
// find the real body anyway and pass. Placed first, only reaching the body
// THROUGH the proven tree can mark the right one.
//
// The reference node is `root`, the sidebar subtree's own top element and a
// direct child of `body` — NOT `listArea`, which the scaffold re-parented
// under `root`. An unresolved reference is not an error in this fake, it
// appends, which would put the look-alike last again and silently disarm the
// case; the precondition below is what keeps that honest.
{
  const sc = officialUiScaffold()
  const elsewhere = new El('div')
  elsewhere.className = '_8WIE4q_treeBody _8WIE4q_wide'
  sc.body.insertBefore(elsewhere, sc.root)
  assert.ok(
    sc.body.children.indexOf(elsewhere) < sc.body.children.indexOf(sc.root),
    `precondition: the look-alike precedes the real sidebar, else this case proves nothing; order ${sc.body.children.indexOf(elsewhere)} vs ${sc.body.children.indexOf(sc.root)}`,
  )
  const run = await runBundle(sc, { pinned: [] })
  assert.notEqual(sc.treeBody.getAttribute('data-stp-groups'), null, 'the proven body is marked')
  assert.equal(elsewhere.getAttribute('data-stp-groups'), null, 'a look-alike is never adopted')
  assert.equal(elsewhere.querySelector('[data-stp-groups-toggle]'), null, 'and never gains a control')
  run.dispose()
  console.log('✔ directories: only the body under the proven tree is marked')
}

// --- 3j: an idle second writes nothing.
{
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [] })
  let bodyWrites = 0
  let toggleWrites = 0
  const bodySet = sc.treeBody.setAttribute.bind(sc.treeBody)
  sc.treeBody.setAttribute = (name, value) => {
    if (name === 'data-stp-groups' || name === 'data-stp-groups-body') bodyWrites += 1
    return bodySet(name, value)
  }
  const toggle = dirsToggle(sc)
  const toggleSet = toggle.setAttribute.bind(toggle)
  toggle.setAttribute = (name, value) => {
    // `aria-expanded` is the only attribute an idle pass can change the VALUE
    // of; the rest are re-asserted identically every pass, as the panels
    // control already does.
    if (name === 'aria-expanded') toggleWrites += 1
    return toggleSet(name, value)
  }
  for (let i = 0; i < 5; i += 1) { run.nudge(); await settle() }
  assert.equal(bodyWrites, 0, `an unchanged body must not be rewritten; got ${bodyWrites} writes across 5 idle passes`)
  assert.equal(toggleWrites, 0, `and neither must the control; got ${toggleWrites}`)
  run.dispose()
  console.log('✔ directories: five idle reconciles write nothing at all')
}

// --- 3k: a sidebar that mounts LATE still gets the control.
{
  const sc = makeTree()
  const run = await runBundle(sc, { pinned: [] })
  assert.equal(sc.body.querySelector('[data-stp-groups-toggle]'), null, 'nothing to fold yet')

  sc.tree.setAttribute('aria-label', 'sessions')
  const head = new El('div')
  head.setAttribute('role', 'treeitem')
  head.setAttribute('data-row-key', 'workspace:w1')
  head.setAttribute('aria-expanded', 'false')
  sc.tree.appendChild(head)
  run.nudge()
  await settle()
  const toggle = dirsToggle(sc)
  assert.ok(toggle !== null, 'a sidebar that appears later must still get the control')
  assert.equal(sc.treeBody.getAttribute('id'), toggle.getAttribute('aria-controls'))
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  run.dispose()
  console.log('✔ directories: a late sidebar gets the control on the next pass')
}

// --- 3l: dispose takes every trace of it back, and a remount does not stack.
{
  const sc = officialUiScaffold()
  const first = await runBundle(sc, { pinned: [] })
  const bodyId = sc.treeBody.getAttribute('id')
  assert.ok(bodyId, 'the control lent the body an id while it was mounted')

  first.dispose()
  assert.equal(sc.body.querySelector('[data-stp-groups-toggle]'), null, 'dispose removes the control')
  assert.equal(sc.treeBody.getAttribute('data-stp-groups'), null, 'and the fold attribute')
  assert.equal(sc.treeBody.getAttribute('data-stp-groups-body'), null, 'and the marker')
  assert.equal(sc.treeBody.getAttribute('id'), null, 'and the id it added')
  assert.ok(sc.head.isConnected !== false, 'and not one host node of the region')
  assert.equal(
    sheetRules(sc).some(rule => rule.includes('data-stp-groups')), false,
    'and the shared sheet must not keep a rule for a region nobody owns',
  )

  const second = await runBundle(sc, { pinned: [] })
  assert.equal(sc.body.querySelectorAll('[data-stp-groups-toggle]').length, 1, 'exactly one control')
  second.dispose()
  console.log('✔ directories: dispose is complete and a remount does not stack controls')
}

// =====================================================================
// REQUIREMENT 2 — a right-click offers the HOST's own session actions, on a
// real official row AND on a plugin-drawn pinned row, anchored where the user
// clicked, with nothing left behind afterwards.
//
// The host's menu is a "…" BUTTON menu per row (Rows.tsx:667-690), not a
// `contextmenu` surface. Clicking that button is the only way to open it, so
// the hand-off is a click on the host's own control — never a re-implementation
// of rename/fork/archive/copy, never a graft into the portalled list.
// =====================================================================

/**
 * Deliver a contextmenu at the pointer, the way a browser does: every
 * document-capture listener sees it, in registration order.
 */
function rightClickAt(run, target, x, y) {
  const event = {
    defaultPrevented: false,
    target,
    clientX: x,
    clientY: y,
    button: 2,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() {},
  }
  for (const fn of [...(run.listeners.get('contextmenu') ?? [])]) fn(event)
  return event
}

// --- 2a: a plain official row, unhandled by anyone, opens the HOST's own menu.
{
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [] })
  openWorkspace(sc)
  const event = rightClickAt(run, sc.liveRow(), 120, 200)
  await afterDispatch()

  assert.equal(sc.liveRow().ellipsis.clicks, 1, "the host's own … button must be what opens")
  const hostMenu = sc.liveRow().hostMenu()
  assert.ok(hostMenu !== null, 'the host menu must be open, with the host\'s own items')
  const labels = hostMenu.children.map(item => item.textContent)
  for (const label of ['置顶', '重命名', '分叉会话', '归档会话', '复制 Session ID']) {
    assert.ok(labels.includes(label), `the host's own action must survive: ${label}`)
  }
  assert.equal(
    sc.body.querySelector('[data-stp-menu]'), null,
    'a one-item plugin menu must not replace the host menu',
  )
  assert.equal(event.defaultPrevented, true, 'the browser default must not open underneath')
  run.dispose()
  console.log('✔ official row: right-click opens the host\'s own full session menu')
}

// --- 2b: the same row must NOT be stolen from an owner that already handled it.
{
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [] })
  openWorkspace(sc)
  // Registered before the plugin's own listener, exactly as the shared owner is.
  run.listeners.get('contextmenu').unshift((event) => {
    if (event.target === sc.liveRow()) event.preventDefault()
  })
  const event = rightClickAt(run, sc.liveRow(), 120, 200)
  await afterDispatch()

  assert.equal(event.defaultPrevented, true)
  assert.equal(sc.liveRow().ellipsis.clicks, 0, 'a menu that already exists must not be doubled')
  assert.equal(sc.liveRow().hostMenu(), null)
  run.dispose()
  console.log('✔ official row: another owner\'s claim is never overridden')
}

// --- 2c: codex keeps its native menu — actions and all.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [] })
  const event = rightClickAt(run, sc.row, 120, 200)
  await afterDispatch()
  assert.equal(
    event.defaultPrevented, false,
    'the host\'s own native menu must not be prevented or covered by a plugin menu',
  )
  assert.equal(sc.body.querySelector('[data-stp-menu]'), null, 'and not replaced by a plugin menu')
  run.dispose()
  console.log('✔ codex: the native session menu is left to the host, with its own actions')
}

// --- 2d: a PINNED row — the plugin's own row, whose official row the pin rule
// has hidden — offers the same full host menu, at the row that was clicked.
{
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  openWorkspace(sc)
  const region = sc.body.querySelector('[data-stp-region]')
  const own = region.querySelector('[data-stp-row]')
  assert.ok(own !== null, 'the pinned row must be on screen')
  const clickX = 140
  const clickY = 96
  rightClickAt(run, own, clickX, clickY)
  await settle()

  assert.equal(
    sc.body.querySelector('[data-stp-menu]'), null,
    'a pinned row must not fall back to the one-item plugin menu',
  )
  assert.equal(sc.liveRow().ellipsis.clicks, 1, 'the pinned row must reach the host\'s own menu')
  const hostMenu = sc.liveRow().hostMenu()
  assert.ok(hostMenu !== null)
  const labels = hostMenu.children.map(item => item.textContent)
  for (const label of ['重命名', '分叉会话', '归档会话', '复制 Session ID']) {
    assert.ok(labels.includes(label), `the host's own action must survive: ${label}`)
  }
  assert.equal(
    labels.filter(label => label === '置顶' || label === '取消置顶').length, 1,
    'the host already carries Pin/Unpin — a second copy is a duplicate action',
  )

  // Position. The hidden official row sits at y≈420; the user clicked y=96 on
  // the pinned region at the top. The host puts the menu at the anchor it
  // measured, so the anchor's own centre must be the pointer.
  const anchor = hostMenu.anchorRect
  assert.ok(
    Math.abs((anchor.top + anchor.bottom) / 2 - clickY) < 40
      && Math.abs((anchor.left + anchor.right) / 2 - clickX) < 40,
    `the menu must anchor on the row the user clicked, not on the hidden group: got ${JSON.stringify(anchor)}`,
  )
  run.dispose()
  console.log('✔ pinned row: the full host menu, anchored on the row that was clicked')
}

// --- 2e: closing restores everything — no stray inline styles, no re-folded
// state, no duplicate rows.
{
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  openWorkspace(sc)
  const region = sc.body.querySelector('[data-stp-region]')
  rightClickAt(run, region.querySelector('[data-stp-row]'), 140, 96)
  await settle()
  assert.ok(sc.liveRow().hostMenu() !== null, 'precondition: the host menu opened')
  // Captured now: closing puts the group back, which unmounts this row.
  const row = sc.liveRow()

  // The user picks an item: a pointerdown on the list, then the host closes.
  const item = sc.liveRow().hostMenu().children[1]
  item.dispatch('pointerdown')
  row.ellipsis.click()
  await settle()

  assert.equal(row.style.props.size, 0, `inline styles must be handed back; left ${JSON.stringify([...row.style.props])}`)
  assert.equal(row.style.priorities.size, 0)
  assert.equal(region.querySelectorAll('[data-stp-row]').length, 1, 'no duplicated pinned row')
  assert.ok(
    sheetRules(sc).some(rule => rule.includes(S1) && rule.includes('display:none')),
    'the pin hide rule must still be in force for the pinned session',
  )
  run.dispose()
  console.log('✔ pinned row: closing hands every temporary style back')
}

// --- 2f: the group FOLDED case. The host renders no rows for a folded group
// (`childRows = group.expanded ? … : []`), so the hand-off has to make the row
// exist, use it, and put the group back exactly as it found it.
{
  const sc = officialUiScaffold({ folded: true })
  const run = await runBundle(sc, { pinned: [S1] })
  assert.equal(sc.tree.querySelector('[data-row-key^="session:"]'), null, 'precondition: no rows mounted')
  assert.equal(sc.head.getAttribute('aria-expanded'), 'false', 'precondition: the group is folded')

  const region = sc.body.querySelector('[data-stp-region]')
  rightClickAt(run, region.querySelector('[data-stp-row]'), 140, 96)
  await settle()

  assert.ok(sc.liveRow().hostMenu() !== null, 'a folded group must still yield the host menu')
  const anchor = sc.liveRow().hostMenu().anchorRect
  assert.ok(
    Math.abs((anchor.top + anchor.bottom) / 2 - 96) < 40,
    `the menu must appear near the click, not inside the group it came from: ${JSON.stringify(anchor)}`,
  )
  assert.equal(sc.head.onclickCount, 1, 'exactly one expansion, through the header\'s own toggle')

  // Close it.
  const row = sc.liveRow()
  sc.liveRow().hostMenu().children[1].dispatch('pointerdown')
  row.ellipsis.click()
  await settle()
  assert.equal(
    sc.head.getAttribute('aria-expanded'), 'false',
    'the group the plugin expanded must be folded again when the menu closes',
  )
  assert.equal(sc.head.onclickCount, 2, 'and by exactly one more header toggle')
  run.dispose()
  console.log('✔ pinned row in a FOLDED group: menu opens, then the group is put back')
}

// --- 2g: dispose while that menu is open still hands everything back.
{
  const sc = officialUiScaffold({ folded: true })
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  rightClickAt(run, region.querySelector('[data-stp-row]'), 140, 96)
  await settle()
  assert.ok(sc.liveRow().ellipsis.clicks >= 1)
  const row = sc.liveRow()

  run.dispose()
  await settle()
  assert.equal(row.style.props.size, 0, 'dispose must drop the temporary anchor styles')
  assert.equal(row.style.priorities.size, 0)
  assert.equal(
    sc.head.getAttribute('aria-expanded'), 'false',
    'and leave no group expanded that it was the one to expand',
  )
  assert.equal(run.liveTimers().length, 0, 'and no timer of the watch left running')
  console.log('✔ pinned row in a folded group: dispose mid-menu still restores everything')
}

// --- 2h: no host row to borrow at all — the one-item fallback stays as the
// emergency exit, and the gesture is still not left to the browser.
{
  const sc = officialUiScaffold({ hostRowMenu: false })
  const run = await runBundle(sc, { pinned: [] })
  const event = rightClickAt(run, sc.row, 120, 200)
  await afterDispatch()
  assert.ok(sc.body.querySelector('[data-stp-menu]') !== null, 'the fallback menu must still exist')
  assert.ok(sc.body.querySelector('[data-stp-pin-item]') !== null, 'with the pin action')
  assert.equal(event.defaultPrevented, true, 'and never the browser default')
  run.dispose()
  console.log('✔ official row without a … button: the pin fallback, never the browser menu')
}

// --- 2i: codex serves its OWN session menu on right-click — but it serves it
//     FROM a host row. A pinned session whose host row is not mounted (group
//     folded, search view, mid-render) therefore has nothing to be served, and
//     the gesture is already suppressed by the time we get here. Measured: the
//     right-click did nothing at all, not even the browser's own menu.
{
  const sc = codexScaffold()
  sc.row.remove() // the host renders no session row at all: every group folded
  const run = await runBundle(sc, { pinned: [S1] })
  const own = sc.body.querySelector('[data-stp-row]')
  assert.ok(own !== null, 'precondition: the pinned row is on screen')
  assert.equal(sc.body.querySelector('[data-dcu-session]'), null, 'precondition: and no host row to borrow')

  const event = rightClickAt(run, own, 140, 96)
  await settle()
  const menu = sc.body.querySelector('[data-stp-menu]')
  assert.ok(
    menu !== null,
    'a pinned codex row with no host row must still get the pin fallback, not a dead gesture',
  )
  const item = menu.querySelector('[data-stp-pin-item]')
  assert.ok(item !== null, 'with the pin action')
  assert.match(item.textContent, /取消置顶/, 'a pinned session offers Unpin')
  assert.equal(event.defaultPrevented, true, 'and never the browser default')
  run.dispose()
  console.log('✔ codex pinned row with no host row: the pin fallback, not a dead right-click')
}

// --- 2j: on a codex host with NO shared owner, the hand-off is NOT taken, even
//     with the host row MOUNTED. This assertion was inverted when the codex-ui
//     runtime was measured for real, and the measurement is the reason.
//
//     `@michengai/dsh-codex-ui` builds its row menu inline in
//     `sessionMenuItems()` (lib/client.js:1757-1836) and hands it to
//     `SessionRow` as a prop. It is not the `sidebar.workspaces.session.menu.item`
//     slot: codex-ui claims that `single` slot itself at `priority: -1`, so the
//     stock `WorkspaceBrowser` — the entry that DECLARES the menu.item list and
//     registers the stock `pin` row — never mounts and never renders it. The
//     plugin's own colour item, registered into that same list, is in the same
//     position: present in the registry, drawn by nobody.
//
//     So the menu codex really opens is CODEX_SESSION_MENU: rename / unread /
//     archive / fork / openPath / moveWorkspace / copyId / copyTitle / copyPath,
//     none of them Unpin, none of them a row colour. Forwarding the gesture
//     therefore handed the user a menu with nothing in it that a PINNED row
//     needs, while the plugin's own menu holds exactly those two actions.
//
//     "NO SHARED OWNER" IS LOAD-BEARING IN THIS CASE, not decoration. The owner
//     (`@baihejiangnan/dsh-session-context-menu`) does not use that slot either:
//     it builds its own `.dshcm-menu` and reads our entries out of
//     `Symbol.for('dsh.session-context-menu.extensions')`, so on this very host
//     its menu carries the host actions AND Unpin AND the row colour. When it
//     is installed, forwarding is the better answer and this short-circuit must
//     NOT fire. `test/owner-menu-real.mjs` drives exactly that pair against the
//     REAL artifact: with the owner, its full menu wins; without it, this case
//     applies. Asserting only one half of that pair is how the previous
//     revision shipped a regression.
//
//     codex's own rows are untouched either way: this never claims a host row,
//     only a row this plugin drew.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const own = sc.body.querySelector('[data-stp-row]')
  assert.ok(sc.body.querySelector('[data-dcu-session]') !== null, 'precondition: the host row is there')
  assert.equal(
    globalThis[Symbol.for('dsh.session-context-menu.extensions')], undefined,
    'precondition: no shared owner is installed — this case is the no-owner half',
  )
  const event = rightClickAt(run, own, 140, 96)
  await settle()
  assert.deepEqual(
    sc.nativeClaims, [],
    'the host\'s own row handler must NOT be handed a pinned row\'s gesture — its menu has no Unpin and no colour',
  )
  const menu = sc.body.querySelector('[data-stp-menu]')
  assert.ok(menu !== null, 'the plugin-owned menu opens on the pinned row instead')
  assert.match(
    menu.querySelector('[data-stp-pin-item]').textContent, /取消置顶/,
    'and the first thing in it is the Unpin a pinned row exists for',
  )
  assert.match(
    menu.querySelector('[data-stp-color-item]').textContent, /自定义行背景颜色/,
    'and the row colour the host menu could not carry',
  )
  assert.equal(sc.body.querySelector('.dcu-host-menu'), null, 'no host menu is opened behind it')
  assert.equal(event.defaultPrevented, true, 'and never the browser default')
  run.dispose()
  console.log('✔ codex pinned row, no owner: its own menu (Unpin + colour), not the host\'s menu without them')
}

// (The host's OWN rows stay observe-only — that is case 2c above, which holds
//  for a pinned session's host row too: the plugin claims only rows it drew,
//  never a `[data-dcu-session]` the host rendered.)

// =====================================================================
// REQUIREMENT 3 — the Pinned region's OWN header folds its rows away.
//
// The host has no control for this region (the plugin drew it), so the fold is
// this plugin's: a real, focusable, keyboard-operable disclosure control on the
// header it already renders. Two things make it safe to have there, and both
// are asserted below rather than assumed:
//
//   - the rows are HIDDEN by this plugin's own stylesheet, never removed. A row
//     removed and re-added is a new node at the pointerup, and the browser then
//     dispatches the click on the common ancestor instead — which is why a
//     fold implemented by rebuilding the list silently eats clicks.
//   - the fold state is a PREFERENCE, not projection: it must not be in the
//     render signature, or every reconcile would rebuild the region.
// =====================================================================

/** The control that folds the pinned region. */
const regionHeaderOf = (region) => region.querySelector('[data-stp-region-header]')
/** The pinned rows, in DOM order. */
const rowsOf = (region) => [...region.querySelectorAll('[data-stp-row]')]
/** The trailing colour point of a row. */
const swatchOf = (row) => row.querySelector('[data-stp-row-color]')
/** The native colour control inside a row's colour point. */
const colorInputOf = (row) => row.querySelector('[data-stp-color-input]')

/**
 * Everything about a row's colour a repaint is allowed to touch, as one value.
 *
 * `mutationLog` only sees childList and textContent, so it cannot see an
 * attribute or a custom-property write at all — which is exactly the noise
 * "a foreign write that changes nothing must repaint nothing" is about. This
 * snapshot is the probe for it: same object in means nothing was written.
 * @param {Element} row - the row.
 * @returns {object} the row's whole colour surface.
 */
const colorSurfaceOf = (row) => {
  const swatch = swatchOf(row)
  const input = colorInputOf(row)
  return {
    attr: row.getAttribute('data-stp-color'),
    prop: row.style.getPropertyValue('--stp-row-color').trim(),
    set: swatch.hasAttribute('data-stp-row-color-set'),
    input: input.value,
    name: swatch.getAttribute('aria-label'),
  }
}

// --- 3a: the header is a real, named, keyboard-operable disclosure control.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  const header = regionHeaderOf(region)
  assert.ok(header !== null, 'the region must carry its own header control')
  assert.equal(
    header.getAttribute('aria-hidden'), null,
    'the fold control cannot be aria-hidden — a keyboard/AT user would have nothing to operate',
  )
  assert.equal(header.getAttribute('role'), 'button')
  assert.equal(header.getAttribute('tabindex'), '0', 'the fold must be reachable by Tab')
  assert.equal(header.getAttribute('aria-expanded'), 'true', 'the region starts EXPANDED, as it always has')
  assert.ok(
    (header.getAttribute('aria-label') ?? '').length > 0,
    'the control must name itself, since its glyph and count are decoration',
  )
  assert.equal(region.getAttribute('data-stp-collapsed'), 'false')
  run.dispose()
  console.log('✔ pinned region: the header is a focusable, named disclosure control, expanded by default')
}

// --- 3b: the hide rule is OURS, targets only DIRECT child rows, and is CSS.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1, S2] })
  const region = sc.body.querySelector('[data-stp-region]')
  assert.match(
    staticCss(sc),
    /\[data-stp-region\]\[data-stp-collapsed='true'\]\s*>\s*\[data-stp-row\]\s*\{[^}]*display:\s*none/,
    'folding must be a direct-child stylesheet rule from this plugin, so no row node is destroyed',
  )
  const header = regionHeaderOf(region)
  const before = rowsOf(region)
  assert.equal(before.length, 2)

  header.click()
  assert.equal(region.getAttribute('data-stp-collapsed'), 'true')
  assert.equal(header.getAttribute('aria-expanded'), 'false')
  assert.deepEqual(
    rowsOf(region), before,
    'folding must not rebuild, reorder or remove a single row — identity is what makes a later click land',
  )
  assert.equal(region.querySelector('[data-stp-region-count]').textContent, '2', 'the count is kept')
  assert.equal(regionHeaderOf(region), header, 'the header is not the thing being folded')

  header.click()
  assert.equal(region.getAttribute('data-stp-collapsed'), 'false')
  assert.equal(header.getAttribute('aria-expanded'), 'true')
  assert.deepEqual(rowsOf(region), before, 'and unfolding brings the same nodes back')
  run.dispose()
  console.log('✔ pinned region: the fold is a CSS rule over untouched rows, count and header intact')
}

// --- 3c: Enter and Space operate it, and Space does not scroll.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  const header = regionHeaderOf(region)

  header.dispatch('keydown', { key: 'Enter' })
  assert.equal(header.getAttribute('aria-expanded'), 'false', 'Enter folds')
  const space = header.dispatch('keydown', { key: ' ' })
  assert.equal(space.defaultPrevented, true, 'Space must be consumed, not left to scroll the sidebar')
  assert.equal(header.getAttribute('aria-expanded'), 'true', 'Space unfolds')

  // Keys that are not the fold must stay inert, and must not reach a row.
  header.dispatch('keydown', { key: 'a' })
  header.dispatch('keydown', { key: 'Tab' })
  assert.equal(header.getAttribute('aria-expanded'), 'true')
  assert.deepEqual(run.opened, [], 'operating the fold must never open a session')
  assert.deepEqual(run.pinCalls, [], 'and never touch the pin set')
  run.dispose()
  console.log('✔ pinned region: Enter and Space operate the fold, and nothing navigates')
}

// --- 3d: the fold is a PREFERENCE, not projection. Pin changes under a folded
//     region still render, still reuse their nodes, and the header never moves.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  const header = regionHeaderOf(region)
  header.click()
  assert.equal(region.getAttribute('data-stp-collapsed'), 'true')

  // A pin arrives while the region is folded.
  run.live.pinned = [S1, S2]
  run.nudge()
  await settle()
  const rows = rowsOf(region)
  assert.equal(rows.length, 2, 'a session pinned while folded must still get its row')
  assert.equal(rows[1].getAttribute('data-stp-session'), S2, 'in the official order')
  assert.equal(regionHeaderOf(region), header, 'and the header must survive the pin change')
  assert.equal(region.getAttribute('data-stp-collapsed'), 'true', 'the fold must not be undone by a reconcile')
  assert.equal(header.getAttribute('aria-expanded'), 'false')

  // The proof that the preference is NOT in the render signature: three
  // notifications that change nothing rebuild nothing.
  const before = rowsOf(region)
  const mutationsBefore = mutationLog.records
  for (let i = 0; i < 3; i += 1) {
    run.nudge()
    await settle()
  }
  assert.deepEqual(rowsOf(region), before, 'an idle reconcile must not touch the rows')
  assert.equal(mutationLog.records - mutationsBefore, 0, 'and must not write anything at all')

  // And the row that was there before the fold is still the very same node.
  assert.equal(rows[0], before[0])
  run.dispose()
  console.log('✔ pinned region: folding survives pin changes and is kept out of the render signature')
}

// --- 3e: the choice is remembered, and only an explicit '1' means folded.
{
  const sc = codexScaffold()
  const folded = await runBundle(sc, {
    pinned: [S1],
    storageSeed: { 'dsh-session-top:region-collapsed': '1' },
  })
  const foldRegion = sc.body.querySelector('[data-stp-region]')
  assert.equal(regionHeaderOf(foldRegion).getAttribute('aria-expanded'), 'false', 'a remembered fold is honoured')
  folded.dispose()

  for (const raw of ['0', '', 'true', 'yes']) {
    const fresh = codexScaffold()
    const open = await runBundle(fresh, {
      pinned: [S1],
      storageSeed: { 'dsh-session-top:region-collapsed': raw },
    })
    const region = fresh.body.querySelector('[data-stp-region]')
    assert.equal(
      regionHeaderOf(region).getAttribute('aria-expanded'), 'true',
      `stored ${JSON.stringify(raw)} is not "1", so the region is expanded`,
    )
    assert.equal(open.storageCalls.writes.length, 0, 'reading a preference must not write one')
    open.dispose()
  }
  console.log('✔ pinned region: only an explicit "1" folds; anything else is expanded')
}

// --- 3f: the whole round trip — what is written is exactly what the next
//     mount reads back. (Each run gets its own storage, so the next mount is
//     seeded with the value this one wrote rather than sharing a store.)
{
  const KEY = 'dsh-session-top:region-collapsed'
  const sc = codexScaffold()
  const first = await runBundle(sc, { pinned: [S1] })
  regionHeaderOf(sc.body.querySelector('[data-stp-region]')).click()
  const writes = first.storageCalls.writes.filter(([key]) => key === KEY)
  assert.equal(writes.length, 1, 'the explicit choice is written under this plugin\'s own key')
  assert.deepEqual(
    [...new Set(first.storageCalls.writes.map(([key]) => key))],
    [KEY],
    'and nothing else is written',
  )
  const stored = writes[0][1]
  assert.equal(stored, '1', 'a fold is stored as "1"')
  first.dispose()

  // A fresh mount seeded with exactly that value starts folded, and unfolding
  // it writes the value that makes the NEXT mount start expanded.
  const live = codexScaffold()
  const second = await runBundle(live, { pinned: [S1], storageSeed: { [KEY]: stored } })
  const header = regionHeaderOf(live.body.querySelector('[data-stp-region]'))
  assert.equal(header.getAttribute('aria-expanded'), 'false', 'the next mount starts folded')
  header.click()
  assert.equal(second.storageCalls.writes.at(-1)[1], '0', 'an unfold is stored as "0"')
  second.dispose()

  const thirdSc = codexScaffold()
  const third = await runBundle(thirdSc, { pinned: [S1], storageSeed: { [KEY]: '0' } })
  assert.equal(
    regionHeaderOf(thirdSc.body.querySelector('[data-stp-region]')).getAttribute('aria-expanded'),
    'true',
    'and that mount starts expanded',
  )
  third.dispose()
  console.log('✔ pinned region: the fold round-trips through storage across mounts')
}

// --- 3g: a browser that refuses storage still gets a working control.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1], storage: 'throw' })
  const region = sc.body.querySelector('[data-stp-region]')
  const header = regionHeaderOf(region)
  assert.equal(header.getAttribute('aria-expanded'), 'true', 'the default still applies without storage')
  header.click()
  assert.equal(region.getAttribute('data-stp-collapsed'), 'true', 'folding still works without storage')
  assert.deepEqual(
    run.logs.filter(([, line]) => /error|fail/i.test(line)),
    [],
    'a refused storage is not a failure to report',
  )
  run.dispose()
  console.log('✔ pinned region: storage refusal degrades to the default and keeps working')
}

// =====================================================================
// REQUIREMENT 4 — every pinned session can carry its own background colour.
//
// The colour is a LOCAL preference, kept under this plugin's own key and
// nowhere else: it must never reach the pin set, the host's settings or the
// shared menu owner's document, and it must survive unpin/repin without being
// silently thrown away.
//
// The control is a `span[role="button"]`, NOT a `<button>`: the shared owner's
// row test recognises a session row by a `button[aria-label]` descendant, so a
// real button inside one of these rows would make the owner resolve the
// CURRENT session instead of the one that was clicked. The native control
// underneath it is a real `<input type="color">`, so there is no dependency and
// no hand-rolled picker.
// =====================================================================

// --- 4a: the control exists at the row's trailing edge, in the host's
//     vocabulary for "a session row" not at all.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  const row = rowsOf(region)[0]
  const swatch = swatchOf(row)
  assert.ok(swatch !== null, 'a colour control must sit at the row\'s trailing edge')
  assert.equal(row.lastElementChild ?? row.children[row.children.length - 1], swatch, 'at the very end of the row')
  assert.equal(swatch.tagName, 'SPAN', 'never a <button>: the shared owner reads that as a session row')
  assert.equal(swatch.getAttribute('role'), 'button', 'it is still a control, and says so')
  assert.equal(swatch.getAttribute('tabindex'), '0', 'and reachable by Tab')
  assert.equal(row.querySelector('button'), null, 'no button may appear inside a plugin row')
  assert.equal(row.getAttribute('data-row-key'), null)
  assert.equal(row.getAttribute('data-dcu-session'), null)
  assert.equal(row.getAttribute('role'), 'button')
  assert.equal(row.getAttribute('aria-selected'), null)

  const input = colorInputOf(row)
  assert.ok(input !== null, 'a native colour input must be there: no dependency, no hand-rolled picker')
  assert.equal(input.getAttribute('type'), 'color')
  assert.equal(input.getAttribute('aria-hidden'), 'true', 'the swatch is the accessible control, not the input')
  assert.equal(input.getAttribute('tabindex'), '-1', 'and the input is not a second tab stop')
  // Default: no colour at all.
  assert.equal(row.hasAttribute('data-stp-color'), false, 'a row carries no colour until one is chosen')
  run.dispose()
  console.log('✔ row colour: a native colour input behind a span control, in no host row vocabulary')
}

// --- 4b: choosing a colour applies at once, persists under our own key, and
//     touches neither the pin set nor a session.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  const row = rowsOf(region)[0]
  const input = colorInputOf(row)

  input.value = '#1a2b3c'
  input.dispatch('change', { target: input })

  assert.equal(row.getAttribute('data-stp-color'), '#1a2b3c', 'the choice must show immediately')
  assert.equal(row.style.getPropertyValue('--stp-row-color').trim(), '#1a2b3c', 'as a property the stylesheet mixes')
  assert.deepEqual(
    [...new Set(run.storageCalls.writes.map(([key]) => key))],
    ['dsh-session-top:row-colors'],
    'this plugin\'s own key, and only that key',
  )
  assert.deepEqual(JSON.parse(run.storageCalls.writes[0][1]), { [S1]: '#1a2b3c' })
  assert.deepEqual(run.pinCalls, [], 'a colour is not a pin')
  assert.deepEqual(run.opened, [], 'and not a navigation')
  assert.equal(run.live.pinned.length, 1)

  // A second row is unaffected.
  run.live.pinned = [S1, S2]
  run.nudge()
  await settle()
  assert.equal(rowsOf(region)[1].hasAttribute('data-stp-color'), false, 'colours are per session')
  run.dispose()
  console.log('✔ row colour: a choice applies at once and persists under the plugin\'s own key')
}

// --- 4c: dirty stored data is not a failure. Neither is a refused storage.
{
  const dirty = ['{not json', '[]', 'null', '42', '"#ffffff"',
    JSON.stringify({ [S1]: 'red' }), JSON.stringify({ [S1]: '#12345' }), JSON.stringify({ [S1]: '#1234567' }),
    JSON.stringify({ [S1]: null }), JSON.stringify({ [S1]: 5 })]
  for (const seed of dirty) {
    const sc = codexScaffold()
    const run = await runBundle(sc, { pinned: [S1], storageSeed: { 'dsh-session-top:row-colors': seed } })
    const region = sc.body.querySelector('[data-stp-region]')
    const row = rowsOf(region)[0]
    assert.equal(row.hasAttribute('data-stp-color'), false, `stored ${seed} must not paint a colour`)
    assert.ok(swatchOf(row) !== null, 'and the control is still there to pick one')
    // Picking one still works after every one of those.
    const input = colorInputOf(row)
    input.value = '#010203'
    input.dispatch('change', { target: input })
    assert.equal(row.getAttribute('data-stp-color'), '#010203', 'stored garbage must not poison a new choice')
    run.dispose()
  }
  const fresh = codexScaffold()
  const refused = await runBundle(fresh, { pinned: [S1], storage: 'throw' })
  const refusedRow = rowsOf(fresh.body.querySelector('[data-stp-region]'))[0]
  assert.equal(refusedRow.hasAttribute('data-stp-color'), false, 'no stored colour without storage')
  const refusedInput = colorInputOf(refusedRow)
  refusedInput.value = '#040506'
  refusedInput.dispatch('change', { target: refusedInput })
  assert.equal(refusedRow.getAttribute('data-stp-color'), '#040506', 'a colour still applies without storage')
  assert.deepEqual(
    refused.logs.filter(([, line]) => /error|fail/i.test(line)), [],
    'a refused storage is not a failure to report',
  )
  refused.dispose()
  console.log('✔ row colour: dirty or refused storage degrades to "no colour" and still works')
}

// --- 4d: a stored colour is honoured by the FIRST render, before any update.
{
  const sc = codexScaffold()
  await runBundle(sc, {
    pinned: [S1, S2],
    storageSeed: {
      'dsh-session-top:row-colors': JSON.stringify({ [S1]: '#123456', [S9]: '#abcdef' }),
    },
  })
  const rows = rowsOf(sc.body.querySelector('[data-stp-region]'))
  assert.equal(rows[0].getAttribute('data-stp-color'), '#123456', 'a stored colour must be on screen at mount')
  assert.equal(rows[0].style.getPropertyValue('--stp-row-color').trim(), '#123456')
  assert.equal(
    colorInputOf(rows[0]).value, '#123456',
    'the native input must open on the stored colour, not on its own default',
  )
  assert.match(swatchOf(rows[0]).getAttribute('aria-label'), /#123456/, 'and the control must name it')
  assert.match(
    swatchOf(rows[0]).getAttribute('aria-label'), /设置背景颜色/,
    'a plain click always picks, so the name must always say so',
  )
  assert.equal(rows[1].hasAttribute('data-stp-color'), false, 'a session with no colour has none')
  assert.equal(
    colorInputOf(rows[1]).value, '#ffffff',
    'and its input sits on the empty default',
  )
  assert.equal(swatchOf(rows[1]).getAttribute('aria-label').includes('#123456'), false)
  console.log('✔ row colour: a stored colour is painted by the first render')
}

// --- 4e: #000000 is a colour, not a sentinel.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const row = rowsOf(sc.body.querySelector('[data-stp-region]'))[0]
  const input = colorInputOf(row)
  input.value = '#000000'
  input.dispatch('change', { target: input })
  assert.equal(row.getAttribute('data-stp-color'), '#000000', 'black is a legal colour')
  assert.equal(row.hasAttribute('data-stp-color'), true, 'and it is not mistaken for "no colour"')
  assert.deepEqual(JSON.parse(run.storageCalls.writes.at(-1)[1]), { [S1]: '#000000' })
  run.dispose()
  console.log('✔ row colour: #000000 is kept as a colour, never as a clear sentinel')
}

// --- 4f: clearing is explicit, and both ways say how they work.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  const row = rowsOf(region)[0]
  const swatch = swatchOf(row)
  const input = colorInputOf(row)
  input.value = '#654321'
  input.dispatch('change', { target: input })
  assert.equal(row.getAttribute('data-stp-color'), '#654321')

  // Shift-click restores the default.
  swatch.dispatch('click', { shiftKey: true, target: swatch })
  assert.equal(row.hasAttribute('data-stp-color'), false, 'Shift-click clears')
  assert.deepEqual(JSON.parse(run.storageCalls.writes.at(-1)[1]), {}, 'and the stored map empties')
  assert.equal(
    input.value, '#ffffff',
    'and the native input goes back to its default, so reopening the picker is not stale',
  )

  // So does Delete from the keyboard, with the control focused.
  input.value = '#112233'
  input.dispatch('change', { target: input })
  assert.equal(input.value, '#112233')
  swatch.dispatch('keydown', { key: 'Delete', target: swatch })
  assert.equal(row.hasAttribute('data-stp-color'), false, 'Delete clears')
  assert.equal(input.value, '#ffffff', 'and resets the input')

  // The hints are on the control itself, in both states.
  input.value = '#445566'
  input.dispatch('change', { target: input })
  assert.match(swatch.getAttribute('title'), /Shift/, 'the tooltip must name Shift-click')
  assert.match(swatch.getAttribute('title'), /Delete/, 'and Delete')
  assert.match(swatch.getAttribute('aria-label'), /Shift/, 'and so must the accessible name')
  assert.match(swatch.getAttribute('aria-label'), /Delete/, 'both ways, not just one')
  assert.match(swatch.getAttribute('aria-label'), /设置背景颜色/, 'a plain click picks, so the name says pick')
  assert.match(swatch.getAttribute('aria-label'), /#445566/, 'which also says what is set')
  input.value = '#445566'
  input.dispatch('change', { target: input })
  assert.deepEqual(run.opened, [], 'clearing is not a navigation')
  assert.deepEqual(run.pinCalls, [], 'nor a pin change')
  run.dispose()
  console.log('✔ row colour: Shift-click and Delete both restore the default, and both are labelled')
}

// --- 4g: no colour gesture may navigate the session or re-pin it, and the row
//     itself must still work exactly as before.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const row = rowsOf(sc.body.querySelector('[data-stp-region]'))[0]
  const swatch = swatchOf(row)
  const input = colorInputOf(row)

  // Real bubbling, so a gesture that reached the row would open it.
  swatch.dispatch('click', { target: swatch }, { bubble: true })
  swatch.dispatch('keydown', { key: 'Enter', target: swatch }, { bubble: true })
  swatch.dispatch('keydown', { key: ' ', target: swatch }, { bubble: true })
  swatch.dispatch('click', { shiftKey: true, target: swatch }, { bubble: true })
  // And the native input, whose own click and keys would otherwise land on the row.
  input.dispatch('click', { target: input }, { bubble: true })
  input.dispatch('keydown', { key: 'ArrowRight', target: input }, { bubble: true })
  input.dispatch('input', { target: input }, { bubble: true })
  input.dispatch('change', { target: input }, { bubble: true })
  assert.deepEqual(run.opened, [], 'no colour gesture may open the session')
  assert.deepEqual(run.pinCalls, [], 'nor change the pin set')

  // A key that belongs to the control, delivered on the row, is the control's.
  row.dispatch('keydown', { key: 'Enter', target: swatch })
  assert.deepEqual(run.opened, [], 'the row must ignore a key aimed at its own control')
  // The row's own keys still work.
  row.dispatch('keydown', { key: 'Enter', target: row })
  assert.deepEqual(run.opened, [S1], 'Enter on the row still opens the session')
  row.dispatch('keydown', { key: ' ', target: row })
  assert.deepEqual(run.opened, [S1, S1], 'and Space still does')
  run.dispose()
  console.log('✔ row colour: colour gestures never navigate; the row itself still does')
}

// --- 4h: a colour is not lost by an ordinary update, and unpinning never
//     silently throws another session's colour away.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1, S2] })
  const region = sc.body.querySelector('[data-stp-region]')
  const rows = rowsOf(region)
  for (const [row, color] of [[rows[0], '#0a0b0c'], [rows[1], '#0d0e0f']]) {
    const input = colorInputOf(row)
    input.value = color
    input.dispatch('change', { target: input })
  }

  // A title and a timestamp change: the row is updated in place.
  run.live.byId[S1] = { id: S1, displayTitle: 'renamed', updatedAt: 9 }
  run.nudge()
  await settle()
  const after = rowsOf(region)
  assert.equal(after[0], rows[0], 'the row is updated, not rebuilt')
  assert.equal(after[0].getAttribute('data-stp-color'), '#0a0b0c', 'and its colour survives the update')
  assert.equal(listenersOf(after), listenersOf(rows), 'an update must not add a listener')
  assert.equal(after[0].querySelector('[data-stp-row-title]').textContent, 'renamed')

  // Unpin everything: the region goes, the stored colours do not.
  run.live.pinned = []
  run.nudge()
  await settle()
  assert.equal(sc.body.querySelector('[data-stp-region]'), null, 'no pins, no region')
  assert.deepEqual(
    JSON.parse(run.storageCalls.writes.at(-1)[1]),
    { [S1]: '#0a0b0c', [S2]: '#0d0e0f' },
    'unpinning must never clear a stored colour',
  )

  // Re-pin: both colours come back.
  run.live.pinned = [S1, S2]
  run.nudge()
  await settle()
  const back = rowsOf(sc.body.querySelector('[data-stp-region]'))
  assert.equal(back[0].getAttribute('data-stp-color'), '#0a0b0c', 'a re-pinned session keeps its colour')
  assert.equal(back[1].getAttribute('data-stp-color'), '#0d0e0f')
  run.dispose()
  console.log('✔ row colour: an update keeps the colour, and unpin/repin never loses it')
}

// --- 4i: the colours are legible: the background is a light mix, and hover,
//     focus and the active session stay legible OVER it.
{
  const sc = codexScaffold()
  await runBundle(sc, { pinned: [S1] })
  const css = staticCss(sc)
  const ruleFor = (selector) => {
    const match = css.match(new RegExp(`${selector.replace(/[[\]]/g, '\\$&')}[^{]*\\{[^}]*\\}`))
    return match === null ? null : match[0]
  }
  const base = ruleFor("[data-stp-row][data-stp-color]")
  assert.ok(base !== null, 'a coloured row needs its own background rule')
  assert.match(base, /color-mix\(/, 'mixed, not opaque: the host\'s own tokens stay readable through it')
  assert.match(base, /--stp-row-color/, 'mixed from the colour the user picked')
  for (const selector of [
    "[data-stp-row][data-stp-color]:hover",
    "[data-stp-row][data-stp-color]:focus-visible",
    "[data-stp-row][data-stp-color][aria-current='true']",
  ]) {
    const rule = ruleFor(selector)
    assert.ok(rule !== null, `${selector} must stay distinguishable over a colour`)
    assert.match(rule, /--stp-row-color/, `${selector} must keep the colour rather than paint over it`)
  }
  console.log('✔ row colour: hover, focus and current all stay legible over the chosen colour')
}

// --- 4j: right-click still belongs to the host — from the row AND from the
//     colour point, which is the one place a new control could have broken it.
{
  const sc = officialUiScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  openWorkspace(sc)
  const row = rowsOf(sc.body.querySelector('[data-stp-region]'))[0]
  const swatch = swatchOf(row)
  rightClickAt(run, swatch, 140, 96)
  await settle()
  assert.equal(
    sc.body.querySelector('[data-stp-menu]'), null,
    'the colour point must not fall back to the plugin\'s own one-item menu',
  )
  assert.equal(sc.liveRow().ellipsis.clicks, 1, "it must reach the host's own … control")
  const labels = sc.liveRow().hostMenu().children.map(item => item.textContent)
  for (const label of ['置顶', '重命名', '分叉会话', '归档会话', '复制 Session ID']) {
    assert.ok(labels.includes(label), `the host's own action must survive the colour point: ${label}`)
  }
  assert.equal(labels.filter(label => label === '置顶' || label === '取消置顶').length, 1, 'one Pin, not two')

  // And a row that now CARRIES a colour is still a session row for the menu.
  const other = officialUiScaffold()
  const second = await runBundle(other, { pinned: [S1] })
  openWorkspace(other)
  const colorRow = rowsOf(other.body.querySelector('[data-stp-region]'))[0]
  const input = colorInputOf(colorRow)
  input.value = '#778899'
  input.dispatch('change', { target: input })
  assert.equal(colorRow.getAttribute('data-stp-color'), '#778899', 'precondition: the row is coloured')
  rightClickAt(second, colorRow, 140, 96)
  await settle()
  assert.equal(other.body.querySelector('[data-stp-menu]'), null, 'still the host menu, not the plugin\'s')
  assert.equal(other.liveRow().ellipsis.clicks, 1, 'a coloured row is still a session row for the menu')
  const labels2 = other.liveRow().hostMenu().children.map(item => item.textContent)
  for (const label of ['重命名', '分叉会话', '归档会话', '复制 Session ID']) {
    assert.ok(labels2.includes(label), `the host's own action must survive a coloured row: ${label}`)
  }
  second.dispose()
  run.dispose()
  console.log('✔ row colour: the host\'s full session menu is untouched, from row and colour point')
}

// --- 4k: a timestamp that arrives AFTER the first render must not reorder the
//     row. The summaries land after the pin registry, so a session whose
//     summary has no `updatedAt` yet renders no time cell at all — and the cell
//     created when it finally arrives has to go where a first-render row would
//     have put it, in front of the trailing colour point, not after it.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  // A summary with NO timestamp: the first render draws no time cell.
  run.live.byId[S1] = { id: S1, displayTitle: 'one' }
  run.nudge()
  await settle()
  const region = sc.body.querySelector('[data-stp-region]')
  const row = rowsOf(region)[0]
  const swatch = swatchOf(row)
  assert.ok(swatch !== null)
  assert.equal(row.querySelector('[data-stp-row-time]'), null, 'precondition: no time cell yet')
  assert.equal(
    row.children[row.children.length - 1], swatch,
    'precondition: the colour point is the trailing child',
  )

  // The timestamp arrives late.
  run.live.byId[S1] = { id: S1, displayTitle: 'one', updatedAt: Date.now() - 3 * 86_400_000 }
  run.nudge()
  await settle()
  const cell = row.querySelector('[data-stp-row-time]')
  assert.ok(cell !== null, 'the late timestamp renders its cell')
  assert.equal(cell.textContent, '3天')
  assert.equal(
    row.children[row.children.length - 1], swatch,
    'the colour point must still be the trailing child, not the middle one',
  )
  const order = row.children.map(child =>
    child.getAttribute('data-stp-row-slot') !== null ? 'slot'
      : child.getAttribute('data-stp-row-title') !== null ? 'title'
        : child.getAttribute('data-stp-row-time') !== null ? 'time'
          : child.hasAttribute('data-stp-absolute-button') ? 'absolute'
            : child.getAttribute('data-stp-row-color') !== null ? 'color' : '?')
  assert.deepEqual(order, ['slot', 'title', 'time', 'absolute', 'color'], 'exactly what a first render produces')
  assert.equal(rowsOf(region)[0], row, 'and the row is updated in place')
  assert.equal(swatchOf(row), swatch, 'the colour control is not rebuilt either')
  assert.equal(listenersOf([row]), 2, 'and no listener was added')
  run.dispose()
  console.log('✔ row colour: a timestamp arriving late keeps the colour point at the row\'s end')
}

// --- 4l: TWO WINDOWS, ONE ORIGIN, BOTH LOADED FIRST.
//
// The conflict is not hypothetical and it is not a race inside one mount: it is
// the ordinary case of the same preference open twice. Window A mounts, window
// B mounts — both have now read an empty store into memory. A sets its colour.
// B, whose in-memory map is stale BY CONSTRUCTION, sets a different one.
//
// What must not happen is B writing out the map it loaded at mount. Storage is
// the shared truth, so the settled write has to read it again, merge only this
// session's id, and write that back.
{
  const KEY = 'dsh-session-top:row-colors'
  const scA = codexScaffold()
  const scB = codexScaffold()
  // One origin: the two mounts are two windows over ONE Storage.
  const origin = newStorageFixture()
  const a = await runBundle(scA, { pinned: [S1], storageFixture: origin, alongside: true })
  const b = await runBundle(scB, { pinned: [S1, S2], storageFixture: origin, alongside: true })
  const rowFor = (sc, id) => rowsOf(sc.body.querySelector('[data-stp-region]'))
    .find(row => row.getAttribute('data-stp-session') === id)

  assert.deepEqual(
    origin.calls.writes, [],
    'precondition: reading the preference at mount must not write one, in either window',
  )

  // Window A colours its own session.
  const aInput = colorInputOf(rowFor(scA, S1))
  aInput.value = '#0a0b0c'
  aInput.dispatch('change', { target: aInput })
  assert.deepEqual(
    JSON.parse(origin.calls.writes.at(-1)[1]), { [S1]: '#0a0b0c' },
    'precondition: window A wrote its own colour',
  )
  assert.deepEqual(
    [...new Set(origin.calls.writes.map(([key]) => key))], [KEY],
    'precondition: under this plugin\'s own key, and no other',
  )

  // Window B colours a DIFFERENT session. It has heard nothing.
  const bInput = colorInputOf(rowFor(scB, S2))
  bInput.value = '#0d0e0f'
  bInput.dispatch('change', { target: bInput })
  assert.deepEqual(
    JSON.parse(origin.calls.writes.at(-1)[1]),
    { [S1]: '#0a0b0c', [S2]: '#0d0e0f' },
    "window B's write must merge into what storage actually holds, not overwrite it with the map it loaded at mount",
  )

  // And clearing from B deletes B's own id and nothing else — the entry another
  // window owns survives a clear here.
  const bSwatch = swatchOf(rowFor(scB, S2))
  bSwatch.dispatch('click', { shiftKey: true, target: bSwatch })
  assert.deepEqual(
    JSON.parse(origin.calls.writes.at(-1)[1]),
    { [S1]: '#0a0b0c' },
    'clearing removes THIS session\'s colour and leaves every other id alone',
  )
  a.dispose()
  b.dispose()
  console.log('✔ row colour: two windows on one origin merge instead of overwriting each other')
}

// --- 4m: a picker DRAG previews, and only the gesture that ends it persists.
//     `input` fires per pixel of a native colour picker; writing storage on
//     every one of them is a synchronous disk write per pixel of a drag.
{
  const KEY = 'dsh-session-top:row-colors'
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const row = rowsOf(sc.body.querySelector('[data-stp-region]'))[0]
  const input = colorInputOf(row)
  const colorWrites = () => run.storageCalls.writes.filter(([key]) => key === KEY)

  input.value = '#123abc'
  input.dispatch('input', { target: input })
  assert.equal(row.getAttribute('data-stp-color'), '#123abc', 'a drag must be on screen as it happens')
  assert.equal(row.style.getPropertyValue('--stp-row-color').trim(), '#123abc')
  assert.equal(
    colorWrites().length, 0,
    'a drag must not write storage on every pixel of it — the value is not chosen yet',
  )

  input.value = '#123abd'
  input.dispatch('input', { target: input })
  assert.equal(colorWrites().length, 0, 'nor on the next pixel')
  assert.equal(row.getAttribute('data-stp-color'), '#123abd')

  input.dispatch('change', { target: input })
  assert.equal(colorWrites().length, 1, 'ending the picker persists exactly once')
  assert.deepEqual(JSON.parse(colorWrites()[0][1]), { [S1]: '#123abd' })
  assert.equal(row.getAttribute('data-stp-color'), '#123abd', 'and the row keeps it')
  assert.equal(
    listenersOf([row]), 2,
    'the drag must not add a listener — the same control handled both events',
  )
  run.dispose()
  console.log('✔ row colour: a picker drag previews, and only the finished choice persists')
}

// --- 4n: a write by ANOTHER window reaches this one, repaints in place, and is
//     never written back. This is the only way two windows agree without a
//     reload, so the delivery is not optional; and a listener that wrote on
//     receipt would start an echo that ends in a storage-event storm.
{
  const KEY = 'dsh-session-top:row-colors'
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1, S2] })
  const region = sc.body.querySelector('[data-stp-region]')
  const rows = rowsOf(region)
  const initial = rows.map(colorSurfaceOf)

  // Somebody else's key. Nothing about colours may move, and nothing may be
  // written: this plugin does not get to police other plugins' storage.
  dispatchWindowEvent(run, 'storage', { key: 'some-other-plugin:prefs', newValue: '{"a":1}' })
  assert.deepEqual(rows.map(colorSurfaceOf), initial, 'an unrelated key must not repaint a row')
  assert.equal(run.storageCalls.writes.length, 0, 'and must not be answered with a write')

  // Our key, a real change from another window.
  writeFromOtherWindow(run, KEY, JSON.stringify({ [S1]: '#010203', [S2]: '#040506' }))
  assert.equal(rows[0].getAttribute('data-stp-color'), '#010203', 'the row takes the foreign colour')
  assert.equal(rows[0].style.getPropertyValue('--stp-row-color').trim(), '#010203')
  assert.equal(
    colorInputOf(rows[0]).value, '#010203',
    'the native input follows, or reopening the picker on that row is stale',
  )
  assert.match(swatchOf(rows[0]).getAttribute('aria-label'), /#010203/, 'and the control names it')
  assert.equal(rows[1].getAttribute('data-stp-color'), '#040506')
  assert.deepEqual(
    rowsOf(region), rows,
    'repainted IN PLACE — a rebuilt row is a new node at the pointerup, which eats clicks',
  )
  assert.equal(listenersOf(rows), 4, 'and no listener was added or lost')
  assert.equal(
    run.storageCalls.writes.length, 0,
    'a foreign write is repainted, never written back — that would echo',
  )

  // The same value delivered again: an event that changes nothing repaints
  // nothing. Every write inside paintRowColor is guarded, and this is where
  // that claim is either true or not.
  const settled = rows.map(colorSurfaceOf)
  dispatchWindowEvent(run, 'storage', {
    key: KEY,
    newValue: JSON.stringify({ [S1]: '#010203', [S2]: '#040506' }),
  })
  assert.deepEqual(rows.map(colorSurfaceOf), settled, 'an unchanged foreign write must write no DOM')
  assert.equal(run.storageCalls.writes.length, 0)

  // Dispose takes the listener with it.
  run.dispose()
  assert.equal(
    run.windowListeners.get('storage')?.length ?? 0, 0,
    'dispose must remove the storage listener it added',
  )
  dispatchWindowEvent(run, 'storage', { key: KEY, newValue: JSON.stringify({ [S1]: '#999999' }) })
  assert.equal(
    rows[0].getAttribute('data-stp-color'), '#010203',
    'a disposed mount must not repaint from storage',
  )
  console.log('✔ row colour: a foreign window\'s write repaints in place, is never echoed, and dies with the mount')
}

// --- 4o: the picker is OPEN. A foreign write must not yank the colour out from
//     under the pointer, and the gesture that ends the drag must merge into the
//     storage that arrived WHILE it was open, not into the map from before it.
{
  const KEY = 'dsh-session-top:row-colors'
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1, S2] })
  const rows = rowsOf(sc.body.querySelector('[data-stp-region]'))
  const s2Input = colorInputOf(rows[1])

  // The picker opens on the second row and the user drags: preview, no storage.
  s2Input.value = '#0d0e0f'
  s2Input.dispatch('input', { target: s2Input })
  assert.equal(rows[1].getAttribute('data-stp-color'), '#0d0e0f', 'precondition: the drag is on screen')
  assert.equal(run.storageCalls.writes.length, 0, 'precondition: nothing is stored yet')

  // Meanwhile another window colours two OTHER sessions, one of which is not
  // even pinned here.
  writeFromOtherWindow(run, KEY, JSON.stringify({ [S1]: '#0a0b0c', [S9]: '#0f1011' }))
  assert.equal(rows[0].getAttribute('data-stp-color'), '#0a0b0c', 'the other row takes the foreign colour at once')
  assert.equal(
    rows[1].getAttribute('data-stp-color'), '#0d0e0f',
    'and the row being picked keeps the colour being picked — the drag is not over',
  )

  // The picker closes.
  s2Input.dispatch('change', { target: s2Input })
  assert.deepEqual(
    JSON.parse(run.storageCalls.writes.at(-1)[1]),
    { [S1]: '#0a0b0c', [S9]: '#0f1011', [S2]: '#0d0e0f' },
    'the committed colour merges into the storage that arrived during the drag, foreign ids and all',
  )
  assert.equal(rows[1].getAttribute('data-stp-color'), '#0d0e0f')
  assert.deepEqual(run.pinCalls, [], 'and none of this is a pin')
  assert.deepEqual(run.opened, [], 'nor a navigation')
  run.dispose()
  console.log('✔ row colour: a foreign write mid-drag repaints the others and spares the open picker')
}

// =====================================================================
// REQUIREMENT 5 — THE COLOUR DIALOG, and ONE colour map for every row.
//
// The control is no longer a hidden <input type="color"> and nothing else: it is
// a dialog a person can type into, drive from the keyboard, read, correct and
// cancel — and it is the SAME surface from the row's colour point, from the
// plugin's own fallback menu and from the official session-row menu, so a
// session's colour never depends on which entry point found it.
// =====================================================================

const COLOR_KEY = 'dsh-session-top:row-colors'
/** The decorative pin glyph the plugin's own menu item leads with. */
const PIN_GLYPH = '\u{1F4CC}'
/** The dialog this mount currently has open, or null. */
const dialogOf = (sc) => sc.body.querySelector('[data-stp-color-dialog]')
const hexOf = (dialog) => dialog.querySelector('[data-stp-color-hex]')
const buttonOf = (dialog, attr) => dialog.querySelector(`[${attr}]`)
const nativeOf = (dialog) => dialog.querySelector('[data-stp-color-native]')
const alertOf = (sc) => sc.body.querySelector('[data-stp-alert]')

// --- 5a: it opens as a real, named dialog on the visible page, prefilled.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, {
    pinned: [S1],
    storageSeed: { [COLOR_KEY]: JSON.stringify({ [S1]: '#123456' }) },
  })
  const region = sc.body.querySelector('[data-stp-region]')
  swatchOf(rowsOf(region)[0]).dispatch('click', { shiftKey: false })
  const dialog = dialogOf(sc)
  assert.ok(dialog !== null, 'clicking the colour point must open the plugin dialog')
  assert.equal(dialog.getAttribute('role'), 'dialog')
  assert.equal(dialog.getAttribute('aria-hidden'), null, 'a dialog under aria-hidden is a dialog nobody can use')
  assert.ok((dialog.getAttribute('aria-label') ?? '').length > 0, 'it must name itself')
  assert.equal(dialog.parentElement, sc.body, 'it is on the visible page, not in the off-screen menu anchor')
  assert.equal(hexOf(dialog).value, '#123456', 'it opens on the colour the row actually carries')
  run.dispose()
  console.log('✔ colour dialog: the colour point opens a named role=dialog, prefilled with the stored colour')
}

// --- 5b: 应用 commits, and ONLY 应用 and 恢复默认 commit.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  const row = rowsOf(region)[0]
  const swatch = swatchOf(row)

  swatch.dispatch('click', { shiftKey: false })
  let dialog = dialogOf(sc)
  hexOf(dialog).value = '#1a2b3c'
  buttonOf(dialog, 'data-stp-color-cancel').click()
  assert.equal(dialogOf(sc), null, '取消 closes the dialog')
  assert.deepEqual(run.storageCalls.writes, [], 'and stores NOTHING — a cancelled colour is not a colour')
  assert.equal(row.hasAttribute('data-stp-color'), false, 'nor does it paint one')

  // Typing alone changes nothing either; only the native helper follows it.
  swatch.dispatch('click', { shiftKey: false })
  dialog = dialogOf(sc)
  const hex = hexOf(dialog)
  hex.value = '#1a2b3c'
  hex.dispatch('input', { target: hex })
  assert.deepEqual(run.storageCalls.writes, [], 'typing into the box is not a commit')
  const native = nativeOf(dialog)
  native.value = '#0a0b0c'
  native.dispatch('input', { target: native })
  assert.equal(hex.value, '#0a0b0c', 'the native swatch drives the box')
  assert.deepEqual(run.storageCalls.writes, [], 'and still is not a commit')

  buttonOf(dialog, 'data-stp-color-apply').click()
  assert.equal(dialogOf(sc), null, '应用 closes the dialog')
  assert.deepEqual(
    [...new Set(run.storageCalls.writes.map(([key]) => key))],
    [COLOR_KEY],
    'and writes under this plugin\'s own key, and no other',
  )
  // What is committed is what the BOX holds — and the helper moved it, so the
  // value the user last saw is the value that is stored.
  assert.deepEqual(JSON.parse(run.storageCalls.writes.at(-1)[1]), { [S1]: '#0a0b0c' })
  assert.equal(row.getAttribute('data-stp-color'), '#0a0b0c', 'the row shows it at once')
  assert.deepEqual(run.pinCalls, [], 'a colour is not a pin')
  assert.deepEqual(run.opened, [], 'and not a navigation')

  // 恢复默认 deletes THIS id and leaves every other alone.
  run.live.pinned = [S1, S2]
  run.nudge()
  await settle()
  swatchOf(rowsOf(region)[0]).dispatch('click', { shiftKey: false })
  dialog = dialogOf(sc)
  buttonOf(dialog, 'data-stp-color-reset').click()
  assert.deepEqual(JSON.parse(run.storageCalls.writes.at(-1)[1]), {}, '恢复默认 clears exactly one id')
  assert.equal(rowsOf(region)[0].hasAttribute('data-stp-color'), false)
  run.dispose()
  console.log('✔ colour dialog: only 应用 and 恢复默认 commit; 取消 and typing store nothing')
}

// --- 5c: an invalid value is refused in place, and #000000 is a colour.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  const row = rowsOf(region)[0]
  swatchOf(row).dispatch('click', { shiftKey: false })
  for (const bad of ['red', '#12345', '#1234567', 'rgb(1,2,3)', '', '#abcdefg']) {
    const dialog = dialogOf(sc)
    hexOf(dialog).value = bad
    buttonOf(dialog, 'data-stp-color-apply').click()
    assert.equal(dialogOf(sc), dialog, `${JSON.stringify(bad)} must not close the dialog`)
    assert.equal(hexOf(dialog).getAttribute('aria-invalid'), 'true', `${JSON.stringify(bad)} must be reported invalid`)
    assert.deepEqual(run.storageCalls.writes, [], `${JSON.stringify(bad)} must not be written`)
    assert.equal(row.hasAttribute('data-stp-color'), false)
  }
  const dialog = dialogOf(sc)
  hexOf(dialog).value = '#000000'
  buttonOf(dialog, 'data-stp-color-apply').click()
  assert.deepEqual(JSON.parse(run.storageCalls.writes.at(-1)[1]), { [S1]: '#000000' }, '#000000 is a colour')
  assert.equal(row.getAttribute('data-stp-color'), '#000000')
  run.dispose()
  console.log('✔ colour dialog: invalid hex is refused in place, #000000 stays a colour')
}

// --- 5c-bis: the refusal is actually VISIBLE and actually SAYS something.
// aria-invalid alone is not feedback: the live dialog refused `oops`, set
// aria-invalid='true', stored nothing — and left the message div carrying
// `hidden`, so nothing was on screen and nothing was announced. Both halves of
// the pair are asserted here: the attribute AND the element that is readable.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  swatchOf(rowsOf(region)[0]).dispatch('click', { shiftKey: false })
  const dialog = dialogOf(sc)
  const error = buttonOf(dialog, 'data-stp-color-error')
  assert.equal(error.getAttribute('hidden'), '', 'an unused error line starts hidden')
  assert.equal(error.textContent, '', 'and starts empty')

  hexOf(dialog).value = 'oops'
  buttonOf(dialog, 'data-stp-color-apply').click()
  assert.equal(error.getAttribute('hidden'), null, 'a refusal MUST unhide the message, or the user sees nothing')
  assert.notEqual(error.textContent, '', 'and it must carry the actual text to read')
  assert.equal(error.getAttribute('role'), 'status', 'a live region, so it is announced too')
  assert.equal(hexOf(dialog).getAttribute('aria-invalid'), 'true')

  // A corrected value clears BOTH halves again.
  hexOf(dialog).value = '#1a2b3c'
  buttonOf(dialog, 'data-stp-color-apply').click()
  assert.deepEqual(JSON.parse(run.storageCalls.writes.at(-1)[1]), { [S1]: '#1a2b3c' })
  run.dispose()
  console.log('✔ colour dialog: a refused value SHOWS its message; a good one hides it again')
}

// --- 5d-bis: Enter on a BUTTON is that button, never a silent commit.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  const row = rowsOf(region)[0]
  const swatch = swatchOf(row)

  // Enter on 取消 must cancel. The inverted handler committed instead, which is
  // the worst version of this bug: the user asked to discard and it saved.
  // A real browser ALSO activates the focused button on Enter; this fake does
  // not, so the click stands in for that platform step. What is under test is
  // that the dialog's own keydown handler stayed out of the way.
  swatch.dispatch('click', { shiftKey: false })
  let dialog = dialogOf(sc)
  hexOf(dialog).value = '#1a2b3c'
  buttonOf(dialog, 'data-stp-color-cancel').dispatch('keydown', { key: 'Enter' }, { bubble: true })
  assert.deepEqual(run.storageCalls.writes, [], 'Enter on 取消 stores nothing, whatever the field holds')
  buttonOf(dialog, 'data-stp-color-cancel').click()
  assert.equal(dialogOf(sc), null, 'and 取消 still closes the dialog')

  // Enter on 恢复默认 must reset, not save the field's value.
  swatch.dispatch('click', { shiftKey: false })
  dialog = dialogOf(sc)
  hexOf(dialog).value = '#1a2b3c'
  buttonOf(dialog, 'data-stp-color-reset').dispatch('keydown', { key: 'Enter' }, { bubble: true })
  assert.deepEqual(run.storageCalls.writes, [], 'Enter on 恢复默认 does not commit the typed hex')
  buttonOf(dialog, 'data-stp-color-reset').click()
  assert.equal(row.hasAttribute('data-stp-color'), false, 'and the colour is actually cleared')

  // Enter on the FIELD is still apply — the shortcut this dialog promises.
  swatch.dispatch('click', { shiftKey: false })
  dialog = dialogOf(sc)
  hexOf(dialog).value = '#1a2b3c'
  dialog.dispatch('keydown', { key: 'Enter', target: hexOf(dialog) })
  assert.deepEqual(JSON.parse(run.storageCalls.writes.at(-1)[1]), { [S1]: '#1a2b3c' }, 'Enter from the field still applies')
  assert.equal(dialogOf(sc), null)

  // And an Enter with no target at all (the dialog itself) still applies.
  swatch.dispatch('click', { shiftKey: false })
  dialog = dialogOf(sc)
  hexOf(dialog).value = '#0a0b0c'
  dialog.dispatch('keydown', { key: 'Enter' })
  assert.deepEqual(JSON.parse(run.storageCalls.writes.at(-1)[1]), { [S1]: '#0a0b0c' }, 'a targetless Enter still applies')
  run.dispose()
  console.log('✔ colour dialog: Enter belongs to a focused button; only the field submits')
}

// --- 5d: Escape cancels, Enter applies, and focus always goes back.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  const swatch = swatchOf(rowsOf(region)[0])

  swatch.dispatch('click', { shiftKey: false })
  let dialog = dialogOf(sc)
  assert.equal(hexOf(dialog).focusCalls, 1, 'the field takes focus when the dialog opens')
  dialog.dispatch('keydown', { key: 'Escape' })
  assert.equal(dialogOf(sc), null, 'Escape closes the dialog')
  assert.deepEqual(run.storageCalls.writes, [], 'Escape stores nothing')
  assert.equal(swatch.focusCalls, 1, 'and focus goes back to the control that opened it')

  swatch.dispatch('click', { shiftKey: false })
  dialog = dialogOf(sc)
  hexOf(dialog).value = '#0d0e0f'
  dialog.dispatch('keydown', { key: 'Enter' })
  assert.equal(dialogOf(sc), null, 'Enter applies and closes')
  assert.deepEqual(JSON.parse(run.storageCalls.writes.at(-1)[1]), { [S1]: '#0d0e0f' })
  assert.equal(swatch.focusCalls, 2, 'and gives it back on the way out, whichever way it closed')
  run.dispose()
  console.log('✔ colour dialog: Escape cancels, Enter applies, focus is always handed back')
}

// --- 5e: dispose removes it, and a dialog from a dead mount cannot write.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1] })
  const region = sc.body.querySelector('[data-stp-region]')
  swatchOf(rowsOf(region)[0]).dispatch('click', { shiftKey: false })
  const dialog = dialogOf(sc)
  assert.ok(dialog !== null)
  run.dispose()
  assert.equal(dialogOf(sc), null, 'dispose must take the dialog off the page')
  const before = run.storageCalls.writes.length
  hexOf(dialog).value = '#0a0b0c'
  buttonOf(dialog, 'data-stp-color-apply').click()
  dialog.dispatch('keydown', { key: 'Enter' })
  assert.equal(run.storageCalls.writes.length, before, 'a dialog from a disposed mount writes nothing')
  console.log('✔ colour dialog: dispose removes it and a dead dialog can no longer write')
}

// --- 5f: a refused storage is reported, never silently swallowed.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [S1], storage: 'throw' })
  const region = sc.body.querySelector('[data-stp-region]')
  swatchOf(rowsOf(region)[0]).dispatch('click', { shiftKey: false })
  const dialog = dialogOf(sc)
  hexOf(dialog).value = '#1a2b3c'
  buttonOf(dialog, 'data-stp-color-apply').click()
  assert.equal(dialogOf(sc), null, 'the colour still applies to this session')
  const alert = alertOf(sc)
  assert.ok(alert !== null, 'but the user is told it will not be remembered')
  assert.equal(alert.getAttribute('data-stp-alert-reason'), 'unavailable')
  run.dispose()
  console.log('✔ colour dialog: a refused storage is surfaced, never a silent downgrade')
}

// --- 5g: the plugin's OWN fallback menu opens the SAME dialog, for an ordinary
//     UNPINNED session, and the colour shows on the host's own row.
{
  const sc = officialUiScaffold({ hostRowMenu: false })
  const run = await runBundle(sc, { pinned: [] })
  openWorkspace(sc)
  const row = sc.liveRow()
  assert.ok(row !== null, 'the host row is mounted')

  rightClickAt(run, row, 120, 200)
  await afterDispatch()
  const own = sc.body.querySelector('[data-stp-menu]')
  assert.ok(own !== null, 'with no host "…" control, the plugin serves its own menu')
  assert.deepEqual(
    [...own.querySelectorAll('[role="menuitem"]')].map(node => node.textContent),
    [`${PIN_GLYPH}置顶该会话`, '自定义行背景颜色…'],
    'the fallback menu carries the colour entry as well as the pin action',
  )
  own.querySelector('[data-stp-color-item]').click()
  await afterDispatch()
  const dialog = dialogOf(sc)
  assert.ok(dialog !== null, 'the menu entry opens the same dialog')
  assert.equal(dialog.getAttribute('data-stp-session'), S1, 'for the right session')
  hexOf(dialog).value = '#1a2b3c'
  buttonOf(dialog, 'data-stp-color-apply').click()
  assert.deepEqual(
    JSON.parse(run.storageCalls.writes.at(-1)[1]), { [S1]: '#1a2b3c' },
    'an UNPINNED session gets a stored colour of its own',
  )
  assert.deepEqual(run.pinCalls, [], 'and choosing one is not a pin')
  assert.equal(row.getAttribute('data-stp-color'), '#1a2b3c', 'the HOST row is tinted at once, from the same map')
  assert.equal(row.style.getPropertyValue('--stp-row-color').trim(), '#1a2b3c')

  // Pinning it keeps the colour, and the pinned row carries the same value.
  own.querySelector('[data-stp-pin-item]').click()
  // The pin round-trip is async (registry write → reconcile → region render), so
  // wait for the region to actually hold the row instead of guessing a duration.
  await waitUntil(
    () => (sc.body.querySelector('[data-stp-region]')?.querySelectorAll('[data-stp-row]').length ?? 0) === 1,
    'the pinned region to render exactly one row',
  )
  const pinned = rowsOf(sc.body.querySelector('[data-stp-region]'))
  assert.equal(pinned.length, 1, 'the session is now pinned')
  assert.equal(pinned[0].getAttribute('data-stp-color'), '#1a2b3c', 'pinning keeps the colour')
  run.dispose()
  console.log('✔ colour dialog: the fallback menu opens it for an ordinary session, and the host row shows the colour')
}

// --- 5h: another window's write repaints the host rows too, and dispose hands
//     every host-row mark back.
{
  const sc = officialUiScaffold({ hostRowMenu: false })
  const run = await runBundle(sc, { pinned: [] })
  openWorkspace(sc)
  const row = sc.liveRow()
  writeFromOtherWindow(run, COLOR_KEY, JSON.stringify({ [S1]: '#0a0b0c' }))
  assert.equal(row.getAttribute('data-stp-color'), '#0a0b0c', 'the host row takes the foreign colour at once')
  assert.equal(run.storageCalls.writes.length, 0, 'and the foreign write is never echoed')

  writeFromOtherWindow(run, COLOR_KEY, JSON.stringify({}))
  assert.equal(row.getAttribute('data-stp-color'), null, 'a cleared foreign colour is taken back off the row')
  assert.equal(row.style.getPropertyValue('--stp-row-color').trim(), '', 'and so is the property behind it')

  writeFromOtherWindow(run, COLOR_KEY, JSON.stringify({ [S1]: '#0a0b0c' }))
  assert.equal(row.getAttribute('data-stp-color'), '#0a0b0c')
  run.dispose()
  assert.equal(row.getAttribute('data-stp-color'), null, 'dispose takes the colour off the host row')
  assert.equal(row.style.getPropertyValue('--stp-row-color').trim(), '', 'attribute and property both')
  assert.equal(row.getAttribute('data-row-key'), `session:${S1}`, 'and nothing of the host is left changed')
  console.log('✔ host row colour: a foreign write repaints it, a clear takes it back, dispose returns it')
}

// =====================================================================
// REQUIREMENT 6 — THE OFFICIAL SESSION-ROW MENU ITEM.
//
// The stock sidebar has no `contextmenu` surface: every row owns a "…" button
// whose menu is built from the `sidebar.workspaces.session.menu.item` slot
// (rows/Rows.tsx:681-685), and the host registers its own Pin item there as
// `{name, id: 'pin', order: 100, locale, inject, component}`. So an entry added
// to that slot is the ONLY way an ordinary row can offer a colour — and it has
// to be a real registration: never a graft into a rendered menu, never a
// replacement of the host's own item, and never a private colour store.
// =====================================================================

const SLOT_ROW_MENU = 'sidebar.workspaces.session.menu.item'
const OFFICIAL_COLOR_ID = 'dsh-session-top.row-color'
const OFFICIAL_COLOR_LABEL = '自定义行背景颜色…'

/**
 * A slot registry with the host's own Pin entry already in it, as in real life.
 *
 * The host component is transcribed from the REAL source, not paraphrased
 * (ui-workspace `session-actions/PinSession.tsx:30-44`):
 *
 *   const [, setMenuOpen] = useMenuOpenState()   // a TUPLE, not a setter
 *   const { pinned, archived } = usePinState(props)
 *   if (archived) return null
 *   onSelect: setMenuOpen(false); (pinned ? unpinSession : pinSession)(sessionId)
 *
 * Three details the old fixture got wrong, each of which could let a plugin
 * pass against a component that behaves differently:
 *
 *   1. `useMenuOpenState` returns a TUPLE. The old fixture returned a bare
 *      function, so destructuring `[, setMenuOpen]` would have produced
 *      `undefined` and the "close the menu first" step would have been untested.
 *   2. EACH HOOK IS CALLED EXACTLY ONCE. The real component calls each in
 *      `usePinState` and reuses the value; the old fixture re-called
 *      `usePinned`/`useArchived` inside the label and inside onSelect, which
 *      let a plugin that swapped the hooks mid-render go unnoticed.
 *   3. THE CLOSE COMES FIRST, THEN THE ACTION, on the SAME values. That order
 *      is the whole reason both pin callbacks can be overridden: the component
 *      decides which to call BEFORE this plugin's dialog exists.
 */
function makeRowMenuSlots() {
  const entries = []
  const subs = new Set()
  const businessRpc = []
  const hookCalls = []
  const hostComponent = (props) => {
    const menuOpenState = props.useMenuOpenState()
    const setMenuOpen = menuOpenState[1]
    hookCalls.push(['useMenuOpenState'])
    const pinned = props.usePinned(p => p.has(props.sessionId))
    hookCalls.push(['usePinned'])
    const archived = props.useArchived(a => a.has(props.sessionId))
    hookCalls.push(['useArchived'])
    if (archived) return null
    return {
      label: props.t(pinned ? 'menu.unpinSession' : 'menu.pinSession'),
      onSelect: () => {
        setMenuOpen(false)
        ;(pinned ? props.unpinSession : props.pinSession)(props.sessionId)
      },
    }
  }
  const state = { pinned: new Set(), archived: new Set(), open: false }
  const inject = (sessionId) => ({
    sessionId,
    useMenuOpenState: () => [state.open, (next) => { state.open = next }],
    usePinned: selector => selector(state.pinned),
    useArchived: selector => selector(state.archived),
    pinSession: async (id) => { businessRpc.push(['pin', id]) },
    unpinSession: async (id) => { businessRpc.push(['unpin', id]) },
    t: key => `host:${key}`,
  })
  const host = {
    options: { name: SLOT_ROW_MENU, id: 'pin', order: 100, locale: 'dsh-ui-sidebar' },
    component: hostComponent,
    inject,
    registrant: 'ui-sidebar',
  }
  entries.push(host)
  return {
    businessRpc,
    hookCalls,
    state,
    entries,
    registry: {
      entries: name => (name === SLOT_ROW_MENU ? [...entries] : []),
      subscribe: (name, cb) => { subs.add(cb); return () => subs.delete(cb) },
      register: (options, component) => {
        const cell = options.key ?? options.id
        if (entries.some(e => (e.options.key ?? e.options.id) === cell)) {
          throw new Error(`list slot "${options.name}" already has an entry with id "${cell}"`)
        }
        const entry = { options, component, inject: options.inject, registrant: options.registrant }
        entries.push(entry)
        for (const cb of [...subs]) cb()
        return () => {
          const at = entries.indexOf(entry)
          if (at >= 0) entries.splice(at, 1)
          for (const cb of [...subs]) cb()
        }
      },
      listenersFor: () => subs.size,
      /** The live subscribers, so a case can fire a real host-side notification. */
      listeners: () => [...subs],
    },
  }
}

{
  const sc = officialUiScaffold({ hostRowMenu: false })
  const slots = makeRowMenuSlots()
  const run = await runBundle(sc, { pinned: [], slots: slots.registry })

  assert.deepEqual(
    slots.entries.map(e => e.options.id),
    ['pin', OFFICIAL_COLOR_ID],
    'a NEW namespaced id, added beside the host entry — never a shadow of it',
  )
  const ours = slots.entries.find(e => e.options.id === OFFICIAL_COLOR_ID)
  assert.equal(ours.options.order, 500, 'and it reads after EVERY one of the host\'s own items (pin 100, rename 200, fork 300, archive 400), so it never wins a tie')
  assert.equal(ours.options.locale, 'dsh-ui-sidebar', 'the host\'s locale namespace is kept, so its other keys still translate')
  assert.equal(slots.entries[0].options.order, 100, 'the host\'s own Pin entry is untouched')
  assert.equal(slots.entries[0].registrant, 'ui-sidebar')

  // Render it the way the host would, and drive it.
  const props = ours.inject(S1, 'one')
  assert.deepEqual(slots.businessRpc, [], 'injection must not touch a pin RPC')
  const rendered = ours.component(props)
  assert.equal(rendered.label, OFFICIAL_COLOR_LABEL, 'the host\'s own component, with OUR label for its two keys')
  assert.equal(props.t('menu.pinSession'), 'host:menu.pinSession', 'every other key still reaches the host\'s translator')
  // Fixed hook order, one call each — the contract the real component relies on
  // to decide which action to call before this plugin's dialog exists.
  assert.deepEqual(
    slots.hookCalls, [['useMenuOpenState'], ['usePinned'], ['useArchived']],
    'the host component calls each hook exactly once, in the real order',
  )
  slots.state.open = true
  rendered.onSelect()
  assert.equal(slots.state.open, false, 'the host\'s own menu is closed first, by the host\'s own call')
  await afterDispatch()
  const dialog = dialogOf(sc)
  assert.ok(dialog !== null, 'the item opens the plugin dialog')
  assert.equal(dialog.getAttribute('data-stp-session'), S1, 'for the clicked session')
  assert.deepEqual(slots.businessRpc, [], 'and the business RPCs are unreachable from this item')
  assert.deepEqual(run.pinCalls, [], 'including the workspace controller\'s own')

  hexOf(dialog).value = '#1a2b3c'
  buttonOf(dialog, 'data-stp-color-apply').click()
  assert.deepEqual(
    JSON.parse(run.storageCalls.writes.at(-1)[1]), { [S1]: '#1a2b3c' },
    'the same dialog, the same map, the same key',
  )

  // An UNPINNED row still reaches the dialog and still never reaches a pin RPC:
  // both callbacks are overridden, so the branch the host takes cannot change
  // what the item does.
  slots.state.pinned = new Set([S1])
  const pinnedProps = ours.inject(S1, 'one')
  const pinnedRendered = ours.component(pinnedProps)
  assert.equal(pinnedRendered.label, OFFICIAL_COLOR_LABEL, 'a pinned row offers the colour item under the same label')
  pinnedRendered.onSelect()
  await afterDispatch()
  assert.deepEqual(slots.businessRpc, [], 'the unpin branch is overridden too, so no RPC fires either')
  assert.ok(dialogOf(sc) !== null, 'the pinned branch opened its own dialog')
  slots.state.pinned = new Set()

  // A session the host calls archived offers nothing, exactly as its own
  // component does — that is the host's contract, not ours.
  const archivedProps = ours.inject(S1, 'one')
  archivedProps.useArchived = () => true
  assert.equal(ours.component(archivedProps), null, 'an archived session offers nothing, as the host does')
  assert.equal(
    ours.component({ ...props, t: undefined, usePinned: () => true }).label, OFFICIAL_COLOR_LABEL,
    'and the label override does not depend on a translator being present',
  )

  run.dispose()
  assert.deepEqual(slots.entries.map(e => e.options.id), ['pin'], 'dispose takes the item back out')
  assert.equal(slots.entries[0].options.order, 100, 'and leaves the host\'s entry exactly as it was')
  assert.equal(slots.registry.listenersFor(), 0, 'and releases the slot watch')
  console.log('✔ official row menu: a namespaced colour item beside the host\'s own Pin entry, and nothing else touched')
}

// --- the host's OWN Pin entry registers LATE, then goes away again.
//
// The previous case only proved the plugin did not throw against an EMPTY slot.
// Apply order is not knowable — the plugin can mount before the host's own
// registrations land — so what has to hold is the watch: the entry appears, the
// colour item follows it, the entry is withdrawn, and the colour item leaves
// with it instead of being stranded in a slot nobody renders.
{
  const sc = officialUiScaffold({ hostRowMenu: false })
  const slots = makeRowMenuSlots()
  // Start from a slot the host has not filled yet, then let it arrive.
  const hostEntry = slots.entries.splice(0, 1)[0]
  const run = await runBundle(sc, { pinned: [], slots: slots.registry })
  assert.deepEqual(slots.entries.map(e => e.options.id), [], 'the host has registered nothing yet, so nothing is added')

  // The host registers its own Pin entry AFTER the plugin mounted.
  slots.entries.push(hostEntry)
  for (const cb of [...slots.registry.listeners()]) cb()
  assert.deepEqual(
    slots.entries.map(e => e.options.id), ['pin', OFFICIAL_COLOR_ID],
    'a host entry that arrives late is still picked up',
  )
  const late = slots.entries.find(e => e.options.id === OFFICIAL_COLOR_ID)
  const lateProps = late.inject(S1, 'one')
  const lateRendered = late.component(lateProps)
  assert.equal(lateRendered.label, OFFICIAL_COLOR_LABEL)
  lateRendered.onSelect()
  await afterDispatch()
  assert.ok(dialogOf(sc) !== null, 'the late-registered item works like any other')
  buttonOf(dialogOf(sc), 'data-stp-color-cancel').click()

  // And when the host withdraws its own entry, the colour entry goes too.
  slots.entries.splice(slots.entries.indexOf(hostEntry), 1)
  for (const cb of [...slots.registry.listeners()]) cb()
  assert.deepEqual(
    slots.entries.map(e => e.options.id), [],
    'the colour entry does not outlive the host entry it is derived from',
  )
  run.dispose()
  console.log('✔ official row menu: a host entry arriving late is picked up, and withdrawn with it')
}

// --- a host that registers its Pin entry LATE still gets the item.
{
  const sc = officialUiScaffold({ hostRowMenu: false })
  const slots = makeRowMenuSlots()
  const late = { ...slots.registry }
  late.entries = () => []
  late.register = () => { throw new Error('nothing registers while the slot is empty') }
  const run = await runBundle(sc, { pinned: [], slots: late })
  assert.deepEqual(late.entries().length, 0, 'nothing to register into, and no error thrown')
  run.dispose()
  console.log('✔ official row menu: a host whose Pin entry has not registered yet is simply left alone')
}

// --- and a host with no slot registry at all is inert.
{
  const sc = officialUiScaffold({ hostRowMenu: false })
  const run = await runBundle(sc, { pinned: [] })
  assert.doesNotThrow(() => run.dispose(), 'a missing slot registry must not throw out of mount or dispose')
  console.log('✔ official row menu: a host without the slot surface stays exactly as it was')
}

// =====================================================================
// REQUIREMENT 7 — THE FOOTER.
//
// Four surfaces, four markers, every one proven from an aria-label or from a
// common ancestor, and every one handed back on dispose. (The rules behind the
// markers are asserted at the end of this file, where the stylesheet helpers
// live.)
// =====================================================================

for (const flavor of ['official', 'codex']) {
  const sc = officialUiScaffold({ footer: true })
  if (flavor === 'codex') {
    sc.head.removeAttribute('data-row-key')
    sc.row.removeAttribute('data-row-key')
    sc.row.setAttribute('data-dcu-session', S1)
    sc.tree.className = 'dcu-wb-tree'
  }
  const run = await runBundle(sc, { pinned: [] })
  const f = sc.footerParts
  assert.equal(f.actions.getAttribute('data-stp-footer'), '', 'the common host of the balance region and the import control')
  assert.equal(f.balance.getAttribute('data-stp-footer-balance'), '')
  assert.equal(f.importer.getAttribute('data-stp-footer-import'), '')
  assert.equal(f.pinnedEntry.getAttribute('data-stp-footer-pin'), '')
  assert.equal(f.account.getAttribute('data-stp-account'), '')
  // The mark is on the CONTROL, never on a wrapper that merely contains it.
  // `getAttribute` is the DOM-truthful read: `hasAttribute` returns a boolean,
  // so asserting it equals null was a harness mistake, not a stronger claim.
  assert.equal(f.balanceWrap.getAttribute('data-stp-footer-balance'), null)
  assert.equal(f.importWrap.getAttribute('data-stp-footer-import'), null)

  // Idle passes must write nothing at all: the marks are compared, not re-set.
  let writes = 0
  for (const node of [f.actions, f.balance, f.importer, f.pinnedEntry, f.account]) {
    const real = node.setAttribute.bind(node)
    node.setAttribute = (name, value) => {
      if (String(name).startsWith('data-stp')) writes += 1
      return real(name, value)
    }
  }
  for (let i = 0; i < 5; i += 1) { run.nudge(); await settle() }
  assert.equal(writes, 0, `five idle reconciles must not re-mark anything; got ${writes} writes`)

  run.dispose()
  for (const node of [f.actions, f.balance, f.importer, f.pinnedEntry, f.account]) {
    for (const attr of ['data-stp-footer', 'data-stp-footer-balance', 'data-stp-footer-import', 'data-stp-footer-pin', 'data-stp-account']) {
      assert.equal(node.getAttribute(attr), null, `dispose must give ${attr} back`)
    }
  }
  assert.equal(f.balance.getAttribute('aria-label'), '简化侧栏显示', 'and leave the host element as it was found')
  console.log('✔ footer: four proven marks, five idle passes write nothing, dispose returns every one')
}

// --- the pin plugin's footer button does not require balance or import plugins.
for (const flavor of ['official', 'codex']) {
  for (const missing of ['balance', 'balance-and-import']) {
    const sc = officialUiScaffold({ footer: true })
    if (flavor === 'codex') {
      sc.head.removeAttribute('data-row-key')
      sc.row.removeAttribute('data-row-key')
      sc.row.setAttribute('data-dcu-session', S1)
      sc.tree.className = 'dcu-wb-tree'
    }
    const f = sc.footerParts
    f.balanceWrap.remove()
    if (missing === 'balance-and-import') f.importWrap.remove()
    const outside = new El('button')
    outside.className = '__dsh-session-pin-footer__'
    sc.body.appendChild(outside)
    const run = await runBundle(sc, { pinned: [S1] })
    assert.equal(f.pinnedEntry.getAttribute('data-stp-footer-pin'), '', 'the dedicated pin button is marked without unrelated footer plugins')
    assert.equal(f.actions.getAttribute('data-stp-footer'), null, 'no balance/import pair means no compaction host')
    assert.equal(f.importer.getAttribute('data-stp-footer-import'), null, 'an unproven import control stays untouched')
    assert.equal(outside.getAttribute('data-stp-footer-pin'), null, 'the body-level lookalike stays outside the proven sidebar')
    assert.ok(sc.body.querySelector('[data-stp-region]') !== null, 'the top pinned list stays mounted')
    run.dispose()
    assert.equal(f.pinnedEntry.getAttribute('data-stp-footer-pin'), null, 'dispose restores the native button')
  }
}
console.log('✔ footer: the native pin button is hidden without balance/import plugins; top pins and outside buttons remain')

// --- the footer lookup never crosses the owning sidebar into a shared layout.
for (const flavor of ['official', 'codex']) {
  const sc = officialUiScaffold({ footer: false })
  if (flavor === 'codex') {
    const root = new El('aside')
    root.className = 'dcu-root'
    sc.body.insertBefore(root, sc.root)
    for (const child of [...sc.root.children]) root.appendChild(child)
    sc.root.remove()
    sc.root = root
    sc.head.removeAttribute('data-row-key')
    sc.row.removeAttribute('data-row-key')
    sc.row.setAttribute('data-dcu-session', S1)
    sc.tree.className = 'dcu-wb-tree'
  }
  const layout = new El('div')
  layout.className = 'app-root'
  sc.body.appendChild(layout)
  layout.appendChild(sc.root)
  const main = new El('main')
  layout.appendChild(main)
  const outside = new El('button')
  outside.className = '__dsh-session-pin-footer__'
  main.appendChild(outside)
  const run = await runBundle(sc, { pinned: [S1] })
  assert.equal(outside.getAttribute('data-stp-footer-pin'), null, 'a main-area pin button is outside the owning sidebar')
  assert.ok(sc.body.querySelector('[data-stp-region]') !== null, 'top pins stay mounted when the sidebar has no footer')
  run.dispose()
}

// --- the shipped Codex root works in expanded mode and leaves its rail alone.
for (const compact of [false, true]) {
  const sc = officialUiScaffold({ footer: true })
  const root = new El('aside')
  root.className = compact ? 'dcu-root dcu-compact' : 'dcu-root'
  const frame = new El('div')
  if (compact) frame.setAttribute('data-sidebar-collapsed', 'true')
  sc.body.appendChild(frame)
  frame.appendChild(root)
  for (const child of [...sc.root.children]) root.appendChild(child)
  sc.root.remove()
  sc.root = root
  sc.head.removeAttribute('data-row-key')
  sc.row.removeAttribute('data-row-key')
  sc.row.setAttribute('data-dcu-session', S1)
  sc.tree.className = 'dcu-wb-tree'
  const run = await runBundle(sc, { pinned: [S1] })
  assert.equal(sc.footerParts.pinnedEntry.getAttribute('data-stp-footer-pin'), compact ? null : '', 'only an expanded Codex footer is marked')
  run.dispose()
  assert.equal(sc.footerParts.pinnedEntry.getAttribute('data-stp-footer-pin'), null, 'dispose gives the Codex footer back')
}
console.log('✔ footer: shared layouts cannot leak main-area pins; actual Codex root and compact rail are covered')

// --- a host whose footer is NOT there gets nothing at all.
{
  const sc = officialUiScaffold({ footer: false })
  const run = await runBundle(sc, { pinned: [] })
  assert.equal(sc.body.querySelector('[data-stp-footer]'), null, 'a sidebar with no footer surfaces is never marked')
  run.dispose()

  const rail = officialUiScaffold({ rail: true, footer: true })
  const railRun = await runBundle(rail, { pinned: [] })
  assert.equal(rail.body.querySelector('[data-stp-footer]'), null, 'the collapsed rail is left to the host')
  assert.equal(rail.footerParts.pinnedEntry.getAttribute('data-stp-footer-pin'), null, 'the rail pin button stays untouched')
  railRun.dispose()
  console.log('✔ footer: no footer, no marks; the narrow rail is never touched')
}

// --- an UNPROVEN sidebar is left alone, exactly like every other surface here.
{
  const sc = makeTree()
  sc.tree.setAttribute('role', 'tree')
  sc.tree.setAttribute('aria-label', 'file explorer')
  const footer = attachSidebarFooter(sc.listArea)
  const run = await runBundle(sc, { pinned: [] })
  assert.equal(footer.pinnedEntry.getAttribute('data-stp-footer-pin'), null, 'an unknown sidebar keeps its pin button')
  assert.equal(sc.body.querySelector('[data-stp-account]'), null, 'an unknown sidebar is observe-only')
  run.dispose()
  console.log('✔ footer: an unproven sidebar is left entirely alone')
}

// --- typography. The user-facing bug is a font-size one and it is invisible to
// every other test in this file, because every one of them asserts DOM shape and
// never computed style. These cases read the stylesheet the plugin actually
// injects, because that is where the bug lives.

// A property/value grammar narrow enough to make an invalid declaration FAIL
// rather than pass by containment. This is the point of the section: a test that
// only grepped for "13px" would have been green against the broken shorthand.
const TYPOGRAPHY_ANCHOR = '[data-stp-typography]'

const TYPO_VALUE_OK = {  'font-family': v => /^(inherit|var\(--stp-token-font,\s*inherit\)|[A-Za-z-]+(,\s*[A-Za-z-]+)*)$/.test(v),
  'font-size': v => /^(inherit|\d+(\.\d+)?px)$/.test(v),
  'font-weight': v => /^(inherit|[1-9]00)$/.test(v),
  'line-height': v => /^(inherit|\d+(\.\d+)?(px)?)$/.test(v),
}

/** The sheet with its comments removed, so a comment is never read as a rule. */
const withoutComments = css => css.replace(/\/\*[\s\S]*?\*\//g, ' ')

/**
 * Every `selector { … }` rule in the sheet, split on the braces.
 *
 * A stylesheet has no nesting here, so the naive split is exact — and it is
 * what stops a lookup from matching a SELECTOR STRING INSIDE ANOTHER SELECTOR
 * (`[data-stp-row]` is a substring of `[data-stp-region] > [data-stp-row]`).
 * Comments are stripped first: they sit between rules, and a brace split would
 * otherwise glue each one onto the head of the rule that follows it.
 * @param {string} css - the stylesheet text.
 * @returns {{selector: string, body: string}[]} the rules, in order.
 */
function rulesOf(css) {
  return (withoutComments(css).match(/[^{}]+\{[^{}]*\}/g) ?? []).map(rule => ({
    selector: rule.slice(0, rule.indexOf('{')).trim().replace(/\s+/g, ' '),
    body: rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}')),
  }))
}

/**
 * The declarations of the FIRST rule whose selector is exactly `selector`.
 *
 * A trailing `!important` is stripped from the value and reported separately by
 * `importantOf`, because the footer rules carry it deliberately — the host wins
 * the cascade there with an inline height and a `button[class]` rule, and a
 * plain declaration provably loses. Reading `28px !important` as the value of
 * `height` would make every value assertion in this file compare against a
 * string the browser never uses.
 * @param {string} css - the stylesheet text.
 * @param {string} selector - the exact selector, whitespace-normalised.
 * @returns {Record<string, string>} property to value, without the flag.
 */
function declsOf(css, selector) {
  const rule = rulesOf(css).find(r => r.selector === selector)
  assert.ok(rule !== undefined, `the stylesheet must carry a rule for ${selector}`)
  const out = {}
  for (const line of rule.body.split(';')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const prop = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (value.endsWith('!important')) value = value.slice(0, -'!important'.length).trim()
    if (prop !== '') out[prop] = value
  }
  return out
}

/**
 * The properties this plugin declares `!important` in one rule.
 *
 * Asserted on purpose and in one place: an `!important` is the only way to beat
 * the host's inline height on the import control and its `button[class]` rule
 * on the pinned entry, so it is required there — but it is also the sharpest
 * tool in the sheet, and it must stay confined to the handful of layout
 * declarations on markers this plugin proved itself.
 * @param {string} css - the stylesheet text.
 * @param {string} selector - the exact selector, whitespace-normalised.
 * @returns {string[]} the property names carrying the flag.
 */
function importantOf(css, selector) {
  const rule = rulesOf(css).find(r => r.selector === selector)
  if (rule === undefined) return []
  return rule.body.split(';')
    .filter(line => line.includes('!important'))
    .map(line => line.slice(0, line.indexOf(':')).trim())
    .filter(Boolean)
}

{
  const sc = officialUiScaffold()
  await runBundle(sc, { pinned: [S1] })
  const css = withoutComments(staticCss(sc))

  // (1) NO `font` SHORTHAND ANYWHERE. The shorthand is what broke: with
  // `--stp-token-font` empty, `font: 400 13px/20px var(--stp-token-font,
  // inherit)` substitutes `inherit` into the family slot, and a global keyword
  // in a shorthand makes the WHOLE declaration invalid, so every property in it
  // silently reverted to the host's inherited 14px.
  const shorthands = [...css.matchAll(/(^|[;{\s])font\s*:/g)].map(m => m[0])
  assert.equal(
    shorthands.length, 0,
    `no rule may use the font shorthand — it is dropped, not merely ignored; found ${JSON.stringify(shorthands)}`,
  )

  // (2) The same failure does not hide in any OTHER shorthand that takes the
  // token. `font-weight: var(...)` would be fine; only font-family may read it.
  const familyReaders = [...css.matchAll(/font-family\s*:\s*([^;]+)/g)].map(m => m[1].trim())
  assert.ok(familyReaders.length > 0, 'font-family must still read the host token')
  for (const value of familyReaders) {
    assert.match(value, /^var\(--stp-token-font,\s*inherit\)$/, `unexpected font-family value: ${value}`)
  }

  // (3) THE PINNED REGION IS THE LARGER SURFACE, and both surfaces are compact:
  // the user asked for a tighter sidebar that shows more rows, so the pinned row
  // drops 16px → 14px (20px line box) with a 26px row, and the workspace title
  // below drops 13px → 12px (16px line box). These are exact assertions on
  // purpose: "smaller" is not a number a stylesheet can be wrong about.
  const header = declsOf(css, '[data-stp-region-header]')
  assert.equal(header['font-size'], '12px')
  assert.equal(header['line-height'], '16px')
  assert.equal(header['font-weight'], '600')
  const row = declsOf(css, '[data-stp-row]')
  assert.equal(row['font-size'], '14px', 'a pinned row must read larger than a workspace row')
  assert.equal(row['line-height'], '20px')
  assert.equal(row['font-weight'], '500')
  assert.equal(row['min-height'], '26px', 'the compact row target, with a hit area far above 24px')
  const time = declsOf(css, '[data-stp-row-time]')
  assert.equal(time['font-size'], '11px')
  assert.equal(time['line-height'], '14px')

  // The colour point keeps a 24px hit area around a 14px visual, so compacting
  // the row never made the colour control smaller to click.
  const swatch = declsOf(css, '[data-stp-row-color]')
  assert.equal(swatch['width'], '14px')
  assert.equal(swatch['height'], '14px')
  assert.equal(swatch['padding'], '5px', 'the 5px ring is what makes the control 24px')
  assert.equal(swatch['box-sizing'], 'content-box', 'the padding must sit outside the 14px visual')
  const swatchVisual = declsOf(css, '[data-stp-row-color]::after')
  assert.equal(swatchVisual['width'], '14px', 'the visible swatch is drawn by the pseudo-element')

  // (4) The WORKSPACE BELOW recedes to a still-readable 12px, which is below
  // the host's own independent 14px title — so the override has to be a real
  // declaration on the title, not merely the absence of one.
  const hostRules = rulesOf(css).filter(r => r.selector.includes(TYPOGRAPHY_ANCHOR))
  assert.ok(hostRules.length > 0, 'the host rows must have their own typography rules')
  const titleRule = hostRules.find(rule => rule.selector.includes("_title"))
  assert.ok(titleRule !== undefined, `a scoped title rule is required; got ${JSON.stringify(hostRules.map(r => r.selector))}`)
  const titleDecls = declsOf(css, titleRule.selector)
  assert.equal(titleDecls['font-size'], '12px')
  assert.equal(titleDecls['line-height'], '16px')
  // Every host rule hangs off the marker, so none of them can match a tree the
  // plugin has not proved. This is the selector half of the scope guarantee.
  for (const rule of hostRules) {
    assert.ok(
      rule.selector.startsWith(TYPOGRAPHY_ANCHOR),
      `host typography rule escapes the marker: ${rule.selector}`,
    )
  }

  // (4b) THE SAME SCOPE, for the host's own ROW RHYTHM: the row box is compacted
  // but nothing is hidden, and the 24px minimum hit area survives it.
  const rhythm = hostRules.find(rule => rule.selector.includes("data-row-key^='session:'")
    && declsOf(css, rule.selector)['min-height'] !== undefined)
  assert.ok(rhythm !== undefined, 'a scoped row-rhythm rule is required')
  assert.equal(declsOf(css, rhythm.selector)['min-height'], '24px', 'a host row never drops below a 24px target')
  const rowRhythmRules = hostRules.filter(rule => rule.selector.includes('[data-stp-color]'))
  assert.ok(rowRhythmRules.length >= 2, 'a colour chosen for an ordinary host row must be painted from the same map')
  for (const rule of rowRhythmRules) {
    assert.ok(rule.selector.includes("data-row-key^='session:'") || rule.selector.includes('data-dcu-session'),
      `the host colour rule must be keyed on the host's own row vocabulary: ${rule.selector}`)
  }

  // (4c) THE HOST ROW HEIGHT IS STATED, NOT ONLY MINIMIZED. The host declares
  // a fixed height on both of its row kinds (`.projectRow` 34px, `.sessionRow`
  // 32px in rows/Rows.module.css), and a declared height beats a minimum: on the
  // live page the padding landed and the directory row stayed at 34px. A rule
  // with only `min-height` is exactly the shape that failed.
  const heightRule = hostRules.find(rule => {
    const d = declsOf(css, rule.selector)
    return rule.selector.includes("data-row-key^='workspace:'") && d['height'] !== undefined
  })
  assert.ok(heightRule !== undefined, `a scoped explicit height is required; got ${JSON.stringify(hostRules.map(r => r.selector))}`)
  const heightDecls = declsOf(css, heightRule.selector)
  assert.equal(heightDecls['height'], '26px', 'the directory row must come down from the host\'s 34px')
  assert.equal(heightDecls['box-sizing'], 'border-box', 'otherwise the padding adds to the height instead of sitting inside it')
  for (const rule of hostRules) {
    if (rule.selector.includes("data-row-key^='session:'") && declsOf(css, rule.selector)['height'] !== undefined) {
      assert.equal(declsOf(css, rule.selector)['height'], '26px', 'the session row shares the same compact height')
    }
  }

  // (4d) THE FOOTER COMPACTION IS DECLARED, AND SCOPED TO ITS MARKERS. Every
  // value here is the one the live page needed: the host declares 42px on the
  // import control and 28px on the pinned entry, and a bare `min-height` cannot
  // reduce either. The retained controls stay at or above 24px.
  const FOOTER_TARGETS = [
    ['[data-stp-footer-import]', '28px'],
    ['[data-stp-account]', '32px'],
  ]
  for (const [selector, want] of FOOTER_TARGETS) {
    const decls = declsOf(css, selector)
    assert.equal(decls['height'], want, `${selector} must state the height the host's own declaration beats`)
    assert.ok(parseInt(want, 10) >= 24, `${selector} must stay a real click target`)
  }
  const summary = declsOf(css, "[data-stp-footer-balance] [class*='cm-simple-summary']")
  assert.equal(summary['height'], '20px')
  const foot = declsOf(css, "[data-stp-footer-balance] [class*='cm-foot']")
  assert.equal(foot['height'], '24px', 'the clickable balance cell keeps a full click target')
  const peak = declsOf(css, "[data-stp-footer-balance] [class*='cm-peak-strip']")
  assert.equal(peak['height'], '18px')
  // Scoped, or the footer rules would restyle any same-named cell on the page.
  for (const rule of rulesOf(css)) {
    if (!rule.selector.includes('[data-stp-footer') && !rule.selector.includes('[data-stp-account]')) continue
    assert.ok(
      rule.selector.startsWith('[data-stp-footer') || rule.selector.startsWith('[data-stp-account'),
      `footer rule escapes its marker: ${rule.selector}`,
    )
  }
  // Only the redundant pinned entry is hidden; the other footer controls remain.
  assert.equal(declsOf(css, '[data-stp-footer-pin]')['display'], 'none')
  assert.deepEqual(importantOf(css, '[data-stp-footer-pin]'), ['display'])
  const footerRules = rulesOf(css).filter(r => r.selector.includes('[data-stp-footer'))
  for (const rule of footerRules) {
    if (rule.selector === '[data-stp-footer-pin]') continue
    assert.ok(!/display\s*:\s*none/.test(rule.body), `an unrelated footer control is hidden: ${rule.selector}`)
  }

  // (4d-bis) !important IS REQUIRED HERE, AND ONLY HERE. Read off the live
  // CSSOM: the import control carries the host's INLINE height (42px) and the
  // pinned entry is styled `button.__dsh-session-pin-footer__` after an
  // `all: unset`, which outranks a single-attribute selector. Both were still
  // 42px/28px after their markers landed, so a plain declaration provably
  // loses. It is also the sharpest tool in the sheet, so the set of properties
  // carrying it is pinned here rather than left to drift.
  const MUST_WIN = ['height', 'min-height', 'box-sizing', 'padding', 'margin', 'line-height', 'font-size', 'padding-top', 'padding-bottom']
  const IMPORTANT_RULES = ['[data-stp-footer-import]']
  for (const selector of IMPORTANT_RULES) {
    const flagged = importantOf(css, selector)
    for (const want of ['height', 'min-height', 'line-height', 'padding']) {
      assert.ok(flagged.includes(want), `${selector} must state ${want} as !important, or the host's declaration wins`);
    }
    for (const prop of flagged) {
      assert.ok(MUST_WIN.includes(prop), `${selector} declares !important on ${prop}, which is not a layout property that has to win`);
    }
  }
  for (const selector of ["[data-stp-footer-balance] [class*='cm-simple-summary']",
    "[data-stp-footer-balance] [class*='cm-foot']",
    "[data-stp-footer-balance] [class*='cm-peak-strip']"]) {
    const flagged = importantOf(css, selector)
    assert.ok(flagged.includes('height'), `${selector} must state height as !important, or the host's cell height wins`);
    for (const prop of flagged) {
      assert.ok(MUST_WIN.includes(prop), `${selector} declares !important on ${prop}, which is not a layout property that has to win`);
    }
  }
  // Execution and selection backgrounds must beat personal row colors; only that
  // property may use the flag. Fold rules still need it to override host visibility.
  const BACKGROUND_RULES = ["[data-stp-runtime='running']", "[data-stp-runtime='children']",
    "[data-stp-typography] [data-row-key^='session:'][aria-selected='true'], "
    + "[data-stp-typography] [data-dcu-session][aria-selected='true'], "
    + "[data-stp-row][aria-current='true']"]
  for (const selector of BACKGROUND_RULES) {
    assert.deepEqual([...new Set(importantOf(css, selector))], ['background'],
      `${selector} must override only the row background`)
  }
  const NATIVE_PIN_SECTION = '[data-stp-typography] .dcu-wb-section:is([aria-label="置顶"], [aria-label="Pinned"])'
  assert.equal(declsOf(css, NATIVE_PIN_SECTION)['display'], 'none')
  assert.deepEqual(importantOf(css, NATIVE_PIN_SECTION), ['display'])
  const ALWAYS_ALLOWED = ['[data-stp-region][hidden]', "[data-stp-region][data-stp-collapsed='true'] > [data-stp-row]", '[data-stp-footer-pin]', NATIVE_PIN_SECTION, ...BACKGROUND_RULES]
  const flaggedElsewhere = rulesOf(css).filter(r => /!important/.test(r.body))
    .filter(r => !IMPORTANT_RULES.includes(r.selector)
      && !r.selector.startsWith('[data-stp-footer-balance]')
      && !ALWAYS_ALLOWED.includes(r.selector))
    .map(r => r.selector)
  assert.deepEqual(flaggedElsewhere, [], `!important is confined to the declarations that have to win: ${JSON.stringify(flaggedElsewhere)}`)

  // (4d-ter) The disclosure stays a usable target: compaction took its line box
  // to 18px, under the 24px floor the rest of the compaction holds to.
  const headerDecls = declsOf(css, '[data-stp-region-header]')
  assert.equal(headerDecls['min-height'], '24px', 'the pinned-region disclosure is still a real click target')
  assert.equal(headerDecls['box-sizing'], 'border-box', 'otherwise its padding adds outside the target')

  // (4e) THE FALLBACK MENU'S TWO ITEMS SHARE ONE STYLE, so the colour entry
  // cannot read as a different kind of row from the pin entry above it. One
  // combined rule is the proof: if the two ever diverged they would need a
  // second, later rule, and this selector would stop covering both.
  const menuItemRule = rulesOf(css).find(r =>
    r.selector.includes('[data-stp-menu] [data-stp-pin-item]')
    && r.selector.includes('[data-stp-menu] [data-stp-color-item]'))
  assert.ok(menuItemRule !== undefined, 'the two fallback menu items must be styled by one shared rule')
  const menuItemDecls = declsOf(css, menuItemRule.selector)
  assert.ok(menuItemDecls['min-height'] !== undefined, 'the fallback menu items must be styled, not left to the UA')
  assert.equal(menuItemDecls['min-height'], '24px', 'a menu row is still a click target')
  assert.equal(menuItemDecls['background'], 'transparent', 'and it is not a filled default button')
  for (const selector of ['[data-stp-menu] [data-stp-pin-item]', '[data-stp-menu] [data-stp-color-item]']) {
    assert.ok(
      rulesOf(css).every(r => !r.selector.split(', ').includes(selector)
        || r.selector === menuItemRule.selector
        || /:hover|:focus-visible/.test(r.selector)),
      `${selector} must not get its own base rule that could drift from the pin item's`,
    )
  }

  // (5) EVERY longhand the sheet writes is a value its own grammar accepts.
  // Without this, "no font shorthand" alone could be satisfied by a typo'd
  // property name that silently matches nothing.
  for (const { selector, body } of rulesOf(css)) {
    for (const line of body.split(';')) {
      const colon = line.indexOf(':')
      if (colon === -1) continue
      const prop = line.slice(0, colon).trim()
      let value = line.slice(colon + 1).trim()
      // The flag is checked separately by `importantOf`; the grammar below is
      // about the VALUE, and `16px !important` is not a value the browser uses.
      if (value.endsWith('!important')) value = value.slice(0, -'!important'.length).trim()
      const check = TYPO_VALUE_OK[prop]
      if (check === undefined || value === '') continue
      assert.ok(
        check(value),
        `${selector} → ${prop}: ${value} is not a valid ${prop} — it would be dropped exactly like the shorthand was`,
      )
    }
  }
  console.log('✔ typography: no font shorthand survives; pinned rows are 14px over a 12px workspace, both compact')
}

// --- SCOPE. The typography rules must reach the one tree the plugin proved and
// no other tree on the page. The stock sidebar's search view renders its OWN
// `[role="tree"][aria-label]` with its own `_title` spans, and a document-wide
// rule would restyle it — which is exactly the R19 failure this plugin already
// suffered once.
{
  const sc = officialUiScaffold()
  // A second, equally-shaped tree that the host would own and this plugin has
  // no proof for: same role, same label attribute, same title class.
  const other = new El('div')
  other.setAttribute('role', 'tree')
  other.setAttribute('aria-label', 'search results')
  const otherRow = new El('div')
  otherRow.setAttribute('data-row-key', 'session:other')
  const otherTitle = new El('span')
  otherTitle.className = 'qCniVq_title'
  otherRow.appendChild(otherTitle)
  other.appendChild(otherRow)
  sc.body.appendChild(other)

  const run = await runBundle(sc, { pinned: [S1] })
  assert.ok(
    sc.tree.getAttribute('data-stp-typography') !== null,
    'the proven tree must be marked',
  )
  assert.equal(
    other.getAttribute('data-stp-typography'), null,
    'an unrelated tree must never be marked — the rules would then reach it',
  )
  console.log('✔ typography scope: only the proven tree is marked, not a second tree of the same shape')

  // Repeated reconciles must not keep writing to the DOM. "Assign when the
  // value differs" is what makes an idle pass genuinely idle.
  let writes = 0
  const realSet = sc.tree.setAttribute.bind(sc.tree)
  sc.tree.setAttribute = (name, value) => {
    if (name === 'data-stp-typography') writes += 1
    return realSet(name, value)
  }
  for (let i = 0; i < 5; i += 1) { run.nudge(); await settle() }
  assert.equal(writes, 0, `an unchanged tree must not be rewritten; got ${writes} writes across 5 idle passes`)
  console.log('✔ typography marker: five idle reconciles write nothing at all')

  // Teardown hands the attribute back and touches nothing else on the host.
  // The workspace header is the row that is still MOUNTED here: pinning folds
  // the group, which by design unmounts its session rows, so asserting on one
  // of those would be asserting about the fold, not about dispose.
  const rowKeyBefore = sc.head.getAttribute('data-row-key')
  run.dispose()
  assert.equal(
    sc.tree.getAttribute('data-stp-typography'), null,
    'dispose must give the marker back',
  )
  assert.equal(
    sc.head.getAttribute('data-row-key'), rowKeyBefore,
    'the host group header is untouched',
  )
  assert.ok(sc.head.isConnected !== false, 'dispose must not remove host rows')
  assert.ok(sc.tree.isConnected !== false, 'dispose must not remove the host list')
  console.log('✔ typography marker: dispose returns the attribute and leaves the host as it was')
}

// --- UNKNOWN SIDEBAR STAYS OBSERVE-ONLY. A labelled tree that carries no host
// marker is not a sidebar, and the typography rules must not appear on it.
// The shape is deliberately the GENERIC one — the same `[role="tree"]` +
// aria-label that findTree() accepts as a candidate — with nothing inside it
// that proves whose it is. Adding a data-row-key row here would make it
// provable and the case would assert nothing.
{
  const sc = makeTree()
  sc.tree.setAttribute('role', 'tree')
  sc.tree.setAttribute('aria-label', 'file explorer')
  const fileRow = new El('div')
  fileRow.setAttribute('role', 'treeitem')
  const fileName = new El('span')
  fileName.className = 'qCniVq_title'
  fileRow.appendChild(fileName)
  sc.tree.appendChild(fileRow)
  const run = await runBundle(sc, { pinned: [S1] })
  assert.equal(
    sc.tree.getAttribute('data-stp-typography'), null,
    'an unproven tree must not be marked — typography stays observe-only',
  )
  run.dispose()
  console.log('✔ typography: an unproven sidebar is left entirely alone')
}

// --- THE COMPACTION HAS TO REACH THE SIDEBAR THAT IS ACTUALLY ON SCREEN.
//
//     This is the assertion the previous revision was missing, and it is the
//     one that matters on a codex-ui profile. The stock sidebar's rows carry
//     `data-row-key`; codex-ui's carry `data-dcu-session` and a
//     `dcu-wb-session` class and NO `data-row-key` at all. So a stylesheet
//     whose row selectors only spoke `data-row-key` was fully applied and
//     matched nothing: the marker went onto `.dcu-wb-tree` and every rule
//     below it hung in the sheet inert. Nothing failed, nothing warned — the
//     sidebar simply stayed at the host's 30px.
//
//     The selectors are asserted against the REAL artifact's class names
//     (`@michengai/dsh-codex-ui@1.1.42` lib/client.js: GroupHead at 1996-2017,
//     SessionRow at 1926-1931, and the CSS table at 3671-3675), and each is
//     required to hang off the marker like every other host rule, so the scope
//     guarantee is not traded away to buy the reach.
{
  const sc = codexScaffold()
  const run = await runBundle(sc, { pinned: [] })
  const css = withoutComments(staticCss(sc))
  const hostRules = rulesOf(css).filter(r => r.selector.includes(TYPOGRAPHY_ANCHOR))
  const selectorsOf = (needle) => hostRules
    .filter(r => r.selector.includes(needle))
    .map(r => r.selector)

  for (const needle of ['[data-dcu-session]', '.dcu-wb-project-head']) {
    assert.ok(
      selectorsOf(needle).length > 0,
      `codex-ui's own row vocabulary is absent from the compaction: nothing matches ${needle}`,
    )
  }
  // Reach AND scope, in one check: every rule that names a codex class still
  // hangs off the proved tree, so a stray .dcu-wb-session elsewhere on the
  // page cannot be restyled by it.
  for (const rule of hostRules) {
    assert.ok(
      rule.selector.startsWith(TYPOGRAPHY_ANCHOR),
      `a rule naming a host row escapes the marker: ${rule.selector}`,
    )
  }
  // The row box, not just the text: a compacted line-height inside a 30px row
  // leaves the row at 30px, which is the half that was actually wrong on screen.
  const codexRhythm = hostRules.find(r =>
    r.selector.includes('[data-dcu-session]') && declsOf(css, r.selector)['min-height'] !== undefined)
  assert.ok(codexRhythm !== undefined, 'codex-ui rows need their own row-rhythm rule, not only a font-size one')
  const rhythmDecls = declsOf(css, codexRhythm.selector)
  assert.equal(rhythmDecls['height'], '26px', 'the 30px row is taken back to the compact 26px')
  assert.equal(rhythmDecls['min-height'], '24px', 'and never below the 24px hit area')
  assert.equal(rhythmDecls['box-sizing'], 'border-box', 'otherwise the padding adds outside the row')
  // The same 12px/16px title the stock sidebar gets, so both hosts compact
  // identically instead of the pinned region reading larger on one of them.
  const codexTitle = hostRules.find(r => r.selector.includes('.dcu-wb-session-title'))
  assert.ok(codexTitle !== undefined, "codex-ui's own title class must be addressed by name")
  assert.equal(declsOf(css, codexTitle.selector)['font-size'], '12px')
  assert.equal(declsOf(css, codexTitle.selector)['line-height'], '16px')
  // And its inline rename field, which sits at 14px/20px in the host's own CSS
  // table — left alone it visibly reflows the 26px row it lives in.
  const codexInput = hostRules.find(r => r.selector.includes('.dcu-wb-rename-input'))
  assert.ok(codexInput !== undefined, "codex-ui's rename input needs the same 12px as the stock sidebar's inline input")
  // The two GROUP HEADS are compacted, so their own labels must be too.
  // codex-ui sizes those independently (`.dcu-wb-collection-label`
  // min-height:32px + 4px padding; `.dcu-wb-section-label` min-height:24px + 2px
  // padding — lib/client.js CSS table at 3671-3674 and 3729-3733). A head forced
  // to 26px while its label still needs 32+ centres a too-tall child that
  // overflows both edges and drags its click area outside the header.
  for (const label of ['.dcu-wb-collection-label', '.dcu-wb-section-label']) {
    const rule = hostRules.find(r => r.selector.includes(label) && declsOf(css, r.selector)['min-height'] !== undefined)
    assert.ok(
      rule !== undefined,
      `${label} is not compacted, so it overflows the 26px head it is centred in`,
    )
    assert.equal(declsOf(css, rule.selector)['box-sizing'], 'border-box', `${label}: otherwise its own padding adds outside the stated height`)
    assert.equal(declsOf(css, rule.selector)['min-height'], '24px', `${label}: and it must come down to the compact box, not stay at the host's 32px`)
  }
  console.log('✔ compaction reaches codex-ui\'s own rows, under the marker, at the compact values')
}

// --- THE FLAVOR IS RE-PROBED, AND OFFICIAL WINS WHEN BOTH ARE ON THE PAGE.
//
//     codex-ui is loaded alongside the stock web app on a real profile
//     (`D:/DSH-Next/data/home/profiles/desktop` bundles both) and wins the
//     `sidebar.workspaces` slot at priority -1, so its rows are the ones in
//     front of the user. Its dcu attributes are ADDITIVE though: the moment a
//     stock row is on the page too — a profile that also loads the stock
//     browser, or the window in which a stock tree outlives codex-ui — a
//     codex-first probe addresses rows the user cannot see.
//
//     The observable is the marker itself, not a log line: the plugin writes
//     `data-stp-typography` onto exactly the tree it proved, so "which tree
//     carries the marker" IS "which flavor was chosen". A console line would
//     only say that the two agree on a quiet machine.
{
  const sc = codexScaffold()
  // A second list in the stock shape — the same listArea > treeBody > tree the
  // stock sidebar really renders, with the label its AnimatedRows puts on the
  // tree (t('section.sessions')) — and deliberately EMPTY. Empty is the point:
  // a labelled tree with no host marker in it is exactly the shape findTree()
  // accepts as a candidate and detectFlavor() must refuse, so it proves nothing
  // here and the codex tree stands alone.
  const stock = makeTree()
  stock.tree.setAttribute('aria-label', '会话')
  sc.body.appendChild(stock.listArea)
  const stockTree = stock.tree

  const run = await runBundle(sc, { pinned: [] })
  assert.equal(
    sc.tree.getAttribute('data-stp-typography'), '',
    'with only codex-ui proven on the page, its tree is the one to address',
  )
  assert.equal(
    stockTree.getAttribute('data-stp-typography'), null,
    'and a labelled tree with no host marker in it is not one to address',
  )

  // A stock SESSION row appears — the positive marker, not the folded fallback.
  const stockRow = new El('div')
  stockRow.setAttribute('data-row-key', 'session:s1')
  stockRow.setAttribute('role', 'treeitem')
  stockTree.appendChild(stockRow)
  await settle()
  assert.equal(
    stockTree.getAttribute('data-stp-typography'), '',
    'the official positive marker outranks codex-ui\'s additive attributes',
  )
  assert.equal(
    sc.tree.getAttribute('data-stp-typography'), null,
    'and the marker is taken back off the tree it no longer belongs to',
  )

  // ...and it is corrected again the moment the stock row goes away. A decision
  // frozen at mount is what made the plugin permanently blind to a sidebar that
  // renders after it does.
  stockRow.remove()
  await settle()
  assert.equal(
    sc.tree.getAttribute('data-stp-typography'), '',
    'codex → official → codex, each corrected on the pass that observes it',
  )
  assert.equal(stockTree.getAttribute('data-stp-typography'), null)
  run.dispose()
  console.log('✔ flavor: the official positive marker outranks codex, and the correction reaches both ways')
}

console.log('\nALL SIDEBAR-FLAVOR DOM CHECKS PASSED')