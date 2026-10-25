/**
 * Pure derivation of the client's { ids, byId } Session list. The client bundle
 * embeds this function unchanged because relative runtime imports are unavailable.
 */

/**
 * Derive root execution and descendant counts without consulting resident Agents.
 * Only ids in the Host list establish running status; retained byId fallbacks
 * may connect ancestry but cannot contribute execution counts.
 * @param {Record<string, {origin?: string, parentId?: string, running?: boolean}> | null} byId - client summaries.
 * @param {readonly string[]} ids - authoritative Host list membership.
 * @returns {{sessions: Record<string, {running: boolean, runningChildren: number}>, runningSessions: number, runningAgents: number}} root rows and separate root/child totals.
 */
export function deriveRuntime(byId = {}, ids = Object.keys(byId ?? {})) {
  const summaries = byId ?? {}
  const listed = new Set(ids)
  const sessions = new Map()
  let runningSessions = 0
  let runningAgents = 0
  for (const id of listed) {
    const summary = Object.hasOwn(summaries, id) ? summaries[id] : undefined
    if (summary == null || summary.origin === 'subagent') continue
    const running = summary.running === true
    sessions.set(id, { running, runningChildren: 0 })
    if (running) runningSessions += 1
  }

  // Cache ownership, including broken chains, so shared ancestry is walked once.
  const roots = new Map([...sessions.keys()].map(id => [id, id]))
  for (const id of listed) {
    const summary = Object.hasOwn(summaries, id) ? summaries[id] : undefined
    if (summary?.origin !== 'subagent' || summary.running !== true) continue
    runningAgents += 1
    const path = new Set()
    let current = id
    while (!roots.has(current) && !path.has(current)) {
      path.add(current)
      const ancestor = Object.hasOwn(summaries, current) ? summaries[current] : undefined
      // A normal fork is its own root even when it has a parentId.
      if (ancestor?.origin !== 'subagent' || typeof ancestor.parentId !== 'string') break
      current = ancestor.parentId
    }
    const root = roots.get(current)
    for (const member of path) roots.set(member, root)
    if (root !== undefined) sessions.get(root).runningChildren += 1
  }
  return { sessions: Object.fromEntries(sessions), runningSessions, runningAgents }
}
