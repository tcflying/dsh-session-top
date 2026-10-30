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
  ROW_KEY_ATTR, SESSION_ROW_PREFIX, UNGROUPED_KEY, WORKSPACE_ROW_PREFIX, planFloatDirty, planFloatToTop,
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

// -------------------------------------------------- batch plan contract
//
// R18a: what the batch plan is allowed to compare, stated once so no later lane
// redefines it. A pass consumes a batch of FACTS, `{id, eventTime}`, and two
// fields that look interchangeable are not:
//
//   eventTime  the EVENT's own clock, in ms, as the host reported it. The only
//              primary order. The receive time never overwrites it: a commit
//              that arrives late carries its own clock and is placed by it.
//   sequence   the plugin's monotonic arrival counter. Identity and freshness
//              ONLY — telling two facts of one session apart, and stopping a
//              refused fact from overwriting a newer one. It is deliberately
//              NOT an input here and must never become one.
//
// The clause R18a had to settle: eventTime has millisecond resolution, so two
// facts in the same millisecond are a genuine tie, and arrival order is NOT
// consulted to break it — a tie keeps the order the ACCOUNT is in right now.
// That is the rule `planFloatToTop` has always applied with its strict `>`,
// and the two must not drift apart. Everything below pins one clause.

test('planFloatDirty floats the newest eventTime, not the leading session', () => {
  const current = ['a', 'b', 'c']
  // b sits nearer the top of the account but acted earlier. The fact wins.
  const moves = planFloatDirty(current, [{ id: 'b', time: 50 }, { id: 'c', time: 100 }])
  const expected = [{ id: 'c', beforeId: 'a' }, { id: 'b', beforeId: 'a' }]
  assert.deepEqual(moves, expected)
  assert.deepEqual(replay(current, moves), ['c', 'b', 'a'])

  // `seq` and `at` are ARRIVAL facts, and in both batches below they point at
  // b: c acted last but arrived early. They exist to kill an ordering that lets
  // an arrival fact OVERRIDE eventTime, as a primary key or as a tie-break. The
  // two batches carry mirror assignments on purpose — with one assignment a
  // descending key and an ascending key cannot be told apart, because one of
  // them agrees with the account order and survives silently.
  assert.deepEqual(planFloatDirty(current, [
    { id: 'b', time: 50, seq: 9, at: 900 }, { id: 'c', time: 100, seq: 1, at: 100 },
  ]), expected)
  assert.deepEqual(planFloatDirty(current, [
    { id: 'c', time: 100, seq: 9, at: 900 }, { id: 'b', time: 50, seq: 1, at: 100 },
  ]), expected)
})

test('an exact same-millisecond tie keeps the order the account is in', () => {
  const current = ['a', 'b', 'c']
  const moves = planFloatDirty(current, [{ id: 'b', time: 100 }, { id: 'c', time: 100 }])
  assert.deepEqual(moves, [{ id: 'b', beforeId: 'a' }, { id: 'c', beforeId: 'a' }])
  assert.deepEqual(replay(current, moves), ['b', 'c', 'a'])
})

test('a same-millisecond tie ignores the batch order, the sequence and the arrival clock', () => {
  // Two accounts that mirror each other: on ['a','b','c'] b leads c, on
  // ['a','c','b'] c leads b. Each is fed BOTH assignments of the arrival facts.
  //
  // One account cannot do this job. Whichever way its two tied members sit, one
  // direction of a `seq`/`at` tie-break agrees with the account order and
  // survives silently, leaving an ASCENDING key indistinguishable from a
  // DESCENDING one — the gap an independent review measured against this file.
  // The PAIR of assignments is what makes both directions die.
  for (const [current, lead, follow] of [
    [['a', 'b', 'c'], 'b', 'c'],
    [['a', 'c', 'b'], 'c', 'b'],
  ]) {
    const expected = [{ id: lead, beforeId: current[0] }, { id: follow, beforeId: current[0] }]
    // Two facts, same millisecond, arrival facts set by the caller.
    const tied = (leadSeq, followSeq, leadAt, followAt) => [
      { id: lead, time: 100, seq: leadSeq, at: leadAt },
      { id: follow, time: 100, seq: followSeq, at: followAt },
    ]
    const batches = [
      // No arrival facts at all: the batch order must not decide either.
      [{ id: lead, time: 100 }, { id: follow, time: 100 }],
      [{ id: follow, time: 100 }, { id: lead, time: 100 }],
      // The follower arrived LAST, then FIRST. Arrival order is not evidence of
      // event order — a late-delivered commit arrives later carrying an older
      // clock — so neither of them may promote it over the account order.
      tied(1, 9, 100, 900),
      tied(9, 1, 900, 100),
    ]
    for (const batch of batches) {
      assert.deepEqual(
        planFloatDirty(current, batch),
        expected,
        `${current.join('')} must keep its own order on ${JSON.stringify(batch)}`,
      )
    }
    // A tie the account already satisfies must produce no host write at all.
    assert.deepEqual(planFloatDirty(current, [
      { id: follow, time: 100, seq: 9, at: 900 },
      { id: current[0], time: 100, seq: 1, at: 100 },
      { id: lead, time: 100 },
    ]), [])
  }
})

