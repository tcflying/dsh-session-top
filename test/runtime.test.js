import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deriveRuntime } from '../src/runtime.js'

// Mirrors the client summary face, not the host wire's sessionId/parentSessionId.
const summary = (id, fields = {}) => ({
  id, updatedAt: 0, displayTitle: id, running: false, blank: false, retainedBy: {}, ...fields,
})

test('counts executing roots independently from executing subagents', () => {
  assert.deepEqual(deriveRuntime({
    green: summary('green', { running: true }),
    idle: summary('idle'),
  }), {
    sessions: { green: { running: true, runningChildren: 0 }, idle: { running: false, runningChildren: 0 } },
    runningSessions: 1, runningAgents: 0,
  })
})

test('attributes running descendants through idle parents without marking a root running', () => {
  const byId = {
    root: summary('root'),
    child: summary('child', { origin: 'subagent', parentId: 'root' }),
    grandchild: summary('grandchild', { origin: 'subagent', parentId: 'child', running: true }),
    sibling: summary('sibling', { origin: 'subagent', parentId: 'root', running: true }),
  }
  Object.values(byId).forEach(Object.freeze)
  Object.freeze(byId)
  assert.deepEqual(deriveRuntime(byId), {
    sessions: { root: { running: false, runningChildren: 2 } },
    runningSessions: 0, runningAgents: 2,
  })
})

test('ignores live residency and activity labels when running is false', () => {
  assert.deepEqual(deriveRuntime({
    root: summary('root', { agentAvailable: true }),
    resident: summary('resident', { origin: 'subagent', parentId: 'root', agentAvailable: true, activity: 'running' }),
    unknown: summary('unknown', { origin: 'subagent', parentId: 'root', running: 'true' }),
  }), {
    sessions: { root: { running: false, runningChildren: 0 } },
    runningSessions: 0, runningAgents: 0,
  })
})

test('keeps ordinary forks as independent roots even when they have a parent', () => {
  assert.deepEqual(deriveRuntime({
    root: summary('root'),
    fork: summary('fork', { parentId: 'root', running: true }),
    teammate: summary('teammate', { origin: 'subagent', parentId: 'fork', running: true }),
  }), {
    sessions: { root: { running: false, runningChildren: 0 }, fork: { running: true, runningChildren: 1 } },
    runningSessions: 1, runningAgents: 1,
  })
})

test('counts a Team child once by authoritative id regardless of duplicate membership', () => {
  assert.deepEqual(deriveRuntime({
    root: summary('root', { running: true }),
    teammate: summary('teammate', { origin: 'subagent', parentId: 'root', running: true, teamId: 'root' }),
  }, ['teammate', 'root', 'teammate', 'root']), {
    sessions: { root: { running: true, runningChildren: 1 } },
    runningSessions: 1, runningAgents: 1,
  })
})

test('uses listed ids as runtime authority and retained rows only for ancestry', () => {
  assert.deepEqual(deriveRuntime({
    root: summary('root'),
    retainedRoot: summary('retainedRoot', { running: true }),
    retainedParent: summary('retainedParent', { origin: 'subagent', parentId: 'root', running: true }),
    child: summary('child', { origin: 'subagent', parentId: 'retainedParent', running: true }),
    stale: summary('stale', { origin: 'subagent', parentId: 'root', running: true }),
  }, ['root', 'child', 'missing']), {
    sessions: { root: { running: false, runningChildren: 1 } },
    runningSessions: 0, runningAgents: 1,
  })
})

test('stops at absent parents and cycles while preserving the global child count', () => {
  assert.deepEqual(deriveRuntime({
    root: summary('root'),
    orphan: summary('orphan', { origin: 'subagent', parentId: 'missing', running: true }),
    self: summary('self', { origin: 'subagent', parentId: 'self', running: true }),
    a: summary('a', { origin: 'subagent', parentId: 'b', running: true }),
    b: summary('b', { origin: 'subagent', parentId: 'a', running: true }),
  }), {
    sessions: { root: { running: false, runningChildren: 0 } },
    runningSessions: 0, runningAgents: 4,
  })
})

test('derives an empty snapshot when the list is unavailable or empty', () => {
  const empty = { sessions: {}, runningSessions: 0, runningAgents: 0 }
  assert.deepEqual(deriveRuntime(), empty)
  assert.deepEqual(deriveRuntime(null), empty)
  assert.deepEqual(deriveRuntime({}), empty)
  assert.deepEqual(deriveRuntime({ stale: summary('stale', { running: true }) }, []), empty)
})

test('walks deep descendant chains iteratively', () => {
  const byId = { root: summary('root') }
  for (let index = 0; index < 12000; index += 1) {
    const id = `child-${index}`
    byId[id] = summary(id, {
      origin: 'subagent', parentId: index === 0 ? 'root' : `child-${index - 1}`, running: true,
    })
  }
  assert.deepEqual(deriveRuntime(byId, Object.keys(byId).reverse()), {
    sessions: { root: { running: false, runningChildren: 12000 } },
    runningSessions: 0, runningAgents: 12000,
  })
})
