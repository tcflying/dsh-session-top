const MIN_SIDEBAR = 264
const MAX_SIDEBAR = 420
const MIN_RIGHTBAR = 300
const MAX_RIGHTBAR_RATIO = 0.7
const STORAGE_VERSION = 1

export const LAYOUT_WIDTHS_KEY = 'dsh-session-top:layout-widths:v1'

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Match the host frame's first and last pixel tracks. */
export function parseGridTemplateColumns(template, viewport) {
  if (typeof template !== 'string' || !finite(viewport) || viewport <= 0) return null
  const tracks = [...template.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]))
  if (tracks.length < 2 || !finite(tracks[0]) || !finite(tracks.at(-1))) return null
  const sidebar = Math.max(0, Math.round(tracks[0]))
  const rightbar = Math.max(0, Math.round(tracks.at(-1)))
  return { sidebar, center: Math.max(0, Math.round(viewport) - sidebar - rightbar), rightbar }
}

/** Keep restored values inside the same range as the host store. */
export function clampLayoutWidths({ viewport, sidebar, rightbar }) {
  if (!finite(viewport) || viewport <= 0 || !finite(sidebar) || !finite(rightbar)) return null
  return {
    sidebar: clamp(sidebar, MIN_SIDEBAR, MAX_SIDEBAR),
    rightbar: rightbar === 0 ? 0 : clamp(rightbar, MIN_RIGHTBAR, Math.max(MIN_RIGHTBAR, viewport * MAX_RIGHTBAR_RATIO)),
  }
}

export function readLayoutWidths(storage) {
  try {
    const raw = storage?.getItem?.(LAYOUT_WIDTHS_KEY)
    if (raw === null || raw === undefined) return null
    const value = JSON.parse(raw)
    if (value?.version !== STORAGE_VERSION) return null
    return clampLayoutWidths(value)
  } catch {
    return null
  }
}

export function writeLayoutWidths(storage, widths) {
  const normalized = clampLayoutWidths(widths)
  if (normalized === null) return false
  try {
    storage?.setItem?.(LAYOUT_WIDTHS_KEY, JSON.stringify({ version: STORAGE_VERSION, viewport: widths.viewport, ...normalized }))
    return true
  } catch {
    return false
  }
}