test('a same-millisecond tie resolves the way planFloatToTop resolves it', () => {
  const current = ['a', 'b', 'c']
  const times = { a: 0, b: 100, c: 100 }
  const legacy = planFloatToTop(current, id => times[id] ?? 0)
  const batch = planFloatDirty(current, [{ id: 'b', time: 100 }, { id: 'c', time: 100 }])
  assert.deepEqual(legacy, [{ id: 'b', beforeId: 'a' }])
  assert.equal(batch[0].id, legacy[0].id, 'both plans must pick the same session')
})

test('planFloatToTop keeps its own tie rule; R18a does not change it', () => {
  // Strict `>`: a session already leading its account keeps a tie against a
  // member that ties with it. This is the compat anchor — the batch plan above
  // mirrors this rule, and the next lane must not "fix" this one.
  assert.deepEqual(planFloatToTop(['a', 'b', 'c'], id => ({ a: 100, b: 100, c: 0 })[id] ?? 0), [])
  // Among tied members, the one that comes first in the account wins.
  assert.deepEqual(
    planFloatToTop(['a', 'b', 'c'], id => ({ a: 0, b: 100, c: 100 })[id] ?? 0),
    [{ id: 'b', beforeId: 'a' }],
  )
})

test('an older fact cannot overtake a newer one in the same batch', () => {
  // a acts last (100) and sits at the bottom; b leads the account but its fact
  // is older (50). The newer fact owns the top; the older one is not chased.
  const current = ['b', 'c', 'a']
  const moves = planFloatDirty(current, [{ id: 'a', time: 100 }, { id: 'b', time: 50 }])
  assert.deepEqual(moves, [{ id: 'a', beforeId: 'b' }])
  assert.deepEqual(replay(current, moves), ['a', 'b', 'c'], 'c carries no fact and never moves')
})

test('an older fact produces no host write when a newer fact already leads', () => {
  assert.deepEqual(planFloatDirty(['a', 'b', 'c'], [{ id: 'a', time: 100 }, { id: 'b', time: 50 }]), [])
})

test('the plan is a pure function of the batch; no rank survives a pass', () => {
  const current = ['a', 'b', 'c']
  const first = planFloatDirty(current, [{ id: 'b', time: 100 }])
  // A later batch naming only `a` is planned from that fact alone. Keeping no
  // rank between calls is what stops a stale fact from re-asserting an order an
  // earlier batch already spent — the R01 defect, at the pure layer.
  const second = planFloatDirty(current, [{ id: 'a', time: 5 }])
  assert.deepEqual(first, [{ id: 'b', beforeId: 'a' }])
  assert.deepEqual(second, [])
})

test('a fact for a session that is no longer a member is never written back', () => {
  // A session that migrated to another workspace is in the batch but not in
  // this account. It is planned where it is now; this plan must not chase it
  // into the account it left, which the host would refuse mid-pass anyway.
  assert.deepEqual(planFloatDirty(['a', 'b', 'c'], [{ id: 'zz', time: 999 }]), [])
})

test('two facts for one id resolve to the first; freshness is the caller\'s', () => {
  const current = ['a', 'b', 'c']
  // DEFENSIVE ONLY, and pinned because the answer is NOT "the newer one": the
  // first in batch order. The host hands over a batch built as a Map keyed by
  // id, so this cannot happen there; R18a adds no max() because a max() would
  // be a freshness rule the host already owns (its sequence guard refuses to
  // let an older fact overwrite a newer one).
  const expected = [{ id: 'b', beforeId: 'a' }]
  assert.deepEqual(planFloatDirty(current, [{ id: 'b', time: 100 }, { id: 'b', time: 1 }]), expected)
  assert.deepEqual(planFloatDirty(current, [{ id: 'b', time: 1 }, { id: 'b', time: 100 }]), expected)
})

