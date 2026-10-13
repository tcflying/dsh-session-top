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