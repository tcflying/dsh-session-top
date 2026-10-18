/**
 * Real-owner pinned-row context-menu behavior test.
 *
 * test/shared-menu.mjs proves the plugin interoperates with a faithful
 * TRANSCRIPTION of `@baihejiangnan/dsh-session-context-menu`. A transcription
 * only proves agreement with what we believe the owner does. This file loads the
 * owner's real `lib/client.js` off disk and runs it against the same fake DOM, so
 * the assertions are about the owner's actual code path:
 *
 *   rowFrom         lib/client.js:104-109  `[role=treeitem]` + aria-selected or
 *                                            a descendant `button[aria-label]`
 *                                            naming "会话操作"/"session action"
 *   titleFrom       lib/client.js:194-197
 *   resolveSession  lib/client.js:199-214  unique title match over state.ids
 *   menu build      OWNER_CONTRACTS below  rename/archive[/delete]/explorer/
 *                                            copycwd/copyid/fork + extensions
 *                                            + refresh
 *
 * The host fixture is transcribed from `@michengai/dsh-codex-ui` lib/client.js
 * (the version installed under the desktop profile, 1.1.35):
 *   :4560-4562  div.dcu-wb-session[data-dcu-session][role=treeitem][aria-selected]
 *   :4617       the session row's OWN `onContextMenu` — preventDefault(),
 *               stopPropagation(), setMenu({type:"session"}) — which is
 *               codex-ui's native claim of a right-click on a session row, and
 *               is what the plugin must observe instead of assume
 *   :4704       button.dcu-wb-context-anchor[aria-label=t("sessions.actions")]
 *   :9175       zh "sessions.actions" = "{name} 的会话操作"
 *   :4540,:3592 <DisclosureBody open> — folding sets data-open + `inert`; the
 *               session rows STAY MOUNTED, so a pinned session's real host row
 *               is reachable even inside a collapsed workspace group.
 *
 * The owner is VERSION-PINNED by the sha256 of its own `lib/client.js`, and the
 * menu each version must produce is a hand-written literal per version. The
 * owner's published menu is not one menu: the v0.2.14 tagged artifact
 * never had a delete entry, and unreleased main added one. Asserting either one
 * against the other is a false failure; deriving the expectation from whatever
 * the owner happened to render is a test that cannot fail, so neither is done.
 * An artifact that is neither pin FAILS, rather than being accommodated.
 *
 * Run: node test/owner-menu-real.mjs
 *      DSH_CTX_MENU_CLIENT=<path to a pinned owner's lib/client.js> node test/owner-menu-real.mjs
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const PKG = '@baihejiangnan/dsh-session-context-menu'

const S1 = 'session-aaaaaaaa-1111-4111-8111-111111111111'
const S2 = 'session-bbbbbbbb-2222-4222-8222-222222222222'
const UNPIN_ID = 'dsh-session-top.unpin'
const KEY = Symbol.for('dsh.session-context-menu.extensions')
const LEASE = Symbol.for('dsh.session-context-menu.lease')

/** codex-ui's zh labels (lib/client.js:9182-9212), used by the host menu stub. */
const HOST_MENU = ['重命名会话', '标记未读', '归档会话', '在新会话中继续', '在资源管理器中打开', '复制会话 ID', '复制标题']

// ------------------------------------------------------- locate the real owner

/**
 * The owner's client half must be the file on disk, not a transcription of it.
 * `DSH_CTX_MENU_CLIENT` overrides the search for a profile that installs the
 * owner somewhere else; without it this test FAILS rather than quietly falling
 * back to a mock, because a green run against a mock is exactly the gap that
 * let a pinned row keep a one-item menu on a machine that has the real owner.
 */
