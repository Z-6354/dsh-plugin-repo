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

    // Compare two semver-ish versions. Returns -1 (a<b), 0 (equal), 1 (a>b), or
    // null when either side cannot be parsed.
    function compareVersions(a, b) {
      const pa = String(a || '').trim().replace(/^v/, '').split(/[.+-]/).map((x) => parseInt(x, 10))
      const pb = String(b || '').trim().replace(/^v/, '').split(/[.+-]/).map((x) => parseInt(x, 10))
      if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return null
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0, y = pb[i] || 0
        if (x !== y) return x > y ? 1 : -1
      }
      return 0
    }

    // Version state of a repo package vs what's installed locally.
    //   'uninstalled' — no local install (no badge)
    //   'current'     — same version   (green)
    //   'stale'       — installed older (yellow)
    //   'newer'       — installed newer (red, unexpected)
    function versionStateOf(pkg, installed) {
      const loc = installed.find((p) => p.name === pkg.name)
      if (!loc || !loc.version) return 'uninstalled'
      const cmp = compareVersions(loc.version, pkg.version)
      if (cmp === null) return 'unknown'
      if (cmp === 0) return 'current'
      if (cmp > 0) return 'newer'
      return 'stale'
    }

    const VERSION_BADGE = {
      current: { label: '已安装', color: '#16a34a' },
      stale: { label: '可升级', color: '#d97706' },
      newer: { label: '本机更新', color: '#e5484d' },
      unknown: { label: '版本未知', color: '#80868b' },
    }

    // DSH design tokens live on :root (set by @deepseek-ai/dsh-client-ui-theme).
    // Text/surface/border tokens are used (with safe fallbacks); button action
    // colors use explicit values because the alias button-* tokens chain through
    // boot vars that are unreliable across themes and rendered as white blocks.
    const cssVar = (name, fallback) => `var(${name}, ${fallback})`

    const BRAND = '#4d6bfe'
    const T = {
      labelPrimary: cssVar('--dsw-alias-label-primary', '#333'),
      labelSecondary: cssVar('--dsw-alias-label-secondary', '#5f6368'),
      labelTertiary: cssVar('--dsw-alias-label-tertiary', '#80868b'),
      labelDimmed: cssVar('--dsw-alias-label-dimmed', '#9aa0a6'),
      bgBase: cssVar('--dsw-alias-bg-base', '#ffffff'),
      borderL1: cssVar('--dsw-alias-border-l1', 'rgba(0,0,0,0.12)'),
      brandPrimary: BRAND,
      danger: '#e5484d',
      warning: '#d97706',
      success: '#16a34a',
      fontFamily: cssVar('--dsw-font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'),
    }

    const fontS = { fontFamily: T.fontFamily, fontSize: '13px', lineHeight: '20px' }
    const fontBase = { fontFamily: T.fontFamily, fontSize: '14px', lineHeight: '22px' }

    const rowStyle = {
      padding: '8px 0', borderBottom: `1px solid ${T.borderL1}`,
      display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
    }
    // Ghost button: transparent surface, thin border, label text.
    const btnStyle = {
      padding: '5px 12px', fontSize: '13px', lineHeight: '18px', cursor: 'pointer',
      whiteSpace: 'nowrap',
      fontFamily: T.fontFamily, color: T.labelPrimary,
      background: 'transparent', border: `1px solid ${T.borderL1}`,
      borderRadius: '6px',
    }
    // Primary button: explicit brand fill + white text (no unreliable tokens).
    const btnPrimaryStyle = {
      ...btnStyle, color: '#ffffff', background: BRAND, borderColor: BRAND,
    }
    const small = { ...fontS, color: T.labelTertiary }
    const inputStyle = {
      padding: '5px 10px', fontSize: '13px', lineHeight: '18px',
      fontFamily: T.fontFamily, color: T.labelPrimary,
      background: T.bgBase, border: `1px solid ${T.borderL1}`, borderRadius: '6px',
    }
    const sectionTitle = { ...fontBase, fontWeight: 600, color: T.labelPrimary, margin: '0 0 4px' }
    const h3Style = { ...fontBase, fontWeight: 600, color: T.labelPrimary, margin: '20px 0 8px' }

    // Module-level "加载更多" (defined once, NOT inside the section) so its
    // component identity is stable across renders — avoids unmount/remount churn.
    function LoadMore(props) {
      const { shown, total, onMore } = props
      if (shown >= total) return null
      return h('button', {
        onClick: onMore,
        style: { ...btnStyle, marginTop: '6px' },
      }, `加载更多（已显示 ${shown}/${total}）`)
    }

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
      const [remoteAddr, setRemoteAddr] = React.useState('') // domain/IP, optional scheme[:port]
      const [remoteList, setRemoteList] = React.useState(null) // { addr, packages }
      const [selected, setSelected] = React.useState({}) // remote filename -> true
      const [selInstalled, setSelInstalled] = React.useState({}) // installed name -> true
      const [selRepo, setSelRepo] = React.useState({}) // repo filename -> true

      // install flow
      const [confirmPlan, setConfirmPlan] = React.useState(null) // { filename, plan }

      // Pagination / lazy loading: each long list reveals PAGE_SIZE items at a
      // time via a "加载更多" affordance instead of rendering everything up-front.
      const PAGE_SIZE = 10
      const [shownInstalled, setShownInstalled] = React.useState(PAGE_SIZE)
      const [shownRepo, setShownRepo] = React.useState(PAGE_SIZE)
      const [shownRemote, setShownRemote] = React.useState(PAGE_SIZE)

      const refresh = React.useCallback(async () => {
        setBusy(true); setError('')
        try {
          const u = await fetchJson(`${API}/unofficial`)
          setInstalled(u.installed || [])
          setRepoPkgs(u.repo || [])
          setRoots(u.roots || [])
        } catch (e) { setError(String(e && e.message || e)) } finally { setBusy(false) }
      }, [])

      // Lightweight reload of the repo list only (no installed scan), used after
      // uploads so the list updates in place without a full page refresh.
      const refreshRepo = React.useCallback(async () => {
        try {
          const r = await fetchJson(`${API}/packages`)
          setRepoPkgs((r && r.packages) || [])
        } catch (e) { /* keep the previous list on transient failure */ }
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
        setMessage(''); setError('')
        try {
          const r = await fetch(`${API}/pack-upload?name=${encodeURIComponent(pkg.name)}`, { method: 'POST' })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          setMessage(`已上传 ${b.name}@${b.version} 到仓库`)
          await refreshRepo()
        } catch (e) { setError(String(e && e.message || e)) }
      }

      async function manualUpload(file) {
        if (!file) return
        setMessage(''); setError('')
        try {
          const qs = uploadName.trim() ? `?name=${encodeURIComponent(uploadName.trim())}` : ''
          const r = await fetch(`${API}/upload${qs}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          setMessage(`已上传 ${b.filename} (${b.size} 字节)`)
          setUploadName('')
          await refreshRepo()
        } catch (e) { setError(String(e && e.message || e)) }
      }

      async function boolUpload() {
        const names = installed.filter((p) => selInstalled[p.name]).map((p) => p.name)
        if (names.length === 0) { setError('请先勾选要上传的插件'); return }
        setMessage(''); setError('')
        try {
          const r = await fetch(`${API}/pack-upload-all`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ names }),
          })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          const okCount = (b.packed || []).filter((x) => x.ok).length
          setMessage(`已上传 ${okCount}/${names.length} 个到本机仓库`)
          setSelInstalled({})
          await refreshRepo()
        } catch (e) { setError(String(e && e.message || e)) }
      }

      function toggleAllInstalled(checked) {
        const next = {}
        if (checked) for (const p of installed) next[p.name] = true
        setSelInstalled(next)
      }

      function toggleAllRepo(checked) {
        const next = {}
        if (checked) for (const p of repoPkgs) next[p.filename] = true
        setSelRepo(next)
      }

      // 一键安装：把仓库里勾选的所有 .tgz 直接安装到本地 web profile
      async function installSelectedRepo() {
        const files = repoPkgs.filter((p) => selRepo[p.filename]).map((p) => p.filename)
        if (files.length === 0) { setError('请先勾选要安装的包'); return }
        setBusy(true); setError(''); setMessage('')
        try {
          const r = await fetch(`${API}/install-all`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filenames: files, confirm: true }),
          })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          const okCount = (b.installed || []).filter((x) => x.ok).length
          const skippedCount = (b.installed || []).filter((x) => x.skipped).length
          setMessage(`已安装 ${okCount} 个、跳过 ${skippedCount} 个（重启后生效）`)
          setSelRepo({})
          await refresh()
        } catch (e) { setError(String(e && e.message || e)) } finally { setBusy(false) }
      }

      async function visitRemote() {
        const addr = remoteAddr.trim()
        if (!addr) { setError('请输入对方 DSH 的地址（域名或 IP，可带端口）'); return }
        setBusy(true); setError(''); setMessage(''); setSelected({}); setShownRemote(PAGE_SIZE)
        try {
          const r = await fetch(`${API}/remote?host=${encodeURIComponent(addr)}`)
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          setRemoteList({ addr, packages: b.packages || [] })
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
            body: JSON.stringify({ host: remoteList.addr, filenames: files }),
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

      return h('div', { style: { fontFamily: T.fontFamily, fontSize: '14px', color: T.labelPrimary } },
        h('h2', { style: { ...fontBase, fontWeight: 600, fontSize: '18px', color: T.labelPrimary, margin: '0 0 6px' } }, '插件仓库'),
        h('p', { style: { ...small, margin: '0 0 12px' } },
          '每个设备自带一个插件仓库服务器（非官方插件，自动排除 @deepseek-ai/* 官方插件）。'
          + '可一键上传本机插件、输入对方地址（域名或 IP，可带端口）拉取其仓库内容，'
          + '再从仓库一键安装到本地。'),

        error ? h('p', { style: { ...fontS, color: T.danger, margin: '0 0 8px' } }, String(error)) : null,
        message ? h('p', { style: { ...fontS, color: T.success, margin: '0 0 8px' } }, message) : null,

        // ---- remote access ----
        h('h3', { style: h3Style }, '跨设备拉取'),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          h('input', { type: 'text', placeholder: '对方地址：裸 IP/域名用 http:3080；写 https:// 用 443；可带 :端口（如 https://dsh.example.com 或 192.168.1.10:8443）', value: remoteAddr, onChange: (e) => setRemoteAddr(e.target.value), style: { ...inputStyle, width: '460px' } }),
          h('button', { onClick: visitRemote, disabled: busy, style: busy ? { ...btnStyle, opacity: 0.6 } : btnStyle }, busy ? '访问中…' : '访问'),
          h('button', { onClick: () => { setRemoteList(null); setSelected({}) }, style: btnStyle }, '清空'),
        ),
        remoteList && h('div', { style: { marginTop: '8px' } },
          h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
            h('label', null, h('input', { type: 'checkbox', onChange: (e) => toggleAllRemote(e.target.checked), checked: remoteList.packages.length > 0 && remoteList.packages.every((p) => selected[p.filename]) }), ` 全选 (${remoteList.packages.length})`),
            h('button', { onClick: pullRemoteSelected, disabled: busy, style: btnStyle }, '拉取所选到本机仓库'),
          ),
          h('div', { style: { marginTop: '6px' } },
            remoteList.packages.length === 0 ? h('p', { style: small }, '（对方仓库为空）')
              : h('div', null,
                  remoteList.packages.slice(0, shownRemote).map((p) => h('div', { key: p.filename, style: rowStyle },
                    h('input', { type: 'checkbox', checked: !!selected[p.filename], onChange: (e) => setSelected((s) => ({ ...s, [p.filename]: e.target.checked })) }),
                    h('span', { style: { ...fontS, fontWeight: 600 } }, `${p.name}@${p.version}`),
                    h('span', { style: small }, `${p.size} 字节`),
                  )),
                  h(LoadMore, { shown: shownRemote, total: remoteList.packages.length, onMore: () => setShownRemote((n) => n + PAGE_SIZE) }),
                ),
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
          : h('div', null,
              h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px' } },
                h('label', null, h('input', { type: 'checkbox', onChange: (e) => toggleAllInstalled(e.target.checked), checked: installed.length > 0 && installed.every((p) => selInstalled[p.name]) }), ` 全选`),
                h('button', { onClick: boolUpload, disabled: busy, style: busy ? { ...btnPrimaryStyle, opacity: 0.6 } : btnPrimaryStyle }, '一键上传全部'),
              ),
              installed.slice(0, shownInstalled).map((p) => h('div', { key: p.name, style: rowStyle },
                h('input', { type: 'checkbox', checked: !!selInstalled[p.name], onChange: (e) => setSelInstalled((s) => ({ ...s, [p.name]: e.target.checked })) }),
                h('span', { style: { ...fontS, fontWeight: 600, color: T.labelPrimary } }, `${p.name}@${p.version}`),
                h('button', { onClick: () => autoUpload(p), disabled: busy, style: busy ? { ...btnStyle, opacity: 0.6 } : btnStyle }, '上传到仓库'),
              )),
              h(LoadMore, { shown: shownInstalled, total: installed.length, onMore: () => setShownInstalled((n) => n + PAGE_SIZE) }),
            ),

        // ---- repo .tgz ----
        h('h3', { style: h3Style }, `本机仓库中的 .tgz 包 (${repoPkgs.length})`),
        repoPkgs.length === 0
          ? h('p', { style: small }, '（空）')
          : h('div', null,
              h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px' } },
                h('label', null, h('input', { type: 'checkbox', onChange: (e) => toggleAllRepo(e.target.checked), checked: repoPkgs.length > 0 && repoPkgs.every((p) => selRepo[p.filename]) }), ` 全选`),
                h('button', { onClick: installSelectedRepo, disabled: busy, style: busy ? { ...btnPrimaryStyle, opacity: 0.6 } : btnPrimaryStyle }, '一键安装全部'),
              ),
              repoPkgs.slice(0, shownRepo).map((p) => {
                const st = versionStateOf(p, installed)
                const badge = VERSION_BADGE[st]
                const loc = installed.find((x) => x.name === p.name)
                return h('div', { key: p.filename, style: rowStyle },
                  h('input', { type: 'checkbox', checked: !!selRepo[p.filename], onChange: (e) => setSelRepo((s) => ({ ...s, [p.filename]: e.target.checked })) }),
                  h('span', { style: { ...fontS, fontWeight: 600, color: T.labelPrimary } }, `${p.name}@${p.version}`),
                  h('span', { style: small }, `${p.size} 字节`),
                  badge ? h('span', {
                    style: {
                      ...fontS, color: badge.color, fontWeight: 600,
                      padding: '2px 8px', borderRadius: '999px',
                      border: `1px solid ${badge.color}`,
                    },
                  }, badge.label + (loc && loc.version ? ` ${loc.version}` : '')) : null,
                  h('button', { onClick: () => planInstall(p), disabled: busy, style: busy ? { ...btnStyle, opacity: 0.6 } : btnStyle }, '安装到本地'),
                )
              }),
              h(LoadMore, { shown: shownRepo, total: repoPkgs.length, onMore: () => setShownRepo((n) => n + PAGE_SIZE) }),
            ),

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