/**
 * Row-layout budget test.
 *
 * The sidebar row is a fixed-width strip: the title is the ONLY flexible part
 * of it, so every control that is laid out for good eats the title. A control
 * added without a budget check once left a running row's title at 1px — the
 * row showed a green "运行中" badge and nothing else, which is exactly the
 * "the running task vanished" symptom on a host whose sidebar is narrower
 * than the one it was designed on.
 *
 * The numbers below are MEASURED, not guessed:
 *   - the host's narrowest sidebar column is 256px;
 *   - the plugin's own root + region chrome inside it eats 42px;
 *   - the row's own horizontal padding eats 16px;
 *   - "1小时" (time cell, 11px) measured 29px, "运行中" (badge, 10px) measured 36px.
 * The fixed widths are NOT hard-coded: they are read out of the bundle's own
 * CSS, so widening a control or adding one breaks this test instead of
 * silently squeezing the title out of the row.
 *
 * Run: node --test test/row-layout.test.js
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = await readFile(join(here, '..', 'src', 'client.js'), 'utf8')

// --------------------------------------------------------------- CSS reader

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The body of the rule whose selector stands alone on its own line.
 *
 * Anchoring on the line start is what keeps a compound selector
 * (`[data-stp-row][data-stp-absolute] [data-stp-row-slot]`) from being read
 * as the simple one: the compound rule has two selectors on its line and
 * never matches.
 *
 * @param {string} selector the selector as it is written in the bundle.
 * @returns {string} the declarations inside the braces.
 */
const rule = selector => {
  const at = new RegExp(`^[ \\t]*${escapeRe(selector)}(?:::[a-z-]+)?[ \\t]*\\{`, 'm').exec(bundle)
  assert.notEqual(at, null, `the bundle has no CSS rule for ${selector}`)
  const open = bundle.indexOf('{', at.index)
  const close = bundle.indexOf('}', open)
  return bundle.slice(open + 1, close)
}

/**
 * A pixel length declared by a property inside a rule body.
 *
 * @param {string} body the rule body.
 * @param {string} property the CSS property to read.
 * @returns {number|null} the length, or null when the property is not set.
 */
const px = (body, property) => {
  const at = new RegExp(`(^|[;\\s])${escapeRe(property)}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)(px)?`).exec(body)
  if (at === null) return null
  // A bare number is a length only when it is zero; anything else needs a unit.
  if (at[3] === undefined && Number(at[2]) !== 0) return null
  return Number(at[2])
}

// --------------------------------------------------------------- the budget

const HOST_COLUMN = 256
const PLUGIN_CHROME = 42
const ROW_PADDING = 16
const TIME_TEXT = 29
const BADGE_TEXT = 36
const CHILDREN = 6 // slot, title, time, badge, star, colour point
const TITLE_MIN = 48

const slot = px(rule('[data-stp-row-slot]'), 'width')
const star = px(rule('[data-stp-absolute-button]'), 'min-width')
const colour = px(rule('[data-stp-row-color]:not([data-stp-row-color-set])'), 'width')
const gap = px(rule('[data-stp-row]'), 'gap')

test('the row keeps its fixed controls inside the narrowest host sidebar', () => {
  assert.notEqual(slot, null, 'the row slot lost its width')
  assert.notEqual(star, null, 'the super-pin button lost its width')
  assert.notEqual(colour, null, 'the colour point no longer collapses when unset')
  assert.notEqual(gap, null, 'the row lost its gap')

  const inner = HOST_COLUMN - PLUGIN_CHROME - ROW_PADDING
  const chrome = slot + star + colour + TIME_TEXT + BADGE_TEXT + gap * (CHILDREN - 1)
  const title = inner - chrome

  assert.ok(
    title >= TITLE_MIN,
    `the title gets ${title}px of ${inner}px — under the ${TITLE_MIN}px floor; ` +
    `a running row would show a badge and no name`,
  )
})

test('the colour point takes no space until the row carries a colour', () => {
  assert.equal(colour, 0, 'an unset colour point still reserves its box')
  const set = rule('[data-stp-row-color][data-stp-row-color-set]')
  assert.ok(set.includes('background'), 'a coloured row has nothing left to show its colour')
})

test('the row carries no inline ordinary-pin control', () => {
  // An inline +/- pin button cost 24px in every row and was the difference
  // between a readable title and a 1px one. Ordinary pinning lives in the
  // shared row menu, which costs nothing while it is closed.
  assert.equal(bundle.includes('stp-pin-button'), false, 'the inline pin button is back')
})