test('core does not validate eventTime; the host is the trust boundary', () => {
  // What this module does NOT do, pinned so no later lane adds it quietly:
  //   - a negative eventTime is not "no activity": it floats like any fact,
  //     while `planFloatToTop` reads a negative rank as no rank. That
  //     asymmetry is real and stays real here.
  //   - a non-finite eventTime is not filtered. It leaves the comparison
  //     unordered, so the account order stops deciding and the BATCH order
  //     decides — the very leak the tie rule exists to prevent.
  // The host is what keeps both unreachable: it substitutes `Date.now()` for
  // any non-finite `event.time` before a fact is ever recorded.
  assert.deepEqual(planFloatDirty(['a', 'b', 'c'], [{ id: 'b', time: -5 }]), [{ id: 'b', beforeId: 'a' }])
  const nan = id => [{ id, time: Number.NaN }]
  assert.deepEqual(
    planFloatDirty(['a', 'b', 'c'], [...nan('b'), ...nan('c')]),
    [{ id: 'b', beforeId: 'a' }, { id: 'c', beforeId: 'a' }],
  )
  assert.deepEqual(
    planFloatDirty(['a', 'b', 'c'], [...nan('c'), ...nan('b')]),
    [{ id: 'c', beforeId: 'a' }, { id: 'b', beforeId: 'a' }],
    'a non-finite time hands the tie to the batch order — pinned as the known hazard',
  )
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
  const end = source.indexOf('const ownRowId', start)
  assert.ok(start > 0 && end > start, 'onContextMenu must exist')
  const handler = source.slice(start, end)

  // Own rows and known native sessions without a shared owner may claim eagerly.
  // The remaining host fallback must wait for dispatch. Unknown rows never claim.
  assert.equal((handler.match(/preventDefault\(\)/g) ?? []).length, 3)
  assert.equal((handler.match(/stopPropagation\(\)/g) ?? []).length, 2)

  const ownRow = handler.indexOf("[data-stp-row]")
  const handledBail = handler.indexOf('if (event.defaultPrevented === true) return')
  const nullBail = handler.indexOf('if (flavor === null) return')
  const nativeGuard = handler.indexOf('if (flavor.nativeContextMenu === true')
  const deferred = handler.indexOf('afterDispatch(() => {')
  const suppressions = []
  for (const m of handler.matchAll(/preventDefault\(\)/g)) suppressions.push(m.index)
  const [ownSuppress, nativeSuppress, fallbackSuppress] = suppressions
  assert.ok(ownRow > 0 && ownRow < ownSuppress, 'own-row suppression follows its match')
  assert.ok(handledBail < ownSuppress, 'already-handled events bail before any suppression')
  assert.ok(ownSuppress < nullBail && nullBail < nativeGuard, 'unknown sidebars bail before native fallback')
  assert.ok(nativeGuard < nativeSuppress && nativeSuppress < deferred, 'native fallback claims before React dispatch')
  const nativeCondition = handler.slice(nativeGuard, nativeSuppress)
  assert.ok(nativeCondition.includes('Object.hasOwn(sessionById(), id)'), 'unknown native IDs must not be claimed')
  assert.ok(nativeCondition.includes('sharedMenuServing(sharedMenuApi()) === false'), 'live shared menus retain their full owner')
  assert.ok(handler.indexOf('publishSharedMenu()') < nativeGuard, 'publish entries before probing either load order')
  assert.ok(deferred < fallbackSuppress, 'remaining fallback suppresses inside its deferred callback')
  assert.ok(
    handler.slice(deferred, fallbackSuppress).includes('if (event.defaultPrevented === true) return'),
    'deferred fallback must re-read event ownership after dispatch',
  )

  const observeOnly = handler.slice(handler.indexOf('openOwnRowMenu(ownRow'), nativeGuard)
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

// The right-click menu belongs to @baihejiangnan/dsh-session-context-menu,
// whose client half renders `.dshcm-menu[role=menu]` from a shared extension
// table. Grafting into `[data-menu-material]` matched ZERO of those menus, so
// the pin affordance never appeared anywhere; the entries now go through the
// owner's own registry instead. test/shared-menu.mjs proves that behaviourally
// against a faithful mock of that owner; this pins the source contract.
test('pin actions are published into the shared context-menu table', async () => {
  const raw = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.ok(
    source.includes("Symbol.for('dsh.session-context-menu.extensions')"),
    "the owner's registry key must be the well-known symbol",
  )
  assert.ok(
    /api\.register\(pinEntry\(\)\)/.test(source) && /api\.register\(unpinEntry\(\)\)/.test(source),
    'both pin and unpin must be registered through the owner\'s own register()',
  )
  assert.ok(
    !/globalThis\[CTX_MENU_KEY\]\s*=/.test(source),
    'the table belongs to the owner: this plugin must never create or replace one',
  )
  assert.ok(
    !source.includes('[data-menu-material]'),
    'the graft is gone: no foreign menu surface may be searched for or written into',
  )
  assert.ok(source.includes('data-stp-pin-item'), "the plugin's own fallback menu item must stay identifiable")
  // Entries carry the owner's own call shape: visible({session,row}) gates them
  // and run({session,row,sessions,workspaces,close}) performs them.
  assert.ok(/visible:\s*\(\{ session \}/.test(source), 'entries must expose visible({session})')
  assert.ok(/run:\s*\(\{ session, close \}/.test(source), 'entries must expose run({session,close})')
  // Registration is bounded and cleaned up: a late owner is retried until it
  // takes, and teardown hands the table back exactly as it was found.
  assert.ok(source.includes('scheduleSharedMenu'), 'a late owner must be retried for')
  assert.ok(
    /if \(releaseSharedMenu !== null\) releaseSharedMenu\(\)/.test(source),
    'teardown must unregister both entries',
  )
  // Ownership must NOT be read off the table: it outlives its owner (the table
  // is only deleted when it is empty, and our entries keep it non-empty), so
  // "our ids are in list()" says nothing about the owner still being loaded —
  // believing it silenced every right-click after an owner reload.
  assert.ok(
    !source.includes('sharedMenuActive'),
    'no liveness probe may branch on the table: only what the event does decides ownership',
  )
  assert.ok(
    /const afterDispatch = \(fn\)/.test(source) && source.includes('queueMicrotask(fn)'),
    'the fallback must be deferred past the whole dispatch so it can read the real outcome',
  )
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