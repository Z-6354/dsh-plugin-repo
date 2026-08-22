/**
 * dsh-plugin-repo — browser client half.
 *
 * Settings 「插件仓库」: dual-column sync with version tags, drag-and-drop
 * transfer (with confirm), and local repo ↔ installed compare.
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
      function parts(v) {
        const t = String(v || '').trim().replace(/^v/i, '')
        if (!t) return null
        const dash = t.indexOf('-')
        const main = dash >= 0 ? t.slice(0, dash) : t
        const pre = dash >= 0 ? t.slice(dash + 1) : ''
        const nums = main.split('.').map((x) => parseInt(x, 10))
        if (!nums.length || nums.some((n) => Number.isNaN(n))) return null
        return { nums, pre }
      }
      const x = parts(a)
      const y = parts(b)
      if (!x || !y) return null
      const n = Math.max(x.nums.length, y.nums.length)
      for (let i = 0; i < n; i++) {
        const xv = x.nums[i] || 0
        const yv = y.nums[i] || 0
        if (xv !== yv) return xv > yv ? 1 : -1
      }
      // release > prerelease; then compare prerelease tokens
      if (x.pre && !y.pre) return -1
      if (!x.pre && y.pre) return 1
      if (x.pre === y.pre) return 0
      const xp = x.pre.split(/[.+]/)
      const yp = y.pre.split(/[.+]/)
      for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
        const as = xp[i] || ''
        const bs = yp[i] || ''
        const an = parseInt(as, 10)
        const bn = parseInt(bs, 10)
        const aNum = !Number.isNaN(an) && String(an) === as
        const bNum = !Number.isNaN(bn) && String(bn) === bs
        if (aNum && bNum) {
          if (an !== bn) return an > bn ? 1 : -1
        } else if (as !== bs) {
          return as > bs ? 1 : -1
        }
      }
      return 0
    }

    function formatBytes(n) {
      const x = Number(n) || 0
      if (x < 1024) return `${x} B`
      if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`
      return `${(x / (1024 * 1024)).toFixed(1)} MB`
    }

    function blankVer(v) {
      if (v == null) return true
      const s = String(v).trim()
      return !s || s === '?' || s.toLowerCase() === 'unknown'
    }

    /**
     * Diff "localRef" version against "other" version for the same plugin name.
     * - missing: other side has no package at all
     * - unknown: cannot compare (blank/unknown version on either side that exists)
     * - higher / lower / equal
     * Pass peerExists=true when the other package row exists but may lack a version.
     */
    function diffLocalVsOther(localVer, otherVer, opts) {
      const peerExists = !!(opts && opts.peerExists)
      const lv = blankVer(localVer) ? '' : String(localVer).trim()
      const ov = blankVer(otherVer) ? '' : String(otherVer).trim()
      if (!ov) {
        if (peerExists) return 'unknown' // 对方有包但版本未知 → 应推送核对，不是「对方无」
        return lv ? 'missing' : 'unknown'
      }
      if (!lv) return 'unknown'
      const cmp = compareVersions(lv, ov)
      if (cmp === null) return 'unknown'
      if (cmp === 0) return 'equal'
      if (cmp > 0) return 'higher'
      return 'lower'
    }

    function needsPush(state) {
      return state === 'missing' || state === 'higher' || state === 'unknown'
    }

    // Blue / red / green as specified; equal uses slate; need-restart uses amber.
    const BLUE = '#2563eb'
    const RED = '#e5484d'
    const GREEN = '#16a34a'
    const SLATE = '#64748b'
    const AMBER = '#d97706'

    // Tag color maps (labels built dynamically with concrete versions).
    const COLOR = {
      missing: BLUE,
      higher: RED,
      lower: GREEN,
      equal: SLATE,
      unknown: SLATE,
      'need-restart': AMBER,
    }

    /**
     * Build a badge that always shows concrete versions.
     * kind:
     *  - 'repo-vs-remote'   localVer=本机仓库, peerVer=对方
     *  - 'remote-vs-repo'   localVer=对方, peerVer=本机仓库 (localRef for state is peer/repo)
     *  - 'installed-vs-repo'
     *  - 'repo-vs-installed'
     * opts.needRestart: disk has the package but process still runs the old module
     */
    function badgeFor(kind, state, localVer, peerVer, opts) {
      const needRestart = !!(opts && opts.needRestart)
      const lv = localVer || '?'
      const pv = peerVer || '?'
      let color = COLOR[state] || SLATE
      let label
      let outState = state
      if (kind === 'repo-vs-remote') {
        if (state === 'missing') label = `对方无 · 本机 ${lv}`
        else if (state === 'equal') label = `已同步 ${lv}`
        else if (state === 'higher') label = `本机 ${lv} > 对方 ${pv}`
        else if (state === 'lower') label = `本机 ${lv} < 对方 ${pv}`
        else if (blankVer(peerVer) && !blankVer(localVer)) {
          label = `对方版本未知 · 默认推送本机 ${lv}`
        } else if (blankVer(localVer)) {
          label = `本机版本未知 · 仍可推送（对方 ${pv}）`
        } else {
          label = `无法比较 · 本机 ${lv} / 对方 ${pv}`
        }
      } else if (kind === 'remote-vs-repo') {
        // localVer here is 对方包, peerVer is 本机仓库
        if (state === 'missing') label = `未入库 · 对方 ${lv}`
        else if (state === 'equal') label = `已入库 ${lv}`
        else if (state === 'higher') label = `本机仓库 ${pv} > 对方 ${lv}`
        else if (state === 'lower') label = `可拉取 ${lv}（本机 ${pv}）`
        else if (blankVer(localVer)) {
          label = `对方版本未知 · 建议拉取核对（本机 ${pv}）`
        } else {
          label = `无法比较 · 对方 ${lv} / 本机 ${pv}`
        }
      } else if (kind === 'installed-vs-repo') {
        const runRaw = opts && opts.loadedVersion
        const run = (runRaw == null || runRaw === '') ? '未加载' : runRaw
        if (needRestart && state === 'lower') {
          outState = 'need-restart'
          color = AMBER
          label = `可升级到仓库 ${pv} · 已装 ${lv}（运行中 ${run}，需重启）`
        } else if (needRestart) {
          outState = 'need-restart'
          color = AMBER
          label = `需重启 · 已装 ${lv}（运行中 ${run}）`
        } else if (state === 'missing') label = `未入库 · 已装 ${lv}`
        else if (state === 'equal') label = `已入库 ${lv}`
        else if (state === 'higher') label = `已装 ${lv} > 仓库 ${pv}`
        else if (state === 'lower') label = `仓库 ${pv} > 已装 ${lv}`
        else label = `无法比较 · 已装 ${lv} / 仓库 ${pv}`
      } else {
        // repo-vs-installed: localVer=仓库, peerVer=已装(磁盘)
        const runRaw = opts && opts.loadedVersion
        const run = (runRaw == null || runRaw === '') ? '未加载' : runRaw
        if (state === 'missing') {
          label = `未安装 · 仓库 ${lv}`
        } else if (needRestart && state === 'equal') {
          outState = 'need-restart'
          color = AMBER
          label = `需重启 · 已装 ${lv}（运行中仍为 ${run}）`
        } else if (needRestart && state === 'lower') {
          label = `可升级到仓库 ${lv}（已装 ${pv}，运行中 ${run}，需重启）`
        } else if (needRestart) {
          outState = 'need-restart'
          color = AMBER
          label = `需重启 · 已装 ${pv}（运行中 ${run}）`
        } else if (state === 'equal') {
          label = `已安装 ${lv}`
        } else if (state === 'higher') {
          label = `已装 ${pv} > 仓库 ${lv}`
        } else if (state === 'lower') {
          label = `可升级到仓库 ${lv}（已装 ${pv}）`
        } else {
          label = `无法比较 · 仓库 ${lv} / 已装 ${pv}`
        }
      }
      return { color, label, state: outState }
    }

    function findByName(list, name) {
      return (list || []).find((p) => p.name === name) || null
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
      danger: RED,
      success: GREEN,
      fontFamily: cssVar('--dsw-font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'),
    }

    const fontS = { fontFamily: T.fontFamily, fontSize: '12px', lineHeight: '18px' }
    const fontBase = { fontFamily: T.fontFamily, fontSize: '13px', lineHeight: '20px' }
    const fontTitle = { fontFamily: T.fontFamily, fontSize: '16px', lineHeight: '24px', fontWeight: 600, color: T.labelPrimary, margin: 0 }

    function btn(kind, extra) {
      const base = {
        padding: '6px 12px', fontSize: '13px', lineHeight: '18px', cursor: 'pointer',
        whiteSpace: 'nowrap', fontFamily: T.fontFamily, borderRadius: '6px',
        border: `1px solid ${T.borderL1}`, background: 'transparent', color: T.labelPrimary,
        ...extra,
      }
      if (kind === 'primary') return { ...base, color: '#fff', background: BRAND, borderColor: BRAND }
      if (kind === 'soft') return { ...base, background: T.bgSubtle, borderColor: 'transparent' }
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

    function Legend(props) {
      const mode = (props && props.mode) || 'local'
      const showAmber = !!(props && props.showAmber)
      const items = mode === 'sync'
        ? [
          { color: BLUE, text: '蓝：仅一侧有' },
          { color: RED, text: '红：本机更新' },
          { color: GREEN, text: '绿：对方更新' },
          { color: SLATE, text: '灰：已对齐' },
        ]
        : [
          { color: BLUE, text: '蓝：未安装' },
          { color: GREEN, text: '绿：仓库有更新' },
          { color: SLATE, text: '灰：已对齐' },
        ]
      if (showAmber) items.push({ color: AMBER, text: '橙：已装未加载，需重启' })
      return h('div', {
        style: { display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '10px' },
      }, items.map((it) => h('span', {
        key: it.text,
        style: { ...fontS, color: it.color, display: 'inline-flex', alignItems: 'center', gap: '4px' },
      },
        h('span', {
          style: {
            width: 8, height: 8, borderRadius: 2, background: it.color, display: 'inline-block',
          },
        }),
        it.text,
      )))
    }

    function Banner(props) {
      const { tone, children, onClose } = props
      if (!children) return null
      const color = tone === 'error' ? T.danger
        : tone === 'warn' ? AMBER
          : T.success
      const bg = tone === 'error' ? 'rgba(229,72,77,0.08)'
        : tone === 'warn' ? 'rgba(217,119,6,0.10)'
          : 'rgba(22,163,74,0.08)'
      return h('div', {
        style: {
          display: 'flex', alignItems: 'flex-start', gap: '8px',
          padding: '8px 10px', marginBottom: '12px', borderRadius: '8px',
          background: bg, border: `1px solid ${color}33`, color, ...fontBase,
        },
      },
        h('span', { style: { flex: 1, wordBreak: 'break-word', whiteSpace: 'pre-wrap' } }, children),
        onClose ? h('button', {
          onClick: onClose,
          style: { ...btn('ghost'), padding: '0 4px', border: 'none', color },
          'aria-label': '关闭',
        }, '×') : null,
      )
    }

    function TabBar(props) {
      const { tabs, active, onChange } = props
      return h('div', {
        role: 'tablist',
        style: { display: 'flex', gap: '2px', marginBottom: '14px', borderBottom: `1px solid ${T.borderL1}` },
      },
        tabs.map((t) => {
          const on = t.id === active
          return h('button', {
            key: t.id, role: 'tab', 'aria-selected': on, onClick: () => onChange(t.id),
            style: {
              ...fontBase, fontWeight: on ? 600 : 500, padding: '8px 12px', marginBottom: '-1px',
              cursor: 'pointer', border: 'none',
              borderBottom: on ? `2px solid ${BRAND}` : '2px solid transparent',
              background: 'transparent', color: on ? T.labelPrimary : T.labelTertiary,
              fontFamily: T.fontFamily,
            },
          }, t.label)
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
      const dropActive = props.dropActive
      return h('div', {
        style: {
          border: `1px solid ${dropActive ? BRAND : T.borderL1}`,
          borderRadius: '10px', background: T.bgBase, overflow: 'hidden',
          display: 'flex', flexDirection: 'column', minHeight: props.minHeight || 0,
          boxShadow: dropActive ? `0 0 0 2px ${BRAND}33` : 'none',
          transition: 'border-color 120ms ease, box-shadow 120ms ease',
          ...props.style,
        },
        onDragOver: props.onDragOver,
        onDragLeave: props.onDragLeave,
        onDrop: props.onDrop,
      },
        props.title ? h('div', {
          style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px',
            padding: '10px 12px', borderBottom: `1px solid ${T.borderL1}`, background: T.bgSubtle,
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: 0 } },
            h('span', { style: { ...fontBase, fontWeight: 600 } }, props.title),
            props.subtitle ? h('span', {
              style: { ...fontS, color: T.labelTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            }, props.subtitle) : null,
          ),
          props.actions || null,
        ) : null,
        h('div', { style: { padding: props.pad === false ? 0 : '8px 10px', flex: 1, minHeight: 120 } }, props.children),
      )
    }

    function Empty(props) {
      return h('p', { style: { ...fontBase, color: T.labelTertiary, margin: '12px 4px', textAlign: 'center' } }, props.children)
    }

    function CheckLabel(props) {
      return h('label', {
        style: {
          ...fontBase, color: T.labelSecondary, display: 'inline-flex',
          alignItems: 'center', gap: '6px', cursor: 'pointer', userSelect: 'none',
        },
      },
        h('input', { type: 'checkbox', checked: !!props.checked, onChange: (e) => props.onChange(e.target.checked) }),
        props.children,
      )
    }

    function ConfirmModal(props) {
      const { title, body, confirmLabel, danger, busy, onCancel, onConfirm } = props
      if (!title) return null
      return h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 1000,
          background: cssVar('--dsw-alias-bg-mask-1', 'rgba(0,0,0,0.45)'),
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
        },
      },
        h('div', {
          role: 'dialog', 'aria-modal': true,
          style: {
            background: T.bgBase, color: T.labelPrimary, borderRadius: '12px',
            padding: '18px 20px', maxWidth: '460px', width: '100%',
            border: `1px solid ${T.borderL1}`, boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
          },
        },
          h('h3', { style: { ...fontTitle, fontSize: '15px', marginBottom: '8px' } }, title),
          typeof body === 'string'
            ? h('p', { style: { ...fontBase, color: T.labelSecondary, margin: '0 0 14px', whiteSpace: 'pre-wrap' } }, body)
            : body,
          h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' } },
            h('button', { onClick: onCancel, style: btn('ghost') }, '取消'),
            h('button', {
              onClick: onConfirm, disabled: busy,
              style: busyStyle(danger ? { ...btn('primary'), background: RED, borderColor: RED } : btn('primary'), busy),
            }, busy ? '处理中…' : (confirmLabel || '确认')),
          ),
        ),
      )
    }

    /** Draggable package chip/row */
    function PkgCard(props) {
      const {
        pkg, badge, checked, onCheck, actions, dragPayload, onReorderDrop, onForeignDrop, listId, index,
      } = props
      const [dragging, setDragging] = React.useState(false)
      const [over, setOver] = React.useState(false)

      return h('div', {
        draggable: !!dragPayload,
        onDragStart: (e) => {
          if (!dragPayload) return
          setDragging(true)
          e.dataTransfer.effectAllowed = 'copyMove'
          e.dataTransfer.setData('application/x-dsh-plugin', JSON.stringify(dragPayload))
          e.dataTransfer.setData('text/plain', dragPayload.name || '')
        },
        onDragEnd: () => setDragging(false),
        onDragOver: (e) => {
          // Always allow drop over cards so cross-column drops (入库/安装) work;
          // otherwise the browser rejects the drop when hovering a child card.
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setOver(true)
        },
        onDragLeave: () => setOver(false),
        onDrop: (e) => {
          e.preventDefault()
          setOver(false)
          let data = null
          try {
            data = JSON.parse(e.dataTransfer.getData('application/x-dsh-plugin') || 'null')
          } catch (err) { data = null }
          if (!data) return
          // Same column → reorder (stop bubble so the panel does not also fire).
          if (data.listId === listId) {
            e.stopPropagation()
            if (onReorderDrop && dragPayload && data.key !== dragPayload.key) {
              onReorderDrop(data.key, index)
            }
            return
          }
          // Cross column → 入库 / 安装 / 推拉；stop so panel does not double-fire.
          e.stopPropagation()
          if (typeof onForeignDrop === 'function') onForeignDrop(data)
        },
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
          padding: '8px 8px', marginBottom: '6px', borderRadius: '8px',
          border: `1px solid ${over ? BRAND : T.borderL1}`,
          background: dragging ? T.bgSubtle : T.bgBase,
          cursor: dragPayload ? 'grab' : 'default',
          opacity: dragging ? 0.55 : 1,
          userSelect: 'none',
        },
      },
        dragPayload ? h('span', {
          title: '拖动排序，或拖到另一列入库/安装/同步',
          style: { ...fontS, color: T.labelTertiary, letterSpacing: '1px', cursor: 'grab' },
        }, '⋮⋮') : null,
        onCheck ? h('input', {
          type: 'checkbox', checked: !!checked,
          onChange: (e) => onCheck(e.target.checked),
          onClick: (e) => e.stopPropagation(),
          onMouseDown: (e) => e.stopPropagation(),
        }) : null,
        h('div', { style: { flex: '1 1 140px', minWidth: 0 } },
          h('div', { style: { ...fontBase, fontWeight: 600, wordBreak: 'break-all' } },
            `${pkg.name}@${pkg.version || '?'}`),
          h('div', { style: { ...fontS, color: T.labelTertiary, marginTop: '2px' } },
            pkg.size != null ? formatBytes(pkg.size) : (pkg.filename || '')),
        ),
        badge ? h(Badge, { color: badge.color }, badge.label) : null,
        actions ? h('div', {
          style: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
          onMouseDown: (e) => e.stopPropagation(),
          onDragStart: (e) => e.preventDefault(),
        }, actions) : null,
      )
    }

    function applyOrder(items, orderKeys, keyFn) {
      if (!orderKeys || !orderKeys.length) return items
      const map = new Map(items.map((it) => [keyFn(it), it]))
      const out = []
      for (const k of orderKeys) {
        if (map.has(k)) { out.push(map.get(k)); map.delete(k) }
      }
      for (const it of items) {
        const k = keyFn(it)
        if (map.has(k)) out.push(map.get(k))
      }
      return out
    }

    function reorderKeys(keys, fromKey, toIndex, allItems, keyFn) {
      const base = (keys && keys.length)
        ? keys.slice()
        : allItems.map(keyFn)
      const from = base.indexOf(fromKey)
      if (from < 0) return base
      base.splice(from, 1)
      const insertAt = Math.max(0, Math.min(toIndex, base.length))
      base.splice(insertAt, 0, fromKey)
      return base
    }

    const TABS = [
      { id: 'repo', label: '本机' },
      { id: 'sync', label: '跨设备同步' },
      { id: 'advanced', label: '高级' },
    ]

    function PluginRepoSection() {
      const [tab, setTab] = React.useState('repo')
      const [installed, setInstalled] = React.useState([])
      const [repoPkgs, setRepoPkgs] = React.useState([])
      const [roots, setRoots] = React.useState([])
      const [runtime, setRuntime] = React.useState({
        platform: '', autoRestart: false, restartHint: '', restartScheduled: false,
      })
      const [newRoot, setNewRoot] = React.useState('')
      const [uploadName, setUploadName] = React.useState('')
      const [error, setError] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [messageTone, setMessageTone] = React.useState('ok')
      const [busy, setBusy] = React.useState(false)

      const [remoteAddr, setRemoteAddr] = React.useState('')
      const [remoteList, setRemoteList] = React.useState(null)
      const [selectedRemote, setSelectedRemote] = React.useState({})
      const [selInstalled, setSelInstalled] = React.useState({})
      const [selRepo, setSelRepo] = React.useState({})

      const [orderRepo, setOrderRepo] = React.useState([])
      const [orderRemote, setOrderRemote] = React.useState([])
      const [orderInstalled, setOrderInstalled] = React.useState([])

      const [dropTarget, setDropTarget] = React.useState(null) // 'repo' | 'remote' | 'installed'
      const [confirm, setConfirm] = React.useState(null)
      // confirm: { kind, title, body, filenames?, names?, filename?, run }
      const [pushHistory, setPushHistory] = React.useState([])

      const orderedRepo = React.useMemo(
        () => applyOrder(repoPkgs, orderRepo, (p) => p.filename),
        [repoPkgs, orderRepo],
      )
      const orderedRemote = React.useMemo(
        () => applyOrder((remoteList && remoteList.packages) || [], orderRemote, (p) => p.filename),
        [remoteList, orderRemote],
      )
      const orderedInstalled = React.useMemo(
        () => applyOrder(installed, orderInstalled, (p) => p.name),
        [installed, orderInstalled],
      )

      const selectedRepoCount = orderedRepo.filter((p) => selRepo[p.filename]).length
      const selectedRemoteCount = orderedRemote.filter((p) => selectedRemote[p.filename]).length
      const selectedInstalledCount = orderedInstalled.filter((p) => selInstalled[p.name]).length

      const refresh = React.useCallback(async () => {
        setBusy(true); setError('')
        try {
          const u = await fetchJson(`${API}/unofficial`)
          setInstalled(u.installed || [])
          setRepoPkgs(u.repo || [])
          setRoots(u.roots || [])
          setRuntime({
            platform: u.platform || '',
            autoRestart: !!u.autoRestart,
            restartHint: u.restartHint || '',
            restartScheduled: !!u.restartScheduled,
          })
        } catch (e) { setError(String(e && e.message || e)) } finally { setBusy(false) }
      }, [])

      const anyNeedRestart = React.useMemo(
        () => (installed || []).some((p) => p && p.needRestart),
        [installed],
      )

      async function requestRestart() {
        if (runtime.restartScheduled) {
          flash('重启已在排队…')
          return
        }
        setBusy(true)
        try {
          const r = await fetch(`${API}/restart`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
          })
          const b = await r.json().catch(() => ({}))
          if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
          if (b.restartScheduled) {
            setRuntime((s) => ({ ...s, restartScheduled: true }))
            flash(b.message || '即将自动重启以加载新插件…')
          } else {
            flash(b.message || runtime.restartHint || '请手动重启 dsh web')
          }
        } catch (e) {
          flash(null, String(e && e.message || e))
        } finally { setBusy(false) }
      }

      function RestartAffordance(props) {
        const label = (props && props.label) || '重启'
        if (runtime.restartScheduled) {
          return h('button', {
            disabled: true,
            style: busyStyle(btn('soft'), true),
            title: '进程即将退出并重新拉起',
          }, '重启中…')
        }
        if (runtime.autoRestart) {
          return h('button', {
            onClick: () => requestRestart(),
            disabled: busy,
            style: busyStyle(btn('primary'), busy),
            title: '重启 dsh web 以加载已安装到磁盘的插件',
          }, label)
        }
        // Windows / autoRestart off: visible but disabled hint
        return h('button', {
          disabled: true,
          style: busyStyle(btn('soft'), true),
          title: runtime.restartHint || '请手动关闭并重新启动 dsh web',
        }, '需重启')
      }

      const refreshPushHistory = React.useCallback(async () => {
        try {
          const r = await fetchJson(`${API}/push-history`)
          setPushHistory((r && r.entries) || [])
        } catch (e) { /* keep */ }
      }, [])

      const refreshRepo = React.useCallback(async () => {
        try {
          const r = await fetchJson(`${API}/packages`)
          setRepoPkgs((r && r.packages) || [])
        } catch (e) { /* keep */ }
      }, [])

      React.useEffect(() => { refresh(); refreshPushHistory() }, [refresh, refreshPushHistory])

      function flash(okMsg, errMsg, tone) {
        if (okMsg) {
          setMessage(okMsg)
          setError('')
          setMessageTone(tone === 'warn' ? 'warn' : 'ok')
        }
        if (errMsg) { setError(errMsg); setMessage('') }
      }

      function restartBannerText() {
        if (runtime.restartScheduled) {
          return '正在重启以加载新插件，页面即将不可用…'
        }
        if (!anyNeedRestart) return ''
        const names = (installed || []).filter((p) => p && p.needRestart).map((p) => p.name)
        const tip = names.length <= 3
          ? names.join('、')
          : (names.slice(0, 3).join('、') + ` 等 ${names.length} 个`)
        if (runtime.autoRestart) {
          return `已装未加载：${tip || '插件'}。点「重启以生效」后自动重启。`
        }
        return `已装未加载：${tip || '插件'}。请手动关闭并重新启动 dsh web 后生效。`
      }

      function repoInstallState(repoPkg) {
        const peer = findByName(installed, repoPkg.name)
        if (!peer) return 'missing'
        return diffLocalVsOther(peer.version, repoPkg.version, { peerExists: true })
      }

      function canInstallFromRepo(repoPkg) {
        const s = repoInstallState(repoPkg)
        return s === 'missing' || s === 'lower'
      }

      async function visitRemote() {
        if (runtime.restartScheduled) {
          flash('重启已在排队，请稍候…', null, 'warn')
          return
        }
        const addr = remoteAddr.trim()
        if (!addr) { flash(null, '请输入对方 DSH 地址'); return }
        setBusy(true); setSelectedRemote({}); setOrderRemote([])
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

      async function doPull(filenames) {
        if (!remoteList) throw new Error('请先连接对方')
        const r = await fetch(`${API}/remote-pull`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: remoteList.addr, filenames }),
        })
        const b = await r.json()
        if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
        const okCount = (b.pulled || []).filter((x) => x.ok).length
        flash(`已拉取 ${okCount}/${filenames.length} 个到本机仓库`)
        setSelectedRemote({})
        await refreshRepo()
      }

      async function doPush(filenames) {
        const addr = (remoteList && remoteList.addr) || remoteAddr.trim()
        if (!addr) throw new Error('请先填写对方地址')
        const r = await fetch(`${API}/remote-push`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ host: addr, filenames }),
        })
        const b = await r.json()
        if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
        const okItems = (b.pushed || []).filter((x) => x.ok)
        const failItems = (b.pushed || []).filter((x) => !x.ok)
        const detailLines = (b.pushed || []).map((x) => {
          const ver = x.localVersion || x.version || '?'
          const head = `${x.name || x.filename}@${ver}`
          if (!x.ok) return `× ${head} 失败（未推送）：${x.error || 'unknown'}`
          const note = x.note || '已推送'
          // Strip machine prefix before Chinese explanation if present
          const human = String(note).replace(/^[a-z0-9_]+\s*[：:]\s*/i, '')
          return `✓ ${head} — ${human}`
        })
        let msg = `推送结果 ${okItems.length} 成功 / ${failItems.length} 失败（均非“静默跳过”）`
        if (detailLines.length) msg += '\n' + detailLines.join('\n')
        flash(msg)
        setSelRepo({})
        await refreshPushHistory()
        if (remoteList && remoteList.addr === addr) {
          try {
            const rr = await fetch(`${API}/remote?host=${encodeURIComponent(addr)}`)
            const rb = await rr.json()
            if (rr.ok) setRemoteList({ addr, packages: rb.packages || [] })
          } catch (e) { /* keep */ }
        }
      }

      async function doUploadNames(names) {
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
      }

      async function doInstall(filenames) {
        const r = await fetch(`${API}/install-all`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filenames, confirm: true }),
        })
        const b = await r.json()
        if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`)
        const rows = b.installed || []
        const okCount = rows.filter((x) => x.ok && !x.skipped).length
        const skippedCount = rows.filter((x) => x.skipped).length
        const failCount = rows.filter((x) => !x.ok && !x.skipped).length
        let msg = `已安装 ${okCount} 个`
        if (skippedCount) msg += `、跳过 ${skippedCount} 个`
        if (failCount) msg += `、失败 ${failCount} 个`
        if (okCount > 0) {
          if (b.restartScheduled) {
            setRuntime((s) => ({
              ...s,
              restartScheduled: true,
              autoRestart: b.autoRestart != null ? !!b.autoRestart : s.autoRestart,
              platform: b.platform || s.platform,
              restartHint: b.restartMessage || s.restartHint,
            }))
            flash(`${msg}。即将自动重启…`, null, 'warn')
            setSelRepo({})
            return
          }
          flash(msg, null, 'warn')
          setSelRepo({})
          await refresh()
          return
        }
        flash(msg)
        setSelRepo({})
        await refresh()
      }

      function askConfirm(spec) {
        setConfirm(spec)
      }

      async function runConfirm() {
        if (!confirm || !confirm.run) return
        setBusy(true)
        try {
          await confirm.run()
          setConfirm(null)
        } catch (e) {
          flash(null, String(e && e.message || e))
        } finally { setBusy(false) }
      }

      function summarizeDiff(filenames, fromList, toFinder, direction) {
        // direction: 'pull' | 'push' | 'install' | 'upload'
        const lines = []
        for (const fn of filenames) {
          const src = fromList.find((p) => p.filename === fn || p.name === fn)
          if (!src) continue
          const peer = toFinder(src.name)
          let badge
          if (direction === 'pull') {
            const s = peer ? diffLocalVsOther(peer.version, src.version, { peerExists: true }) : 'missing'
            badge = badgeFor('remote-vs-repo', s, src.version, peer && peer.version)
          } else if (direction === 'push') {
            const s = peer ? diffLocalVsOther(src.version, peer.version, { peerExists: true }) : 'missing'
            badge = badgeFor('repo-vs-remote', s, src.version, peer && peer.version)
          } else if (direction === 'install') {
            const s = peer ? diffLocalVsOther(peer.version, src.version, { peerExists: true }) : 'missing'
            badge = badgeFor('repo-vs-installed', s, src.version, peer && peer.version, {
              needRestart: !!(peer && peer.needRestart),
              loadedVersion: peer && peer.loadedVersion,
            })
          } else {
            const s = peer ? diffLocalVsOther(src.version, peer.version, { peerExists: true }) : 'missing'
            badge = badgeFor('installed-vs-repo', s, src.version, peer && peer.version, {
              needRestart: !!(src && src.needRestart),
              loadedVersion: src && src.loadedVersion,
            })
          }
          lines.push(`· ${src.name}@${src.version || '?'}（${badge.label}）`)
        }
        return lines.join('\n')
      }

      function confirmPull(filenames) {
        if (runtime.restartScheduled) {
          flash('重启已在排队，请稍候…', null, 'warn')
          return
        }
        if (!filenames.length) { flash(null, '请先选择要拉取的包'); return }
        const body = '将把以下对方包写入本机仓库（不会自动安装）：\n\n'
          + summarizeDiff(filenames, orderedRemote, (n) => findByName(repoPkgs, n), 'pull')
        askConfirm({
          kind: 'pull',
          title: `确认拉取 ${filenames.length} 个到本机仓库`,
          body,
          confirmLabel: '确认拉取',
          run: () => doPull(filenames),
        })
      }

      function confirmPush(filenames) {
        if (runtime.restartScheduled) {
          flash('重启已在排队，请稍候…', null, 'warn')
          return
        }
        if (!filenames.length) { flash(null, '请先选择要推送的包'); return }
        if (!(remoteList || remoteAddr.trim())) { flash(null, '请先填写/连接对方地址'); return }
        const remotePkgs = (remoteList && remoteList.packages) || []
        const downgrades = []
        const synced = []
        const unknowns = []
        for (const fn of filenames) {
          const src = orderedRepo.find((p) => p.filename === fn)
          if (!src) continue
          const peer = findByName(remotePkgs, src.name)
          const s = peer ? diffLocalVsOther(src.version, peer.version, { peerExists: true }) : 'missing'
          if (s === 'lower') downgrades.push(`${src.name}@${src.version} → 对方 ${peer.version}`)
          if (s === 'equal') synced.push(`${src.name}@${src.version}`)
          if (s === 'unknown') {
            unknowns.push(
              peer
                ? `${src.name}：对方有包但版本未知（将推送本机 ${src.version || '?'}，不是跳过）`
                : `${src.name}：本机版本未知，仍会推送文件`,
            )
          }
        }
        let body = '将把以下本机仓库包推送到对方（对方已有同名包会被覆盖为该版本）：\n\n'
          + summarizeDiff(filenames, orderedRepo, (n) => findByName(remotePkgs, n), 'push')
        if (unknowns.length) {
          body += `\n\n版本未知（默认仍推送，不会跳过）：\n${unknowns.map((x) => `· ${x}`).join('\n')}`
        }
        if (synced.length) {
          body += `\n\n已与对方相同（推送无实质变化）：\n${synced.map((x) => `· ${x}`).join('\n')}`
        }
        if (downgrades.length) {
          body += `\n\n⚠ 以下会把对方覆盖为更旧版本：\n${downgrades.map((x) => `· ${x}`).join('\n')}`
        }
        askConfirm({
          kind: 'push',
          title: `确认推送 ${filenames.length} 个到对方`,
          body,
          confirmLabel: downgrades.length ? '仍要推送（含降级）' : '确认推送',
          run: () => doPush(filenames),
        })
      }

      function confirmUpload(names) {
        if (!names.length) { flash(null, '请先选择要上传的插件'); return }
        const body = '将打包并写入本机仓库：\n\n' + names.map((n) => {
          const inst = findByName(installed, n)
          const repo = findByName(repoPkgs, n)
          const s = repo ? diffLocalVsOther(inst && inst.version, repo.version, { peerExists: true }) : 'missing'
          const badge = badgeFor('installed-vs-repo', s, inst && inst.version, repo && repo.version)
          return `· ${n}@${inst && inst.version || '?'}（${badge.label}）`
        }).join('\n')
        askConfirm({
          kind: 'upload',
          title: `确认上传 ${names.length} 个到本机仓库`,
          body,
          confirmLabel: '确认上传',
          run: () => doUploadNames(names),
        })
      }

      function confirmInstall(filenames) {
        if (!filenames.length) { flash(null, '请先选择要安装的包'); return }
        if (runtime.restartScheduled) {
          flash('重启已在排队，请稍候…', null, 'warn')
          return
        }
        const installable = filenames.filter((fn) => {
          const pkg = orderedRepo.find((p) => p.filename === fn)
          return pkg && canInstallFromRepo(pkg)
        })
        if (!installable.length) {
          flash(null, '所选包均已安装或无需升级（若显示橙标，请先重启）')
          return
        }
        const lead = runtime.autoRestart
          ? '将写入本地 profile。成功后可自动重启以加载新模块。\n版本不高于已装的会跳过：\n\n'
          : '将写入本地 profile。成功后需手动重启 dsh web 才会加载新模块。\n版本不高于已装的会跳过：\n\n'
        const body = lead
          + summarizeDiff(installable, orderedRepo, (n) => findByName(installed, n), 'install')
        askConfirm({
          kind: 'install',
          title: `确认安装 ${installable.length} 个到本机`,
          body,
          confirmLabel: runtime.autoRestart ? '确认安装并准备重启' : '确认安装（稍后需手动重启）',
          run: () => doInstall(installable),
        })
      }

      function onColumnDragOver(e, target) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropTarget(target)
      }

      function onColumnDrop(e, target) {
        e.preventDefault()
        setDropTarget(null)
        let data = null
        try {
          data = JSON.parse(e.dataTransfer.getData('application/x-dsh-plugin') || 'null')
        } catch (err) { data = null }
        acceptForeignDrop(data, target)
      }

      /** Cross-column drop: installed→repo 入库, repo→installed 安装, sync 推拉. */
      function acceptForeignDrop(data, target) {
        if (!data || !data.listId || data.listId === target) return
        if (target === 'repo' && data.listId === 'remote') {
          if (data.filename) confirmPull([data.filename])
          return
        }
        if (target === 'remote' && data.listId === 'repo') {
          if (data.filename) confirmPush([data.filename])
          return
        }
        if (target === 'repo' && data.listId === 'installed') {
          if (data.name) confirmUpload([data.name])
          return
        }
        if (target === 'installed' && data.listId === 'repo') {
          if (data.filename) confirmInstall([data.filename])
        }
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

      async function manualUpload(file) {
        if (!file) return
        askConfirm({
          kind: 'manual',
          title: '确认手动加入本机仓库',
          body: `文件：${file.name}\n大小：${formatBytes(file.size)}\n将写入本机仓库，不会自动安装。`,
          confirmLabel: '确认上传',
          run: async () => {
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
          },
        })
      }

      // ---------- render helpers ----------
      function renderRepoColumn(opts) {
        const { forSync, showInstall } = opts || {}
        const remotePkgs = (remoteList && remoteList.packages) || []
        if (!orderedRepo.length) {
          return h(Empty, null, forSync
            ? '本机仓库为空'
            : h('span', { style: { display: 'block' } },
              '还没有包。可从右侧「已安装」拖入入库，或去跨设备同步拉取。',
              h('div', {
                style: {
                  display: 'flex', justifyContent: 'center', gap: '8px',
                  marginTop: '10px', flexWrap: 'wrap',
                },
              },
                h('button', {
                  onClick: () => setTab('sync'),
                  style: busyStyle(btn('soft'), false),
                }, '去跨设备同步'),
              ),
            ))
        }
        const selectedInstallable = showInstall
          ? orderedRepo.filter((p) => selRepo[p.filename] && canInstallFromRepo(p))
          : []
        const selectedInstallableCount = selectedInstallable.length
        const locked = busy || runtime.restartScheduled
        return h('div', null,
          h(Toolbar, { tight: true },
            h(CheckLabel, {
              checked: orderedRepo.length > 0 && orderedRepo.every((p) => selRepo[p.filename]),
              onChange: (checked) => {
                const next = {}
                if (checked) for (const p of orderedRepo) next[p.filename] = true
                setSelRepo(next)
              },
            }, `全选（${selectedRepoCount}/${orderedRepo.length}）`),
            forSync ? h('button', {
              onClick: () => confirmPush(orderedRepo.filter((p) => selRepo[p.filename]).map((p) => p.filename)),
              disabled: locked || !selectedRepoCount,
              style: busyStyle(btn('primary'), locked || !selectedRepoCount),
            }, selectedRepoCount ? `推送所选 ${selectedRepoCount}` : '推送到对方') : null,
            forSync ? h('button', {
              onClick: () => {
                const next = {}
                for (const p of orderedRepo) {
                  const peer = findByName(remotePkgs, p.name)
                  const state = peer
                    ? diffLocalVsOther(p.version, peer.version, { peerExists: true })
                    : 'missing'
                  if (needsPush(state)) next[p.filename] = true
                }
                setSelRepo(next)
              },
              disabled: locked || !orderedRepo.length,
              style: busyStyle(btn('soft'), locked || !orderedRepo.length),
              title: '勾选：对方无 / 本机更新 / 版本未知（默认推送）',
            }, '选需推送') : null,
            showInstall ? h('button', {
              onClick: () => {
                const next = {}
                for (const p of orderedRepo) {
                  if (canInstallFromRepo(p)) next[p.filename] = true
                }
                setSelRepo(next)
              },
              disabled: locked || !orderedRepo.length,
              style: busyStyle(btn('soft'), locked || !orderedRepo.length),
              title: '勾选：未安装 / 仓库版本更高',
            }, '选需安装') : null,
            showInstall ? h('button', {
              onClick: () => confirmInstall(selectedInstallable.map((p) => p.filename)),
              disabled: locked || !selectedInstallableCount,
              style: busyStyle(btn('primary'), locked || !selectedInstallableCount),
              title: selectedRepoCount && !selectedInstallableCount
                ? '所选均已安装或无需升级'
                : undefined,
            }, selectedInstallableCount
              ? `安装所选 ${selectedInstallableCount}`
              : '安装到本机') : null,
            showInstall && anyNeedRestart ? h(RestartAffordance, { label: '重启以生效' }) : null,
          ),
          orderedRepo.map((p, index) => {
            const peer = forSync
              ? findByName(remotePkgs, p.name)
              : findByName(installed, p.name)
            // forSync: localRef=本机包版本 vs 对方
            // !forSync: localRef=已装 vs 仓库包
            const state = forSync
              ? (peer ? diffLocalVsOther(p.version, peer.version, { peerExists: true }) : 'missing')
              : (peer ? diffLocalVsOther(peer.version, p.version, { peerExists: true }) : 'missing')
            const needRestart = !!(peer && peer.needRestart)
            const badge = forSync
              ? badgeFor('repo-vs-remote', state, p.version, peer && peer.version)
              : badgeFor('repo-vs-installed', state, p.version, peer && peer.version, {
                needRestart,
                loadedVersion: peer && peer.loadedVersion,
              })
            const pushDisabled = locked || (forSync && state === 'equal')
            const canUpgrade = !forSync && (state === 'missing' || state === 'lower')
            const installDone = !forSync && (state === 'equal' || state === 'higher') && !needRestart
            const diskNewer = !forSync && state === 'higher' && !needRestart
            const installNeedsRestart = !forSync && needRestart && !canUpgrade
            let installAction = null
            if (showInstall) {
              if (runtime.restartScheduled && (installNeedsRestart || needRestart)) {
                installAction = h(RestartAffordance, { label: '重启' })
              } else if (canUpgrade) {
                installAction = h('button', {
                  onClick: () => confirmInstall([p.filename]),
                  disabled: locked,
                  style: busyStyle(btn('soft'), locked),
                }, '安装')
              } else if (installNeedsRestart) {
                installAction = h(RestartAffordance, { label: '重启' })
              } else if (diskNewer) {
                installAction = h('button', {
                  disabled: true,
                  style: busyStyle(btn('soft'), true),
                  title: '已装版本不低于仓库，无需安装',
                }, '无需安装')
              } else if (installDone) {
                installAction = h('button', {
                  disabled: true,
                  style: busyStyle(btn('soft'), true),
                }, '已安装')
              } else {
                installAction = h('button', {
                  disabled: true,
                  style: busyStyle(btn('soft'), true),
                  title: '版本无法比较，请核对后手动处理',
                }, '无法比较')
              }
            }
            return h(PkgCard, {
              key: p.filename,
              pkg: p,
              badge,
              checked: !!selRepo[p.filename],
              onCheck: (v) => setSelRepo((s) => ({ ...s, [p.filename]: v })),
              listId: 'repo',
              index,
              dragPayload: {
                listId: 'repo', key: p.filename, filename: p.filename,
                name: p.name, version: p.version,
              },
              onReorderDrop: (fromKey, toIndex) => {
                setOrderRepo((prev) => reorderKeys(prev, fromKey, toIndex, orderedRepo, (x) => x.filename))
              },
              onForeignDrop: (data) => acceptForeignDrop(data, 'repo'),
              actions: showInstall ? installAction : (
                forSync ? h('button', {
                  onClick: () => confirmPush([p.filename]),
                  disabled: pushDisabled,
                  title: state === 'equal'
                    ? '对方已是相同版本'
                    : (state === 'unknown' ? '版本未知：默认仍推送（不会跳过）' : undefined),
                  style: busyStyle(btn(state === 'unknown' ? 'primary' : 'soft'), pushDisabled),
                }, state === 'equal' ? '已同步' : (state === 'unknown' ? '推送(未知)' : '推送')) : null
              ),
            })
          }),
        )
      }

      function renderRemoteColumn() {
        if (!remoteList) return h(Empty, null, '填写地址并点「连接」后显示对方仓库')
        if (!orderedRemote.length) return h(Empty, null, '对方仓库为空')
        return h('div', null,
          h(Toolbar, { tight: true },
            h(CheckLabel, {
              checked: orderedRemote.length > 0 && orderedRemote.every((p) => selectedRemote[p.filename]),
              onChange: (checked) => {
                const next = {}
                if (checked) for (const p of orderedRemote) next[p.filename] = true
                setSelectedRemote(next)
              },
            }, `全选（${selectedRemoteCount}/${orderedRemote.length}）`),
            h('button', {
              onClick: () => confirmPull(orderedRemote.filter((p) => selectedRemote[p.filename]).map((p) => p.filename)),
              disabled: busy || !selectedRemoteCount,
              style: busyStyle(btn('primary'), busy || !selectedRemoteCount),
            }, selectedRemoteCount ? `拉取所选 ${selectedRemoteCount}` : '拉取到本机'),
            h('button', {
              onClick: () => {
                const next = {}
                for (const p of orderedRemote) {
                  const local = findByName(repoPkgs, p.name)
                  const state = local ? diffLocalVsOther(local.version, p.version, { peerExists: true }) : 'missing'
                  // 对方更新（本机更低）或本机无 → 需拉取
                  if (state === 'missing' || state === 'lower') next[p.filename] = true
                }
                setSelectedRemote(next)
              },
              disabled: busy || !orderedRemote.length,
              style: busyStyle(btn('soft'), busy || !orderedRemote.length),
              title: '只勾选本机没有、或对方更新的包',
            }, '选需拉取'),
          ),
          orderedRemote.map((p, index) => {
            const local = findByName(repoPkgs, p.name)
            const state = local ? diffLocalVsOther(local.version, p.version, { peerExists: true }) : 'missing'
            const badge = badgeFor('remote-vs-repo', state, p.version, local && local.version)
            return h(PkgCard, {
              key: p.filename,
              pkg: p,
              badge,
              checked: !!selectedRemote[p.filename],
              onCheck: (v) => setSelectedRemote((s) => ({ ...s, [p.filename]: v })),
              listId: 'remote',
              index,
              dragPayload: {
                listId: 'remote', key: p.filename, filename: p.filename,
                name: p.name, version: p.version,
              },
              onReorderDrop: (fromKey, toIndex) => {
                setOrderRemote((prev) => reorderKeys(prev, fromKey, toIndex, orderedRemote, (x) => x.filename))
              },
              onForeignDrop: (data) => acceptForeignDrop(data, 'remote'),
              actions: h('button', {
                onClick: () => confirmPull([p.filename]),
                disabled: busy,
                style: busyStyle(btn('soft'), busy),
              }, '拉取'),
            })
          }),
        )
      }

      function tabSync() {
        const connected = !!remoteList
        return h('div', null,
          h(Panel, { title: '对方地址' },
            h(Toolbar, null,
              h('input', {
                type: 'text',
                placeholder: '例：192.168.1.10 或 https://dsh.example.com',
                value: remoteAddr,
                onChange: (e) => setRemoteAddr(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') visitRemote() },
                style: { ...inputStyle, flex: '1 1 240px', maxWidth: '420px' },
              }),
              h('button', {
                onClick: visitRemote, disabled: busy,
                style: busyStyle(btn('primary'), busy),
              }, busy ? '连接中…' : '连接'),
              connected ? h('button', {
                onClick: () => { setRemoteList(null); setSelectedRemote({}); setOrderRemote([]) },
                style: btn('ghost'),
              }, '断开') : null,
            ),
            h('p', { style: { ...fontS, color: T.labelTertiary, margin: 0 } },
              '拖动插件到另一列可拉取/推送（会弹出确认）。同列内拖动可排序。'),
          ),
          h('div', { style: { height: 10 } }),
          h(Legend, { mode: 'sync' }),
          h('div', {
            style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'stretch' },
          },
            h(Panel, {
              title: '本机仓库',
              subtitle: `${repoPkgs.length}`,
              minHeight: '280px',
              style: { flex: '1 1 320px', minWidth: '280px' },
              dropActive: dropTarget === 'repo',
              onDragOver: (e) => onColumnDragOver(e, 'repo'),
              onDragLeave: () => setDropTarget(null),
              onDrop: (e) => onColumnDrop(e, 'repo'),
            }, renderRepoColumn({ forSync: true })),
            h(Panel, {
              title: '对方仓库',
              subtitle: connected ? remoteList.addr : '未连接',
              minHeight: '280px',
              style: { flex: '1 1 320px', minWidth: '280px' },
              dropActive: dropTarget === 'remote',
              onDragOver: (e) => onColumnDragOver(e, 'remote'),
              onDragLeave: () => setDropTarget(null),
              onDrop: (e) => onColumnDrop(e, 'remote'),
            }, renderRemoteColumn()),
          ),
          h('div', { style: { height: 12 } }),
          h(Panel, {
            title: '最近推送',
            subtitle: pushHistory.length ? `${pushHistory.length} 条 · 重启后保留` : '暂无',
            actions: h('div', { style: { display: 'flex', gap: '6px' } },
              h('button', {
                onClick: refreshPushHistory, disabled: busy,
                style: busyStyle(btn('soft'), busy),
              }, '刷新'),
              pushHistory.length ? h('button', {
                onClick: async () => {
                  if (!window.confirm('清空本机保存的推送记录？')) return
                  setBusy(true)
                  try {
                    await fetch(`${API}/push-history`, { method: 'DELETE' })
                    setPushHistory([])
                  } catch (e) { flash(null, String(e && e.message || e)) }
                  finally { setBusy(false) }
                },
                disabled: busy,
                style: busyStyle(btn('ghost'), busy),
              }, '清空') : null,
            ),
          },
            !pushHistory.length
              ? h(Empty, null, '推送成功后会在此留下记录（含推送前/后对方版本说明）')
              : pushHistory.slice(0, 12).map((entry) => {
                const when = entry.at ? new Date(entry.at).toLocaleString() : '?'
                return h('div', {
                  key: entry.at + (entry.remoteHost || ''),
                  style: {
                    padding: '8px 0', borderBottom: `1px solid ${T.borderL1}`,
                  },
                },
                  h('div', { style: { ...fontS, color: T.labelSecondary, marginBottom: 4 } },
                    `${when} → ${entry.remoteHost || '?'} · 成功 ${entry.okCount || 0} / 失败 ${entry.failCount || 0}`),
                  (entry.items || []).map((it, i) => {
                    const human = String(it.note || '').replace(/^[a-z0-9_]+\s*[：:]\s*/i, '') || (it.ok ? '已推送' : '失败')
                    const before = it.remoteVersionBefore == null || it.remoteVersionBefore === ''
                      ? (it.ok ? '（推送前无/未知）' : '')
                      : `推送前对方 ${it.remoteVersionBefore}`
                    const after = it.remoteVersionAfter
                      ? `推送后对方 ${it.remoteVersionAfter}`
                      : (it.ok ? '推送后对方仍无版本' : '')
                    return h('div', {
                      key: `${it.filename || it.name}-${i}`,
                      style: { ...fontS, color: it.ok ? T.labelPrimary : T.danger, marginBottom: 2 },
                    },
                      `${it.ok ? '✓' : '×'} ${it.name || it.filename}@${it.localVersion || '?'} — ${human}`
                      + (before || after ? `（${[before, after].filter(Boolean).join('；')}）` : '')
                      + (it.error ? `｜${it.error}` : ''),
                    )
                  }),
                )
              }),
          ),
        )
      }

      function renderInstalledColumn() {
        if (!orderedInstalled.length) {
          return h(Empty, null, '没有非官方插件（@deepseek-ai/* 已自动排除）')
        }
        const locked = busy || runtime.restartScheduled
        return h('div', null,
          h(Toolbar, { tight: true },
            h(CheckLabel, {
              checked: orderedInstalled.every((p) => selInstalled[p.name]),
              onChange: (checked) => {
                const next = {}
                if (checked) for (const p of orderedInstalled) next[p.name] = true
                setSelInstalled(next)
              },
            }, `全选（${selectedInstalledCount}/${orderedInstalled.length}）`),
            h('button', {
              onClick: () => confirmUpload(orderedInstalled.filter((p) => selInstalled[p.name]).map((p) => p.name)),
              disabled: locked || !selectedInstalledCount,
              style: busyStyle(btn('primary'), locked || !selectedInstalledCount),
            }, selectedInstalledCount ? `入库所选 ${selectedInstalledCount}` : '入库到仓库'),
            anyNeedRestart ? h(RestartAffordance, { label: '重启以生效' }) : null,
          ),
          orderedInstalled.map((p, index) => {
            const repo = findByName(repoPkgs, p.name)
            const state = repo ? diffLocalVsOther(p.version, repo.version, { peerExists: true }) : 'missing'
            const badge = badgeFor('installed-vs-repo', state, p.version, repo && repo.version, {
              needRestart: !!p.needRestart,
              loadedVersion: p.loadedVersion,
            })
            return h(PkgCard, {
              key: p.name,
              pkg: p,
              badge,
              checked: !!selInstalled[p.name],
              onCheck: (v) => setSelInstalled((s) => ({ ...s, [p.name]: v })),
              listId: 'installed',
              index,
              dragPayload: {
                listId: 'installed', key: p.name, name: p.name, version: p.version,
              },
              onReorderDrop: (fromKey, toIndex) => {
                setOrderInstalled((prev) => reorderKeys(prev, fromKey, toIndex, orderedInstalled, (x) => x.name))
              },
              onForeignDrop: (data) => acceptForeignDrop(data, 'installed'),
              actions: h(React.Fragment, null,
                h('button', {
                  onClick: () => confirmUpload([p.name]),
                  disabled: locked,
                  style: busyStyle(btn('soft'), locked),
                  title: '打包并写入本机仓库',
                }, '入库'),
                p.needRestart ? h(RestartAffordance, { label: '重启' }) : null,
              ),
            })
          }),
        )
      }

      function tabRepo() {
        return h('div', null,
          h(Legend, { mode: 'local', showAmber: anyNeedRestart }),
          h('p', { style: { ...fontS, color: T.labelTertiary, margin: '0 0 10px' } },
            '左侧仓库 → 安装到本机；右侧已装 → 拖入左侧入库。橙标表示运行中尚未加载新版本。'),
          h('div', {
            style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'stretch' },
          },
            h(Panel, {
              title: '本机仓库',
              subtitle: `${repoPkgs.length} · 安装到 profile`,
              minHeight: '280px',
              style: { flex: '1 1 320px', minWidth: '280px' },
              dropActive: dropTarget === 'repo',
              onDragOver: (e) => onColumnDragOver(e, 'repo'),
              onDragLeave: () => setDropTarget(null),
              onDrop: (e) => onColumnDrop(e, 'repo'),
              actions: h('button', {
                onClick: refresh, disabled: busy || runtime.restartScheduled,
                style: busyStyle(btn('soft'), busy || runtime.restartScheduled),
              }, busy ? '刷新中…' : '刷新'),
            }, renderRepoColumn({ forSync: false, showInstall: true })),
            h(Panel, {
              title: '已安装',
              subtitle: `${installed.length} · 拖到左侧可入库`,
              minHeight: '280px',
              style: { flex: '1 1 320px', minWidth: '280px' },
              dropActive: dropTarget === 'installed',
              onDragOver: (e) => onColumnDragOver(e, 'installed'),
              onDragLeave: () => setDropTarget(null),
              onDrop: (e) => onColumnDrop(e, 'installed'),
            }, renderInstalledColumn()),
          ),
          h('div', { style: { height: 12 } }),
          h(Panel, { title: '手动加入 .tgz' },
            h(Toolbar, null,
              h('input', {
                type: 'text', placeholder: '包名（可选）', value: uploadName,
                onChange: (e) => setUploadName(e.target.value),
                style: { ...inputStyle, width: '180px' },
              }),
              h('label', {
                style: { ...btn('soft'), display: 'inline-flex', alignItems: 'center', cursor: 'pointer' },
              },
                '选择文件',
                h('input', {
                  type: 'file', accept: '.tgz', style: { display: 'none' },
                  onChange: (e) => {
                    const f = e.target.files && e.target.files[0]
                    if (f) manualUpload(f)
                    e.target.value = ''
                  },
                }),
              ),
            ),
          ),
        )
      }

      function tabAdvanced() {
        return h(Panel, { title: '搜索根目录' },
          h('p', { style: { ...fontS, color: T.labelTertiary, margin: '0 0 8px' } },
            '额外扫描路径。默认已包含 ~/.dsh。'),
          h(Toolbar, null,
            h('input', {
              type: 'text', placeholder: '如 D:\\0HAN\\Work\\my-plugins',
              value: newRoot, onChange: (e) => setNewRoot(e.target.value),
              style: { ...inputStyle, flex: '1 1 240px', maxWidth: '360px' },
            }),
            h('button', {
              onClick: addRoot, disabled: busy, style: busyStyle(btn('primary'), busy),
            }, '添加'),
          ),
          roots.length === 0
            ? h(Empty, null, '仅默认位置 ~/.dsh')
            : roots.map((r) => h('div', {
              key: r,
              style: {
                ...fontS, color: T.labelSecondary, padding: '6px 4px',
                borderBottom: `1px solid ${T.borderL1}`, wordBreak: 'break-all',
              },
            }, r)),
        )
      }

      return h('div', {
        style: { fontFamily: T.fontFamily, fontSize: '13px', color: T.labelPrimary, maxWidth: '960px' },
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
              `本机 ${repoPkgs.length} 包 · 已装非官方 ${installed.length}`
              + (remoteList ? ` · 已连 ${remoteList.addr}` : '')),
          ),
          h('button', {
            onClick: refresh, disabled: busy, style: busyStyle(btn('soft'), busy),
          }, busy ? '刷新中…' : '刷新'),
        ),

        h(Banner, { tone: 'error', onClose: () => setError('') }, error || null),
        h(Banner, {
          tone: messageTone || 'ok',
          onClose: () => setMessage(''),
        }, message || null),
        h(Banner, { tone: 'warn' }, restartBannerText() || null),
        h(TabBar, {
          tabs: TABS,
          active: tab === 'installed' ? 'repo' : tab,
          onChange: (id) => setTab(id),
        }),

        (tab === 'repo' || tab === 'installed') ? tabRepo() : null,
        tab === 'sync' ? tabSync() : null,
        tab === 'advanced' ? tabAdvanced() : null,

        h(ConfirmModal, {
          title: confirm && confirm.title,
          body: confirm && confirm.body,
          confirmLabel: confirm && confirm.confirmLabel,
          danger: confirm && (confirm.kind === 'push' || confirm.kind === 'install'),
          busy,
          onCancel: () => setConfirm(null),
          onConfirm: runConfirm,
        }),
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