function resolveOwnerClient() {
  const candidates = [
    process.env.DSH_CTX_MENU_CLIENT,
    resolve(repoRoot, 'node_modules', PKG, 'lib', 'client.js'),
    resolve(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', PKG, 'lib', 'client.js'),
    resolve(homedir(), '.dsh', 'profiles', 'default', 'node_modules', PKG, 'lib', 'client.js'),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `the real ${PKG} client half was not found; this test must run against it, not a mock.\n`
    + `set DSH_CTX_MENU_CLIENT to its lib/client.js. searched:\n  ${candidates.join('\n  ')}`,
  )
}

const ownerClientPath = resolveOwnerClient()

// ------------------------------------------------- the owner's version pin

/**
 * What one OWNED REVISION of the owner's `lib/client.js` must render.
 *
 * Hand-written from the owner's own menu-build source, per revision:
 *   - `sessionMenu`    the owner's own items for a RESOLVED session, in the
 *                      order `add()` is called, before extensions and 刷新.
 *   - `unresolvedMenu` the same with an ambiguous title, where the owner drops
 *                      the session-scoped items it cannot attribute.
 *   - `tail`           what follows the plugin's own extension entry.
 *
 * The plugin's entry is appended between `unresolvedMenu`/`sessionMenu` and
 * `tail` by the builders below, because the owner renders registered extensions
 * after `创建会话分支` and before `刷新`.
 *
 * These are literals on purpose. Anything computed from the menu the owner
 * actually rendered would make every assertion below tautological.
 */
/** This plugin's row-colour entry label, in the owner's rendered menu. */
const COLOR_LABEL = '自定义行背景颜色…'
const COLOR_ID = 'dsh-session-top.row-color'

const OWNER_CONTRACTS = {
  // github.com/baihejiangnan/dsh-session-context-menu tag v0.2.14
  // (commit fc9ab4692fc9d1d9825b671c56abf21aeabca938), the v0.2.14 tagged
  // artifact. Its menu build has no `deleteSession` call at all
  // (lib/client.js:437-459: 重命名会话, 归档会话, then the cwd block), so this
  // revision's menu must NOT contain 删除会话.
  '6960b05c2199c529e5daaba738287ba59bbfa1394862d2ae734c3c6475d229c9': {
    revision: 'v0.2.14 tagged artifact (tag fc9ab469)',
    sessionMenu: ['重命名会话', '归档会话', '在资源管理器中打开', '复制工作目录', '复制会话 ID', '创建会话分支'],
    unresolvedMenu: ['重命名会话', '归档会话', '创建会话分支'],
    tail: ['刷新'],
  },
  // Unreleased main, commit ab40ccedd79f36961fddfe5adf0a99cbe489ab6f
  // (2026-09-29). Its menu build DOES call
  // `add(root, t("deleteSession"), ...)` (lib/client.js:637), so this
  // revision's menu MUST contain 删除会话.
  '9ccc3ab8dbefb1d8e100b232c7e612315d81aa084ddced55e789ec48cc6243b9': {
    revision: 'main@ab40cced (unreleased; introduces 删除会话)',
    sessionMenu: ['重命名会话', '归档会话', '删除会话', '在资源管理器中打开', '复制工作目录', '复制会话 ID', '创建会话分支'],
    unresolvedMenu: ['重命名会话', '归档会话', '删除会话', '创建会话分支'],
    tail: ['刷新'],
  },
}

/** The owner's file, hashed, and the contract that hash is pinned to. */
const ownerSource = readFileSync(ownerClientPath, 'utf8')
const ownerSha256 = createHash('sha256').update(ownerSource, 'utf8').digest('hex')
const ownerContract = OWNER_CONTRACTS[ownerSha256]
if (ownerContract === undefined) {
  throw new Error(
    `the owner at ${ownerClientPath} is not a revision this file has a menu contract for.\n`
    + `  sha256 ${ownerSha256}\n`
    + `read that revision's menu build (the \`if (row) {\` block of its lib/client.js)\n`
    + `and add its sha256 to OWNER_CONTRACTS above with the labels it calls add() with.\n`
    + `Guessing is not an option: this file must not silently accept an owner whose\n`
    + `menu has drifted, and it must not filter the actual menu down to what it expects.\n`
    + `known revisions:\n`
    + Object.entries(OWNER_CONTRACTS).map(([sha, c]) => `  ${sha}  ${c.revision}`).join('\n'),
  )
}

/**
 * The owner's full menu for a resolved session, plus this plugin's entries.
 *
 * TWO of them now, in the order they are registered: the pin/unpin toggle
 * (order 50/51) and the row-colour item (order 52). The owner's own items and
 * its 刷新 tail are untouched, which is the whole point of registering into its
 * table rather than replacing the menu.
 */
const ownRowMenu = (pinLabel) => [...ownerContract.sessionMenu, pinLabel, COLOR_LABEL, ...ownerContract.tail]
/** The same, on an ordinary host row. */
const hostRowMenu = (pinLabel) => [...ownerContract.sessionMenu, pinLabel, COLOR_LABEL, ...ownerContract.tail]
/** The owner's menu when the title is ambiguous and no session can be attributed. */
const unresolvedMenu = () => [...ownerContract.unresolvedMenu, ...ownerContract.tail]

console.log(`owner revision: ${ownerContract.revision} (sha256 ${ownerSha256.slice(0, 12)})`)

// --------------------------------------------------------------- fake DOM

/** The document the current `run()` built; element dispatch bubbles up to it. */
let ACTIVE_DOCUMENT = null

class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase()
    this.attributes = new Map()
    this.children = []
    this.parentElement = null
    this.listeners = new Map()
    this.onclick = null
    this.tabIndex = -1
    this.type = 'button'
    this._text = ''
    this.isConnected = true
    this.dataset = new Proxy({}, {
      get: (_t, name) => this.getAttribute(`data-${dash(name)}`),
      set: (_t, name, value) => { this.setAttribute(`data-${dash(name)}`, value); return true },
      has: (_t, name) => this.attributes.has(`data-${dash(name)}`),
    })
    const props = new Map()
    this.style = {
      props,
      visibility: '',
      left: '',
      top: '',
      cssText: '',
      setProperty: (k, v) => { props.set(k, v); this.style[k] = v },
      removeProperty: (k) => { props.delete(k); this.style[k] = '' },
    }
  }

  get classList() {
    const list = (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
    return {
      contains: (name) => list.includes(name),
      add: (...names) => { const next = new Set([...list, ...names]); this.setAttribute('class', [...next].join(' ')) },
    }
  }

  get className() { return this.getAttribute('class') ?? '' }
  set className(value) { this.setAttribute('class', value) }
  get childElementCount() { return this.children.length }
  get firstChild() { return this.children[0] ?? null }
  get firstElementChild() { return this.children[0] ?? null }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null }
  get textContent() {
    if (this.children.length === 0) return this._text
    return this.children.map(child => child.textContent).join('')
  }
  set textContent(value) { this._text = String(value); this.children.length = 0 }

  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }

  appendChild(child) { child.parentElement = this; this.children.push(child); child.isConnected = true; return child }
  insertBefore(child, anchor) {
    child.parentElement = this
    const at = anchor == null ? this.children.length : this.children.indexOf(anchor)
    this.children.splice(at < 0 ? this.children.length : at, 0, child)
    child.isConnected = true
    return child
  }
  remove() {
    if (this.parentElement === null) return
    const at = this.parentElement.children.indexOf(this)
    if (at >= 0) this.parentElement.children.splice(at, 1)
    this.parentElement = null
    this.isConnected = false
  }
  contains(node) {
    let cursor = node
    while (cursor !== null) { if (cursor === this) return true; cursor = cursor.parentElement }
    return false
  }

  descendants() {
    const out = []
    const walk = (node) => { for (const child of node.children) { out.push(child); walk(child) } }
    walk(this)
    return out
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    const at = list.indexOf(fn)
    if (at >= 0) list.splice(at, 1)
  }
  /**
   * Capture-phase semantics, and the propagation a real DOM gives an
   * `element.dispatchEvent`: the document's CAPTURE listeners for this type run
   * first, in registration order, and only then the listeners on the target
   * itself. Without that second half a re-delivered gesture could never reach
   * the shared owner, which listens on `document` exactly as it does live.
   */
  dispatchEvent(event) {
    event.target = event.target ?? this
    const capture = ACTIVE_DOCUMENT?.docListeners.get(event.type)
    if (capture !== undefined) for (const fn of [...capture]) fn(event)
    for (const fn of [...(this.listeners.get(event.type) ?? [])]) fn(event)
    return !event.defaultPrevented
  }
  click() {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    this.dispatchEvent(event)
    if (typeof this.onclick === 'function') this.onclick(event)
  }
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 24 } }
  matches(selector) { return matchSimple(this, selector) }
  closest(selector) {
    let node = this
    while (node !== null) {
      if (typeof node.matches === 'function' && node.matches(selector)) return node
      node = node.parentElement
    }
    return null
  }
  querySelector(selector) { return this.descendants().find(node => node.matches(selector)) ?? null }
  querySelectorAll(selector) { return this.descendants().filter(node => node.matches(selector)) }
}

