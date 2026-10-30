/**
 * One live "remote DSH" session.
 *
 * Everything happens over the SSH connection, so the remote keeps `dsh web`
 * bound to 127.0.0.1 (no LAN exposure, no helper process to install):
 *
 *   ssh2 connect
 *     -> inspect the remote (node version, installed dsh version)
 *     -> install the matching dsh when it is missing or mismatched
 *     -> ensure `dsh web` is listening (start it if not)
 *     -> read the launch token out of its log
 *     -> local TCP tunnel 127.0.0.1:<random> -> remote 127.0.0.1:<webPort>
 *     -> gateway on another 127.0.0.1 port (holds the auth cookie)
 *
 * The browser page embeds the gateway URL; the remote cookie never leaves this
 * process.
 */
import fs from 'node:fs'
import net from 'node:net'
import ssh2 from 'ssh2'
import { createGateway } from './gateway.js'

const { Client } = ssh2

/** Version assumed when the page does not report one. */
const FALLBACK_VERSION = '0.2.1-rc.3'

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

/** Run one command over the session and collect its output. */
function run(client, command) {
  return new Promise(resolve => {
    client.exec(command, (error, stream) => {
      if (error !== undefined && error !== null) {
        resolve({ code: -1, stdout: '', stderr: error.message })
        return
      }
      let stdout = ''
      let stderr = ''
      stream.on('data', chunk => { stdout += String(chunk) })
      stream.stderr.on('data', chunk => { stderr += String(chunk) })
      stream.on('close', code => resolve({ code: code ?? 0, stdout, stderr }))
      stream.on('error', err => resolve({ code: -1, stdout, stderr: err.message }))
    })
  })
}

