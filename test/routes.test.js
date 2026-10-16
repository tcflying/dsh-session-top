/**
 * dsh-session-top — the loopback fence contract.
 *
 * `isLoopbackRequest` is the only thing between a cross-site page and the two
 * diagnostics routes, so this file is written as an attack matrix rather than
 * as a summary of the implementation: every origin shape a legitimate caller
 * sends, every shape a forger can send, and every header a forger can add.
 *
 * The scheme the fence compares against is a composition-time fact about the
 * listener (the host serves plaintext `node:http`), never something read off
 * the request — a node `IncomingMessage` carries no trustworthy URL scheme at
 * all. Nothing here reaches a real DSH host: the only socket in this file is a
 * throwaway loopback server this test starts and stops itself.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import net from 'node:net'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { isLoopbackRequest } from '../src/routes.js'

const here = dirname(fileURLToPath(import.meta.url))

/** A request arriving over a loopback socket, with `Host` and extra headers. */
function loopback(host, headers = {}) {
  return { socket: { remoteAddress: '127.0.0.1' }, headers: { host, ...headers } }
}

// -------------------------------------------------------------- allowed in

test('a loopback diagnostic request with no Origin passes', () => {
  // curl, scripts and native clients send no Origin at all; the loopback-only
  // diagnostics contract exists for exactly them.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:8080')), true)
  assert.equal(isLoopbackRequest(loopback('localhost:3000')), true)
  assert.equal(isLoopbackRequest(loopback('[::1]:3000')), true)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:8080', { 'sec-fetch-site': 'same-origin' })), true)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:8080', { 'sec-fetch-site': 'same-site' })), true)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:8080', { 'sec-fetch-site': 'none' })), true)
})

test('an Origin on the listener scheme and the Host authority passes', () => {
  // The desktop host rewrites Origin to its own real origin, so this is the
  // exact shape a real browser request carries.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'http://127.0.0.1:3000' })), true)
  assert.equal(isLoopbackRequest(loopback('localhost:3000', { origin: 'http://localhost:3000' })), true)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1', { origin: 'http://127.0.0.1' })), true)
  assert.equal(isLoopbackRequest(loopback('[::1]:3000', { origin: 'http://[::1]:3000' })), true)
  assert.equal(isLoopbackRequest(loopback('[::1]', { origin: 'http://[::1]' })), true)
})

test('a default port written on either side compares equal', () => {
  // `http://h` and `http://h:80` are the same origin; only the written form
  // differs, and the Host header is written by the client, not by us.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:80', { origin: 'http://127.0.0.1' })), true)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1', { origin: 'http://127.0.0.1:80' })), true)
  assert.equal(isLoopbackRequest(loopback('localhost:80', { origin: 'http://localhost' })), true)
})

test('a serialized origin is compared case-insensitively, as RFC 3986 requires', () => {
  assert.equal(isLoopbackRequest(loopback('localhost:3000', { origin: 'HTTP://LOCALHOST:3000' })), true)
  // A bare trailing slash is the same origin re-serialized, not a path.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'http://127.0.0.1:3000/' })), true)
})

// ------------------------------------------------------------- refused

test('an Origin whose scheme is not the listener scheme is refused', () => {
  // The defect this fence file exists for: same authority, different scheme.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'https://127.0.0.1:3000' })), false)
  assert.equal(isLoopbackRequest(loopback('localhost:3000', { origin: 'https://localhost:3000' })), false)
  assert.equal(isLoopbackRequest(loopback('[::1]:3000', { origin: 'https://[::1]:3000' })), false)
  // Same trap without an explicit port.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'https://127.0.0.1' })), false)
  // Omitting the port means the default one, not "whatever the Host says".
  assert.equal(isLoopbackRequest(loopback('[::1]:3000', { origin: 'http://[::1]' })), false)
  // A non-tuple scheme is not a serialized origin at all.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'foo://127.0.0.1:3000' })), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'file:///c:/x' })), false)
})

test('an Origin on a different authority is refused', () => {
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:8080', { origin: 'http://evil.test' })), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:8080', { origin: 'https://evil.test' })), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:8080', { origin: 'http://127.0.0.1:8081' })), false)
  // localhost and 127.0.0.1 are different authorities, not two spellings of one.
  assert.equal(isLoopbackRequest(loopback('localhost:3000', { origin: 'http://127.0.0.1:3000' })), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'http://localhost:3000' })), false)
  // Matching port and host does not rescue a mismatched scheme.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:443', { origin: 'https://127.0.0.1' })), false)
})

test('an opaque, empty or multi-valued Origin is refused', () => {
  // RFC 6454 §7.1: the field is `null` or an origin list of SP-separated
  // serialized origins; a forger controls all of that text.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'null' })), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: '' })), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: '   ' })), false)
  // A repeated header reaches us as one string, never as a trusted single.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', {
    origin: 'http://127.0.0.1:3000, http://evil.test',
  })), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', {
    origin: 'http://127.0.0.1:3000 http://evil.test',
  })), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', {
    origin: ['http://127.0.0.1:3000', 'http://evil.test'],
  })), false)
  // One element is still not a single serialized origin: an adapter that
  // hands the fence an array has not established what it means.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', {
    origin: ['http://127.0.0.1:3000'],
  })), false)
})

test('an Origin carrying anything beyond scheme, host and port is refused', () => {
  // Every one of these parses to the right `host`, which is exactly why a
  // host-only comparison used to wave them through.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'http://user@127.0.0.1:3000' })), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'http://user:pass@127.0.0.1:3000' })), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'http://127.0.0.1:3000/x' })), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'http://127.0.0.1:3000/?q=1' })), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'http://127.0.0.1:3000/#f' })), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'http://user@127.0.0.1:3000/#f' })), false)
  // An empty query or fragment carries nothing and is indistinguishable from
  // none once parsed, so it stays allowed; a non-empty one is refused above.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'http://127.0.0.1:3000?' })), true)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'http://127.0.0.1:3000#' })), true)
})

