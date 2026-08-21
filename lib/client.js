/**
 * dsh-plugin-repo — browser client half.
 *
 * Settings section "插件仓库": local repo, install, pack-upload, and
 * cross-device pull/push against another DSH's /pluginrepo.
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-repo',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const API = '/pluginrepo/api'

    function h(type, props, ...children) {
      return React.createElement(type, props || null, ...children)
    }

    async function fetchJson(path, init) {
      const res = await fetch(path, init)
      let body = null
      try { body = await res.json() } catch (e) { /* non-json */ }
      if (!res.ok) throw new Error((body && body.error) || `HTTP ${res.status}`)
      return body
    }

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

    function versionStateOf(pkg, installed) {
      const loc = installed.find((p) => p.name === pkg.name)
      if (!loc || !loc.version) return 'uninstalled'
      const cmp = compareVersions(loc.version, pkg.version)
      if (cmp === null) return 'unknown'
      if (cmp === 0) return 'current'
      if (cmp > 0) return 'newer'
      return 'stale'
    }

    function formatBytes(n) {
      const x = Number(n) || 0
      if (x < 1024) return `${x} B`
      if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`
      return `${(x / (1024 * 1024)).toFixed(1)} MB`
    }

    const cssVar = (name, fallback) => `var(${name}, ${fallback})`
    const BRAND = '#4d6bfe'
    const T = {
      labelPrimary: cssVar('--dsw-alias-label-primary', '#1f2329'),
      labelSecondary: cssVar('--dsw-alias-label-secondary', '#5f6368'),
      labelTertiary: cssVar('--dsw-alias-label-tertiary', '#80868b'),
      bgBase: cssVar('--dsw-alias-bg-base', '#ffffff'),
      bgSubtle: cssVar('--dsw-alias-bg-l1', 'rgba(0,0,0,0.03)'),
      borderL1: cssVar('--dsw-alias-border-l1', 'rgba(0,0,0,0.10)'),
      danger: '#e5484d',
      warning: '#d97706',
      success: '#16a34a',
      fontFamily: cssVar('--dsw-font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'),
    }

    const VERSION_BADGE = {
      current: { label: '已安装', color: T.success },
      stale: { label: '可升级', color: T.warning },
      newer: { label: '本机更新', color: T.danger },
      unknown: { label: '版本未知', color: T.labelTertiary },
    }

    const fontS = { fontFamily: T.fontFamily, fontSize: '12px', lineHeight: '18px' }
    const fontBase = { fontFamily: T.fontFamily, fontSize: '13px', lineHeight: '20px' }
    const fontTitle = { fontFamily: T.fontFamily, fontSize: '16px', lineHeight: '24px', fontWeight: 600, color: T.labelPrimary, margin: 0 }

    function btn(kind, extra) {
      const base = {
        padding: '6px 12px', fontSize: '13px', lineHeight: '18px', cursor: 'pointer',
        whiteSpace: 'nowrap', fontFamily: T.fontFamily, borderRadius: '6px',
        border: `1px solid ${T.borderL1}`, background: 'transparent', color: T.labelPrimary,
        transition: 'opacity 120ms ease, background 120ms ease',
        ...extra,
      }
      if (kind === 'primary') {
        return { ...base, color: '#fff', background: BRAND, borderColor: BRAND }
      }
      if (kind === 'soft') {
        return { ...base, background: T.bgSubtle, borderColor: 'transparent' }
      }
      if (kind === 'danger') {
        return { ...base, color: T.danger, borderColor: 'rgba(229,72,77,0.35)' }
      }
      return base
    }

    function busyStyle(style, busy) {
      return busy ? { ...style, opacity: 0.55, cursor: 'not-allowed' } : style
    }

    const inputStyle = {
      padding: '7px 10px', fontSize: '13px', lineHeight: '18px',
      fontFamily: T.fontFamily, color: T.labelPrimary, boxSizing: 'border-box',
      background: T.bgBase, border: `1px solid ${T.borderL1}`, borderRadius: '6px',
      outline: 'none', minWidth: 0,
    }

    function Badge(props) {
      const { color, children } = props
      return h('span', {
        style: {
          ...fontS, color, fontWeight: 600, padding: '1px 7px',
          borderRadius: '4px', border: `1px solid ${color}`, whiteSpace: 'nowrap',
        },
      }, children)
    }

    function Banner(props) {
      const { tone, children, onClose } = props
      if (!children) return null
      const color = tone === 'error' ? T.danger : T.success
      const bg = tone === 'error' ? 'rgba(229,72,77,0.08)' : 'rgba(22,163,74,0.08)'
      return h('div', {
        style: {
          display: 'flex', alignItems: 'flex-start', gap: '8px',
          padding: '8px 10px', marginBottom: '12px', borderRadius: '8px',
          background: bg, border: `1px solid ${color}33`, color,
          ...fontBase,
        },
      },
        h('span', { style: { flex: 1, wordBreak: 'break-word' } }, children),
        onClose ? h('button', {
          onClick: onClose,
          style: { ...btn('ghost'), padding: '0 4px', border: 'none', color, lineHeight: '18px' },
          'aria-label': '关闭',
        }, '×') : null,
      )
    }

    function TabBar(props) {
      const { tabs, active, onChange } = props
      return h('div', {
        role: 'tablist',
        style: {
          display: 'flex', gap: '2px', marginBottom: '14px',
          borderBottom: `1px solid ${T.borderL1}`, paddingBottom: '0',
        },
      },
        tabs.map((t) => {
          const on = t.id === active
          return h('button', {
            key: t.id,
            role: 'tab',
            'aria-selected': on,
            onClick: () => onChange(t.id),
            style: {
              ...fontBase, fontWeight: on ? 600 : 500,
              padding: '8px 12px', marginBottom: '-1px', cursor: 'pointer',
              border: 'none', borderBottom: on ? `2px solid ${BRAND}` : '2px solid transparent',
              background: 'transparent', color: on ? T.labelPrimary : T.labelTertiary,
              fontFamily: T.fontFamily,
            },
          }, t.label)
        }),
      )
    }

    function Segmented(props) {
      const { options, value, onChange } = props
      return h('div', {
        style: {
          display: 'inline-flex', padding: '3px', gap: '2px',
          background: T.bgSubtle, borderRadius: '8px', border: `1px solid ${T.borderL1}`,
        },
      },
        options.map((o) => {
          const on = o.id === value
          return h('button', {
            key: o.id,
            onClick: () => onChange(o.id),
            style: {
              ...fontBase, fontWeight: on ? 600 : 500, cursor: 'pointer',
              padding: '6px 14px', borderRadius: '6px', border: 'none',
              fontFamily: T.fontFamily,
              background: on ? T.bgBase : 'transparent',
              color: on ? T.labelPrimary : T.labelSecondary,
              boxShadow: on ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
            },
          }, o.label)
        }),
      )
    }

    function Toolbar(props) {
      return h('div', {
        style: {
          display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap',
          marginBottom: props.tight ? '6px' : '10px',
        },
      }, ...(props.children || []))
    }

    function Panel(props) {
      return h('div', {
        style: {
          border: `1px solid ${T.borderL1}`, borderRadius: '10px',
          background: T.bgBase, overflow: 'hidden',
          display: 'flex', flexDirection: 'column', minHeight: props.minHeight || 0,
          ...props.style,
        },
      },
        props.title ? h('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: '8px', padding: '10px 12px',
            borderBottom: `1px solid ${T.borderL1}`, background: T.bgSubtle,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 } },
            h('span', { style: { ...fontBase, fontWeight: 600, color: T.labelPrimary } }, props.title),
            props.subtitle ? h('span', { style: { ...fontS, color: T.labelTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, props.subtitle) : null,
          ),
          props.actions || null,
        ) : null,
        h('div', { style: { padding: props.pad === false ? 0 : '8px 10px', flex: 1 } }, props.children),
      )
    }

    function Empty(props) {
      return h('p', {
        style: { ...fontBase, color: T.labelTertiary, margin: '12px 4px', textAlign: 'center' },
      }, props.children)
    }

    function LoadMore(props) {
      const { shown, total, onMore } = props
      if (shown >= total) return null
      return h('button', {
        onClick: onMore,
        style: { ...btn('soft'), width: '100%', marginTop: '6px' },
      }, `加载更多 ${shown}/${total}`)
    }

    function CheckLabel(props) {
      return h('label', {
        style: { ...fontBase, color: T.labelSecondary, display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none' },
      },
        h('input', {
          type: 'checkbox',
          checked: !!props.checked,
          onChange: (e) => props.onChange(e.target.checked),
        }),
        props.children,
      )
    }

    function PkgRow(props) {
      const {
        checked, onCheck, title, meta, badge, actions, dim,
      } = props
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
          padding: '8px 6px', borderRadius: '6px',
          borderBottom: `1px solid ${T.borderL1}`,
          opacity: dim ? 0.55 : 1,
        },
      },
        onCheck ? h('input', {
          type: 'checkbox',
          checked: !!checked,
          onChange: (e) => onCheck(e.target.checked),
        }) : null,
        h('div', { style: { flex: '1 1 160px', minWidth: 0 } },
          h('div', { style: { ...fontBase, fontWeight: 600, color: T.labelPrimary, wordBreak: 'break-all' } }, title),
          meta ? h('div', { style: { ...fontS, color: T.labelTertiary, marginTop: '2px' } }, meta) : null,
        ),
        badge || null,
        actions ? h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, actions) : null,
      )
    }

    const PAGE_SIZE = 10
    const TABS = [
      { id: 'repo', label: '本机仓库' },
      { id: 'sync', label: '跨设备同步' },
      { id: 'installed', label: '已安装' },
      { id: 'advanced', label: '高级' },
    ]

    function PluginRepoSection() {
      const [tab, setTab] = React.useState('repo')
      const [syncMode, setSyncMode] = React.useState('pull') // pull | push

      const [installed, setInstalled] = React.useState([])
      const [repoPkgs, setRepoPkgs] = React.useState([])
      const [roots, setRoots] = React.useState([])
      const [newRoot, setNewRoot] = React.useState('')
      const [uploadName, setUploadName] = React.useState('')

      const [error, setError] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [busy, setBusy] = React.useState(false)

      const [remoteAddr, setRemoteAddr] = React.useState('')
      const [remoteList, setRemoteList] = React.useState(null)
      const [selectedRemote, setSelectedRemote] = React.useState({})
      const [selInstalled, setSelInstalled] = React.useState({})
      const [selRepo, setSelRepo] = React.useState({})
      const [selPush, setSelPush] = React.useState({}) // dedicated push selection

      const [confirmPlan, setConfirmPlan] = React.useState(null)
      const [shownInstalled, setShownInstalled] = React.useState(PAGE_SIZE)
      const [shownRepo, setShownRepo] = React.useState(PAGE_SIZE)
      const [shownRemote, setShownRemote] = React.useState(PAGE_SIZE)
      const [shownPush, setShownPush] = React.useState(PAGE_SIZE)

      const selectedRepoCount = repoPkgs.filter((p) => selRepo[p.filename]).length
      const selectedPushCount = repoPkgs.filter((p) => selPush[p.filename]).length
      const selectedRemoteCount = remoteList
        ? remoteList.packages.filter((p) => selectedRemote[p.filename]).length
        : 0
      const selectedInstalledCount = installed.filter((p) => selInstalled[p.name]).length

      const refresh = React.useCallback(async () => {
        setBusy(true); setError('')
        try {
          const u = await fetchJson(`${API}/unofficial`)
          setInstalled(u.installed || [])
          setRepoPkgs(u.repo || [])
          setRoots(u.roots || [])
        } catch (e) { setError(String(e && e.message || e)) } finally { setBusy(false) }
      }, [])

      const refreshRepo = React.useCallback(async () => {
        try {
          const r = await fetchJson(`${API}/packages`)
          setRepoPkgs((r && r.packages) || [])
        } catch (e) { /* keep */ }
      }, [])

      React.useEffect(() => { refresh() }, [refresh])

      function flash(okMsg, errMsg) {
        if (okMsg) { setMessage(okMsg); setError('') }
        if (errMsg) { setError(errMsg); setMessage('') }
      }

      async function addRoot() {
        const p = newRoot.trim()
        if (!p) { flash(null, '请输入要添加的搜索路径'); return }
        setBusy(true)
        try {
          const r = await fetch(`${API}/roots?path=${encodeURIComponent(p)}`, { method: 'POST' })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          setNewRoot('')
          flash(`已添加搜索路径：${p}`)
          await refresh()
        } catch (e) { flash(null, String(e && e.message || e)) } finally { setBusy(false) }
      }

      async function autoUpload(pkg) {
        try {
          const r = await fetch(`${API}/pack-upload?name=${encodeURIComponent(pkg.name)}`, { method: 'POST' })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          flash(`已上传 ${b.name}@${b.version} 到本机仓库`)
          await refreshRepo()
        } catch (e) { flash(null, String(e && e.message || e)) }
      }

      async function manualUpload(file) {
        if (!file) return
        try {
          const qs = uploadName.trim() ? `?name=${encodeURIComponent(uploadName.trim())}` : ''
          const r = await fetch(`${API}/upload${qs}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file,
          })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          flash(`已上传 ${b.filename}（${formatBytes(b.size)}）`)
          setUploadName('')
          await refreshRepo()
        } catch (e) { flash(null, String(e && e.message || e)) }
      }

      async function bulkUploadInstalled() {
        const names = installed.filter((p) => selInstalled[p.name]).map((p) => p.name)
        if (!names.length) { flash(null, '请先勾选要上传的插件'); return }
        setBusy(true)
        try {
          const r = await fetch(`${API}/pack-upload-all`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ names }),
          })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          const okCount = (b.packed || []).filter((x) => x.ok).length
          flash(`已上传 ${okCount}/${names.length} 个到本机仓库`)
          setSelInstalled({})
          await refreshRepo()
        } catch (e) { flash(null, String(e && e.message || e)) } finally { setBusy(false) }
      }

      async function installSelectedRepo() {
        const files = repoPkgs.filter((p) => selRepo[p.filename]).map((p) => p.filename)
        if (!files.length) { flash(null, '请先勾选要安装的包'); return }
        setBusy(true)
        try {
          const r = await fetch(`${API}/install-all`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filenames: files, confirm: true }),
          })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          const okCount = (b.installed || []).filter((x) => x.ok).length
          const skippedCount = (b.installed || []).filter((x) => x.skipped).length
          flash(`已安装 ${okCount} 个、跳过 ${skippedCount} 个（重启后生效）`)
          setSelRepo({})
          await refresh()
        } catch (e) { flash(null, String(e && e.message || e)) } finally { setBusy(false) }
      }

      async function visitRemote() {
        const addr = remoteAddr.trim()
        if (!addr) { flash(null, '请输入对方 DSH 地址'); return }
        setBusy(true); setSelectedRemote({}); setShownRemote(PAGE_SIZE)
        try {
          const r = await fetch(`${API}/remote?host=${encodeURIComponent(addr)}`)
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          setRemoteList({ addr, packages: b.packages || [] })
          flash(`已连接 ${addr}，对方共 ${(b.packages || []).length} 个包`)
        } catch (e) {
          setRemoteList(null)
          flash(null, String(e && e.message || e))
        } finally { setBusy(false) }
      }

      async function pullRemoteSelected() {
        if (!remoteList) { flash(null, '请先访问对方仓库'); return }
        const files = remoteList.packages.filter((p) => selectedRemote[p.filename]).map((p) => p.filename)
        if (!files.length) { flash(null, '请勾选要拉取的对方包'); return }
        setBusy(true)
        try {
          const r = await fetch(`${API}/remote-pull`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: remoteList.addr, filenames: files }),
          })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          const okCount = (b.pulled || []).filter((x) => x.ok).length
          flash(`已拉取 ${okCount}/${files.length} 个到本机仓库`)
          setSelectedRemote({})
          await refreshRepo()
        } catch (e) { flash(null, String(e && e.message || e)) } finally { setBusy(false) }
      }

      async function pushRemoteSelected() {
        const addr = (remoteList && remoteList.addr) || remoteAddr.trim()
        if (!addr) { flash(null, '请先填写对方 DSH 地址'); return }
        const files = repoPkgs.filter((p) => selPush[p.filename]).map((p) => p.filename)
        if (!files.length) { flash(null, '请勾选要推送的本机包'); return }
        setBusy(true)
        try {
          const r = await fetch(`${API}/remote-push`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host: addr, filenames: files }),
          })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          const okCount = (b.pushed || []).filter((x) => x.ok).length
          const fail = (b.pushed || []).filter((x) => !x.ok)
          flash(
            `已推送 ${okCount}/${files.length} 个到对方` +
            (fail.length ? `；失败 ${fail.length} 个` : ''),
          )
          setSelPush({})
          if (remoteList && remoteList.addr === addr) {
            try {
              const rr = await fetch(`${API}/remote?host=${encodeURIComponent(addr)}`)
              const rb = await rr.json()
              if (rr.ok) setRemoteList({ addr, packages: rb.packages || [] })
            } catch (e) { /* keep */ }
          }
        } catch (e) { flash(null, String(e && e.message || e)) } finally { setBusy(false) }
      }

      async function planInstall(pkg) {
        setBusy(true)
        try {
          const r = await fetch(`${API}/install`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: pkg.filename, confirm: false }),
          })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          if (b.skip) { flash(String(b.reason)); return }
          setConfirmPlan({ filename: pkg.filename, plan: b })
        } catch (e) { flash(null, String(e && e.message || e)) } finally { setBusy(false) }
      }

      async function confirmInstall() {
        if (!confirmPlan) return
        setBusy(true)
        try {
          const r = await fetch(`${API}/install`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: confirmPlan.filename, confirm: true }),
          })
          const b = await r.json()
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          setConfirmPlan(null)
          flash(b.skipped ? `已跳过：${b.reason}` : `已安装 ${b.name}@${b.version}（重启后生效）`)
          await refresh()
        } catch (e) { flash(null, String(e && e.message || e)) } finally { setBusy(false) }
      }

      function renderRepoList(opts) {
        const {
          selection, setSelection, shown, setShown, showInstall, emptyText,
        } = opts
        if (!repoPkgs.length) return h(Empty, null, emptyText || '本机仓库为空')
        const allOn = repoPkgs.length > 0 && repoPkgs.every((p) => selection[p.filename])
        return h('div', null,
          h(Toolbar, { tight: true },
            h(CheckLabel, {
              checked: allOn,
              onChange: (checked) => {
                const next = {}
                if (checked) for (const p of repoPkgs) next[p.filename] = true
                setSelection(next)
              },
            }, `全选（${Object.keys(selection).filter((k) => selection[k]).length}/${repoPkgs.length}）`),
            showInstall ? h('button', {
              onClick: installSelectedRepo,
              disabled: busy || !selectedRepoCount,
              style: busyStyle(btn('primary'), busy || !selectedRepoCount),
            }, selectedRepoCount ? `安装所选 ${selectedRepoCount}` : '安装所选') : null,
          ),
          repoPkgs.slice(0, shown).map((p) => {
            const st = versionStateOf(p, installed)
            const badgeMeta = VERSION_BADGE[st]
            const loc = installed.find((x) => x.name === p.name)
            return h(PkgRow, {
              key: p.filename,
              checked: !!selection[p.filename],
              onCheck: (v) => setSelection((s) => ({ ...s, [p.filename]: v })),
              title: `${p.name}@${p.version || '?'}`,
              meta: `${formatBytes(p.size)} · ${p.filename}`,
              badge: badgeMeta ? h(Badge, { color: badgeMeta.color },
                badgeMeta.label + (loc && loc.version ? ` ${loc.version}` : '')) : null,
              actions: showInstall ? h('button', {
                onClick: () => planInstall(p),
                disabled: busy,
                style: busyStyle(btn('ghost'), busy),
              }, '安装') : null,
            })
          }),
          h(LoadMore, { shown, total: repoPkgs.length, onMore: () => setShown((n) => n + PAGE_SIZE) }),
        )
      }

      function renderRemoteList() {
        if (!remoteList) {
          return h(Empty, null, '填写地址并点「连接」，即可列出对方仓库')
        }
        const pkgs = remoteList.packages
        if (!pkgs.length) return h(Empty, null, '对方仓库为空')
        const allOn = pkgs.length > 0 && pkgs.every((p) => selectedRemote[p.filename])
        return h('div', null,
          h(Toolbar, { tight: true },
            h(CheckLabel, {
              checked: allOn,
              onChange: (checked) => {
                const next = {}
                if (checked) for (const p of pkgs) next[p.filename] = true
                setSelectedRemote(next)
              },
            }, `全选（${selectedRemoteCount}/${pkgs.length}）`),
            syncMode === 'pull' ? h('button', {
              onClick: pullRemoteSelected,
              disabled: busy || !selectedRemoteCount,
              style: busyStyle(btn('primary'), busy || !selectedRemoteCount),
            }, selectedRemoteCount ? `拉取所选 ${selectedRemoteCount}` : '拉取所选') : null,
          ),
          pkgs.slice(0, shownRemote).map((p) => h(PkgRow, {
            key: p.filename,
            checked: !!selectedRemote[p.filename],
            onCheck: syncMode === 'pull'
              ? (v) => setSelectedRemote((s) => ({ ...s, [p.filename]: v }))
              : null,
            title: `${p.name}@${p.version || '?'}`,
            meta: formatBytes(p.size),
            dim: syncMode === 'push',
          })),
          h(LoadMore, {
            shown: shownRemote,
            total: pkgs.length,
            onMore: () => setShownRemote((n) => n + PAGE_SIZE),
          }),
        )
      }

      // ---------- tabs ----------
      function tabRepo() {
        return h('div', null,
          h(Panel, {
            title: '本机仓库',
            subtitle: `${repoPkgs.length} 个包`,
            actions: h('button', {
              onClick: refresh,
              disabled: busy,
              style: busyStyle(btn('soft'), busy),
            }, busy ? '刷新中…' : '刷新'),
          },
            renderRepoList({
              selection: selRepo,
              setSelection: setSelRepo,
              shown: shownRepo,
              setShown: setShownRepo,
              showInstall: true,
              emptyText: '还没有包。可从「已安装」上传，或到「跨设备同步」拉取。',
            }),
          ),
          h('div', { style: { height: '12px' } }),
          h(Panel, { title: '手动加入 .tgz' },
            h(Toolbar, null,
              h('input', {
                type: 'text',
                placeholder: '包名（可选）',
                value: uploadName,
                onChange: (e) => setUploadName(e.target.value),
                style: { ...inputStyle, width: '180px' },
              }),
              h('label', {
                style: { ...btn('soft'), display: 'inline-flex', alignItems: 'center', cursor: 'pointer' },
              },
                '选择文件',
                h('input', {
                  type: 'file',
                  accept: '.tgz',
                  style: { display: 'none' },
                  onChange: (e) => {
                    const f = e.target.files && e.target.files[0]
                    if (f) manualUpload(f)
                    e.target.value = ''
                  },
                }),
              ),
            ),
            h('p', { style: { ...fontS, color: T.labelTertiary, margin: '0' } },
              '选择本地 .tgz 直接写入本机仓库，不会自动安装。'),
          ),
        )
      }

      function tabSync() {
        const connected = !!remoteList
        return h('div', null,
          h(Panel, { title: '对方地址', pad: true },
            h(Toolbar, null,
              h('input', {
                type: 'text',
                placeholder: '例：192.168.1.10 或 https://dsh.example.com',
                value: remoteAddr,
                onChange: (e) => setRemoteAddr(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') visitRemote() },
                style: { ...inputStyle, flex: '1 1 240px', width: '100%', maxWidth: '420px' },
              }),
              h('button', {
                onClick: visitRemote,
                disabled: busy,
                style: busyStyle(btn('primary'), busy),
              }, busy ? '连接中…' : '连接'),
              connected ? h('button', {
                onClick: () => { setRemoteList(null); setSelectedRemote({}) },
                style: btn('ghost'),
              }, '断开') : null,
            ),
            h('p', { style: { ...fontS, color: T.labelTertiary, margin: '0' } },
              '裸 IP/域名默认 http:3080；写 https:// 默认 443；可带 :端口。'),
          ),

          h('div', {
            style: {
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: '12px', flexWrap: 'wrap', margin: '14px 0 10px',
            },
          },
            h(Segmented, {
              value: syncMode,
              onChange: setSyncMode,
              options: [
                { id: 'pull', label: '拉取 → 本机' },
                { id: 'push', label: '推送 → 对方' },
              ],
            }),
            syncMode === 'push'
              ? h('button', {
                onClick: pushRemoteSelected,
                disabled: busy || !selectedPushCount || !(remoteAddr.trim() || connected),
                style: busyStyle(
                  btn('primary'),
                  busy || !selectedPushCount || !(remoteAddr.trim() || connected),
                ),
              }, selectedPushCount ? `推送 ${selectedPushCount} 个到对方` : '推送所选到对方')
              : h('button', {
                onClick: pullRemoteSelected,
                disabled: busy || !selectedRemoteCount || !connected,
                style: busyStyle(btn('primary'), busy || !selectedRemoteCount || !connected),
              }, selectedRemoteCount ? `拉取 ${selectedRemoteCount} 个到本机` : '拉取所选到本机'),
          ),

          h('p', { style: { ...fontS, color: T.labelSecondary, margin: '0 0 10px' } },
            syncMode === 'pull'
              ? '在右侧勾选对方包，再点拉取。包会写入本机仓库，不会自动安装。'
              : '在左侧勾选本机包，填好地址后点推送。建议先连接对方以便核对结果。'),

          h('div', {
            style: {
              display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'stretch',
            },
          },
            h(Panel, {
              title: syncMode === 'push' ? '本机 · 勾选后推送' : '本机 · 对照',
              subtitle: `${repoPkgs.length}`,
              minHeight: '220px',
              style: { flex: '1 1 300px', minWidth: '260px' },
            },
              syncMode === 'push'
                ? renderRepoList({
                  selection: selPush,
                  setSelection: setSelPush,
                  shown: shownPush,
                  setShown: setShownPush,
                  showInstall: false,
                  emptyText: '本机仓库为空，无法推送',
                })
                : h('div', null,
                  repoPkgs.length === 0
                    ? h(Empty, null, '本机仓库为空')
                    : repoPkgs.slice(0, Math.min(5, repoPkgs.length)).map((p) => h(PkgRow, {
                      key: p.filename,
                      title: `${p.name}@${p.version || '?'}`,
                      meta: formatBytes(p.size),
                      dim: true,
                    })),
                  repoPkgs.length > 5
                    ? h('p', { style: { ...fontS, color: T.labelTertiary, margin: '6px 4px' } },
                      `另有 ${repoPkgs.length - 5} 个未列出（拉取模式仅作对照）`)
                    : null,
                ),
            ),

            h(Panel, {
              title: syncMode === 'pull' ? '对方 · 勾选后拉取' : '对方 · 结果预览',
              subtitle: connected ? remoteList.addr : '未连接',
              minHeight: '220px',
              style: { flex: '1 1 300px', minWidth: '260px' },
            }, renderRemoteList()),
          ),
        )
      }

      function tabInstalled() {
        if (!installed.length) {
          return h(Panel, { title: '已安装的非官方插件' },
            h(Empty, null, '没有非官方插件（@deepseek-ai/* 已自动排除）'))
        }
        const allOn = installed.every((p) => selInstalled[p.name])
        return h(Panel, {
          title: '已安装的非官方插件',
          subtitle: `${installed.length}`,
        },
          h(Toolbar, { tight: true },
            h(CheckLabel, {
              checked: allOn,
              onChange: (checked) => {
                const next = {}
                if (checked) for (const p of installed) next[p.name] = true
                setSelInstalled(next)
              },
            }, `全选（${selectedInstalledCount}/${installed.length}）`),
            h('button', {
              onClick: bulkUploadInstalled,
              disabled: busy || !selectedInstalledCount,
              style: busyStyle(btn('primary'), busy || !selectedInstalledCount),
            }, selectedInstalledCount ? `上传所选 ${selectedInstalledCount}` : '上传到本机仓库'),
          ),
          installed.slice(0, shownInstalled).map((p) => h(PkgRow, {
            key: p.name,
            checked: !!selInstalled[p.name],
            onCheck: (v) => setSelInstalled((s) => ({ ...s, [p.name]: v })),
            title: `${p.name}@${p.version}`,
            actions: h('button', {
              onClick: () => autoUpload(p),
              disabled: busy,
              style: busyStyle(btn('ghost'), busy),
            }, '上传'),
          })),
          h(LoadMore, {
            shown: shownInstalled,
            total: installed.length,
            onMore: () => setShownInstalled((n) => n + PAGE_SIZE),
          }),
        )
      }

      function tabAdvanced() {
        return h(Panel, { title: '搜索根目录' },
          h('p', { style: { ...fontS, color: T.labelTertiary, margin: '0 0 8px' } },
            '额外扫描路径，用于发现可上传的已安装插件。默认已包含 ~/.dsh。'),
          h(Toolbar, null,
            h('input', {
              type: 'text',
              placeholder: '如 D:\\0HAN\\Work\\my-plugins',
              value: newRoot,
              onChange: (e) => setNewRoot(e.target.value),
              style: { ...inputStyle, flex: '1 1 240px', maxWidth: '360px' },
            }),
            h('button', {
              onClick: addRoot,
              disabled: busy,
              style: busyStyle(btn('primary'), busy),
            }, '添加'),
          ),
          roots.length === 0
            ? h(Empty, null, '仅默认位置 ~/.dsh')
            : h('div', null, roots.map((r) => h('div', {
              key: r,
              style: {
                ...fontS, color: T.labelSecondary, padding: '6px 4px',
                borderBottom: `1px solid ${T.borderL1}`, wordBreak: 'break-all',
              },
            }, r))),
        )
      }

      return h('div', {
        style: {
          fontFamily: T.fontFamily, fontSize: '13px', color: T.labelPrimary,
          maxWidth: '920px',
        },
      },
        h('div', {
          style: {
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
            gap: '12px', flexWrap: 'wrap', marginBottom: '8px',
          },
        },
          h('div', null,
            h('h2', { style: fontTitle }, '插件仓库'),
            h('p', { style: { ...fontS, color: T.labelTertiary, margin: '4px 0 0' } },
              `本机 ${repoPkgs.length} 包 · 已装非官方 ${installed.length}` +
              (remoteList ? ` · 已连 ${remoteList.addr}` : '')),
          ),
          h('button', {
            onClick: refresh,
            disabled: busy,
            style: busyStyle(btn('soft'), busy),
          }, busy ? '刷新中…' : '刷新'),
        ),

        h(Banner, { tone: 'error', onClose: () => setError('') }, error || null),
        h(Banner, { tone: 'ok', onClose: () => setMessage('') }, message || null),

        h(TabBar, { tabs: TABS, active: tab, onChange: setTab }),

        tab === 'repo' ? tabRepo() : null,
        tab === 'sync' ? tabSync() : null,
        tab === 'installed' ? tabInstalled() : null,
        tab === 'advanced' ? tabAdvanced() : null,

        confirmPlan && h('div', {
          style: {
            position: 'fixed', inset: 0, zIndex: 1000,
            background: cssVar('--dsw-alias-bg-mask-1', 'rgba(0,0,0,0.45)'),
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '16px',
          },
        },
          h('div', {
            role: 'dialog',
            'aria-modal': true,
            style: {
              background: T.bgBase, color: T.labelPrimary, borderRadius: '12px',
              padding: '18px 20px', maxWidth: '440px', width: '100%',
              border: `1px solid ${T.borderL1}`,
              boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
            },
          },
            h('h3', { style: { ...fontTitle, fontSize: '15px', marginBottom: '8px' } }, '确认安装到本地'),
            confirmPlan.plan && h('div', null,
              h('p', { style: { ...fontBase, margin: '4px 0' } },
                `${confirmPlan.plan.name}@${confirmPlan.plan.version}`),
              confirmPlan.plan.installedVersion
                ? h('p', { style: { ...fontS, color: T.labelTertiary, margin: '4px 0' } },
                  `当前已装：${confirmPlan.plan.installedVersion}`)
                : null,
              h('p', { style: { ...fontBase, margin: '10px 0 4px' } }, '将会执行：'),
              h('ul', { style: { margin: '0 0 14px', paddingLeft: '18px' } },
                (confirmPlan.plan.actions || []).map((a) => h('li', {
                  key: a,
                  style: { ...fontS, color: T.labelSecondary, marginBottom: '2px' },
                }, a)),
              ),
            ),
            h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
              h('button', { onClick: () => setConfirmPlan(null), style: btn('ghost') }, '取消'),
              h('button', {
                onClick: confirmInstall,
                disabled: busy,
                style: busyStyle(btn('primary'), busy),
              }, busy ? '安装中…' : '确认安装'),
            ),
          ),
        ),
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
