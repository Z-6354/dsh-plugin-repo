/**
 * dsh-plugin-repo — browser client half.
 *
 * A pure Cordis client plugin (no dependency on any @deepseek-ai official
 * package): registers a `settings.section` page "插件仓库".
 *
 * Features:
 *  - Lists THIS device's installed non-official plugins with a "上传到仓库"
 *    button (auto npm-pack) plus a manual .tgz upload.
 *  - Lists this device's repository .tgz packages: pull (download) to local,
 *    and install into the local web profile (with a confirm step; version-aware,
 *    lower/equal versions are skipped).
 *  - Remote device: enter another DSH's IP (+port), click 访问, list its repo,
 *    multi-select / select-all packages and download them into THIS local repo.
 *
 * Talks to the host over same-origin fetch against the /pluginrepo REST API.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-repo',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react')

    const API = '/pluginrepo/api'

    function h(type, props, ...children) {
      return React.createElement(type, props || null, ...children)
    }

    async function fetchJson(path, init) {
      const res = await fetch(path, init)
      let body = null
      try { body = await res.json() } catch (e) { /* non-json */ }
      if (!res.ok) {
        const msg = (body && body.error) || `HTTP ${res.status}`
        throw new Error(msg)
      }
      return body
    }

    // DSH design tokens live on :root (set by @deepseek-ai/dsh-client-ui-theme).
    // Reference them through CSS custom properties with graceful fallbacks so the
    // section matches the host look in both light and dark themes.
    const cssVar = (name, fallback) => `var(${name}, ${fallback})`

    const T = {
      labelPrimary: cssVar('--dsw-alias-label-primary', '#333'),
      labelSecondary: cssVar('--dsw-alias-label-secondary', '#5f6368'),
      labelTertiary: cssVar('--dsw-alias-label-tertiary', '#80868b'),
      labelDimmed: cssVar('--dsw-alias-label-dimmed', '#9aa0a6'),
      bgBase: cssVar('--dsw-alias-bg-base', '#ffffff'),
      bgLayer1: cssVar('--dsw-alias-bg-layer-1', '#f7f7f8'),
      bgHover: cssVar('--dsw-alias-interactive-bg-hover', 'rgba(0,0,0,0.04)'),
      borderL1: cssVar('--dsw-alias-border-l1', 'rgba(0,0,0,0.08)'),
      brandPrimary: cssVar('--dsw-alias-brand-primary', '#4d6bfe'),
      buttonPrimaryFill: cssVar('--dsw-alias-button-primary-fill', '#4d6bfe'),
      buttonPrimaryHover: cssVar('--dsw-alias-button-primary-hover', '#5a78ff'),
      buttonPrimaryFg: cssVar('--dsw-alias-button-contrast-fill', '#ffffff'),
      danger: cssVar('--dsw-alias-state-error-primary', '#e5484d'),
      success: cssVar('--dsw-alias-state-success-primary', '#30a46c'),
      fontFamily: cssVar('--dsw-font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'),
    }

    const fontS = { fontFamily: T.fontFamily, fontSize: '13px', lineHeight: '20px' }
    const fontBase = { fontFamily: T.fontFamily, fontSize: '14px', lineHeight: '22px' }

    const rowStyle = {
      padding: '8px 0', borderBottom: `1px solid ${T.borderL1}`,
      display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
    }
    const btnStyle = {
      padding: '5px 12px', fontSize: '13px', lineHeight: '18px', cursor: 'pointer',
      fontFamily: T.fontFamily, color: T.labelPrimary,
      background: T.bgLayer1, border: `1px solid ${T.borderL1}`,
      borderRadius: '6px',
    }
    const btnPrimaryStyle = {
      ...btnStyle, color: T.buttonPrimaryFg, background: T.buttonPrimaryFill,
      borderColor: T.buttonPrimaryFill,
    }
    const small = { ...fontS, color: T.labelTertiary }
    const inputStyle = {
      padding: '5px 10px', fontSize: '13px', lineHeight: '18px',
      fontFamily: T.fontFamily, color: T.labelPrimary,
      background: T.bgBase, border: `1px solid ${T.borderL1}`, borderRadius: '6px',
    }
    const sectionTitle = { ...fontBase, fontWeight: 600, color: T.labelPrimary, margin: '0 0 4px' }
    const h3Style = { ...fontBase, fontWeight: 600, color: T.labelPrimary, margin: '20px 0 8px' }

    function PluginRepoSection() {
      const [installed, setInstalled] = React.useState([])
      const [repoPkgs, setRepoPkgs] = React.useState([])
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [uploadName, setUploadName] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [roots, setRoots] = React.useState([])
      const [newRoot, setNewRoot] = React.useState('')

      // remote state
      const [remoteHost, setRemoteHost] = React.useState('')
      const [remotePort, setRemotePort] = React.useState('3080')
      const [remoteList, setRemoteList] = React.useState(null) // { host, port, packages }
      const [selected, setSelected] = React.useState({}) // filename -> true

      // install flow
      const [confirmPlan, setConfirmPlan] = React.useState(null) // { filename, plan }

      const refresh = React.useCallback(async () => {
        setBusy(true); setError('')
        try {
          const u = await fetchJson(`${API}/unofficial`)
          setInstalled(u.installed || [])
          setRepoPkgs(u.repo || [])
          setRoots(u.roots || [])
        } catch (e) { setError(String(e && e.message || e)) } finally { setBusy(false) }
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      async function addRoot() {
        const p = newRoot.trim()
        if (!p) { setError('请输入要添加的搜索路径'); return }
        setBusy(true); setMessage(''); setError('')
        try {
          const r = await fetch(`${API}/roots?path=${encodeURIComponent(p)}`, { method: 'POST' })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          setNewRoot('')
          setMessage(`已添加搜索路径：${p}`)
          await refresh()
        } catch (e) { setError(String(e && e.message || e)) } finally { setBusy(false) }
      }

      async function autoUpload(pkg) {
        setBusy(true); setMessage(''); setError('')
        try {
          const r = await fetch(`${API}/pack-upload?name=${encodeURIComponent(pkg.name)}`, { method: 'POST' })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          setMessage(`已上传 ${b.name}@${b.version} 到仓库`)
          await refresh()
        } catch (e) { setError(String(e && e.message || e)) } finally { setBusy(false) }
      }

      async function manualUpload(file) {
        if (!file) return
        setBusy(true); setMessage(''); setError('')
        try {
          const qs = uploadName.trim() ? `?name=${encodeURIComponent(uploadName.trim())}` : ''
          const r = await fetch(`${API}/upload${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          setMessage(`已上传 ${b.filename} (${b.size} 字节)`)
          await refresh()
        } catch (e) { setError(String(e && e.message || e)) } finally { setBusy(false) }
      }

      async function visitRemote() {
        const host = remoteHost.trim()
        if (!host) { setError('请输入对方 DSH 的 IP'); return }
        setBusy(true); setError(''); setMessage(''); setSelected({})
        try {
          const r = await fetch(`${API}/remote?host=${encodeURIComponent(host)}&port=${encodeURIComponent(remotePort || '3080')}`)
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          setRemoteList({ host, port: remotePort || '3080', packages: b.packages || [] })
        } catch (e) { setError(String(e && e.message || e)) } finally { setBusy(false) }
      }

      function toggleAllRemote(checked) {
        const next = {}
        if (checked && remoteList) for (const p of remoteList.packages) next[p.filename] = true
        setSelected(next)
      }

      async function pullRemoteSelected() {
        if (!remoteList) return
        const files = remoteList.packages.filter((p) => selected[p.filename]).map((p) => p.filename)
        if (files.length === 0) { setError('请先选择要拉取的插件'); return }
        setBusy(true); setMessage(''); setError('')
        try {
          const r = await fetch(`${API}/remote-pull`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: remoteList.host, port: remoteList.port, filenames: files }),
          })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          const okCount = (b.pulled || []).filter((x) => x.ok).length
          setMessage(`已拉取 ${okCount}/${files.length} 个到本机仓库`)
          setSelected({})
          await refresh()
        } catch (e) { setError(String(e && e.message || e)) } finally { setBusy(false) }
      }

      async function planInstall(pkg) {
        setBusy(true); setError(''); setMessage('')
        try {
          const r = await fetch(`${API}/install`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: pkg.filename, confirm: false }),
          })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          if (b.skip) { setMessage(`${b.reason}`); return }
          setConfirmPlan({ filename: pkg.filename, plan: b })
        } catch (e) { setError(String(e && e.message || e)) } finally { setBusy(false) }
      }

      async function confirmInstall() {
        if (!confirmPlan) return
        setBusy(true); setError(''); setMessage('')
        try {
          const r = await fetch(`${API}/install`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: confirmPlan.filename, confirm: true }),
          })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          setConfirmPlan(null)
          setMessage(b.skipped ? `已跳过：${b.reason}` : `已安装 ${b.name}@${b.version}（重启后生效）`)
          await refresh()
        } catch (e) { setError(String(e && e.message || e)) } finally { setBusy(false) }
      }

      function PullDownload(pkg) {
        fetch(`${API}/../download/${encodeURIComponent(pkg.filename)}`)
          .then((res) => res.blob())
          .then((blob) => {
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url; a.download = pkg.filename
            document.body.appendChild(a); a.click(); a.remove()
            URL.revokeObjectURL(url)
            setMessage(`已开始下载 ${pkg.filename}`)
          })
          .catch((e) => setError(String(e && e.message || e)))
      }

      return h('div', { style: { fontFamily: T.fontFamily, fontSize: '14px', color: T.labelPrimary } },
        h('h2', { style: { ...fontBase, fontWeight: 600, fontSize: '18px', color: T.labelPrimary, margin: '0 0 6px' } }, '插件仓库'),
        h('p', { style: { ...small, margin: '0 0 12px' } },
          '每个设备自带一个插件仓库服务器（非官方插件，自动排除 @deepseek-ai/* 官方插件）。'
          + '可上传本机插件、输入对方 DSH 的 IP 拉取其仓库内容，再从仓库确认后安装到本地。'),

        error ? h('p', { style: { ...fontS, color: T.danger, margin: '0 0 8px' } }, String(error)) : null,
        message ? h('p', { style: { ...fontS, color: T.success, margin: '0 0 8px' } }, message) : null,

        // ---- remote access ----
        h('h3', { style: h3Style }, '跨设备拉取'),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('input', { type: 'text', placeholder: '对方 DSH 的 IP（如 192.168.1.10）', value: remoteHost, onChange: (e) => setRemoteHost(e.target.value), style: { ...inputStyle, width: '220px' } }),
          h('input', { type: 'text', placeholder: '端口(默认3080)', value: remotePort, onChange: (e) => setRemotePort(e.target.value), style: { ...inputStyle, width: '90px' } }),
          h('button', { onClick: visitRemote, disabled: busy, style: busy ? { ...btnStyle, opacity: 0.6 } : btnStyle }, busy ? '访问中…' : '访问'),
          h('button', { onClick: () => { setRemoteList(null); setSelected({}) }, style: btnStyle }, '清空'),
        ),
        remoteList && h('div', { style: { marginTop: '8px' } },
          h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            h('label', null, h('input', { type: 'checkbox', onChange: (e) => toggleAllRemote(e.target.checked), checked: remoteList.packages.length > 0 && remoteList.packages.every((p) => selected[p.filename]) }), ` 全选 (${remoteList.packages.length})`),
            h('button', { onClick: pullRemoteSelected, disabled: busy, style: btnStyle }, '下载所选到本机仓库'),
          ),
          h('div', { style: { marginTop: '6px' } },
            remoteList.packages.length === 0 ? h('p', { style: small }, '（对方仓库为空）')
              : remoteList.packages.map((p) => h('div', { key: p.filename, style: rowStyle },
                  h('input', { type: 'checkbox', checked: !!selected[p.filename], onChange: (e) => setSelected((s) => ({ ...s, [p.filename]: e.target.checked })) }),
                  h('span', { style: { fontWeight: 500 } }, `${p.name}@${p.version}`),
                  h('span', { style: small }, `${p.size} 字节`),
                )),
          ),
        ),

        // ---- search roots ----
        h('h3', { style: h3Style }, '搜索根目录'),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px' } },
          h('input', { type: 'text', placeholder: '输入插件目录路径（如 D:\\0HAN\\Work\\my-plugins）', value: newRoot, onChange: (e) => setNewRoot(e.target.value), style: { ...inputStyle, width: '320px' } }),
          h('button', { onClick: addRoot, disabled: busy, style: busy ? { ...btnStyle, opacity: 0.6 } : btnStyle }, '添加路径'),
        ),
        roots.length === 0
          ? h('p', { style: small }, '（仅默认位置 ~/.dsh）')
          : h('div', null, roots.map((r) => h('div', { key: r, style: { ...fontS, color: T.labelTertiary, padding: '2px 0', wordBreak: 'break-all' } }, r))),

        // ---- installed non-official (auto upload) ----
        h('h3', { style: h3Style }, `本机已安装的非官方插件 (${installed.length})`),
        installed.length === 0
          ? h('p', { style: small }, '（无）')
          : h('div', null, installed.map((p) => h('div', { key: p.name, style: rowStyle },
              h('span', { style: { ...fontS, fontWeight: 600, color: T.labelPrimary } }, `${p.name}@${p.version}`),
              h('button', { onClick: () => autoUpload(p), disabled: busy, style: busy ? { ...btnStyle, opacity: 0.6 } : btnStyle }, '上传到仓库'),
            ))),

        // ---- repo .tgz ----
        h('h3', { style: h3Style }, `本机仓库中的 .tgz 包 (${repoPkgs.length})`),
        repoPkgs.length === 0
          ? h('p', { style: small }, '（空）')
          : h('div', null, repoPkgs.map((p) => h('div', { key: p.filename, style: rowStyle },
              h('span', { style: { ...fontS, fontWeight: 600, color: T.labelPrimary } }, `${p.name}@${p.version}`),
              h('span', { style: small }, `${p.size} 字节`),
              h('button', { onClick: () => PullDownload(p), style: btnStyle }, '下载/拉取'),
              h('button', { onClick: () => planInstall(p), disabled: busy, style: busy ? { ...btnStyle, opacity: 0.6 } : btnStyle }, '安装到本地'),
            ))),

        // ---- manual upload ----
        h('h3', { style: h3Style }, '手动上传 .tgz'),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
          h('input', { type: 'text', placeholder: '包名（可选，默认用文件名）', value: uploadName, onChange: (e) => setUploadName(e.target.value), style: inputStyle }),
          h('input', { type: 'file', accept: '.tgz', onChange: (e) => { const f = e.target.files && e.target.files[0]; if (f) manualUpload(f) }, style: { ...fontS, color: T.labelSecondary, fontFamily: T.fontFamily } }),
        ),

        // ---- install confirm dialog ----
        confirmPlan && h('div', { style: { position: 'fixed', inset: 0, background: cssVar('--dsw-alias-bg-mask-1', 'rgba(0,0,0,0.45)'), display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 } },
          h('div', { style: { background: T.bgBase, color: T.labelPrimary, borderRadius: '10px', padding: '18px 22px', maxWidth: '460px', width: '90%', border: `1px solid ${T.borderL1}` } },
            h('h3', { style: { ...fontBase, fontWeight: 600, color: T.labelPrimary, margin: '0 0 8px', fontSize: '16px' } }, '确认安装到本地代码'),
            confirmPlan.plan && (
              h('div', null,
                h('p', { style: { ...fontBase, color: T.labelPrimary, margin: '4px 0' } }, `插件：${confirmPlan.plan.name}@${confirmPlan.plan.version}`),
                confirmPlan.plan.installedVersion ? h('p', { style: { ...small, margin: '4px 0' } }, `当前已装：${confirmPlan.plan.installedVersion}`) : null,
                h('p', { style: { ...fontBase, color: T.labelPrimary, margin: '4px 0' } }, '将会执行：'),
                h('ul', { style: { margin: '0 0 12px', paddingLeft: '18px' } },
                  (confirmPlan.plan.actions || []).map((a) => h('li', { key: a, style: { ...fontS, color: T.labelSecondary } }, a)),
                ),
              )
            ),
            h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'flex-end' } },
              h('button', { onClick: () => setConfirmPlan(null), style: btnStyle }, '取消'),
              h('button', { onClick: confirmInstall, disabled: busy, style: busy ? { ...btnPrimaryStyle, opacity: 0.6 } : btnPrimaryStyle }, busy ? '安装中…' : '确认安装'),
            ),
          ),
        ),

        h('button', { onClick: refresh, disabled: busy, style: { ...btnStyle, marginTop: '16px' } }, busy ? '刷新中…' : '刷新'),
      )
    }

    const name = 'plugin-repo'

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'plugin-repo',
        order: 40,
        label: '插件仓库',
      }, PluginRepoSection))
    }

    exports.name = name
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})