/**
 * dsh-session-top — unit coverage.
 *
 * Two things are worth pinning down here:
 *
 *  1. The durable float-up plan, which is the only logic the host executes and
 *     therefore the part a wrong answer silently corrupts the user's sidebar.
 *  2. The constants the browser bundle restates as literals. The bundle cannot
 *     import this module (the client module table resolves only package rows
 *     and platform modules), so a drifted copy is a real and invisible failure;
 *     these assertions are what keep the two in step.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ROW_KEY_ATTR, SESSION_ROW_PREFIX, UNGROUPED_KEY, WORKSPACE_ROW_PREFIX, planFloatToTop,
} from '../src/core.js'

const here = dirname(fileURLToPath(import.meta.url))

/** Replay a move plan the way `insertSessionBefore` would, for assertions. */
function replay(current, moves) {
  const sim = [...current]
  for (const move of moves) {
    sim.splice(sim.indexOf(move.id), 1)
    sim.splice(sim.indexOf(move.beforeId), 0, move.id)
  }
  return sim
}

// --------------------------------------------------------------- float-up

test('planFloatToTop floats the active session above the current leader', () => {
  const ranks = { a: 10, b: 20, c: 5 }
  const moves = planFloatToTop(['a', 'b', 'c'], id => ranks[id] ?? 0)
  assert.deepEqual(moves, [{ id: 'b', beforeId: 'a' }])
  assert.deepEqual(replay(['a', 'b', 'c'], moves), ['b', 'a', 'c'])
})

test('planFloatToTop is the behavior-1 scenario at the durable layer', () => {
  // The session that just acted rises to the top of its account.
  const ranks = { a: 100, b: 50, c: 999 }
  const current = ['a', 'b', 'c']
  const next = replay(current, planFloatToTop(current, id => ranks[id] ?? 0))
  assert.equal(next[0], 'c', 'the session that just acted must lead')
  assert.deepEqual(new Set(next), new Set(current), 'no session may be lost')
})

test('planFloatToTop preserves the relative order of the rest', () => {
  // The regression this guards: a full re-sort would reshuffle a manual drag
  // order on every background activity event.
  const ranks = { a: 1, b: 99, c: 2 }
  const current = ['a', 'c', 'b']
  const next = replay(current, planFloatToTop(current, id => ranks[id] ?? 0))
  assert.deepEqual(next, ['b', 'a', 'c'])
  assert.deepEqual(next.slice(1), ['a', 'c'], 'non-active members keep their relative order')
})

test('planFloatToTop is a no-op when the leader is already the most active', () => {
  const ranks = { a: 50, b: 10, c: 5 }
  assert.deepEqual(planFloatToTop(['a', 'b', 'c'], id => ranks[id] ?? 0), [])
})

test('planFloatToTop leaves an account with no activity untouched', () => {
  // An account the user arranged by hand and never used must be left alone.
  assert.deepEqual(planFloatToTop(['a', 'b', 'c'], () => 0), [])
})

test('planFloatToTop treats a negative rank as no rank', () => {
  assert.deepEqual(planFloatToTop(['a', 'b'], () => -1), [])
})

test('planFloatToTop is a no-op on a single-member or empty account', () => {
  assert.deepEqual(planFloatToTop(['only'], () => 99), [])
  assert.deepEqual(planFloatToTop([], () => 99), [])
})

test('planFloatToTop picks the single most active member, not merely any', () => {
  const ranks = { a: 1, b: 500, c: 300 }
  const moves = planFloatToTop(['a', 'b', 'c'], id => ranks[id] ?? 0)
  assert.equal(moves.length, 1)
  assert.equal(moves[0].id, 'b', 'only the most active session moves')
})

// --------------------------------------------------------- drift guards

test('client bundle literals match core.js', async () => {
  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  assert.ok(
    source.includes(`SESSION_ROW_PREFIX: '${SESSION_ROW_PREFIX}'`),
    'SESSION_ROW_PREFIX drifted',
  )
  assert.ok(
    source.includes(`WORKSPACE_ROW_PREFIX: '${WORKSPACE_ROW_PREFIX}'`),
    'WORKSPACE_ROW_PREFIX drifted',
  )
  assert.ok(source.includes(`ROW_KEY_ATTR: '${ROW_KEY_ATTR}'`), 'ROW_KEY_ATTR drifted')
})