function dash(name) { return String(name).replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`) }

/** Node 24 defines some of these as getter-only globals; replace them outright. */
function define(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
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
    for (let i = compounds.length - 2; i >= 0; i -= 1) {
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
  }
  preventDefault() { if (this.cancelable) this.defaultPrevented = true }
  stopPropagation() {}
}

class CustomEvent {
  constructor(type, init = {}) {
    this.type = type
    this.detail = init.detail
    this.defaultPrevented = false
    this.target = null
  }
  preventDefault() {}
  stopPropagation() {}
}

// ------------------------------------------------------------- the host page

/**
 * The codex-ui workbench tree, transcribed from lib/client.js:
 * `.dcu-wb-tree[role=tree]` > `.dcu-wb-project` > `.dcu-wb-project-head` +
 * `.dcu-wb-project-body[data-open]` > `.dcu-wb-session[data-dcu-session]`.
 *
 * `projectBody` is left COLLAPSED on purpose: that is the state a group holding
 * a pinned session is left in, and the whole point is that the real row is
 * still mounted inside it.
 *
 * `native` attaches codex-ui's OWN session-row `onContextMenu`, transcribed from
 * lib/client.js:4617-4626: it claims the gesture with a synchronous
 * `preventDefault()` + `stopPropagation()` and opens the host's own session menu
 * at the pointer. It is opt-in so a case can turn codex's own menu on or off —
 * but a case that asserts codex serves the gesture must have it ON, and must
 * assert the sentinel it records, so "the host handles it" is an observation and
 * not an assumption about which row happens to exist.
 */
function buildHost({ native = false } = {}) {
  const body = new El('body')
  const head = new El('head')
  const html = new El('html')
  html.setAttribute('lang', 'zh-CN')
  const listArea = new El('div')
  const treeBody = new El('div')
  const tree = new El('div')
  tree.className = 'dcu-wb-tree'
  tree.setAttribute('role', 'tree')

  const project = new El('div')
  project.className = 'dcu-wb-project'
  const projectHead = new El('div')
  projectHead.className = 'dcu-wb-project-head'
  projectHead.setAttribute('role', 'treeitem')
  projectHead.setAttribute('aria-expanded', 'false')
  const headTitle = new El('span')
  headTitle.className = 'dcu-wb-project-title'
  headTitle.textContent = 'W1'
  projectHead.appendChild(headTitle)
  project.appendChild(projectHead)

  const projectBody = new El('div')
  projectBody.className = 'dcu-wb-project-body'
  projectBody.setAttribute('data-open', 'false')
  projectBody.setAttribute('aria-hidden', 'true')

  const hostClicks = []
  const nativeClaims = []
  const rows = {}

  const makeRow = (id, title, selected) => {
    const row = new El('div')
    row.className = `dcu-wb-session${selected ? ' dcu-wb-selected' : ''}`
    row.setAttribute('role', 'treeitem')
    row.setAttribute('data-dcu-session', id)
    row.setAttribute('aria-selected', selected ? 'true' : 'false')
    row.setAttribute('draggable', 'true')

    const copy = new El('div')
    copy.className = 'dcu-wb-session-copy'
    const titleEl = new El('span')
    titleEl.className = 'dcu-wb-session-title'
    const titleText = new El('span')
    titleText.className = 'dcu-wb-session-title-text'
    titleText.textContent = title
    titleEl.appendChild(titleText)
    copy.appendChild(titleEl)

    const time = new El('span')
    time.className = 'dcu-wb-session-time'
    time.textContent = '1 分钟'

    const actions = new El('span')
    actions.className = 'dcu-wb-actions'
    const anchor = new El('button')
    anchor.type = 'button'
    anchor.className = 'dcu-wb-more dcu-wb-context-anchor'
    anchor.setAttribute('aria-label', `${title} 的会话操作`)
    // Stands in for React's delegated onClick: the "..." button opens codex-ui's
    // own session menu. The owner reaches official actions ONLY through this.
    anchor.addEventListener('click', (event) => {
      event.stopPropagation()
      hostClicks.push({ id, title })
      openHostMenu(document, id, title)
    })
    actions.appendChild(anchor)

    // codex-ui's own session-row right-click handler (lib/client.js:4617).
    // React serves it at the row, so a right-click on the row reaches it — the
    // claim it makes is a synchronous preventDefault, which is the only thing a
    // re-delivered gesture can be judged by.
    if (native === true) {
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        event.stopPropagation()
        nativeClaims.push({ id, x: event.clientX, y: event.clientY })
        openHostMenu(document, id, title)
      })
    }

    row.appendChild(copy)
    row.appendChild(time)
    row.appendChild(actions)
    return { row, title: titleText, anchor }
  }

  for (const [id, title, selected] of [[S1, 'first', false], [S2, 'second', true]]) {
    const made = makeRow(id, title, selected)
    rows[id] = made
    projectBody.appendChild(made.row)
  }
  project.appendChild(projectBody)
  tree.appendChild(project)
  treeBody.appendChild(tree)
  listArea.appendChild(treeBody)
  body.appendChild(listArea)

  const docListeners = new Map()
  const document = {
    body,
    head,
    documentElement: html,
    activeElement: null,
    execCommand: () => true,
    createElement: (tag) => new El(tag),
    querySelector: (sel) => body.querySelector(sel) ?? head.querySelector(sel) ?? html.querySelector(sel),
    querySelectorAll: (sel) => [
      ...html.querySelectorAll(sel),
      ...head.querySelectorAll(sel),
      ...body.querySelectorAll(sel),
    ],
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, [])
      docListeners.get(type).push(fn)
    },
    removeEventListener: (type, fn) => {
      const list = docListeners.get(type) ?? []
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    dispatchEvent: (event) => {
      for (const fn of [...(docListeners.get(event.type) ?? [])]) fn(event)
      return !event.defaultPrevented
    },
  }
  return { body, head, html, document, docListeners, tree, treeBody, projectBody, rows, hostClicks, nativeClaims }
}

/** codex-ui's own session menu, as `Menu` renders it into a portal. */
function openHostMenu(document, id, title) {
  document.body.querySelector('.dcu-host-menu')?.remove()
  const root = document.createElement('div')
  root.className = 'dcu-host-menu'
  root.setAttribute('role', 'menu')
  for (const label of HOST_MENU) {
    const item = document.createElement('button')
    item.type = 'button'
    item.setAttribute('role', 'menuitem')
    item.setAttribute('data-host-session', id)
    item.setAttribute('data-host-title', title)
    item.textContent = label
    item.addEventListener('click', () => {
      globalThis.__hostMenuInvoked.push({ id, label })
      root.remove()
    })
    root.appendChild(item)
  }
  document.body.appendChild(root)
}

// ------------------------------------------------------- run plugin + owner

async function run({ pinned = [S1], withOwner = true, order = 'owner-first', titles = null, native = false } = {}) {
  delete globalThis[KEY]
  const host = buildHost({ native })
  ACTIVE_DOCUMENT = host
  const pinCalls = []
  const opened = []
  const ownerEvents = []
  globalThis.__hostMenuInvoked = []

  // `titles` rewrites the titles the HOST rows render, which is how the
  // same-name case is reached: the owner's `titleFrom` reads the row text and
  // `resolveSession` then refuses an ambiguous match.
  if (titles !== null) {
    for (const [id, title] of Object.entries(titles)) {
      const made = host.rows[id]
      made.title.textContent = title
      made.anchor.setAttribute('aria-label', `${title} 的会话操作`)
    }
  }

  const summaries = {
    [S1]: { id: S1, displayTitle: titles?.[S1] ?? 'first', cwd: '/work/one', updatedAt: 1 },
    [S2]: { id: S2, displayTitle: titles?.[S2] ?? 'second', cwd: '/work/two', updatedAt: 2 },
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
      unpinSession: async (id) => { pinCalls.push(['unpin', id]) },
      archiveSession: async (id) => { pinCalls.push(['archive', id]) },
    },
    sessions: {
      list: {
        getSnapshot: () => ({ ids: [S1, S2], byId: summaries, phase: 'ready', projectionsBySession: {} }),
        subscribe: () => () => {},
      },
      fork: async ({ sessionId }) => { pinCalls.push(['fork', sessionId]); return `${sessionId}-child` },
      open: (id) => { opened.push(['sessions.open', id]) },
      binding: () => ({ session: { rename: async () => ({ ok: true }) } }),
      subagentAddress: () => undefined,
    },
    uiWorkspace: {
      openSession: (id) => { opened.push(['uiWorkspace.openSession', id]) },
      mainReference: { sessionId: S2, release() {} },
    },
  }

  globalThis.document = host.document
  globalThis.window = {
    addEventListener: () => {}, removeEventListener: () => {}, innerWidth: 1280, innerHeight: 900,
  }
  globalThis.innerWidth = 1280
  globalThis.innerHeight = 900
  globalThis.location = { reload: () => { pinCalls.push(['reload']) } }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.Element = El
  globalThis.HTMLElement = El
  globalThis.HTMLInputElement = El
  globalThis.HTMLTextAreaElement = El
  globalThis.MouseEvent = MouseEvent
  globalThis.CustomEvent = CustomEvent
  globalThis.KeyboardEvent = class { constructor(type, init) { Object.assign(this, { type }, init) } }
  globalThis.InputEvent = class { constructor(type, init) { Object.assign(this, { type }, init) } }
  globalThis.requestAnimationFrame = (fn) => { fn(); return 1 }
  globalThis.getSelection = () => null
  define('navigator', { language: 'zh-CN', clipboard: { writeText: async () => {}, readText: async () => '' } })
  globalThis.prompt = () => null
  globalThis.confirm = () => false
  globalThis.globalListeners = new Map()
  globalThis.addEventListener = (type, fn) => {
    if (!globalThis.globalListeners.has(type)) globalThis.globalListeners.set(type, [])
    globalThis.globalListeners.get(type).push(fn)
  }
  globalThis.dispatchEvent = (event) => {
    if (event.type === 'dsh:session-context-menu') ownerEvents.push(event.detail)
    for (const fn of [...(globalThis.globalListeners.get(event.type) ?? [])]) fn(event)
    return true
  }

  let ownerRegistration = null
  globalThis.window.__ModuleLoader__ = { load: (value) => { ownerRegistration = value } }
  new Function('window', ownerSource)(globalThis.window)
  const ownerExports = ownerRegistration.factory()

  // Both apply orders are exercised. They are not equivalent: the two
  // document-capture listeners live on the SAME node in the SAME phase, so
  // which one runs first is decided by registration order, and a pinned row
  // that the owner could mistake for its own session row would be claimed with
  // the wrong context under one of them and not the other. Nothing in the
  // plugin may depend on which order the host happened to boot in.
  const applyOwner = () => {
    if (!withOwner) return () => {}
    return ownerExports.apply({ get: name => services[name] })
  }
  let pluginRegistration = null
  globalThis.window.__ModuleLoader__ = { load: (value) => { pluginRegistration = value } }
  const pluginSource = await readFile(join(repoRoot, 'src', 'client.js'), 'utf8')
  new Function('window', 'document', 'Element', 'MutationObserver', 'KeyboardEvent', pluginSource)(
    globalThis.window, host.document, El, globalThis.MutationObserver, globalThis.KeyboardEvent,
  )
  const pluginExports = pluginRegistration.factory()

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

  let ownerDispose = () => {}
  if (order === 'owner-first') ownerDispose = applyOwner()
  const realWarn = console.warn
  const realInfo = console.info
  console.warn = () => {}
  console.info = () => {}
  pluginExports.apply(ctx)
  console.warn = realWarn
  console.info = realInfo
  if (order === 'plugin-first') ownerDispose = applyOwner()

  // The late owner needs the plugin's bounded registration retry to land.
  await new Promise(r => { setTimeout(r, order === 'plugin-first' ? 700 : 200) })

  return {
    ...host,
    ownerEvents,
    pinCalls,
    opened,
    ownerEntries: () => {
      const api = globalThis[KEY]
      return api === undefined ? [] : api.list()
    },
    dispose() { for (const one of disposers.splice(0)) one() },
    disposeOwner() { ownerDispose() },
  }
}

/** Deliver a contextmenu the way a document-capture listener sees it. */
function deliverContextMenu(docListeners, target, clientX = 120, clientY = 240) {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY, button: 2, buttons: 2 })
  event.target = target
  for (const fn of [...(docListeners.get('contextmenu') ?? [])]) fn(event)
  return event
}

/** As `deliverContextMenu`, then wait out the microtask the plugin defers to. */
async function rightClick(docListeners, target, clientX = 120, clientY = 240) {
  const event = deliverContextMenu(docListeners, target, clientX, clientY)
  await new Promise(r => { queueMicrotask(() => { setTimeout(r, 0) }) })
  return event
}

/**
 * The owner's rendered labels, in order.
 *
 * Separators are `div.dshcm-separator`, not buttons, and a shortcut hint is a
 * second span inside the same button — so a label is the button's FIRST span's
 * text, never the whole item's textContent ("刷新Ctrl+R").
 */
function menuLabels(document) {
  const menu = document.body.querySelector('.dshcm-menu')
  if (menu === null) return null
  return menu.children
    .filter(item => item.getAttribute('role') === 'menuitem')
    .map(item => item.children[0]?.textContent ?? item.textContent)
}

function menuItem(document, label) {
  return menuLabels(document)?.includes(label)
    ? document.body.querySelector('.dshcm-menu').children.find(item => item.children[0]?.textContent === label)
    : null
}

// ---------------------------------------------------------------- the tests

// --- The pinned region's OWN row must be served by the real owner's full menu.
{
  const t = await run({ pinned: [S1] })
  const ownRow = t.document.body.querySelector('[data-stp-row]')
  assert.ok(ownRow !== null, 'the pinned region must render its own row for the pinned session')
  assert.equal(ownRow.getAttribute('data-stp-session'), S1)

  const event = await rightClick(t.docListeners, ownRow.querySelector('[data-stp-row-title]'))

  assert.equal(event.defaultPrevented, true, 'the gesture must be claimed')
  assert.ok(
    t.document.body.querySelector('[data-stp-menu]') === null,
    "the plugin must not open its own one-item menu when the real owner owns the gesture",
  )

  const labels = menuLabels(t.document)
  assert.ok(labels !== null, 'the REAL owner must have built .dshcm-menu for the pinned row')
  assert.deepEqual(
    labels,
    ownRowMenu('取消置顶'),
    `a pinned row must offer this owner revision's full menu plus Unpin; got ${JSON.stringify(labels)}`,
  )
  console.log('✔ own pinned row: the REAL owner builds its full menu on it')

  // The menu must be built from the REAL host row, with the right session.
  assert.equal(t.ownerEvents.length, 1, 'the owner announces exactly one dsh:session-context-menu')
  const detail = t.ownerEvents[0]
  assert.equal(detail.row, t.rows[S1].row, 'the menu must be built from the real host session row')
  assert.equal(detail.session?.id, S1, 'and with the PINNED session as its subject')
  assert.deepEqual([detail.x, detail.y], [120, 240], 'opened at the pointer the user actually used')
  console.log('✔ own pinned row: the menu is built from the real host row and the pinned session')

  // Official actions must reach the host's OWN affordance, not a stand-in.
  menuItem(t.document, '归档会话').click()
  await new Promise(r => { setTimeout(r, 30) })
  assert.deepEqual(
    t.hostClicks.map(entry => entry.id), [S1],
    'archive must go through the real row\'s own action button, i.e. codex-ui\'s own menu',
  )
  assert.deepEqual(
    globalThis.__hostMenuInvoked, [{ id: S1, label: '归档会话' }],
    'and the owner must click the matching item in the host menu it opened',
  )
  console.log('✔ own pinned row: rename/archive delegate to the real host action button')

  // Unpin must be scoped to the pinned session and write the official RPC.
  const t2 = await run({ pinned: [S1] })
  const ownRow2 = t2.document.body.querySelector('[data-stp-row]')
  await rightClick(t2.docListeners, ownRow2.querySelector('[data-stp-row-title]'))
  const unpin = menuItem(t2.document, '取消置顶')
  assert.ok(unpin !== null, 'the pinned session must offer Unpin in the real owner menu')
  assert.deepEqual(t2.ownerEvents[0].session?.id, S1, 'Unpin must be filtered against the pinned session')
  unpin.click()
  await new Promise(r => { setTimeout(r, 20) })
  assert.deepEqual(t2.pinCalls, [['unpin', S1]], 'Unpin writes through workspaces.unpinSession')
  console.log('✔ own pinned row: Unpin rides the real owner menu against the right session')

  // The forbidden shortcuts stay forbidden: no synthesized selection, no fake
  // action button, no copied operation list on the row we own.
  assert.equal(
    t.document.body.querySelectorAll('[data-stp-row][aria-selected]').length, 0,
    'our row must never borrow aria-selected to steer the owner',
  )
  assert.equal(
    t.document.body.querySelectorAll('[data-stp-row] button[aria-label]').length, 0,
    'our row must never carry a fabricated "会话操作" button',
  )
  console.log('✔ own pinned row: no aria-selected synthesis and no fabricated action button')

  t.dispose(); t.disposeOwner()
  t2.dispose(); t2.disposeOwner()
}

