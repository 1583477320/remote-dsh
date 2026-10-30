/**
 * Host half of dsh-remote-panel: host bookkeeping + one live SSH session per
 * connected host.
 *
 * Every remote operation rides the SSH connection (lib/remote.js), so the remote
 * keeps `dsh web` on 127.0.0.1 and no helper or LAN binding is needed. A connect
 * request returns immediately with a job stage; the page polls /state while the
 * remote installs dsh or starts its web server.
 */
import { listHosts, resolveHost, upsertHost, removeHost } from './hosts.js'
import { openSession, probeHost } from './remote.js'

/** Stable cordis plugin name. */
export const name = 'remote-dsh'

/** Service this plugin needs before it can register routes. */
export const inject = ['webServer']

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null }
}

/**
 * Mount the panel's routes.
 * @param ctx - host plugin context carrying webServer.
 */
export function apply(ctx) {
  /** id -> { session } for a connected host. */
  const sessions = new Map()
  /** id -> { stage, error, proxyUrl, startedAt } while connecting/installing. */
  const jobs = new Map()

  const describe = () => listHosts().map(host => {
    const job = jobs.get(host.id)
    const session = sessions.get(host.id)
    return {
      id: host.id,
      label: host.label,
      host: host.host,
      user: host.user,
      sshPort: host.sshPort,
      webPort: host.webPort,
      source: host.source,
      connected: session !== undefined,
      proxyUrl: session === undefined ? (job === undefined ? null : job.proxyUrl) : session.session.proxyUrl,
      stage: job === undefined ? (session === undefined ? 'idle' : 'ready') : job.stage,
      error: job === undefined ? null : job.error,
      sinceMs: job === undefined ? 0 : Date.now() - job.startedAt,
    }
  })

  const closeSession = async (id) => {
    const entry = sessions.get(id)
    sessions.delete(id)
    if (entry !== undefined) await entry.session.close().catch(() => {})
  }

  const startConnect = (id, version) => {
    const job = { stage: 'connecting', error: null, proxyUrl: null, startedAt: Date.now() }
    jobs.set(id, job)
    void (async () => {
      try {
        const host = resolveHost(id)
        if (host === null) throw new Error('未找到主机 ' + id)
        await closeSession(id)
        const session = await openSession(host, {
          version,
          log: message => console.log('[remote-dsh] ' + message),
          stage: value => { job.stage = value },
        })
        sessions.set(id, { session })
        job.proxyUrl = session.proxyUrl
        job.stage = 'ready'
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error)
        job.stage = 'failed'
        console.warn('[remote-dsh] connect failed for ' + id + ': ' + job.error)
      }
    })()
    return job
  }

  const routes = [
    {
      kind: 'exact',
      path: '/api/remote-dsh/hosts',
      handler: async (req, res) => {
        const method = req.method ?? 'GET'
        if (method === 'GET') { writeJson(res, 200, { hosts: describe() }); return }
        if (method === 'POST') {
          const body = await readBody(req)
          if (body === null) { writeJson(res, 400, { error: 'invalid JSON body' }); return }
          try {
            upsertHost(body)
            writeJson(res, 201, { hosts: describe() })
          } catch (error) {
            writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (method === 'DELETE') {
          const id = new URL(req.url ?? '/', 'http://local').searchParams.get('id') ?? ''
          const bare = id.replace(/^local:/, '')
          const removed = removeHost(bare)
          jobs.delete(id.startsWith('local:') ? id : 'local:' + bare)
          await closeSession(id.startsWith('local:') ? id : 'local:' + bare)
          writeJson(res, removed ? 200 : 404, { hosts: describe() })
          return
        }
        writeJson(res, 405, { error: 'method not allowed' })
      },
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh/connect',
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        const version = typeof body?.version === 'string' && body.version !== '' ? body.version : '0.2.1-rc.3'
        const existing = jobs.get(id)
        if (existing !== undefined && existing.stage !== 'failed' && existing.stage !== 'ready') {
          writeJson(res, 202, { stage: existing.stage, sinceMs: Date.now() - existing.startedAt, hosts: describe() })
          return
        }
        const job = startConnect(id, version)
        writeJson(res, 202, { stage: job.stage, sinceMs: 0, hosts: describe() })
      },
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh/disconnect',
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id !== '') {
          jobs.delete(id)
          await closeSession(id)
        }
        writeJson(res, 200, { hosts: describe() })
      },
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh/state',
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'GET') { writeJson(res, 405, { error: 'method not allowed' }); return }
        writeJson(res, 200, { hosts: describe() })
      },
    },
    {
      kind: 'exact',
      path: '/api/remote-dsh/test',
      handler: async (req, res) => {
        if ((req.method ?? 'GET') !== 'POST') { writeJson(res, 405, { error: 'method not allowed' }); return }
        const body = await readBody(req)
        const id = typeof body?.id === 'string' ? body.id : ''
        if (id === '') { writeJson(res, 400, { error: 'id is required' }); return }
        const host = resolveHost(id)
        if (host === null) { writeJson(res, 404, { error: '未找到主机 ' + id }); return }
        const version = typeof body?.version === 'string' && body.version !== '' ? body.version : '0.2.1-rc.3'
        try {
          writeJson(res, 200, await probeHost(host, version))
        } catch (error) {
          writeJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]

  try {
    ctx.effect(() => {
      const disposers = routes.map(route => ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
        for (const id of [...sessions.keys()]) void closeSession(id)
      }
    }, 'remote-dsh: routes')
  } catch (error) {
    console.warn('[remote-dsh] route registration failed:', error)
  }
}
