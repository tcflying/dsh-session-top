/**
 * dsh-session-top — the loopback trust fence.
 *
 * Both diagnostics routes sit behind the same request-level fence DSH host
 * plugins use: loopback socket + loopback Host + browser same-origin markers.
 * X-Forwarded-For is never trusted — a caller can forge it, the socket address
 * cannot. Responses carry only ids, counts, timestamps and workspace titles;
 * no session content ever crosses this boundary.
 */

/** IPv4 127/8 predicate. */
function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a socket address names the loopback range (127/8, ::1, IPv4-mapped).
 * @param {unknown} address - `request.socket.remoteAddress`.
 * @returns {boolean} true for a loopback peer.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/**
 * Whether a normalized hostname names a loopback authority.
 * @param {string} hostname - the Host header's hostname.
 * @returns {boolean} true for localhost / ::1 / 127.x.
 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence: loopback socket + loopback Host + browser
 * same-origin markers.
 * @param {any} request - the node request.
 * @returns {boolean} true when the request may read diagnostics.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false
  const host = request?.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}