// --- The REAL host row keeps working exactly as before (no regression).
{
  const t = await run({ pinned: [S1] })
  await rightClick(t.docListeners, t.rows[S2].title)
  assert.deepEqual(
    menuLabels(t.document),
    hostRowMenu('置顶该会话'),
    'an ordinary, unpinned host row still offers Pin in the full owner menu',
  )
  assert.equal(t.ownerEvents[0].row, t.rows[S2].row)
  console.log('✔ ordinary host row: unchanged — the full owner menu plus Pin')
  t.dispose(); t.disposeOwner()
}

// --- The PLUGIN's listener registered first: the gesture must still reach the
//     real owner, and the pinned row must never be mistaken for a session row
//     with no session behind it.
{
  const t = await run({ pinned: [S1], order: 'plugin-first' })
  assert.deepEqual(
    t.ownerEntries().map(entry => entry.id).sort(),
    ['dsh-session-top.pin', UNPIN_ID, COLOR_ID].sort(),
    'the bounded retry must publish every entry into a table the owner created late',
  )
  const ownRow = t.document.body.querySelector('[data-stp-row]')
  await rightClick(t.docListeners, ownRow.querySelector('[data-stp-row-title]'))
  assert.equal(t.document.body.querySelector('[data-stp-menu]'), null, 'no plugin menu either way round')
  assert.deepEqual(
    menuLabels(t.document),
    ownRowMenu('取消置顶'),
    'plugin-first must reach exactly the same owner menu',
  )
  assert.equal(t.ownerEvents.length, 1, 'exactly one menu per gesture — the re-delivery must not recurse')
  assert.equal(t.ownerEvents[0].row, t.rows[S1].row, 'still built from the real host row')
  console.log('✔ plugin applies first: same full owner menu, one event, no recursion')
  t.dispose(); t.disposeOwner()
}

