import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const MAX_IDS = 4096
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 256
const validIds = ids => Array.isArray(ids) && ids.length <= MAX_IDS && ids.every(validId)

// Stored ids refine the registry's ordinary pins. A missing file permits one
// legacy import. A saved empty list keeps old browser origins from re-importing.
export function superPinRoute(path, registry) {
  let pending = Promise.resolve()
  const reply = (body, status = 200) => Response.json(body, {
    status, headers: { 'cache-control': 'no-store' },
  })
  const read = async () => {
    let raw
    try { raw = await readFile(path, 'utf8') }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
    const ids = JSON.parse(raw)
    if (!validIds(ids)) throw new Error('Invalid super pin state')
    return ids
  }
  const save = async ids => {
    const temp = path + '.' + randomUUID() + '.tmp'
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(temp, JSON.stringify(ids), { flag: 'wx' })
      await rename(temp, path)
    } finally {
      await rm(temp, { force: true })
    }
  }
  const update = async change => {
    const ordinary = new Set(registry().pinnedSessionIds)
    const stored = await read()
    const ids = new Set((stored ?? []).filter(id => ordinary.has(id)))
    let initialized = stored !== null
    if (change?.import === true) {
      if (!initialized) {
        for (const id of change.ids) if (ordinary.has(id)) ids.add(id)
        initialized = ids.size > 0
      }
    } else if (change !== null) {
      if (change.want && change.ids.some(id => !ordinary.has(id))) return reply({ error: 'Session is not pinned' }, 409)
      for (const id of change.ids) {
        if (change.want) ids.add(id)
        else ids.delete(id)
      }
      initialized ||= change.want
    }
    const next = [...ids]
    if (ids.size > MAX_IDS) return reply({ error: 'Too many super pins' }, 409)
    if (initialized && (stored === null || JSON.stringify(next) !== JSON.stringify(stored))) await save(next)
    return reply({ ids: next, initialized })
  }
  return {
    path: '/api/dsh-session-top.super-pins', methods: ['GET', 'POST'], requestBody: 'buffered',
    async fetch(request) {
      let change = null
      if (request.method === 'POST') {
        if (!request.headers.get('content-type')?.startsWith('application/json')) return reply({ error: 'Expected JSON' }, 415)
        try { change = await request.json() } catch { return reply({ error: 'Invalid JSON' }, 400) }
        if (!validIds(change?.ids) || (change.import !== true && typeof change.want !== 'boolean')) {
          return reply({ error: 'Invalid super pin update' }, 400)
        }
      }
      const task = pending.then(() => update(change))
      pending = task.then(() => {}, () => {})
      try { return await task } catch { return reply({ error: 'Super pin storage unavailable' }, 503) }
    },
  }
}