// The real desktop runs @michengai/dsh-codex-ui, whose patch disables the stock
// ui-sidebar. A first release shipped official-only selectors and rendered
// nothing there. These assertions pin the codex-ui contract so that regression
// cannot come back silently.
// The real machine booted cleanly and then rendered nothing at all — the fiber
// activated during the bootstrap stage, `workspaces` was not published yet, and
// apply returned early. Because that early return also skipped the log, the
// failure was completely silent.
test('apply defers mounting until workspaces is published, and always logs', async () => {
  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')

  // The gate must be cordis's own mechanism, not a hand-rolled poll.
  assert.ok(
    /ctx\.inject\(\['workspaces'\],/.test(source),
    'apply must use ctx.inject(["workspaces"], …) to defer mounting',
  )
  assert.ok(
    /const inject = \[\]/.test(source),
    'the plugin must declare no required services: a named dependency would '
    + 'leave the entry PENDING and fail the whole boot',
  )
  // Diagnostics must go to console, which is what reaches the desktop err.log.
  assert.ok(
    /console\.info\(`\$\{tag\}/.test(source),
    'mount success must log through console.info',
  )
  assert.ok(
    /console\.warn\(`\$\{tag\}/.test(source),
    'degradation must log through console.warn',
  )
  assert.ok(
    /activated; waiting for the workspaces controller service/.test(source),
    'apply must announce that it is waiting, before the controller exists',
  )
  assert.ok(
    /still unpublished after/.test(source),
    'a controller that never arrives must be reported, not left silent',
  )
  // The early-return that caused the silence must not be back: apply must
  // contain no `return` before the ctx.inject call, whatever it tests.
  const applyStart = source.indexOf('function apply(ctx)')
  const injectCall = source.indexOf("ctx.inject(['workspaces']", applyStart)
  const mountStart = source.indexOf('function mount(ctx, warn)')
  assert.ok(applyStart >= 0 && injectCall > applyStart && injectCall < mountStart, 'apply must reach ctx.inject')
  let beforeInject = source.slice(applyStart, injectCall)
// Drop the one legitimate early return: the no-DOM guard, a property of the
// platform rather than of service availability.
beforeInject = beforeInject.replace(
  /if \(typeof document === 'undefined'\) \{[\s\S]*?\n\s*\}/,
  '',
)
const earlyReturns = beforeInject.match(/^\s*return\b.*$/gm) ?? []
assert.deepEqual(
  earlyReturns,
  [],
  'apply must not return before ctx.inject — an early return is exactly how the plugin went silent',
)
  assert.ok(
    !/ctx\.get\('workspaces'\)\s*===\s*undefined/.test(beforeInject),
    'apply must not gate on the workspaces service being present yet',
  )
})

// codex-ui's row menu died twice because the plugin decided the sidebar once,
// at mount, before codex had rendered — and because its OWN region rows
// advertised the stock sidebar (`data-row-key="session:…"`), so on codex with
// no host rows mounted, detection flipped to the stock flavor and right-click
// took the own-menu branch, whose stopPropagation killed the host menu.
test('flavor detection is re-probed, never decided once at mount', async () => {
  const raw = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  assert.match(
    source,
    /const currentFlavor = \(now\)/,
    'a re-probing accessor with a short memo must exist',
  )
  assert.ok(
    source.includes('invalidateFlavor()'),
    'reconcile must invalidate the memo so a late-mounting sidebar is seen',
  )
  assert.ok(
    /sidebar flavor: /.test(source),
    'a flavor change must be logged so the real machine can be read',
  )
  // The mount-time summary must not freeze the flavor it saw. Checking that
  // the summary *calls* the helper is not enough — the helper itself could be
  // frozen — so assert the helper re-probes on every call.
  const helper = source.slice(source.indexOf('const flavorId = () =>'), source.indexOf('const phaseOf'))
  assert.ok(helper.includes('currentFlavor('), 'flavorId must re-probe, not cache a mount-time value')
  const summary = source.slice(source.indexOf('const summary = () =>'))
  assert.ok(
    summary.includes('flavorId()'),
    'the boot summary must read the flavor lazily, not capture it at mount',
  )
  // Region rows must not impersonate a host sidebar.
  const makeRow = source.slice(source.indexOf('const makeRow ='), source.indexOf('const renderRegion'))
  assert.ok(!makeRow.includes('data-row-key'), 'region rows must not carry data-row-key')
  assert.ok(!makeRow.includes('data-dcu-session'), 'region rows must not carry data-dcu-session')
  assert.ok(makeRow.includes('data-stp-row'), 'region rows are matched by data-stp-row')
})

test('an unknown sidebar is observe-only in the contextmenu chain', async () => {
  const raw = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const start = source.indexOf('const onContextMenu = (event) => {')
  const end = source.indexOf('const augmentNativeMenu', start)
  assert.ok(start > 0 && end > start, 'onContextMenu must exist')
  const handler = source.slice(start, end)

  // Exactly two suppressions, in the documented order: our own rows (which no
  // host menu competes for) and the positively-identified stock sidebar.
  assert.equal(
    (handler.match(/preventDefault\(\)/g) ?? []).length,
    2,
    'exactly two branches may suppress the native menu: own rows, and the stock sidebar',
  )
  assert.equal((handler.match(/stopPropagation\(\)/g) ?? []).length, 2)

  // Order matters: own-row check → null-flavor bail → codex graft → official.
  // The two suppressions are the own-row branch (position 1) and the stock
  // branch (position 2); the null bail and the graft must sit between them.
  const ownRow = handler.indexOf("[data-stp-row]")
  const nullBail = handler.indexOf('if (flavor === null) return')
  const graft = handler.indexOf('augmentNativeMenu(id)')
  const suppressions = []
  for (const m of handler.matchAll(/preventDefault\(\)/g)) suppressions.push(m.index)
  assert.equal(suppressions.length, 2)
  const [ownSuppress, officialSuppress] = suppressions
  assert.ok(ownRow > 0 && ownRow < ownSuppress, 'the own-row branch suppresses right after its match')
  assert.ok(ownSuppress < nullBail, 'the null-flavor bail comes after the own-row branch')
  assert.ok(nullBail < graft && graft < officialSuppress, 'the codex graft sits between the bails')
  assert.ok(
    handler.slice(officialSuppress).includes('openMenu(id'),
    'the final suppression belongs to the stock-sidebar own-menu branch',
  )

  // Nothing between the null-flavor bail and the graft may touch the event.
  const observeOnly = handler.slice(nullBail, graft)
  for (const forbidden of ['preventDefault', 'stopPropagation', 'stopImmediatePropagation']) {
    assert.ok(!observeOnly.includes(forbidden), `observe-only span must not call ${forbidden}`)
  }
})

test('both sidebar renderings are supported and detected by attribute', async () => {
  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  // codex-ui: session rows carry the raw id in data-dcu-session; group heads are
  // .dcu-wb-project-head with aria-expanded.
  assert.ok(source.includes("'[data-dcu-session]'"), 'codex-ui session selector missing')
  assert.ok(source.includes(".dcu-wb-project'"), 'codex-ui project container missing')
  assert.ok(source.includes('.dcu-wb-project-head'), 'codex-ui group head missing')
  assert.ok(
    source.includes('data-dcu-session="${cssEscape(id)}"'),
    'codex-ui hide rule must target the raw session id attribute',
  )
  // Stock sidebar: data-row-key prefixes.
  assert.ok(
    source.includes(`'[${ROW_KEY_ATTR}^="${SESSION_ROW_PREFIX}"]'`),
    'official session selector missing',
  )
  assert.ok(
    source.includes(`'${WORKSPACE_ROW_PREFIX}`),
    'official group-head lookup must key on the workspace row prefix',
  )
  // Detection is by attribute existence, not by whole-class matching.
  assert.ok(
    source.includes('document.querySelector(FLAVOR_CODEX.sessionSelector)'),
    'flavor detection must probe attributes',
  )
  assert.match(source, /FLAVOR_CODEX = \{/, 'codex flavor must be defined')
  assert.match(source, /FLAVOR_OFFICIAL = \{/, 'official flavor must be defined')
})

test('theme tokens follow the detected sidebar', async () => {
  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  // codex-ui exposes --dcu-sidebar-*, the stock sidebar the --dsh-* family.
  assert.ok(source.includes('--dcu-sidebar-hover'), 'codex-ui hover token missing')
  assert.ok(source.includes('--dcu-sidebar-primary'), 'codex-ui primary token missing')
  assert.ok(source.includes('--dsh-sidebar-hover'), 'official hover token missing')
  // The indirection must be a real custom property, not a data attribute.
  assert.match(
    source,
    /setProperty\(prop, `var\(\$\{token\}\)`\)/,
    'tokens must be wired through CSS custom properties so theme switches still flow',
  )
})

test('codex-ui keeps its own context menu and gains a pin row', async () => {
  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  // codex-ui opens a session menu on right-click with no pin in it; replacing
  // that menu would delete rename/archive/fork, so the plugin grafts a row on.
  assert.match(source, /nativeContextMenu: true/, 'codex flavor must declare its native menu')
  assert.ok(
    source.includes('[data-menu-material][role="menu"]'),
    'the host menu surface is what the pin row must attach to',
  )
  assert.ok(source.includes('data-stp-pin-item'), 'the grafted pin row must be identifiable')
  assert.ok(
    /if \(flavor\.nativeContextMenu\) \{[\s\S]*?augmentNativeMenu\(id\)\s*\n\s*return/.test(source),
    'codex path must augment, not replace: no preventDefault before augmentNativeMenu',
  )
})

// The row menu died on the real machine: the plugin was supposed to pass the
// contextmenu event through untouched, and anything that interrupts it during
// document-capture stops React (which delegates at the root) from ever seeing
// it. test/sidebar-dom.mjs proves it behaviourally; this pins the source.
test('the codex right-click path never touches the event', async () => {
  const raw = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const start = source.indexOf('const onContextMenu = (event) => {')
  const nullBail = source.indexOf('if (flavor === null) return', start)
  const graft = source.indexOf('augmentNativeMenu(id)', start)
  assert.ok(start > 0 && nullBail > start && graft > nullBail, 'the codex branch must be locatable')

  // Everything from the flavor bail up to the graft covers BOTH the unknown
  // sidebar and the codex sidebar. Neither may suppress the native menu: React
  // delegates at the root container, so any capture-phase interruption stops a
  // host menu from ever opening.
  const observeOnly = source.slice(nullBail, graft)
  for (const forbidden of ['preventDefault', 'stopPropagation', 'stopImmediatePropagation']) {
    assert.ok(
      !observeOnly.includes(forbidden),
      `the codex/unknown path must not call ${forbidden} — it would kill the host menu`,
    )
  }
  assert.ok(graft > nullBail, 'the codex path must still reach a graft')
})

// A failed insertRule left the stylesheet EMPTY, because the old code deleted
// every rule (static ones included) before the insert that threw.
test('pin rules are written via textContent, never the CSSOM', async () => {
  const raw = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.ok(
    !/\.insertRule\(|\.deleteRule\(|\.cssRules/.test(source),
    'CSSOM rule editing is banned: a throwing insertRule after a delete loop '
    + 'leaves the stylesheet empty and the region unstyled',
  )
  assert.ok(source.includes('tag.textContent = css'), 'pin rules must be written through textContent')
  assert.ok(
    source.includes("data-stp-sheet', name"),
    'static and dynamic rules must live in separate <style> elements',
  )
  // Errors must be readable; String(err) on a DOMException is useless.
  assert.ok(
    /function describeError/.test(source) && /`\$\{name\}: \$\{message\}`/.test(source),
    'throwables must be reported as name: message, not [object DOMException]',
  )
  assert.ok(
    !/pin rule injection failed:', error\)/.test(raw),
    'the pin-rule failure log must not stringify the raw error object',
  )
})

// ------------------------------------------------------- package metadata

test('package metadata targets the 0.2.x line and never an upper-bounded 0.2', async () => {
  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  const peers = manifest.peerDependencies ?? {}
  for (const [name, range] of Object.entries(peers)) {
    if (!name.startsWith('@deepseek-ai/')) continue
    assert.ok(
      !range.includes('<0.2.0'),
      `${name} pins <0.2.0, which shadows 0.2.x packages at runtime: ${range}`,
    )
  }
  assert.equal(peers['@deepseek-ai/cordis'], '>=4.0.4 <5')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.exports['./client'], './src/client.js')
  assert.equal(manifest.exports['.'], './src/index.js')
})

// Regression guard for TWO real boot failures on the desktop shell:
//
// 1. An earlier revision declared a `dsh.client.inject` list naming
//    @deepseek-ai/dsh-client-ui-sidebar and friends — unresolvable in a desktop
//    profile, so the row sat in FiberState.LOADING forever: "web boot: 1 entry
//    did not activate".
// 2. Measured on dsh-desktop-next 2.0.17-next (2026-10-13): ANY non-platform
//    member in dsh.client — `inject: ['@deepseek-ai/dsh-client-runtime']` or a
//    self-invented `immediately: true` — stalled the Electron shell's startup
//    past its 60 s watchdog (recovery mode), while `{ platform: 'web' }` alone
//    and no client block at all both reached "Host ready" in ~12 s. The host
//    process itself was never blocked (an isolated fork of lib/host.js booted
//    fine with the same tree); the stall lives in the shell's client-graph
//    pipeline. The client half therefore declares ONLY the platform.
//
// A self-invented `immediately: true` also pins the row into a prefetch tier
// the plugin does not need; it stays gone.
test('dsh.client declares only the platform — no inject rows, no prefetch tier', async () => {
  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  const client = manifest.dsh?.client ?? {}
  assert.equal(client.platform, 'web', 'the browser half needs platform "web"')
  assert.equal(
    client.inject,
    undefined,
    'dsh.client.inject wedges the desktop shell boot past its 60 s watchdog '
    + '(measured 2026-10-13, dsh-desktop-next 2.0.17-next); the client half is '
    + 'self-contained and needs no module-graph rows',
  )
  assert.equal(
    client.immediately,
    undefined,
    'no self-invented prefetch tier: this plugin does not need to boot before the first render',
  )
  assert.deepEqual(client.external ?? [], [], 'the bundle requests no non-baseline module rows')
})

// The desktop shell materializes this factory while the module system is still
// coming up. A `require` against a word the module table does not hold throws
// synchronously right there, the entry never reaches its boot-ready promise,
// and the shell's watchdog drops the whole app into recovery mode — which is
// exactly how this plugin hung startup. The factory therefore requires NOTHING
// and takes no require parameter at all.
test('the client bundle requires no module and takes no require parameter', async () => {
  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  const required = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map(m => m[1])
  assert.deepEqual(
    required,
    [],
    'the bundle must require nothing: a synchronous throw during factory materialization '
    + 'never settles the entry\'s boot-ready promise and hangs the desktop shell',
  )
  assert.match(
    source,
    /factory:\s*\(\)\s*=>/,
    'the factory must be declared with zero parameters — it has no require to receive',
  )
})

test('the cordis bundle patch targets this package by name', async () => {
  const patch = await readFile(join(here, '..', 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /id:\s*session-top/, 'bundle row id must be session-top')
  assert.match(patch, /name:\s*dsh-session-top/, 'bundle row name must be the package name')
})

// --------------------------------------------------------- plugin contract

test('the host half exposes the cordis plugin contract', async () => {
  const host = await import('../src/index.js')
  assert.equal(host.name, 'session-top')
  assert.equal(typeof host.apply, 'function')
  // An empty inject is deliberate: a pending entry fails the whole boot.
  assert.deepEqual(host.inject, [])
  assert.equal(typeof host.defaultConfig, 'object')
})

test('the activity basis decides what counts as activity', async () => {
  const { countsAsActivity } = await import('../src/index.js')
  const toolCommit = { type: 'assistant/message', data: {} }
  const userMessage = { type: 'user/message', data: { source: { kind: 'user' } } }
  const agentMessage = { type: 'user/message', data: { source: { kind: 'agent' } } }

  // 'any' widens the basis to every committed event, which is what keeps a
  // running task floating to the top.
  assert.equal(countsAsActivity('any', toolCommit), true)
  assert.equal(countsAsActivity('any', userMessage), true)

  // 'prompt' narrows it to the user's own messages, matching the GUI labels.
  assert.equal(countsAsActivity('prompt', userMessage), true)
  assert.equal(countsAsActivity('prompt', agentMessage), false)
  assert.equal(countsAsActivity('prompt', toolCommit), false)
  assert.equal(countsAsActivity('prompt', undefined), false)
  assert.equal(countsAsActivity('prompt', {}), false)
})

test('the loopback fence rejects non-loopback and cross-site requests', async () => {
  const { isLoopbackAddress, isLoopbackHostname, isLoopbackRequest } =
    await import('../src/routes.js')

  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.9.9.9'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('10.0.0.5'), false)
  assert.equal(isLoopbackAddress('example.com'), false)
  assert.equal(isLoopbackAddress(undefined), false)

  assert.equal(isLoopbackHostname('localhost'), true)
  assert.equal(isLoopbackHostname('127.0.0.1'), true)
  assert.equal(isLoopbackHostname('evil.test'), false)

  const ok = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:8080' },
  }
  assert.equal(isLoopbackRequest(ok), true)
  assert.equal(isLoopbackRequest({ ...ok, headers: { ...ok.headers, 'sec-fetch-site': 'cross-site' } }), false)
  assert.equal(isLoopbackRequest({ ...ok, headers: { ...ok.headers, origin: 'http://evil.test' } }), false)
  assert.equal(isLoopbackRequest({ ...ok, socket: { remoteAddress: '10.0.0.5' } }), false)
  // A forged X-Forwarded-For must not buy access.
  assert.equal(isLoopbackRequest({
    socket: { remoteAddress: '10.0.0.5' },
    headers: { host: '127.0.0.1:8080', 'x-forwarded-for': '127.0.0.1' },
  }), false)
})

// ----------------------------------------------------------- client bundle

test('the client bundle is a self-registering factory, not an ES module', async () => {
  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  assert.ok(source.startsWith('/**'), 'bundle should keep its leading doc comment')
  assert.ok(
    source.includes('window.__ModuleLoader__.load({'),
    'bundle must self-register through the module loader',
  )
  assert.ok(source.includes("id: 'dsh-session-top'"), 'bundle id must equal the package name')
  assert.ok(
    !/^\s*import\s+.*\s+from\s+/m.test(source),
    'a client bundle cannot use static import: it resolves through the injected require',
  )
})

// The bundle builds its whole visible surface with document.createElement and
// styles it through its own injected <style>, so a stray module table word —
// or a stray static import — is always a regression, never an accepted input.
test('the client bundle builds plain DOM, with no renderer and no import', async () => {
  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  for (const forbidden of ['React.createElement', 'createRoot(', 'jsx(']) {
    assert.ok(
      !source.includes(forbidden),
      `${forbidden} is not available: the bundle requires no module, so the pinned region `
      + 'and the context menu are built as plain DOM nodes',
    )
  }
  assert.ok(
    source.includes('document.createElement('),
    'the region and menu must be built with createElement',
  )
  assert.ok(
    !/^\s*import\s+.*\s+from\s+/m.test(source),
    'a client bundle cannot use static import: it would not resolve at all',
  )
})

test('the client bundle exports the cordis plugin contract', async () => {
  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  assert.ok(source.includes('return { name, inject, apply }'))
  assert.ok(/const name = 'dsh-session-top'/.test(source))
  // An empty inject is deliberate: a pending entry fails the whole boot.
  assert.ok(/const inject = \[\]/.test(source))
  assert.ok(/function apply\(ctx\)/.test(source))
})

test('the pinned region is styled outside the animated list', async () => {
  // AnimatedRows reads every [data-row-key] inside its list; region rows
  // carrying the same session:<id> key inside the list would be cloned into
  // its exit overlay and visibly dissolve.
  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  const hostFn = source.slice(source.indexOf('const findTreeHost'), source.indexOf('let regionEl'))
  assert.match(hostFn, /tree\.parentElement/, 'the host must be derived by walking up from the list')
})

// The failure this package actually shipped with: reading a service as
// `ctx.<name>` on a cordis Context Proxy throws
// `cannot get property "<name>" without inject`. That throw escapes apply(),
// cordis logs it, and the fiber is stranded in FiberState.LOADING — reported at
// boot as "web boot: 1 entry did not activate". `ctx.get(name)` is the only
// safe accessor. test/cordis-activation.mjs proves the behaviour; this
// assertion keeps the source honest between runs.
test('services are resolved with ctx.get, never with bare ctx.<name>', async () => {
  const source = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  // Strip comments so the prose explaining the rule cannot satisfy the check.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

  // Only these are safe without `get`: `effect`, `inject`, `get`, `plugin` and
  // `extend` are Context mixins or the sanctioned accessors themselves. Anything
  // else is a SERVICE, and services must go through ctx.get.
  const allowed = new Set(['effect', 'inject', 'get', 'plugin', 'extend'])
  const offenders = []
  for (const match of code.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    const property = match[1]
    if (allowed.has(property)) continue
    offenders.push(property)
  }
  assert.deepEqual(
    [...new Set(offenders)],
    [],
    'these must be resolved through ctx.get(...): a bare ctx.<service> read throws on a cordis Proxy',
  )
})