// --- The pinned session IS the current one: its real host row is the row the
//     host marks `aria-selected="true"`, and the menu must still be about S2.
{
  const t = await run({ pinned: [S2] })
  const ownRow = t.document.body.querySelector('[data-stp-row]')
  assert.equal(ownRow.getAttribute('aria-current'), 'true', 'the active session is marked on OUR row')
  await rightClick(t.docListeners, ownRow.querySelector('[data-stp-row-title]'))
  assert.deepEqual(
    menuLabels(t.document),
    ownRowMenu('取消置顶'),
  )
  assert.equal(t.ownerEvents[0].row, t.rows[S2].row)
  assert.equal(t.ownerEvents[0].session?.id, S2, 'the CURRENT pinned session, not the other one')
  console.log('✔ pinned session is also the current session: right session, right row')
  t.dispose(); t.disposeOwner()
}

// --- SAME-NAME sessions. `titleFrom` reads the row's own text and
//     `resolveSession` refuses an ambiguous match, so the owner legitimately
//     answers with NO session and drops the session-scoped items. The plugin
//     must neither fabricate one nor pick the wrong same-named session, and a
//     pinned row must behave exactly like the host row it stands in for.
{
  const t = await run({ pinned: [S1], titles: { [S1]: 'Explore', [S2]: 'Explore' } })
  const ownRow = t.document.body.querySelector('[data-stp-row]')
  await rightClick(t.docListeners, ownRow.querySelector('[data-stp-row-title]'))
  assert.equal(t.document.body.querySelector('[data-stp-menu]'), null, 'still the owner, not a plugin menu')
  const labels = menuLabels(t.document)
  assert.deepEqual(
    labels,
    unresolvedMenu(),
    'with an ambiguous title the owner drops the session-scoped items; the plugin adds none of its own',
  )
  assert.ok(!labels.includes('取消置顶'), 'an unresolved session must not offer an Unpin that could hit the wrong one')
  assert.equal(t.ownerEvents[0].session, null, 'and the owner itself reports no session')

  // Parity: the ordinary host row with the same ambiguity loses the same items.
  await rightClick(t.docListeners, t.rows[S1].title, 130, 250)
  assert.deepEqual(
    menuLabels(t.document), labels,
    'a pinned row and the host row it stands in for must offer the SAME menu, ambiguity included',
  )
  console.log('✔ same-named sessions: no fabricated session, and exact parity with the host row')
  t.dispose(); t.disposeOwner()
}