/** Open one loopback tunnel port forwarded over the SSH connection. */
function startTunnel(client, remotePort) {
  const server = net.createServer(socket => {
    client.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (error, stream) => {
      if (error !== undefined && error !== null) { socket.destroy(); return }
      socket.pipe(stream).pipe(socket)
      stream.on('close', () => socket.destroy())
      socket.on('error', () => stream.destroy())
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** Node ^22.19 || >=24 satisfies the CLI's engine range. */
function nodeSupported(version) {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim())
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major > 24) return true
  if (major === 24) return true
  return major === 22 && minor >= 19
}

/**
 * Best-effort install proxy: when the host runs a conventional local HTTP proxy
 * on 7890 (mihomo/clash) and it can reach the npm registry, install through it.
 * Registry traffic is often 5-10x faster that way on lab machines.
 */
async function detectProxy(client) {
  const result = await run(client, 'curl -s -o /dev/null -w "%{http_code}" -m 4 -x http://127.0.0.1:7890 https://registry.npmjs.org/ 2>/dev/null || true')
  const code = result.stdout.trim()
  return code.startsWith('2') || code.startsWith('3') ? 'http://127.0.0.1:7890' : ''
}

/**
 * Connect, prepare the remote (install dsh if needed), and build the gateway.
 * @param {object} entry host entry from hosts.js
 * @param {object} [options]
 * @param {string} [options.version] exact dsh version the local client runs
 * @param {(message: string) => void} [options.log]
 * @param {(stage: string) => void} [options.stage]
 */
export async function openSession(entry, { version = FALLBACK_VERSION, log = () => {}, stage = () => {} } = {}) {
  const client = new Client()
  const auth = entry.auth ?? {}
  const connectConfig = {
    host: entry.host,
    port: Number(entry.sshPort ?? 22),
    username: entry.user,
    readyTimeout: 20_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
  }
  if (typeof auth.password === 'string' && auth.password !== '') connectConfig.password = auth.password
  if (typeof auth.privateKeyPath === 'string' && auth.privateKeyPath !== '') connectConfig.privateKey = fs.readFileSync(auth.privateKeyPath)
  if (typeof auth.passphrase === 'string' && auth.passphrase !== '') connectConfig.passphrase = auth.passphrase

  stage('ssh')
  await new Promise((resolve, reject) => {
    client.once('ready', resolve)
    client.once('error', reject)
    client.connect(connectConfig)
  })
  log('ssh ready ' + entry.user + '@' + entry.host)

  const webPort = Number(entry.webPort ?? 18080)
  const bin = String(entry.dshBin ?? '~/.local/bin/dsh').replace(/^~/, '$HOME')
  const logPath = String(entry.webLog ?? '~/.dsh/logs/dsh-web.log').replace(/^~/, '$HOME')

  // ---------------------------------------------------------------- inspect
  stage('checking')
  const nodeVersion = (await run(client, 'node -v 2>/dev/null')).stdout.trim()
  if (nodeVersion === '') {
    client.end()
    throw new Error('远端没有 Node.js（需要 ^22.19 或 >=24）')
  }
  if (!nodeSupported(nodeVersion)) {
    client.end()
    throw new Error('远端 Node ' + nodeVersion + ' 版本不满足要求（需要 ^22.19 或 >=24）')
  }
  log('remote node ' + nodeVersion)

  const installed = (await run(client, bin + ' --version 2>/dev/null')).stdout.trim()
  if (installed !== version) {
    log('remote dsh is ' + (installed === '' ? 'missing' : installed) + ', installing ' + version)
    stage('installing')
    const npmPath = (await run(client, 'command -v npm 2>/dev/null')).stdout.trim()
    if (npmPath === '') {
      client.end()
      throw new Error('远端没有 npm，无法自动安装 dsh')
    }
    const proxy = typeof entry.installProxy === 'string' && entry.installProxy.trim() !== ''
      ? entry.installProxy.trim()
      : await detectProxy(client)
    if (proxy !== '') log('installing through proxy ' + proxy)
    const proxyEnv = proxy === '' ? '' : 'HTTP_PROXY=' + proxy + ' HTTPS_PROXY=' + proxy + ' '
    const command = proxyEnv + 'npm i -g --prefix "$HOME/.local" @deepseek-ai/dsh@' + version + ' --no-audit --no-fund 2>&1 | tail -n 6'
    const install = await run(client, command)
    log('install exit ' + install.code)
    const after = (await run(client, bin + ' --version 2>/dev/null')).stdout.trim()
    if (after !== version) {
      client.end()
      const tail = (install.stdout || install.stderr || '').trim().split('\n').slice(-3).join(' / ')
      throw new Error('安装 dsh@' + version + ' 失败（当前 ' + (after === '' ? '仍缺失' : after) + '）' + (tail === '' ? '' : '：' + tail))
    }
    log('installed dsh ' + after)
  }

  // ------------------------------------------------------------- web server
  const probe = async () => {
    const result = await run(client, 'curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:' + webPort + '/ 2>/dev/null || true')
    return result.stdout.trim()
  }
  const alive = code => code === '200' || code === '303' || code === '401'

  const readToken = async () => {
    const result = await run(client, 'grep -o "token=[A-Za-z0-9_-]*" ' + logPath + ' 2>/dev/null | tail -1 | cut -d= -f2')
    const token = result.stdout.trim()
    return token === '' ? null : token
  }

  const ensureWeb = async () => {
    if (alive(await probe())) return
    stage('starting')
    log('starting remote dsh web on 127.0.0.1:' + webPort)
    await run(client, 'mkdir -p "$(dirname ' + logPath + ')" 2>/dev/null; nohup env PATH=$HOME/.local/bin:$PATH ' + bin + ' web --host 127.0.0.1 --port ' + webPort + ' --no-open > ' + logPath + ' 2>&1 &')
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(1000)
      if (alive(await probe())) return
    }
    const tail = (await run(client, 'tail -n 3 ' + logPath + ' 2>/dev/null')).stdout.trim()
    throw new Error('远端 dsh web 没有起来（端口 ' + webPort + '）' + (tail === '' ? '' : '：' + tail))
  }

  await ensureWeb()

  const tokenProvider = async () => {
    await ensureWeb()
    const token = await readToken()
    if (token === null) throw new Error('远端日志里没有 token：' + logPath)
    return token
  }

  // ---------------------------------------------------------------- gateway
  stage('gateway')
  const tunnel = await startTunnel(client, webPort)
  log('tunnel 127.0.0.1:' + tunnel.port + ' -> remote 127.0.0.1:' + webPort)

  let gateway = null
  try {
    gateway = await createGateway({
      connectHost: '127.0.0.1',
      connectPort: tunnel.port,
      authority: '127.0.0.1:' + webPort,
      tokenProvider,
      log,
    })
  } catch (error) {
    await new Promise(resolve => tunnel.server.close(resolve))
    client.end()
    throw error
  }

  stage('ready')
  let closed = false
  return {
    proxyUrl: 'http://127.0.0.1:' + gateway.port + '/',
    webUrl: null,
    async close() {
      if (closed) return
      closed = true
      try { await gateway.close() } catch { /* already closed */ }
      await new Promise(resolve => tunnel.server.close(() => resolve()))
      try { client.end() } catch { /* already gone */ }
    },
  }
}

/**
 * Connectivity + environment check behind the panel's "测试" button. Connects,
 * inspects and disconnects — it never installs anything and never starts the
 * remote web server.
 * @param {object} entry host entry from hosts.js
 * @param {string} [version] exact dsh version the local client runs
 */
export async function probeHost(entry, version = FALLBACK_VERSION) {
  const client = new Client()
  const auth = entry.auth ?? {}
  const config = {
    host: entry.host,
    port: Number(entry.sshPort ?? 22),
    username: entry.user,
    readyTimeout: 15_000,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 2,
  }
  if (typeof auth.password === 'string' && auth.password !== '') config.password = auth.password
  if (typeof auth.privateKeyPath === 'string' && auth.privateKeyPath !== '') config.privateKey = fs.readFileSync(auth.privateKeyPath)
  if (typeof auth.passphrase === 'string' && auth.passphrase !== '') config.passphrase = auth.passphrase

  const started = Date.now()
  try {
    await new Promise((resolve, reject) => {
      client.once('ready', resolve)
      client.once('error', reject)
      client.connect(config)
    })
  } catch (error) {
    throw new Error('SSH 连接失败：' + (error instanceof Error ? error.message : String(error)))
  }

  try {
    const bin = String(entry.dshBin ?? '~/.local/bin/dsh').replace(/^~/, '$HOME')
    const webPort = Number(entry.webPort ?? 18080)
    const node = (await run(client, 'node -v 2>/dev/null')).stdout.trim()
    const dsh = (await run(client, bin + ' --version 2>/dev/null')).stdout.trim()
    const web = (await run(client, 'curl -s -o /dev/null -w "%{http_code}" --max-time 3 http://127.0.0.1:' + webPort + '/ 2>/dev/null || true')).stdout.trim()
    return {
      ok: true,
      ms: Date.now() - started,
      node,
      dsh,
      needsInstall: node !== '' && dsh !== version,
      versionMatches: dsh === version,
      webAlive: web === '200' || web === '303' || web === '401',
      webCode: web === '' ? '000' : web,
    }
  } finally {
    try { client.end() } catch { /* already gone */ }
  }
}
