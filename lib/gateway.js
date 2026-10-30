/**
 * Local gateway to a remote DSH web UI.
 *
 * Why this exists: the desktop shell serves its own document from the custom
 * `dsh-app://app` origin, so an iframe pointing straight at the remote is a
 * third-party context and the remote's `SameSite=Strict` auth cookie is never
 * sent. This gateway takes the cookie out of the browser entirely: it
 * authenticates once itself (token -> cookie) and forwards HTTP + WebSocket
 * traffic with that cookie attached. The iframe only talks to
 * `http://127.0.0.1:<gatewayPort>`, which needs no auth of its own.
 *
 * The TCP target (connectHost/connectPort) and the authority the remote
 * believes it serves (authority) are separate: over SSH the target is a local
 * tunnel port while the authority stays `127.0.0.1:<remoteWebPort>`, so the
 * cookie the remote issues matches the Host header of every forwarded request.
 */
import http from 'node:http'
import net from 'node:net'
import zlib from 'node:zlib'

/**
 * Injected into proxied HTML documents. Escape pressed inside the embedded app
 * must reach the embedding page, because that page owns the maximize state and
 * a focused child frame never bubbles key events to its parent.
 */
const ESC_BRIDGE = '<script>(function(){try{document.documentElement.dataset.dshRemoteBridge="1"}catch(e){}document.addEventListener("keydown",function(event){if(event.key!=="Escape"&&event.key!=="Esc")return;setTimeout(function(){try{if(document.querySelector("[role=dialog],[aria-modal=true]"))return;parent.postMessage({type:"dsh-remote-esc"},"*")}catch(error){}},0)},false);})();</script>'

/**
 * @param {object} options
 * @param {string} options.connectHost TCP target host
 * @param {number} options.connectPort TCP target port
 * @param {string} options.authority Host header the remote expects
 * @param {() => Promise<string>} [options.tokenProvider]
 * @param {string} [options.stateUrl] fallback: helper that answers {"webUrl": "...?token=..."}
 * @param {(message: string) => void} [options.log]
 */
export async function createGateway({ connectHost, connectPort, authority, tokenProvider, stateUrl, log = () => {} }) {
  let cookie = ''
  let refreshing = null

  async function readToken() {
    if (typeof tokenProvider === 'function') return tokenProvider()
    const response = await fetch(stateUrl, { signal: AbortSignal.timeout(45_000) })
    const value = await response.json()
    if (typeof value.webUrl !== 'string') throw new Error(value.error ?? 'helper returned no webUrl')
    return new URL(value.webUrl).searchParams.get('token')
  }

  /** One HTTP request to the target, keeping the remote authority as Host. */
  function request({ method, path, headers }) {
    return new Promise((resolve, reject) => {
      const upstream = http.request({ host: connectHost, port: connectPort, method, path, headers }, resolve)
      upstream.on('error', reject)
      upstream.end()
    })
  }

  async function refreshCookie() {
    if (refreshing !== null) return refreshing
    refreshing = (async () => {
      const token = await readToken()
      if (token === null || token === undefined || token === '') throw new Error('empty launch token')
      const response = await request({
        method: 'GET',
        path: '/?token=' + encodeURIComponent(token),
        headers: { host: authority, accept: 'text/html' },
      })
      const rawCookie = response.headers['set-cookie']
      const raw = Array.isArray(rawCookie) ? rawCookie : rawCookie === undefined ? [] : [rawCookie]
      cookie = raw.map(item => String(item).split(';')[0]).join('; ')
      response.resume()
      log('cookie refreshed (status ' + response.statusCode + ', cookies ' + raw.length + ')')
    })().finally(() => { refreshing = null })
    return refreshing
  }

  const rewrite = (headers) => {
    const out = { ...headers }
    out.host = authority
    if (typeof out.origin === 'string') out.origin = 'http://' + authority
    if (typeof out.referer === 'string') {
      try {
        const url = new URL(out.referer)
        out.referer = 'http://' + authority + url.pathname + url.search
      } catch { /* keep original */ }
    }
    if (cookie !== '') out.cookie = cookie
    // Force identity responses: HTML bodies get rewritten below, and a
    // compressed body cannot be patched without inflating it first.
    delete out['accept-encoding']
    return out
  }

  const sendUpstream = (req, headers, retried, res) => {
    const upstream = http.request({ host: connectHost, port: connectPort, method: req.method, path: req.url, headers }, reply => {
      if (reply.statusCode === 401 && !retried && req.method === 'GET') {
        reply.resume()
        refreshCookie().then(
          () => sendUpstream(req, rewrite(req.headers), true, res),
          () => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('gateway: remote auth failed') },
        )
        return
      }

      // Documents get one injected bridge: Escape inside the embedded app has
      // to reach the embedding page, which owns the maximize state.
      const type = String(reply.headers['content-type'] ?? '')
      if (type.includes('text/html')) {
        const encoding = String(reply.headers['content-encoding'] ?? '').toLowerCase()
        const chunks = []
        reply.on('data', chunk => chunks.push(chunk))
        reply.on('end', () => {
          let raw = Buffer.concat(chunks)
          try {
            if (encoding.includes('br')) raw = zlib.brotliDecompressSync(raw)
            else if (encoding.includes('gzip')) raw = zlib.gunzipSync(raw)
            else if (encoding.includes('deflate')) raw = zlib.inflateSync(raw)
          } catch { /* not actually compressed: keep the bytes */ }
          let html = raw.toString('utf8')
          const at = html.lastIndexOf('</body>')
          html = at === -1 ? html + ESC_BRIDGE : html.slice(0, at) + ESC_BRIDGE + html.slice(at)
          const body = Buffer.from(html, 'utf8')
          const responseHeaders = { ...reply.headers }
          delete responseHeaders['content-encoding']
          delete responseHeaders['transfer-encoding']
          responseHeaders['content-length'] = String(body.length)
          res.writeHead(reply.statusCode ?? 200, responseHeaders)
          res.end(body)
        })
        reply.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
        return
      }

      res.writeHead(reply.statusCode ?? 502, reply.headers)
      reply.pipe(res)
    })
    upstream.on('error', error => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('gateway error: ' + error.message)
    })
    req.pipe(upstream)
  }

  const server = http.createServer((req, res) => {
    sendUpstream(req, rewrite(req.headers), false, res)
  })

  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(connectPort, connectHost, () => {
      const headers = rewrite(req.headers)
      const lines = [req.method + ' ' + req.url + ' HTTP/1.1']
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) for (const item of value) lines.push(key + ': ' + item)
        else lines.push(key + ': ' + value)
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n')
      if (head !== undefined && head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })

  await refreshCookie()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  log('gateway on 127.0.0.1:' + port + ' -> ' + connectHost + ':' + connectPort + ' as ' + authority)

  return {
    port,
    refresh: refreshCookie,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}