// --- NO owner, on a codex-ui host. The gesture is NOT handed to codex's own
//     handler, and the plugin's own menu is what opens.
//
//     This case used to assert the opposite, and the real artifact is what
//     turned it around. `HOST_MENU` is transcribed from codex-ui's own
//     `sessionMenuItems()` (@michengai/dsh-codex-ui lib/client.js:1757-1833) —
//     it is pinned here precisely so this suite can name what that menu does
//     and does not contain. It contains no Unpin and no row colour, and it
//     cannot be given them: the menu is a PROP of `SessionRow`, not the
//     `sidebar.workspaces.session.menu.item` list, because codex-ui claims that
//     `single` slot itself at priority -1 and the stock entry that declares the
//     list never mounts to render it.
//
//     So forwarding bought the user a pinned row's menu with nothing in it that
//     a pinned row needs, while the plugin's own menu holds exactly those two
//     actions. The plugin's own row is served here; codex's own rows are
//     untouched.
{
  const t = await run({ pinned: [S1], withOwner: false, native: true })
  const ownRow = t.document.body.querySelector('[data-stp-row]')
  await rightClick(t.docListeners, ownRow.querySelector('[data-stp-row-title]'))
  assert.deepEqual(
    t.nativeClaims, [],
    'codex-ui\'s own handler must NOT be handed a pinned row\'s gesture — its menu has no Unpin and no colour',
  )
  assert.equal(
    t.document.body.querySelector('.dcu-host-menu'), null,
    'no host menu is opened behind the plugin\'s',
  )
  assert.equal(t.document.body.querySelector('.dshcm-menu'), null, 'no owner means no owner menu')
  const own = t.document.body.querySelector('[data-stp-menu]')
  assert.ok(own !== null, 'the plugin\'s own menu opens on its own row')
  assert.match(
    own.textContent, /取消置顶/,
    'and the first thing in it is the Unpin this pinned row exists for',
  )
  assert.match(
    own.textContent, /自定义行背景颜色/,
    'and the row colour the host menu could not carry',
  )
  t.dispose()
  console.log('✔ no owner on a codex host: the pinned row is served by the plugin\'s own menu')
}