test('forwarding headers cannot buy access', () => {
  // The listener is plaintext and loopback-only; nothing upstream vouches for
  // a forwarding header, so none of them may be read as a fact.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', {
    origin: 'https://127.0.0.1:3000',
    'x-forwarded-proto': 'http',
    'x-forwarded-host': '127.0.0.1:3000',
    forwarded: 'for=127.0.0.1;host=127.0.0.1:3000;proto=http',
  })), false)
  assert.equal(isLoopbackRequest({
    socket: { remoteAddress: '10.0.0.5' },
    headers: {
      host: '127.0.0.1:3000',
      origin: 'http://127.0.0.1:3000',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-proto': 'http',
    },
  }), false)
  // And on an honest request they change nothing at all.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', {
    origin: 'http://127.0.0.1:3000',
    'x-forwarded-proto': 'https',
  })), true)
})

test('the loopback fences this file must not weaken still hold', () => {
  assert.equal(isLoopbackRequest({ ...loopback('127.0.0.1:8080'), socket: { remoteAddress: '10.0.0.5' } }), false)
  assert.equal(isLoopbackRequest(loopback('evil.test:80')), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:8080', { 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(isLoopbackRequest(loopback(undefined)), false)
  assert.equal(isLoopbackRequest(undefined), false)
})

// --------------------------------------------- the expected scheme itself

test('the expected scheme is a caller-supplied fact, not a request guess', () => {
  const https = loopback('127.0.0.1:3000', { origin: 'https://127.0.0.1:3000' })
  // With no second argument the fence trusts the listener it was written for.
  assert.equal(isLoopbackRequest(https), false)
  // A host that proves a different scheme can pass it in; the request cannot.
  assert.equal(isLoopbackRequest(https, 'https'), true)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'https://127.0.0.1:3000' }), 'HTTPS'), true)
  // An unknown or malformed scheme fails closed rather than guessing a port.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'http://127.0.0.1:3000' }), ''), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'http://127.0.0.1:3000' }), 'https://127.0.0.1:3000'), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'http://127.0.0.1:3000' }), 'http '), false)
  // A scheme the fence has no default-port fact for is refused outright, even
  // when the Origin speaks it: comparing ports there would be a guess. `ws` is
  // the case that proves the refusal is the scheme check and nothing else — it
  // is a well-formed origin that a stricter check would happily accept.
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'foo://127.0.0.1:3000' }), 'foo'), false)
  assert.equal(isLoopbackRequest(loopback('127.0.0.1:3000', { origin: 'ws://127.0.0.1:3000' }), 'ws'), false)
})

test('the fence reads no forwarding header in code, not merely in prose', async () => {
  const source = await readFile(join(here, '..', 'src', 'routes.js'), 'utf8')
  // Strip comments first: naming what the fence refuses is not reading it.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
  assert.equal(/forwarded/i.test(code), false, 'no code path may read x-forwarded-* or forwarded')
  // And the scheme comparison has to exist as code, not as a file-header claim.
  assert.match(code, /\.protocol\s*!==\s*scheme\b/, 'the expected scheme must be compared, not assumed')
  // No request-side scheme is read: `IncomingMessage` has no `protocol`, and a
  // plain `node:http` socket has no `encrypted`.
  assert.equal(/req\.protocol|request\.protocol|\.encrypted\b/.test(source), false,
    'the expected scheme must never come off the request')
})

// --------------------------------------------- the real request object

test('the fence holds on a real node:http request, not only on a synthetic one', async (t) => {
  const server = createServer((req, res) => {
    const allowed = isLoopbackRequest(req)
    const body = JSON.stringify({ allowed, origin: req.headers.origin ?? null })
    res.writeHead(allowed ? 200 : 403, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      connection: 'close',
    })
    res.end(body)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const { port } = server.address()

  /** Send a raw request so a header can be repeated, and read the verdict. */
  const send = async headerLines => {
    const socket = net.connect(port, '127.0.0.1')
    const chunks = []
    socket.on('data', chunk => chunks.push(chunk))
    await once(socket, 'connect')
    socket.write([
      'GET /api/dsh-session-top/status HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      ...headerLines,
      'Connection: close',
      '', '',
    ].join('\r\n'))
    await once(socket, 'close')
    return JSON.parse(Buffer.concat(chunks).toString('utf8').split('\r\n\r\n')[1])
  }

  // No Origin: the local diagnostics client, allowed on the real object.
  assert.deepEqual(await send([]), { allowed: true, origin: null })
  assert.deepEqual(await send([`Origin: http://127.0.0.1:${port}`]), {
    allowed: true, origin: `http://127.0.0.1:${port}`,
  })
  assert.deepEqual(await send([`Origin: https://127.0.0.1:${port}`]), {
    allowed: false, origin: `https://127.0.0.1:${port}`,
  })
  // A repeated Origin header really does arrive as one joined string.
  assert.deepEqual(await send([`Origin: http://127.0.0.1:${port}`, 'Origin: http://evil.test']), {
    allowed: false, origin: `http://127.0.0.1:${port}, http://evil.test`,
  })
  // And node trims the OWS around the value, which is why the fence never has
  // to reason about framing whitespace: it cannot arrive.
  assert.deepEqual(await send([`Origin:   http://127.0.0.1:${port}   `]), {
    allowed: true, origin: `http://127.0.0.1:${port}`,
  })
})