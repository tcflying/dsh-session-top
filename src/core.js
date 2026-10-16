/**
 * dsh-session-top — the pure logic the host half actually executes.
 *
 * This module is host-side only: the browser half (./client.js) must stay a
 * single self-contained closure factory, because the client module table
 * resolves only package rows and platform-frozen modules — there is no
 * relative path from a bundle back into a sibling source file. Where the two
 * halves must agree on a *constant*, the value lives here, the bundle restates
 * it as a literal, and `test/core.test.js` fails if the two ever drift.
 *
 * Everything else in this module is synchronous and free of host references, so
 * `node --test` covers every branch without a running dsh.
 *
 * Terminology:
 *   - "pinned"   — the registry-global pin set, in pin order (newest first).
 *   - "group key" — the sidebar's owning bucket id: a workspace id, or
 *                   UNGROUPED_KEY for sessions outside every workspace.
 */

/** Group key for sessions outside every workspace (matches ui-workspace's own constant). */
export const UNGROUPED_KEY = ''

/** Attribute carrying the session id on an official session row. */
export const ROW_KEY_ATTR = 'data-row-key'

/** Prefix of the official session row key: `session:<id>`. */
export const SESSION_ROW_PREFIX = 'session:'

/** Prefix of the official workspace row key: `workspace:<key>`. */
export const WORKSPACE_ROW_PREFIX = 'workspace:'

/**
 * Plan the durable move that floats the most recently active session of an
 * account to the top of it. This is behavior 1 ("active float-up") at the layer
 * that survives a restart.
 *
 * The sidebar's default "recent" view already sorts by `updatedAt` on every
 * render, but the durable account (`workspace.sessionIds`) only ever changes
 * through `insertSessionBefore`. Replaying the move through that official API is
 * what makes activity keep mattering once the user switches the sidebar to
 * manual order.
 *
 * This is deliberately NOT a full re-sort. Re-sorting the whole account by
 * activity would silently discard a manual arrangement the user built by
 * dragging rows — the drag order is durable state, and a background activity
 * event is not a licence to throw it away. Only the session that acted moves;
 * every other member keeps its relative position.
 *
 * The plan is the single `insertSessionBefore(id, anchor)` move, where the
 * anchor is whoever currently leads the account. An account already led by its
 * most active member, or one holding no active member at all, yields no moves.
 *
 * @param {readonly string[]} current - the account's session ids in durable order.
 * @param {(id: string) => number} rankOf - id → activity rank (higher is more recent); 0 when unknown.
 * @returns {{id: string, beforeId: string}[]} the moves; empty when nothing should move.
 */
export function planFloatToTop(current, rankOf) {
  if (current.length < 2) return []
  let bestId
  let bestRank = 0
  for (const id of current) {
    const rank = rankOf(id)
    if (rank > bestRank) {
      bestRank = rank
      bestId = id
    }
  }
  // No member has ever been active: the account is exactly as the user left it.
  if (bestId === undefined) return []
  // Already leading.
  if (current[0] === bestId) return []
  return [{ id: bestId, beforeId: current[0] }]
}

/**
 * Order two batch facts. Newer event time wins. An exact tie keeps the order
 * the ACCOUNT is in, never the order the batch arrived in.
 *
 * R18a settled this rather than leaving it open. Event time is ms-resolution
 * and belongs to the event, so two commits in the same millisecond are a real
 * tie and the data carries no evidence of which came first. The arrival
 * counter `seq` cannot break that tie either, because arrival order is not
 * event order: a late-delivered commit carries an OLD clock, so promoting it
 * by arrival would place a stale fact above a newer one. The account's own
 * order is the only tie-break the data supports, and it is the rule
 * `planFloatToTop` has always applied — its strict `>` leaves the member that
 * leads the account winning its own tie.
 *
 * DO NOT ADD A THIRD KEY HERE. `position` is read off the account and never
 * off the batch for exactly that reason: `Array.prototype.sort` is stable, so
 * a comparator that returns 0 on a tie silently re-introduces the batch's
 * iteration order — the leak this function exists to close.
 *
 * @param {{id: string, time: number, position: number}} a - the left fact.
 * @param {{id: string, time: number, position: number}} b - the right fact.
 * @returns {number} negative when `a` is more recent.
 */