// --- NO owner and NO native claimer, with the host row still mounted. Nothing
//     serves the gesture, so the plugin must: delivering the re-delivered event
//     is not the same as somebody having claimed it, and treating delivery as a
//     claim is what turned this right-click into silence.
{
  const t = await run({ pinned: [S1], withOwner: false })
  const ownRow = t.document.body.querySelector('[data-stp-row]')
  await rightClick(t.docListeners, ownRow.querySelector('[data-stp-row-title]'))
  assert.deepEqual(t.nativeClaims, [], 'precondition: nothing in the host claims a right-click')
  assert.equal(t.document.body.querySelector('.dshcm-menu'), null, 'no owner means no owner menu')
  assert.equal(t.document.body.querySelector('.dcu-host-menu'), null, 'and no host menu either')
  const own = t.document.body.querySelector('[data-stp-menu]')
  assert.ok(own !== null, 'the plugin-owned fallback menu must still open on its own row')
  assert.match(own.textContent, /取消置顶/)
  assert.equal(
    t.document.body.querySelectorAll('[data-stp-menu]').length, 1,
    'one unclaimed gesture, one fallback menu — the forward must not recurse into a second',
  )
  t.dispose()
  console.log('✔ no owner and no native claimer: the forwarded gesture falls back to Pin/Unpin')
}

