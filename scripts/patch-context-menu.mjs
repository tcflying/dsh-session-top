import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const hash = source => createHash('sha256').update(source).digest('hex')
const upstream = new Set([
  '6960b05c2199c529e5daaba738287ba59bbfa1394862d2ae734c3c6475d229c9', // v0.2.14
  '9ccc3ab8dbefb1d8e100b232c7e612315d81aa084ddced55e789ec48cc6243b9', // main@ab40cced
])
const before = `    function resolveSession(sessions, row, workspace) {
      const state = sessions.list.getSnapshot()
`
const after = before + `      const key = row.getAttribute("data-row-key")
      const id = row.getAttribute("data-dcu-session") ?? (key?.startsWith("session:") ? key.slice(8) : null)
      if (id !== null) {
        return Object.hasOwn(state.byId, id) && state.byId[id]?.id === id ? state.byId[id] : null
      }
`

const list = '          list: () => [...entries.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),\n'
const active = '          active: () => leases > 0,\n'

export function patchContextMenuSource(source) {
  const normalized = source.replace(/\r\n/g, '\n')
  const original = normalized.replace(after, before).replace(active, '')
  if (!upstream.has(hash(original))) throw new Error('Unsupported context-menu client SHA-256: ' + hash(normalized))
  const patched = original.replace(before, after).replace(list, list + active)
  return source.includes('\r\n') ? patched.replace(/\n/g, '\r\n') : patched
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/patch-context-menu.mjs <owner lib/client.js>')
  const target = resolve(process.argv[2])
  const source = await readFile(target, 'utf8')
  const patched = patchContextMenuSource(source)
  if (patched !== source) {
    const backup = target + '.before-session-id-fix.bak'
    try {
      await writeFile(backup, source, { flag: 'wx' })
    } catch (error) {
      if (error.code !== 'EEXIST' || await readFile(backup, 'utf8') !== source) throw error
    }
    await writeFile(target, patched)
    if (await readFile(target, 'utf8') !== patched) throw new Error('Context-menu patch readback failed')
    console.log('Patched context-menu session IDs; backup: ' + backup)
  } else {
    console.log('Context-menu session ID fix already applied')
  }
  console.log('SHA-256: ' + hash(patched))
}
