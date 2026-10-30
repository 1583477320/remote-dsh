/**
 * Host bookkeeping for the remote DSH panel.
 *
 * Two sources, merged for the UI:
 *  - hosts already configured in dsh-ssh (~/.dsh/dsh-ssh.json): id "ssh:<alias>"
 *  - hosts added here (~/.dsh/remote-dsh.json): id "local:<id>"
 *
 * Credentials are reused verbatim from dsh-ssh (the same plaintext-in-0600
 * trust model that plugin already documents); hosts added here store their own.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const STORE_PATH = path.join(DSH_HOME, 'remote-dsh.json')
const SSH_STORE_PATH = path.join(DSH_HOME, 'dsh-ssh.json')

/** Defaults for a host entry. */
const DEFAULTS = {
  sshPort: 22,
  webPort: 18080,
  dshBin: '~/.local/bin/dsh',
  webLog: '~/.dsh/logs/dsh-web.log',
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** Hosts added through this panel. */
export function loadLocal() {
  const value = readJson(STORE_PATH)
  return Array.isArray(value?.hosts) ? value.hosts : []
}

function saveLocal(hosts) {
  fs.mkdirSync(DSH_HOME, { recursive: true, mode: 0o700 })
  const tmp = STORE_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, hosts }, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, STORE_PATH)
}

/** Hosts already configured for dsh-ssh. */
export function loadSsh() {
  const value = readJson(SSH_STORE_PATH)
  if (!Array.isArray(value?.hosts)) return []
  return value.hosts.map(entry => ({
    id: 'ssh:' + entry.alias,
    label: entry.alias,
    host: entry.host,
    sshPort: entry.port ?? DEFAULTS.sshPort,
    user: entry.user,
    auth: entry.auth ?? { kind: 'password' },
    webPort: entry.webPort ?? DEFAULTS.webPort,
    dshBin: DEFAULTS.dshBin,
    webLog: DEFAULTS.webLog,
    source: 'dsh-ssh',
  }))
}

/** Everything the picker can connect to. */
export function listHosts() {
  const local = loadLocal().map(entry => ({ ...DEFAULTS, ...entry, id: 'local:' + entry.id, source: 'panel' }))
  return [...loadSsh(), ...local]
}

/** Resolve one id to a connectable entry. */
export function resolveHost(id) {
  return listHosts().find(entry => entry.id === id) ?? null
}

/** Insert or update a panel-owned host. */
export function upsertHost(input) {
  const host = String(input.host ?? '').trim()
  const user = String(input.user ?? '').trim()
  if (host === '' || user === '') throw new Error('host and user are required')
  const password = typeof input.password === 'string' ? input.password : ''
  if (password === '') throw new Error('password is required')
  const hosts = loadLocal()
  const id = typeof input.id === 'string' && input.id !== '' ? input.id.replace(/^local:/, '') : Math.random().toString(36).slice(2, 10)
  const entry = {
    id,
    label: String(input.label ?? '').trim() || host,
    host,
    sshPort: Number(input.sshPort ?? DEFAULTS.sshPort),
    user,
    auth: { kind: 'password', password },
    webPort: Number(input.webPort ?? DEFAULTS.webPort),
    dshBin: String(input.dshBin ?? DEFAULTS.dshBin),
    webLog: String(input.webLog ?? DEFAULTS.webLog),
    installProxy: typeof input.installProxy === 'string' ? input.installProxy.trim() : '',
  }
  const index = hosts.findIndex(item => item.id === id)
  if (index >= 0) hosts[index] = entry
  else hosts.push(entry)
  saveLocal(hosts)
  return entry
}

/** Remove a host: panel-owned ones from this store, dsh-ssh ones from its store. */
export function removeHost(id) {
  const raw = String(id)
  if (raw.startsWith('ssh:')) {
    const alias = raw.slice(4)
    const value = readJson(SSH_STORE_PATH)
    if (!Array.isArray(value?.hosts)) return false
    const next = value.hosts.filter(host => host.alias !== alias)
    if (next.length === value.hosts.length) return false
    const tmp = SSH_STORE_PATH + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify({ ...value, hosts: next }, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, SSH_STORE_PATH)
    return true
  }
  const bare = raw.replace(/^local:/, '')
  const hosts = loadLocal()
  const next = hosts.filter(item => item.id !== bare)
  saveLocal(next)
  return hosts.length !== next.length
}
