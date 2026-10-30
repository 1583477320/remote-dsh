/**
 * Browser half of dsh-remote-panel.
 *
 * Two views:
 *  - host picker: hosts already configured in dsh-ssh plus hosts added here,
 *    with an inline "add host" form (password, ports, optional install proxy);
 *  - session: the remote DSH embedded through the loopback gateway, with
 *    reload / maximize / disconnect.
 *
 * A connect request only starts a host-side job; this page polls /state and
 * shows the current stage (SSH, environment check, install, start, gateway) so
 * a first-time host that still needs dsh installed is readable instead of a
 * silent long wait.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-panel-ssh',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'remote-dsh'
    const EMPTY_FORM = { label: '', host: '', sshPort: '22', user: '', password: '', webPort: '18080', installProxy: '' }

    const STAGE_TEXT = {
      idle: '未连接',
      connecting: '正在连接 SSH…',
      ssh: 'SSH 已连通',
      checking: '正在检查远端环境…',
      installing: '正在安装远端 dsh（首次可能需要几分钟）…',
      starting: '正在启动远端 dsh web…',
      gateway: '正在建立会话通道…',
      ready: '已连接',
      failed: '连接失败',
    }

    const s = {
      page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, font: '13px/1.5 system-ui, "Segoe UI", sans-serif', color: 'inherit' },
      header: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', borderBottom: '1px solid color-mix(in srgb, currentColor 15%, transparent)', flex: '0 0 auto' },
      dot: (ok) => ({ width: '8px', height: '8px', borderRadius: '50%', background: ok === true ? '#3fb950' : ok === false ? '#d29922' : '#8b95a5', flex: '0 0 auto' }),
      title: { fontWeight: 600 },
      muted: { opacity: 0.7, fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
      spacer: { flex: 1 },
      btn: { font: 'inherit', padding: '4px 10px', borderRadius: '7px', border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap' },
      primary: { font: 'inherit', padding: '4px 12px', borderRadius: '7px', border: '1px solid #2563eb', background: '#2563eb', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' },
      body: { position: 'relative', flex: 1, minHeight: 0, background: '#fff', overflow: 'auto' },
      frame: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 },
      list: { padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '860px' },
      row: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 14px', borderRadius: '10px', border: '1px solid color-mix(in srgb, currentColor 16%, transparent)' },
      rowMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      badge: { fontSize: '11px', padding: '0 6px', borderRadius: '5px', border: '1px solid color-mix(in srgb, currentColor 22%, transparent)', opacity: 0.75 },
      form: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px', padding: '14px', borderRadius: '10px', border: '1px solid color-mix(in srgb, currentColor 16%, transparent)' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' },
      input: { font: 'inherit', padding: '6px 8px', borderRadius: '7px', border: '1px solid color-mix(in srgb, currentColor 25%, transparent)', background: 'transparent', color: 'inherit' },
      error: { padding: '10px 12px', borderRadius: '9px', background: '#3a1a1a', color: '#f6b8b8', border: '1px solid #6b1e1e', fontSize: '12.5px' },
      center: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: '#8b95a5', fontSize: '12.5px', pointerEvents: 'none', textAlign: 'center', padding: '24px' },
      restore: { position: 'fixed', top: '52px', left: '50%', transform: 'translateX(-50%)', zIndex: 2147483000, padding: '6px 14px', borderRadius: '999px', background: 'rgba(24,26,32,.78)', color: '#fff', font: 'inherit', fontSize: '12.5px', pointerEvents: 'none', boxShadow: '0 4px 16px rgba(0,0,0,.25)' },
    }

    function RemoteDshIcon({ size }) {
      return h(
        'svg',
        {
          'data-dsh-panel-entry': PANEL_ID,
          viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 1.75, y: 2.5, width: 12.5, height: 8.5, rx: 1.5 }),
        h('path', { d: 'M5.5 14h5' }),
        h('path', { d: 'M8 11v3' }),
      )
    }

    function Field({ label, children }) {
      return h('label', { style: s.field }, h('span', { style: s.muted }, label), children)
    }

    /** Parse a JSON body with a readable failure for a stale host half. */
    async function jsonOf(response) {
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new Error('面板后端未就绪（HTTP ' + response.status + '）。请完全退出应用后重新打开，让它加载新版插件。')
      }
    }

    /** The version this client half was built with (the remote must match). */
    function clientVersion() {
      const boot = window.__DSH_BOOT__
      return boot !== undefined && boot.release !== undefined && typeof boot.release.version === 'string'
        ? boot.release.version
        : '0.2.1-rc.3'
    }

    function RemoteDshPage() {
      const [hosts, setHosts] = React.useState([])
      const [busy, setBusy] = React.useState(null)
      const [tests, setTests] = React.useState({})
      const [error, setError] = React.useState(null)
      const [form, setForm] = React.useState(EMPTY_FORM)
      const [showForm, setShowForm] = React.useState(false)
      const [active, setActive] = React.useState(null)
      const [stage, setStage] = React.useState('idle')
      const [elapsed, setElapsed] = React.useState(0)
      const [expanded, setExpanded] = React.useState(false)
      const [showHint, setShowHint] = React.useState(false)
      const [reloadKey, setReloadKey] = React.useState(0)
      const stageRef = React.useRef(null)

      const refresh = React.useCallback(() => {
        fetch('/api/remote-dsh/hosts', { headers: { accept: 'application/json' } })
          .then(jsonOf)
          .then(value => {
            setHosts(Array.isArray(value.hosts) ? value.hosts : [])
            setError(null)
          })
          .catch(cause => setError(cause.message || String(cause)))
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      // Escape closes the maximized view. Focus normally sits inside the
      // embedded frame after any click there, and a focused child frame never
      // bubbles key events to this document — the gateway injects a bridge into
      // the remote page that postMessages Escape here instead.
      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') setExpanded(false) }
        const onMessage = (event) => {
          const data = event.data
          if (data !== null && typeof data === 'object' && data.type === 'dsh-remote-esc') setExpanded(false)
        }
        window.addEventListener('keydown', onKey)
        window.addEventListener('message', onMessage)
        return () => {
          window.removeEventListener('keydown', onKey)
          window.removeEventListener('message', onMessage)
        }
      }, [])

      // Briefly explain how to leave maximized mode; there is no button.
      React.useEffect(() => {
        if (!expanded) { setShowHint(false); return undefined }
        setShowHint(true)
        const timer = setTimeout(() => setShowHint(false), 2500)
        return () => clearTimeout(timer)
      }, [expanded])

      // Poll while a host-side connect job is running (install can take minutes).
      React.useEffect(() => {
        if (active === null || active.proxyUrl !== undefined) return undefined
        let alive = true
        const started = Date.now()
        const tick = async () => {
          try {
            const state = await jsonOf(await fetch('/api/remote-dsh/state', { headers: { accept: 'application/json' } }))
            if (!alive) return
            const row = (state.hosts || []).find(item => item.id === active.id)
            if (row !== undefined) {
              setStage(row.stage || 'connecting')
              setElapsed(Math.round((Date.now() - started) / 1000))
              if (row.error) { setError(row.error); setActive(null); setStage('failed'); return }
              if (row.proxyUrl) { setActive(prev => (prev === null ? prev : { ...prev, proxyUrl: row.proxyUrl })); return }
            }
          } catch { /* keep polling */ }
          if (alive) setTimeout(tick, 1500)
        }
        tick()
        return () => { alive = false }
      }, [active])

      const connect = (host) => {
        setBusy(host.id)
        setError(null)
        setStage('connecting')
        setElapsed(0)
        fetch('/api/remote-dsh/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: host.id, version: clientVersion() }),
        })
          .then(async response => ({ ok: response.ok, value: await jsonOf(response) }))
          .then(({ ok, value }) => {
            if (!ok) throw new Error(value.error || '连接失败')
            setActive({ id: host.id, label: host.label })
            setStage(value.stage || 'connecting')
          })
          .catch(cause => { setError(String(cause.message || cause)); setStage('failed') })
          .finally(() => setBusy(null))
      }

      const disconnect = () => {
        const id = active === null ? null : active.id
        setActive(null)
        setExpanded(false)
        setStage('idle')
        stageRef.current = null
        if (id !== null) {
          fetch('/api/remote-dsh/disconnect', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          }).then(refresh).catch(() => {})
        }
      }

      const save = () => {
        setBusy('form')
        setError(null)
        fetch('/api/remote-dsh/hosts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            label: form.label,
            host: form.host,
            sshPort: Number(form.sshPort || 22),
            user: form.user,
            password: form.password,
            webPort: Number(form.webPort || 18080),
            installProxy: form.installProxy,
          }),
        })
          .then(async response => ({ ok: response.ok, value: await jsonOf(response) }))
          .then(({ ok, value }) => {
            if (!ok) throw new Error(value.error || '保存失败')
            setHosts(Array.isArray(value.hosts) ? value.hosts : hosts)
            setForm(EMPTY_FORM)
            setShowForm(false)
          })
          .catch(cause => setError(String(cause.message || cause)))
          .finally(() => setBusy(null))
      }

      const remove = (host) => {
        setBusy(host.id)
        fetch('/api/remote-dsh/hosts?id=' + encodeURIComponent(host.id), { method: 'DELETE' })
          .then(jsonOf)
          .then(value => setHosts(Array.isArray(value.hosts) ? value.hosts : hosts))
          .catch(cause => setError(String(cause.message || cause)))
          .finally(() => setBusy(null))
      }

      /** Delete with a source-aware confirmation. */
      const askRemove = (host) => {
        const message = host.source === 'dsh-ssh'
          ? '「' + host.label + '」来自 SSH 插件，删除会同时把它从 ~/.dsh/dsh-ssh.json 里移除。继续？'
          : '删除主机「' + host.label + '」？'
        if (window.confirm(message)) remove(host)
      }

      /** Connectivity/environment probe; never installs or starts anything. */
      const test = (host) => {
        setTests(prev => ({ ...prev, [host.id]: { state: 'running', text: '正在测试 SSH 与环境…' } }))
        fetch('/api/remote-dsh/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: host.id, version: clientVersion() }),
        })
          .then(jsonOf)
          .then(value => {
            if (value.ok !== true) {
              setTests(prev => ({ ...prev, [host.id]: { state: 'failed', ok: false, text: '测试失败：' + (value.error || '未知错误') } }))
              return
            }
            const parts = ['SSH 正常']
            parts.push(value.node === '' ? 'Node 缺失' : 'Node ' + value.node)
            parts.push(value.dsh === '' ? 'dsh 未安装（连接时会自动安装）'
              : 'dsh ' + value.dsh + (value.versionMatches ? '（版本匹配）' : '（版本不符，连接时会自动安装）'))
            parts.push(value.webAlive ? '远端 dsh web 在运行' : '远端 dsh web 未运行（连接时会启动）')
            setTests(prev => ({ ...prev, [host.id]: { state: 'done', ok: true, text: parts.join(' · ') + ' · ' + value.ms + 'ms' } }))
          })
          .catch(cause => setTests(prev => ({ ...prev, [host.id]: { state: 'failed', ok: false, text: '测试失败：' + (cause.message || cause) } })))
      }

      const chromeTop = document.documentElement.hasAttribute('data-windows-titlebar') ? 40 : 0
      const stageText = STAGE_TEXT[stage] || stage

      if (active !== null) {
        return h(
          'div',
          { style: s.page, 'data-dsh-plugin': 'remote-dsh' },
          expanded ? null : h(
            'div',
            { style: s.header },
            h('span', { style: s.dot(stage === 'ready' ? true : null) }),
            h('span', { style: s.title }, '远程 DSH'),
            h('span', { style: s.muted }, active.label),
            h('span', { style: s.muted }, stageText + (elapsed > 0 && stage !== 'ready' ? '（' + elapsed + 's）' : '')),
            h('span', { style: s.spacer }),
            h('button', { type: 'button', style: s.btn, onClick: () => { setStage('ready'); setReloadKey(key => key + 1) } }, '重新加载'),
            h('button', { type: 'button', style: s.btn, onClick: () => setExpanded(value => !value) }, '放大'),
            h('button', {
              type: 'button',
              style: s.btn,
              onClick: () => { if (active.proxyUrl !== undefined) window.open(active.proxyUrl, '_blank', 'noopener') },
              title: '在独立浏览器窗口打开（剪贴板不受嵌入限制）',
            }, '在新窗口打开'),
            h('button', { type: 'button', style: s.btn, onClick: disconnect }, '断开'),
          ),
          h(
            'div',
            { ref: stageRef, style: expanded ? { ...s.body, position: 'fixed', left: 0, right: 0, bottom: 0, top: chromeTop, zIndex: 999999 } : s.body },
            active.proxyUrl !== undefined
              ? h('iframe', {
                  key: reloadKey,
                  src: active.proxyUrl,
                  style: s.frame,
                  title: 'remote dsh',
                  // The remote page is cross-origin to the dsh-app shell, so the
                  // clipboard permissions must be delegated explicitly; without
                  // this the remote UI's "copy link" buttons fail silently.
                  allow: 'clipboard-read; clipboard-write',
                  onLoad: () => setStage('ready'),
                })
              : h('div', { style: s.center },
                  stageText + (elapsed > 0 ? '（' + elapsed + 's）' : ''),
                  h('div', { style: { marginTop: '8px' } }, '首次连接一台新机器时，会先检查/安装远端的 dsh，再启动 dsh web。')),
            error !== null ? h('div', { style: { ...s.error, position: 'absolute', left: '16px', right: '16px', bottom: '16px' } }, error) : null,
          ),
          // Maximized mode is keyboard-only by design: Esc closes it (the
          // gateway bridges Esc out of the embedded frame). A short-lived hint
          // is the only affordance, and it disappears on its own.
          expanded && showHint
            ? h('div', { style: s.restore }, '已放大 · 按 Esc 退出')
            : null,
        )
      }

      return h(
        'div',
        { style: s.page, 'data-dsh-plugin': 'remote-dsh' },
        h(
          'div',
          { style: s.header },
          h('span', { style: s.title }, '远程 DSH'),
          h('span', { style: s.muted }, '选择主机后在本面板内打开远端 DSH'),
          h('span', { style: s.spacer }),
          h('button', { type: 'button', style: s.btn, onClick: () => { setShowForm(value => !value); setError(null) } }, showForm ? '取消' : '添加主机'),
        ),
        h(
          'div',
          { style: s.body },
          h(
            'div',
            { style: s.list },
            error !== null ? h('div', { style: s.error }, error) : null,
            showForm ? h(
              'div',
              { style: s.form },
              h(Field, { label: '名称（可选）' }, h('input', { style: s.input, value: form.label, onChange: e => setForm({ ...form, label: e.target.value }), placeholder: '实验室服务器' })),
              h(Field, { label: '主机 / IP' }, h('input', { style: s.input, value: form.host, onChange: e => setForm({ ...form, host: e.target.value }), placeholder: '10.82.186.100' })),
              h(Field, { label: 'SSH 端口' }, h('input', { style: s.input, value: form.sshPort, onChange: e => setForm({ ...form, sshPort: e.target.value }) })),
              h(Field, { label: '用户名' }, h('input', { style: s.input, value: form.user, onChange: e => setForm({ ...form, user: e.target.value }), placeholder: 'zhao' })),
              h(Field, { label: '密码' }, h('input', { style: s.input, type: 'password', value: form.password, onChange: e => setForm({ ...form, password: e.target.value }) })),
              h(Field, { label: '远端 dsh web 端口' }, h('input', { style: s.input, value: form.webPort, onChange: e => setForm({ ...form, webPort: e.target.value }) })),
              h(Field, { label: '安装用代理（可选，如 http://127.0.0.1:7890）' }, h('input', { style: s.input, value: form.installProxy, onChange: e => setForm({ ...form, installProxy: e.target.value }) })),
              h('div', { style: { gridColumn: '1 / -1', display: 'flex', gap: '10px', justifyContent: 'flex-end' } },
                h('button', { type: 'button', style: s.btn, onClick: () => { setForm(EMPTY_FORM); setShowForm(false) } }, '取消'),
                h('button', { type: 'button', style: s.primary, onClick: save, disabled: busy === 'form' }, busy === 'form' ? '保存中…' : '保存')),
            ) : null,
            hosts.length === 0
              ? h('div', { style: { ...s.muted, padding: '10px 2px' } }, '还没有可用主机。可以在上面「添加主机」，或先在 SSH 插件里配置（会自动出现在这里）。')
              : null,
            hosts.map(host => {
              const probe = tests[host.id]
              return h(
                'div',
                { key: host.id, style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                h(
                  'div',
                  { style: s.row },
                  h('div', { style: s.rowMain },
                    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                      h('span', { style: { fontWeight: 600 } }, host.label),
                      h('span', { style: s.badge }, host.source === 'dsh-ssh' ? 'SSH 插件' : '本面板'),
                      host.connected ? h('span', { style: s.badge }, '已连接') : null,
                      host.stage !== undefined && host.stage !== 'idle' && host.stage !== 'ready' && host.stage !== 'failed'
                        ? h('span', { style: s.badge }, STAGE_TEXT[host.stage] || host.stage)
                        : null),
                    h('div', { style: s.muted }, host.user + '@' + host.host + ':' + host.sshPort + '  ·  web ' + host.webPort)),
                  h('button', { type: 'button', style: s.btn, onClick: () => test(host), disabled: probe !== undefined && probe.state === 'running' },
                    probe !== undefined && probe.state === 'running' ? '测试中…' : '测试'),
                  h('button', { type: 'button', style: s.primary, onClick: () => connect(host), disabled: busy === host.id }, busy === host.id ? '连接中…' : '连接'),
                  h('button', { type: 'button', style: s.btn, onClick: () => askRemove(host), disabled: busy === host.id }, '删除'),
                ),
                probe !== undefined && probe.text !== undefined
                  ? h('div', { style: { ...s.muted, whiteSpace: 'normal', paddingLeft: '14px', color: probe.ok ? '#3fb950' : '#e0a458' } }, probe.text)
                  : null,
              )
            }),
          ),
        ),
      )
    }

    exports.inject = ['slots']

    exports.apply = (ctx) => {
      const disposers = []
      try {
        const slots = ctx.slots
        disposers.push(slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 45,
          label: () => '远程 DSH',
        }, RemoteDshIcon)))
        disposers.push(slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
        }, RemoteDshPage)))
      } catch (error) {
        console.warn('[remote-dsh] panel registration failed:', error)
      }
      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) {
          try { dispose() } catch { /* already gone */ }
        }
      })
    }

    return module.exports
  },
})