function byRecency(a, b) {
  if (a.time !== b.time) return b.time - a.time
  return a.position - b.position
}

/**
 * Plan the durable moves for ONE account from ONE activity batch.
 *
 * `planFloatToTop` above answers "which single session is most active"; this
 * answers the narrower question the host actually needs to ask: *which sessions
 * acted in this batch, and where do they belong in this account right now*.
 *
 * The difference is the whole point. Ranking every member by the permanently
 * retained `lastActivity` map replays an intent the user has since overridden:
 * once A's session floated to the top and the user dragged it back down, any
 * later activity in ANY workspace re-asserted that stale rank and undid the
 * drag. Here, only sessions that carry a fact from THIS batch may move; every
 * other member keeps the position the user left it in.
 *
 * Resulting order: batch candidates by recency (newer event time first; an
 * exact tie keeps the account order — see `byRecency`), then the remaining
 * members in their existing relative order. Moves are minimal — a member
 * already standing where the batch puts it produces no host write at all, so
 * an account the batch does not disturb is never touched.
 *
 * Conservative semantics, stated so the host can rely on them:
 *
 *   - Candidates are matched against the account AS READ AT THIS MOMENT. A
 *     session that migrated to another workspace mid-pass is floated there the
 *     first time that workspace is read, and never written back into the
 *     account it left — the host refuses that write, and the pass stops rather
 *     than retrying against an account it never planned.
 *   - `beforeId` is always a member of `current`: the plan is a permutation of
 *     the account, so the slot it moves into is always occupied.
 *
 * The batch is the CALLER's contract, and freshness is the caller's too. The
 * host hands over one fact per session id whose `time` is that event's own
 * clock; it drops a non-advancing or non-finite `event.time` when it records
 * a fact, and its sequence guard refuses to let an older fact overwrite a
 * newer one when a refused write is put back. Given that, a fact in this batch
 * IS the newest fact for its session — which is why an older fact beside a
 * newer one can never overtake it here, and why no `max()` over duplicate ids
 * is needed. This module keeps no rank between calls, so nothing a previous
 * batch spent can be re-asserted by a later one.
 *
 * `time` is deliberately NOT validated here. This is an ordering function, not
 * a trust boundary: rejecting a negative or non-finite `time` inside it would
 * change what "floated" means for every caller, including the host probes. The
 * host substitutes `Date.now()` for a non-finite `event.time` before a fact
 * ever exists, and that is where the check belongs.
 *
 * @param {readonly string[]} current - the account's session ids in durable order.
 * @param {readonly {id: string, time: number}[]} candidates - the batch's facts for members of THIS account.
 * @returns {{id: string, beforeId: string}[]} the minimal moves; empty when the account already matches.
 */
export function planFloatDirty(current, candidates) {
  if (current.length < 2 || candidates.length === 0) return []
  const member = new Set(current.map(String))
  const dirty = new Set()
  const ranked = []
  for (const candidate of candidates) {
    const id = String(candidate.id)
    // Ignored: unknown id, a session that migrated away, or a duplicate fact.
    if (!member.has(id) || dirty.has(id)) continue
    dirty.add(id)
    // `position` is read off the ACCOUNT, never off the batch's iteration
    // order, so an exact time tie resolves the way `planFloatToTop` resolves
    // it instead of by whichever event happened to arrive first.
    ranked.push({ id, time: candidate.time, position: current.indexOf(id) })
  }
  if (ranked.length === 0) return []
  ranked.sort(byRecency)
  const desired = [
    ...ranked.map(candidate => candidate.id),
    ...current.filter(id => !dirty.has(String(id))),
  ]
  const moves = []
  // `working` mirrors the account as the applied moves would leave it. Every
  // target index is occupied at that point — `desired` is a permutation of
  // `current` — so `beforeId` is always defined.
  const working = [...current]
  for (let index = 0; index < desired.length; index += 1) {
    const id = desired[index]
    const at = working.indexOf(id)
    if (at === index) continue
    const beforeId = working[index]
    moves.push({ id, beforeId })
    working.splice(at, 1)
    working.splice(index, 0, id)
  }
  return moves
}