// --- TORN DOWN before the deferred claim check runs. The queued callback
//     belongs to a generation that no longer exists and must not claim the
//     gesture or open anything on the page.
{
  const t = await run({ pinned: [S1], withOwner: false })
  const ownRow = t.document.body.querySelector('[data-stp-row]')
  deliverContextMenu(t.docListeners, ownRow.querySelector('[data-stp-row-title]'))
  t.dispose()
  await new Promise(r => { queueMicrotask(() => { setTimeout(r, 0) }) })
  assert.equal(
    t.document.body.querySelector('[data-stp-menu]'), null,
    'a generation unmounted before its deferred check must not open a menu afterwards',
  )
  assert.equal(t.document.body.querySelector('[data-stp-anchor]'), null, 'and must not resurrect its host either')
  console.log('✔ torn down before the deferred check: the dead generation claims nothing')
}

// --- A pinned session whose real host row is gone: degrade to the own menu,
//     never to a fabricated full menu and never to a wrong session.
{
  const t = await run({ pinned: [S1] })
  t.rows[S1].row.remove()
  const ownRow = t.document.body.querySelector('[data-stp-row]')
  await rightClick(t.docListeners, ownRow.querySelector('[data-stp-row-title]'))
  assert.equal(t.document.body.querySelector('.dshcm-menu'), null, 'with no host row the owner must not be fed a substitute')
  assert.ok(t.document.body.querySelector('[data-stp-menu]') !== null, 'the plugin falls back to its own row menu')
  t.dispose(); t.disposeOwner()
}

console.log('\nALL REAL-OWNER CHECKS PASSED')
