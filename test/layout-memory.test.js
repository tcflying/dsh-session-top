import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LAYOUT_WIDTHS_KEY,
  clampLayoutWidths,
  parseGridTemplateColumns,
  readLayoutWidths,
  writeLayoutWidths,
} from '../src/layout-memory.js'

test('parses the host three-column grid and derives center width', () => {
  assert.deepEqual(
    parseGridTemplateColumns('280px minmax(400px, 1fr) minmax(0px, 722px)', 1600),
    { sidebar: 280, center: 598, rightbar: 722 },
  )
})

test('clamps restored panel widths to the host layout contract', () => {
  assert.deepEqual(clampLayoutWidths({ viewport: 1200, sidebar: 500, rightbar: 100 }), {
    sidebar: 420,
    rightbar: 300,
  })
})

test('persists and reads a versioned layout preference safely', () => {
  const data = new Map()
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  }
  assert.equal(writeLayoutWidths(storage, { viewport: 1600, sidebar: 320, rightbar: 640 }), true)
  assert.equal(data.has(LAYOUT_WIDTHS_KEY), true)
  assert.deepEqual(readLayoutWidths(storage), { sidebar: 320, rightbar: 640 })
  data.set(LAYOUT_WIDTHS_KEY, '{bad json')
  assert.equal(readLayoutWidths(storage), null)
})

test('storage failures do not break layout memory', () => {
  const storage = {
    getItem: () => { throw new Error('blocked') },
    setItem: () => { throw new Error('blocked') },
  }
  assert.equal(readLayoutWidths(storage), null)
  assert.equal(writeLayoutWidths(storage, { viewport: 1600, sidebar: 320, rightbar: 640 }), false)
})
