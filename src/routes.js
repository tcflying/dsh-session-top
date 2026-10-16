/**
 * dsh-session-top — the loopback trust fence.
 *
 * Both diagnostics routes sit behind the same request-level fence DSH host
 * plugins use: loopback socket + loopback Host + browser same-origin markers.
 * X-Forwarded-For is never trusted — a caller can forge it, the socket address
 * cannot. Responses carry only ids, counts, timestamps and workspace titles;
 * no session content ever crosses this boundary.
 *
 * An `Origin`, when a request carries one, has to be a single serialized origin
 * on the listener's own scheme and the Host's own authority. Comparing the
 * authority alone let a cross-scheme origin through, and text that also carries
 * credentials, a path, a query or a fragment is not a serialized origin at all
 * even when it parses to the right host.
 *
 * The scheme to compare against is a composition-time fact supplied by the
 * caller and defaults to `http`, because the host serves plaintext `node:http`
 * and any TLS is terminated before this listener. It can never be read off the
 * request: a node `IncomingMessage` has no `protocol` field, a plain `node:http`
 * socket has no `encrypted` flag, and no forwarding header is a fact about this
 * connection — the host does not emit them and a caller can forge them. No
 * config layer is involved, and none of this widens what may reach the routes.
 */

/** Default ports of the schemes this fence can compare (RFC 3986 §3.2.2). */
const DEFAULT_PORTS = { 'http:': '80', 'https:': '443' }

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
 * Whether a scheme names a transport whose default port this fence knows.
 * Anything else — a typo, or a whole URL handed over by mistake — refuses the
 * request instead of comparing ports against a guess.
 * @param {unknown} scheme - the caller's expected scheme, e.g. `http`.
 * @returns {boolean} true for `http` / `https`, case-insensitively.
 */
function isKnownScheme(scheme) {
  return typeof scheme === 'string' && DEFAULT_PORTS[`${scheme.toLowerCase()}:`] !== undefined
}

/**
 * The port a parsed URL actually means, with the scheme's default filled in:
 * `http://h` is port 80, not "no port", so `http://h:80` and `http://h` compare
 * equal while `http://h` against a Host of port 3000 does not.
 * @param {URL} url - a parsed authority or origin.
 * @returns {string} the decimal port.
 */
function effectivePort(url) {
  if (url.port !== '') return url.port
  return DEFAULT_PORTS[url.protocol] ?? ''
}

/**
 * Whether an `Origin` header carries exactly one serialized origin equal to the
 * Host authority on the listener's scheme.
 *
 * A serialized origin is `scheme "://" host [ ":" port ]` and nothing else
 * (RFC 6454 §7.1); an opaque origin serializes as `null`. Everything that
 * parses to the right host while carrying more than that — credentials, a
 * path, a query, a fragment, a second origin — is refused rather than
 * normalized away.
 * @param {unknown} origin - the raw `Origin` header value.
 * @param {URL} hostUrl - the Host header parsed with the listener's scheme.
 * @param {string} scheme - the expected scheme, with its colon.
 * @returns {boolean} true only for a matching single serialized origin.
 */
function matchesHostOrigin(origin, hostUrl, scheme) {
  // A repeated header arrives as one joined string, never as a trusted single.
  if (typeof origin !== 'string' || origin === '') return false
  let originUrl
  try {
    originUrl = new URL(origin)
  } catch {
    // `null`, an origin list and any other text that is not a serialized
    // origin all fail to parse; an opaque or non-tuple origin that does parse
    // can never carry the expected scheme either.
    return false
  }
  if (originUrl.username !== '' || originUrl.password !== '') return false
  if (originUrl.pathname !== '/' || originUrl.search !== '' || originUrl.hash !== '') return false
  if (originUrl.protocol !== scheme) return false
  return originUrl.hostname === hostUrl.hostname && effectivePort(originUrl) === effectivePort(hostUrl)
}

/**
 * Request-level trust fence: loopback socket + loopback Host + browser
 * same-origin markers, and an `Origin` that is one serialized origin on the
 * listener's scheme and the Host's authority.
 * @param {any} request - the node request.
 * @param {string} [expectedScheme] - the listener's own scheme, from the host
 *   that registered the route; it defaults to the plaintext `http` this host
 *   serves. Never derive it from the request.
 * @returns {boolean} true when the request may read diagnostics.
 */
export function isLoopbackRequest(request, expectedScheme = 'http') {
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false
  if (!isKnownScheme(expectedScheme)) return false
  const scheme = `${expectedScheme.toLowerCase()}:`
  const host = request?.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`${scheme}//${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  // No Origin at all is the local diagnostics client — curl, a script, the
  // native host — which the loopback checks above already cover.
  if (origin === undefined) return true
  return matchesHostOrigin(origin, hostUrl, scheme)
}