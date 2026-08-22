/**
 * dsh-plugin-repo — persistent plugin repository for DeepSeek Harness.
 *
 * Host-plane plugin: each DSH device runs its own plugin repository server.
 *  1. Stores non-official plugin install packages (.tgz) in a repository dir.
 *  2. Detects THIS device's installed non-official plugins (with version), and
 *     can auto-pack one into the repository (npm pack) or accept a manual .tgz
 *     upload.
 *  3. Can list ANOTHER DSH device's repository by its host:port (各设备自带服务器),
 *     download its .tgz into the local repository.
 *  4. Can install a repository .tgz into the LOCAL web profile — only after the
 *     user explicitly confirms; version-aware (newer wins, lower/equal is
 *     skipped).
 *
 * Serves under /pluginrepo on the DSH web port and registers repo_* tools.
 * Non-official = package name not starting with `@deepseek-ai/`; official
 * packages are never listed or modified. Trusted host module: uses node:fs and
 * node:child_process directly (no sandbox fencing).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  readdirSync, readFileSync, writeFileSync, copyFileSync, unlinkSync, mkdirSync,
  existsSync, statSync,
} from 'node:fs'
import { join, basename, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import {
  autoRestartEnabled,
  maybeAutoRestart,
  manualRestartHint,
  isRestartScheduled,
} from './dsh-restart.mjs'

const name = 'plugin-repo'
// schemastery: fields are optional unless `.required()` — do NOT use zod's `.optional()`.
const Config = z.object({
  repoDir: z.string(),
  port: z.number(),
  logLevel: z.union(['silent', 'info']).default('info'),
  /** Linux/macOS: auto-restart after install; Windows always shows manual hint. */
  autoRestart: z.boolean().default(true),
  restartDelayMs: z.number().default(2000),
})
const inject = ['webServer', 'tools']

const ROUTE_PREFIX = '/pluginrepo'
const MAX_BODY = 128 * 1024 * 1024
const OFFICIAL_PREFIX = '@deepseek-ai/'
const DEFAULT_REPO_DIR = join(os.homedir(), '.dsh', 'plugin-repo')

function apply(ctx, config = {}) {
  const repoDir = config.repoDir || DEFAULT_REPO_DIR
  const webServer = ctx.webServer
  const tools = ctx.tools

  const packagesDir = join(repoDir, 'packages')
  const indexFile = join(repoDir, 'index.json')

  // ---------- paths ----------

  function dshHome() {
    return process.env.DSH_HOME || join(os.homedir(), '.dsh')
  }
  function webProfileDir() {
    return join(dshHome(), 'profiles', 'web')
  }

  function ensureDirs() {
    if (!existsSync(repoDir)) mkdirSync(repoDir, { recursive: true })
    if (!existsSync(packagesDir)) mkdirSync(packagesDir, { recursive: true })
    if (!existsSync(indexFile)) writeFileSync(indexFile, '{}')
  }
  function loadIndex() {
    ensureDirs()
    try { return JSON.parse(readFileSync(indexFile, 'utf8')) }
    catch (err) { return {} }
  }
  function saveIndex(index) {
    ensureDirs()
    writeFileSync(indexFile, JSON.stringify(index, null, 2))
  }
  function isOfficial(pkgName) { return String(pkgName).startsWith(OFFICIAL_PREFIX) }
  // A real DSH plugin (bundle) declares dsh.bundle in its package.json. Plain
  // library dependencies (express, react, zod, …) hoisted into the shared
  // profiles/node_modules do NOT, so requiring it excludes them from the scan.
  function isBundle(pkg) { return !!(pkg && pkg.dsh && pkg.dsh.bundle) }

  // ---------- repo state ----------

  function listRepoPackages() {
    const index = loadIndex()
    let dirty = false
    const list = Object.keys(index).sort().map((key) => {
      const e = index[key]
      let version = e.version || ''
      if (!version || version === 'unknown') {
        const parsed = parseVersionFromFilename(e.filename || `${key}.tgz`)
        if (parsed.version) {
          version = parsed.version
          e.version = version
          if (!e.name && parsed.name) e.name = parsed.name
          dirty = true
        }
      }
      return {
        name: e.name || parsedNameFallback(key), version, filename: e.filename,
        size: e.size, uploadedAt: e.uploadedAt, official: false,
      }
    })
    if (dirty) saveIndex(index)
    return list
  }

  function parsedNameFallback(key) {
    const parsed = parseVersionFromFilename(`${key}.tgz`)
    return parsed.name || key
  }

  // ---------- version helpers ----------

  function parseVersionFromFilename(filename) {
    let base = filename
    if (base.endsWith('.tgz')) base = base.slice(0, -4)
    // name-1.2.3 / name-1.2.3-rc.1 / name-1.2.3+build
    const m = /^(.*)-(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.+-]*)?)$/.exec(base)
    return m ? { name: m[1], version: m[2] } : { name: base, version: '' }
  }

  /** Semver compare that understands -rc.N prereleases. Returns -1/0/1 or null. */
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

  function isNewer(a, b) {
    const cmp = compareVersions(a, b)
    return cmp === 1
  }

  // ---------- non-official plugin detection (standard + custom roots) ----------

  function searchRootsFile() { return join(repoDir, 'search-roots.json') }

  function loadSearchRoots() {
    try {
      const f = searchRootsFile()
      if (!existsSync(f)) return []
      const data = JSON.parse(readFileSync(f, 'utf8'))
      return (data && Array.isArray(data.roots)) ? data.roots.filter((r) => typeof r === 'string') : []
    } catch (err) { return [] }
  }

  function saveSearchRoots(roots) {
    ensureDirs()
    writeFileSync(searchRootsFile(), JSON.stringify({ roots }, null, 2))
  }

  // Default roots: profiles' node_modules and the plugins directory itself.
  function defaultRoots() {
    const roots = []
    const home = dshHome()
    try {
      const profiles = join(home, 'profiles')
      if (existsSync(profiles)) {
        roots.push(join(profiles, 'node_modules'))
        for (const p of readdirSync(profiles)) {
          const nm = join(profiles, p, 'node_modules')
          if (existsSync(nm)) roots.push(nm)
        }
      }
      const plugins = join(home, 'plugins')
      if (existsSync(plugins)) roots.push(plugins)
    } catch (err) { /* best effort */ }
    return roots
  }

  function allSearchRoots() {
    const seen = new Set()
    const roots = []
    for (const r of [...defaultRoots(), ...loadSearchRoots()]) {
      const norm = r
      if (!norm || seen.has(norm)) continue
      seen.add(norm)
      roots.push(norm)
    }
    return roots
  }

  // Bounded recursive scan under a root: any directory holding a
  // non-official package.json is a plugin dir. Skips node_modules/.git/.pnpm.
  const SKIP_DIRS = new Set(['node_modules', '.git', '.pnpm', '.hg', '.svn'])

  function collectPluginsUnder(root, found, depth) {
    if (depth < 0) return
    let entries
    try { entries = readdirSync(root) } catch (err) { return }
    for (const nameEntry of entries) {
      if (nameEntry.startsWith('.')) continue
      if (SKIP_DIRS.has(nameEntry)) continue
      const abs = join(root, nameEntry)
      try {
        if (!statSync(abs).isDirectory()) continue
        const pj = join(abs, 'package.json')
        if (existsSync(pj)) {
          try {
            const pkg = JSON.parse(readFileSync(pj, 'utf8'))
            if (pkg.name && !isOfficial(pkg.name) && isBundle(pkg) && !found.has(pkg.name)) {
              found.set(pkg.name, { name: pkg.name, version: pkg.version || '', dir: abs })
            }
            // a plugin dir can itself nest other plugins; keep descending
          } catch (err) { /* bad package.json; descend anyway */ }
        }
        collectPluginsUnder(abs, found, depth - 1)
      } catch (err) { /* best effort */ }
    }
  }

  function tryAddInstalledPkg(abs, found) {
    try {
      if (!statSync(abs).isDirectory()) return
      const pj = join(abs, 'package.json')
      if (!existsSync(pj)) return
      const pkg = JSON.parse(readFileSync(pj, 'utf8'))
      if (!pkg.name || isOfficial(pkg.name) || !isBundle(pkg)) return
      if (!found.has(pkg.name)) {
        found.set(pkg.name, { name: pkg.name, version: pkg.version || '', dir: abs })
      }
    } catch (err) { /* best effort */ }
  }

  function scanInstalledNonOfficial() {
    const found = new Map()
    for (const root of allSearchRoots()) {
      // Direct children of a node_modules-style root (no deep recurse needed
      // for installed bundles), but custom roots recurse with a depth cap.
      if (root.endsWith('node_modules')) {
        let entries
        try { entries = readdirSync(root) } catch (err) { continue }
        for (const entry of entries) {
          if (entry.startsWith('.') || entry === '.pnpm') continue
          // Official scope: never list or modify.
          if (entry === '@deepseek-ai') continue
          const abs = join(root, entry)
          try {
            if (!statSync(abs).isDirectory()) continue
            // Scoped packages live under node_modules/@scope/name
            if (entry.startsWith('@')) {
              let scoped
              try { scoped = readdirSync(abs) } catch (e) { continue }
              for (const name of scoped) {
                if (name.startsWith('.')) continue
                tryAddInstalledPkg(join(abs, name), found)
              }
            } else {
              tryAddInstalledPkg(abs, found)
            }
          } catch (err) { /* best effort */ }
        }
      } else {
        collectPluginsUnder(root, found, 6)
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  // Versions present on disk when this process loaded the plugin. Disk can
  // change after "install to profile" while in-memory modules stay old.
  const diskVersionAtBoot = new Map()
  for (const p of scanInstalledNonOfficial()) {
    diskVersionAtBoot.set(p.name, String(p.version || ''))
  }
  // Names successfully installed in this process — always needRestart until exit.
  const pendingRestart = new Set()

  function packageNeedsRestart(name, diskVersion) {
    if (pendingRestart.has(name)) return true
    const disk = String(diskVersion || '')
    if (!diskVersionAtBoot.has(name)) return true
    return String(diskVersionAtBoot.get(name) || '') !== disk
  }

  function listInstalledWithRuntime() {
    return scanInstalledNonOfficial().map((p) => {
      const loadedVersion = diskVersionAtBoot.has(p.name) ? diskVersionAtBoot.get(p.name) : null
      return {
        ...p,
        loadedVersion,
        needRestart: packageNeedsRestart(p.name, p.version),
      }
    })
  }

  function runtimeMeta() {
    return {
      platform: process.platform,
      autoRestart: autoRestartEnabled(config),
      restartHint: manualRestartHint(),
      restartScheduled: isRestartScheduled(),
    }
  }

  function installedVersionOf(pkgName) {
    const f = scanInstalledNonOfficial().find((p) => p.name === pkgName)
    return f ? f.version : ''
  }

  // ---------- auto-pack an installed plugin into the repo ----------

  // Keep only ONE .tgz per plugin name: remove every other index entry (and its
  // file) whose resolved name matches the kept entry's name, so re-packing a
  // newer version replaces older ones instead of accumulating name-<v1>, ...
  function dedupeByName(index, keepKey) {
    const kept = index[keepKey]
    if (!kept) return
    const keptName = kept.name || keepKey
    for (const key of Object.keys(index)) {
      const entry = index[key]
      if (key === keepKey) continue
      if (entry && (entry.name || key) === keptName) {
        try {
          const f = join(packagesDir, entry.filename)
          if (existsSync(f)) unlinkSync(f)
        } catch (e) { /* already gone */ }
        delete index[key]
      }
    }
  }

  function packInstalled(pkgName) {
    const found = scanInstalledNonOfficial().find((p) => p.name === pkgName)
    if (!found) throw new Error(`installed non-official plugin "${pkgName}" not found`)
    ensureDirs()
    const r = spawnSync('npm', ['pack', found.dir, '--pack-destination', packagesDir], {
      encoding: 'utf8', shell: process.platform === 'win32',
    })
    const stdout = (r.stdout || '') + (r.stderr || '')
    const match = /([^\s]+\.tgz)/.exec(stdout)
    if (r.status !== 0 || !match) {
      throw new Error(`npm pack failed for "${pkgName}": ${stdout || String(r.error || '') || 'unknown'}`)
    }
    const filename = basename(match[1])
    const parsed = parseVersionFromFilename(filename)
    const key = filename.replace(/\.tgz$/, '')
    const file = join(packagesDir, filename)
    const size = existsSync(file) ? readFileSync(file).length : 0
    const index = loadIndex()
    index[key] = {
      name: parsed.name || key, version: parsed.version || found.version,
      filename, size, uploadedAt: new Date().toISOString(),
    }
    // Replace any older/newer .tgz already in the repo under the same plugin name.
    dedupeByName(index, key)
    saveIndex(index)
    return { name: index[key].name, version: index[key].version, filename, size }
  }

  function saveRawTgz(buf, filename, nameOverride) {
    filename = basename(filename)
    if (!filename.endsWith('.tgz')) filename += '.tgz'
    const key = filename.replace(/\.tgz$/, '')
    const parsed = parseVersionFromFilename(filename)
    ensureDirs()
    writeFileSync(join(packagesDir, filename), buf)
    const index = loadIndex()
    const name = (nameOverride && String(nameOverride).trim()) || parsed.name || key
    const version = parsed.version || ''
    index[key] = {
      name, version,
      filename, size: buf.length, uploadedAt: new Date().toISOString(),
    }
    // Same name? keep only this one (replace older manual/remote pulls by name).
    dedupeByName(index, key)
    saveIndex(index)
    return { name: index[key].name, version: index[key].version, filename, size: buf.length }
  }

  function repoFile(filename) { return join(packagesDir, basename(filename)) }

  // ---------- remote device (another DSH's repo) ----------

  async function listRemoteRepo(rawHost, rawPort) {
    const base = remoteBase(rawHost, rawPort)
    const res = await fetch(`${base}/api/packages`)
    if (!res.ok) throw new Error(`remote ${base}/api/packages -> HTTP ${res.status}`)
    const data = await res.json()
    return (data && Array.isArray(data.packages)) ? data.packages : []
  }

  // Normalize a remote target into a base URL. Accepts:
  //   - a bare IP/hostname ("192.168.1.10", "dsh.example.com") → http:3080
  //   - an IP/hostname + :port ("192.168.1.10:3080", "dsh.example.com:8443")
  //   - a full URL ("https://dsh.example.com", "http://1.2.3.4:9000") — explicit scheme wins
  // Default port follows the scheme: http → 3080 (DSH's own web carrier),
  // https → 443 (public reverse-proxy face). Explicit :port always wins.
  function remoteBase(rawHost, rawPort) {
    let host = String(rawHost || '').trim()
    if (!host) throw new Error('远程地址不能为空')
    let port = rawPort ? String(rawPort).trim() : ''
    let scheme = ''
    const schemeMatch = /^(https?):\/\/(.+)$/i.exec(host)
    if (schemeMatch) { scheme = schemeMatch[1].toLowerCase(); host = schemeMatch[2] }
    const hostPortMatch = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(host)
    if (hostPortMatch) { host = hostPortMatch[1]; port = hostPortMatch[2] }
    host = host.replace(/\/.*$/, '')
    if (!host) throw new Error('远程地址无效')
    if (!scheme) scheme = 'http'
    if (!port) port = scheme === 'https' ? '443' : '3080'
    return `${scheme}://${host}:${port}${ROUTE_PREFIX}`
  }

  async function fetchRemoteTgz(rawHost, rawPort, filename) {
    const base = remoteBase(rawHost, rawPort)
    const url = `${base}/download/${encodeURIComponent(basename(filename))}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`remote download -> HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  /** Push one local-repo .tgz to another device's /pluginrepo/api/upload. */
  async function pushTgzToRemote(rawHost, rawPort, filename, remoteBefore) {
    filename = basename(filename)
    const file = repoFile(filename)
    if (!existsSync(file)) throw new Error(`本机仓库没有 "${filename}"`)
    const buf = readFileSync(file)
    const parsed = parseVersionFromFilename(filename)
    const localMeta = (() => {
      const index = loadIndex()
      const key = filename.replace(/\.tgz$/, '')
      return index[key] || null
    })()
    const localName = (localMeta && localMeta.name) || parsed.name || filename
    const localVersion = (localMeta && localMeta.version) || parsed.version || ''
    const base = remoteBase(rawHost, rawPort)
    // Prefer Content-Disposition with the versioned .tgz name.
    // ?name= is only a package-name hint — never rewrite filename to name.tgz
    // (that used to strip versions and make the remote show "unknown").
    const qs = localName ? `?name=${encodeURIComponent(localName)}` : ''
    const res = await fetch(`${base}/api/upload${qs}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      },
      body: buf,
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { /* non-json */ }
    if (!res.ok) throw new Error((data && data.error) || `remote upload -> HTTP ${res.status}: ${text.slice(0, 200)}`)
    const remoteVersionAfter = (data && data.version) || parsed.version || ''
    const remoteVersionBefore = remoteBefore && remoteBefore.version != null
      ? String(remoteBefore.version)
      : (remoteBefore ? '' : null)
    const note = classifyPushNote({
      remoteExisted: !!remoteBefore,
      remoteVersionBefore,
      remoteVersionAfter,
      localVersion,
    })
    return {
      filename,
      name: (data && data.name) || localName,
      version: remoteVersionAfter || localVersion,
      localVersion,
      remoteVersionBefore: remoteVersionBefore == null ? null : remoteVersionBefore,
      remoteVersionAfter,
      size: (data && data.size) || buf.length,
      remote: base,
      note,
    }
  }

  function blankVer(v) {
    if (v == null) return true
    const s = String(v).trim()
    return !s || s === '?' || s.toLowerCase() === 'unknown'
  }

  function classifyPushNote(info) {
    const { remoteExisted, remoteVersionBefore, remoteVersionAfter, localVersion } = info
    const beforeBlank = blankVer(remoteVersionBefore)
    const afterBlank = blankVer(remoteVersionAfter)
    const localBlank = blankVer(localVersion)
    if (!remoteExisted) {
      if (afterBlank && !localBlank) {
        return 'pushed_new_but_remote_version_blank：对方新建了包，但返回/登记版本为空（对方插件可能过旧或未解析文件名）'
      }
      return afterBlank
        ? 'pushed_new：对方原先没有该包；版本仍不清楚'
        : `pushed_new：对方原先没有 → 现为 ${remoteVersionAfter}`
    }
    if (beforeBlank && afterBlank) {
      return 'remote_was_and_still_unknown：对方推送前就是版本未知；本次已推送，但对方元数据仍无版本（不是“跳过”，是对方未解析出版本）'
    }
    if (beforeBlank && !afterBlank) {
      return `fixed_unknown：对方推送前版本未知 → 现为 ${remoteVersionAfter}`
    }
    if (!beforeBlank && afterBlank) {
      return `pushed_but_remote_lost_version：推送前对方是 ${remoteVersionBefore}，推送后对方变成未知（上传侧可能剥掉了版本文件名）`
    }
    if (String(remoteVersionAfter) === String(localVersion)) {
      return `pushed_ok：对方 ${remoteVersionBefore || '?'} → ${remoteVersionAfter}`
    }
    return `pushed：对方 ${remoteVersionBefore || '?'} → ${remoteVersionAfter || '?'}`
  }

  const PUSH_HISTORY_MAX = 40

  function pushHistoryFile() { return join(repoDir, 'push-history.json') }

  function loadPushHistory() {
    try {
      if (!existsSync(pushHistoryFile())) return []
      const data = JSON.parse(readFileSync(pushHistoryFile(), 'utf8'))
      return Array.isArray(data) ? data : (Array.isArray(data.entries) ? data.entries : [])
    } catch {
      return []
    }
  }

  function savePushHistory(entries) {
    ensureDirs()
    writeFileSync(pushHistoryFile(), JSON.stringify({ entries }, null, 2), 'utf8')
  }

  function appendPushHistory(entry) {
    const list = loadPushHistory()
    list.unshift(entry)
    savePushHistory(list.slice(0, PUSH_HISTORY_MAX))
    return list.slice(0, PUSH_HISTORY_MAX)
  }

  async function pushManyToRemote(host, port, files) {
    let remotePkgs = []
    try { remotePkgs = await listRemoteRepo(host, port) } catch { remotePkgs = [] }
    const findRemote = (name) => (remotePkgs || []).find((p) => p.name === name) || null
    const pushed = []
    for (const filename of files) {
      try {
        const key = basename(filename).replace(/\.tgz$/, '')
        const local = loadIndex()[key]
        const parsed = parseVersionFromFilename(filename)
        const localName = (local && local.name) || parsed.name || key
        const before = findRemote(localName)
        pushed.push({ ok: true, ...await pushTgzToRemote(host, port, filename, before) })
      } catch (err) {
        pushed.push({
          ok: false, filename, error: String((err && err.message) || err),
          note: 'failed：未推送到对方（不是跳过）',
        })
      }
    }
    const historyEntry = {
      at: new Date().toISOString(),
      remoteHost: host,
      okCount: pushed.filter((x) => x.ok).length,
      failCount: pushed.filter((x) => !x.ok).length,
      items: pushed.map((x) => ({
        ok: !!x.ok,
        filename: x.filename,
        name: x.name || null,
        localVersion: x.localVersion || null,
        remoteVersionBefore: x.remoteVersionBefore != null ? x.remoteVersionBefore : null,
        remoteVersionAfter: x.remoteVersionAfter != null ? x.remoteVersionAfter : (x.version || null),
        note: x.note || (x.ok ? 'pushed' : 'failed'),
        error: x.error || null,
      })),
    }
    appendPushHistory(historyEntry)
    return { pushed, history: historyEntry }
  }

  // ---------- install from repo into local profile (confirm-gated) ----------

  function planInstall(filename) {
    filename = basename(String(filename || ''))
    if (!filename || !filename.endsWith('.tgz')) {
      throw new Error(`invalid package filename "${filename}"`)
    }
    const file = repoFile(filename)
    if (!existsSync(file)) throw new Error(`package "${filename}" not in repository`)
    const index = loadIndex()
    const key = filename.replace(/\.tgz$/, '')
    const meta = index[key]
    const parsed = parseVersionFromFilename(filename)
    const candidateVersion = (meta && meta.version && meta.version !== 'unknown')
      ? meta.version
      : (parsed.version || '')
    const candidateName = (meta && meta.name) || parsed.name || key
    if (!candidateVersion) {
      return {
        filename, name: candidateName, version: '',
        installedVersion: installedVersionOf(candidateName) || null,
        skip: true, skipReason: `无法解析 ${filename} 的版本号`,
        wouldAddBundle: candidateName, actions: [],
      }
    }
    const installedVersion = installedVersionOf(candidateName)
    let skip = false, skipReason = ''
    if (installedVersion && (installedVersion === candidateVersion || !isNewer(candidateVersion, installedVersion))) {
      skip = true
      skipReason = `已安装 ${candidateName}@${installedVersion}，无需升级到 ${candidateVersion}`
    }
    return {
      filename, name: candidateName, version: candidateVersion,
      installedVersion: installedVersion || null, skip, skipReason,
      wouldAddBundle: candidateName,
      actions: [
        `复制 ${filename} 到 ~/.dsh/plugins/`,
        `以 file: 依赖安装（禁止 link:.tgz；优先 dsh plugin add）`,
        `校验 node_modules/<name> 含 dsh.bundle（下次重启生效）`,
      ],
    }
  }

  function doInstall(filename) {
    filename = basename(String(filename || ''))
    const plan = planInstall(filename)
    if (plan.skip) return { ok: false, skipped: true, reason: plan.skipReason, ...plan }
    const profile = webProfileDir()
    const src = repoFile(filename)
    const pluginsHome = join(dshHome(), 'plugins')
    if (!existsSync(pluginsHome)) mkdirSync(pluginsHome, { recursive: true })
    const dest = join(pluginsHome, filename)
    copyFileSync(src, dest)
    // Portable file: URL (forward slashes). NEVER use link: to a .tgz — that
    // leaves the package unresolved / breaks createRequire for @deepseek-ai/*.
    const fileSpec = `file:${dest.replace(/\\/g, '/')}`

    // Prefer the official DSH plugin installer when the running process is a
    // source checkout (`node … apps/cli/src/bin.ts`), otherwise fall back to
    // editing profile package.json + pnpm install.
    let method = 'pnpm-file'
    let output = ''
    let ok = false
    const harnessBin = detectHarnessCli()
    if (harnessBin) {
      method = 'dsh-plugin-add'
      const r = spawnSync(harnessBin.node, [...harnessBin.argsPrefix, 'plugin', '--profile', 'web', 'add', dest], {
        cwd: harnessBin.cwd,
        encoding: 'utf8',
        shell: false,
        env: process.env,
      })
      output = ((r.stdout || '') + (r.stderr || '')).slice(0, 1200)
      ok = r.status === 0
    }
    if (!ok) {
      method = harnessBin ? 'pnpm-file-fallback' : 'pnpm-file'
      const pjPath = join(profile, 'package.json')
      const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
      const bundles = pj.dsh?.profile?.bundles || []
      if (!bundles.includes(plan.name)) bundles.push(plan.name)
      if (!pj.dsh) pj.dsh = { profile: { bundles } }
      else if (!pj.dsh.profile) pj.dsh.profile = { bundles }
      else pj.dsh.profile.bundles = bundles
      const deps = pj.dependencies || {}
      // Rewrite any previous broken link:…tgz entries for this package.
      deps[plan.name] = fileSpec
      pj.dependencies = deps
      writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n')
      const r = spawnSync('pnpm', ['install'], {
        cwd: profile,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        env: process.env,
      })
      output = ((r.stdout || '') + (r.stderr || '')).slice(0, 1200)
      ok = r.status === 0
    }

    // Verify the package actually landed and declares a DSH bundle.
    const installedPkg = join(profile, 'node_modules', plan.name, 'package.json')
    let verified = false
    let verifyError = ''
    try {
      if (!existsSync(installedPkg)) throw new Error(`missing ${installedPkg}`)
      const pkg = JSON.parse(readFileSync(installedPkg, 'utf8'))
      if (!pkg?.dsh?.bundle) throw new Error(`package "${plan.name}" has no dsh.bundle declaration`)
      verified = true
    } catch (err) {
      verifyError = String((err && err.message) || err)
      ok = false
    }
    if (ok) pendingRestart.add(plan.name)
    return {
      ok, skipped: false, verified, verifyError, method, fileSpec,
      ...plan, dest, profile, output,
      needRestart: ok || packageNeedsRestart(plan.name, plan.version),
    }
  }

  /** After at least one successful profile install: Windows → hint; Linux → auto-restart. */
  function afterInstallRestart(okInstallCount) {
    if (!okInstallCount) {
      return {
        needRestart: false,
        restartScheduled: isRestartScheduled(),
        autoRestart: autoRestartEnabled(config),
        platform: process.platform,
        restartMessage: '',
      }
    }
    const r = maybeAutoRestart('plugin-repo-install', config)
    return {
      needRestart: true,
      restartScheduled: !!r.restartScheduled || isRestartScheduled(),
      autoRestart: autoRestartEnabled(config),
      platform: process.platform,
      restartMessage: r.message || r.error || manualRestartHint(),
    }
  }

  /** Detect a live deepseek-harness CLI invocation we can reuse for `plugin add`. */
  function detectHarnessCli() {
    try {
      const argv = process.argv.map(String)
      const node = argv[0] || process.execPath
      for (let i = 1; i < argv.length; i++) {
        const raw = argv[i]
        const norm = raw.replace(/\\/g, '/')
        for (const marker of ['/apps/cli/src/bin.ts', '/apps/cli/lib/bin.js']) {
          const at = norm.indexOf(marker)
          if (at > 0) {
            return {
              node,
              cwd: norm.slice(0, at),
              argsPrefix: argv.slice(1, i + 1),
            }
          }
        }
      }
      // Fallback: cwd itself is a harness checkout.
      const here = process.cwd().replace(/\\/g, '/')
      if (existsSync(join(process.cwd(), 'apps', 'cli', 'src', 'bin.ts'))) {
        return {
          node: process.execPath,
          cwd: process.cwd(),
          argsPrefix: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts'],
        }
      }
      void here
      void dirname
    } catch { /* ignore */ }
    return null
  }

  // ---------- HTTP helpers ----------

  function json(res, code, payload) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }
  function pathnameOf(raw) {
    let p = raw || '/'
    const q = p.indexOf('?'); if (q !== -1) p = p.slice(0, q)
    const h = p.indexOf('#'); if (h !== -1) p = p.slice(0, h)
    return p
  }
  function queryOf(raw) {
    const q = (raw || '').indexOf('?')
    return q === -1 ? null : new URLSearchParams((raw || '').slice(q + 1))
  }
  function readBodyBuf(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY) { reject(new Error('request body too large')); req.destroy(); return }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  // ---------- route dispatch ----------

  async function dispatch(req, res) {
    const pathname = pathnameOf(req.url)
    if (pathname !== ROUTE_PREFIX && !pathname.startsWith(`${ROUTE_PREFIX}/`)) {
      json(res, 404, { ok: false, error: 'not found' }); return
    }
    const rest = pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '')
    const method = req.method
    try {
      if (method === 'GET' && rest === '') {
        const all = scanInstalledNonOfficial()
        const repo = listRepoPackages()
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>DSH Plugin Repository</title></head><body>`
          + `<h1>DSH 插件仓库</h1>`
          + `<p>本机即服务器。非官方插件（排除 @deepseek-ai/*）可上传、下载、跨设备拉取。</p>`
          + `<h2>仓库 .tgz (${repo.length})</h2><ul>${repo.map((p) => `<li>${p.name}@${p.version} (${p.size} B) <a href="${ROUTE_PREFIX}/download/${encodeURIComponent(p.filename)}">下载</a></li>`).join('') || '<li><em>空</em></li>'}</ul>`
          + `<h2>本机已装非官方插件 (${all.length})</h2><ul>${all.map((p) => `<li>${p.name}@${p.version}</li>`).join('') || '<li><em>无</em></li>'}</ul>`
          + `</body></html>`)
        return
      }

      if (rest === '/api/packages' && method === 'GET') {
        const packages = listRepoPackages()
        json(res, 200, { ok: true, count: packages.length, packages }); return
      }

      if (rest === '/api/installed' && method === 'GET') {
        json(res, 200, {
          ok: true,
          installed: listInstalledWithRuntime(),
          roots: allSearchRoots(),
          ...runtimeMeta(),
        }); return
      }

      if (rest === '/api/unofficial' && method === 'GET') {
        json(res, 200, {
          ok: true,
          installed: listInstalledWithRuntime(),
          repo: listRepoPackages(),
          roots: allSearchRoots(),
          ...runtimeMeta(),
        }); return
      }

      // Manual restart (Linux/macOS auto; Windows returns hint only).
      if (rest === '/api/restart' && method === 'POST') {
        const r = maybeAutoRestart('plugin-repo-manual', config)
        const scheduled = !!r.restartScheduled || isRestartScheduled()
        json(res, 200, {
          ok: !!r.ok || !!r.skipped || scheduled,
          ...runtimeMeta(),
          restartScheduled: scheduled,
          needRestart: !scheduled,
          message: r.message || r.error || manualRestartHint(),
        }); return
      }

      // search roots: GET /api/roots (list) | POST /api/roots?path= (add)
      if (rest === '/api/roots') {
        const q = queryOf(req.url)
        if (method === 'GET') {
          json(res, 200, { ok: true, roots: allSearchRoots(), custom: loadSearchRoots() }); return
        }
        if (method === 'POST') {
          const path = q ? q.get('path') : null
          if (!path) { json(res, 400, { ok: false, error: '?path=<dir> required' }); return }
          const custom = loadSearchRoots()
          if (!custom.includes(path)) custom.push(path)
          saveSearchRoots(custom)
          json(res, 200, { ok: true, custom, roots: allSearchRoots() }); return
        }
      }

      // auto-pack an installed plugin: POST /api/pack-upload?name=<pkgName>
      if (rest === '/api/pack-upload' && method === 'POST') {
        const q = queryOf(req.url)
        const pkgName = q ? q.get('name') : null
        if (!pkgName) { json(res, 400, { ok: false, error: '?name=<installed pkg name> required' }); return }
        const out = packInstalled(pkgName)
        json(res, 200, { ok: true, ...out }); return
      }

      // bulk auto-pack installed plugins: POST /api/pack-upload-all { names: [...] }
      // (empty names → pack all detected non-official plugins)
      if (rest === '/api/pack-upload-all' && method === 'POST') {
        const body = await readBodyBuf(req)
        let input = {}
        try { input = JSON.parse(body.toString('utf8')) } catch (e) { input = {} }
        let names = Array.isArray(input.names) ? input.names : []
        if (names.length === 0) names = scanInstalledNonOfficial().map((p) => p.name)
        const packed = []
        for (const name of names) {
          try { packed.push({ ok: true, ...packInstalled(name) }) }
          catch (err) { packed.push({ ok: false, name, error: String((err && err.message) || err) }) }
        }
        json(res, 200, { ok: true, packed }); return
      }

      // raw .tgz upload: POST /api/upload (body = tgz)
      // Content-Disposition filename keeps versioned names (e.g. pkg-1.2.3.tgz).
      // ?name= is an optional package-name override only — never the .tgz basename.
      if (rest === '/api/upload' && method === 'POST') {
        const buf = await readBodyBuf(req)
        if (buf.length === 0) { json(res, 400, { ok: false, error: 'empty body' }); return }
        const q = queryOf(req.url)
        const nameHint = q && q.get('name')
        let filename = null
        const cd = req.headers['content-disposition'] || ''
        const mQuoted = /filename="([^"]+)"/i.exec(cd)
        const mBare = /filename=([^;\s]+)/i.exec(cd)
        if (mQuoted) filename = mQuoted[1]
        else if (mBare) {
          try { filename = decodeURIComponent(mBare[1]) } catch { filename = mBare[1] }
        }
        if (!filename && nameHint) {
          // Legacy clients that only send ?name= without disposition: keep as last resort
          filename = `${nameHint}.tgz`
        }
        if (!filename) filename = `package-${Date.now()}.tgz`
        const out = saveRawTgz(buf, filename, nameHint || undefined)
        json(res, 200, { ok: true, ...out }); return
      }

      // download: GET /download/<filename>.tgz
      if (rest.startsWith('/download/') && method === 'GET') {
        const filename = basename(decodeURIComponent(rest.slice('/download/'.length)))
        const file = repoFile(filename)
        if (!existsSync(file)) { json(res, 404, { ok: false, error: `package "${filename}" not found` }); return }
        const buf = readFileSync(file)
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`, 'Content-Length': buf.length })
        res.end(buf); return
      }

      // remote device listing: GET /api/remote?host=<ip>&port=<p>
      if (rest === '/api/remote' && method === 'GET') {
        const q = queryOf(req.url)
        const host = q ? q.get('host') || q.get('ip') : null
        if (!host) { json(res, 400, { ok: false, error: '?host=<ip> required' }); return }
        const port = q ? (q.get('port') || '') : ''
        const packages = await listRemoteRepo(host, port)
        json(res, 200, { ok: true, host, port, count: packages.length, packages }); return
      }

      // remote download + save to local repo: POST /api/remote-pull { host, port, filename }
      if (rest === '/api/remote-pull' && method === 'POST') {
        const q = queryOf(req.url)
        const body = await readBodyBuf(req)
        let input = {}
        try { input = JSON.parse(body.toString('utf8')) } catch (e) { input = {} }
        const host = input.host || (q ? q.get('host') || q.get('ip') : null)
        if (!host || !(input.filenames || input.filename)) {
          json(res, 400, { ok: false, error: 'host and filenames (or filename) required' }); return
        }
        const port = input.port || ''
        const files = Array.isArray(input.filenames)
          ? input.filenames
          : [input.filename || (q ? q.get('filename') : null)].filter(Boolean)
        const pulled = []
        for (const filename of files) {
          try {
            const buf = await fetchRemoteTgz(host, port, filename)
            pulled.push({ ok: true, ...saveRawTgz(buf, filename) })
          } catch (err) {
            pulled.push({ ok: false, filename, error: String((err && err.message) || err) })
          }
        }
        json(res, 200, { ok: true, remoteHost: host, pulled }); return
      }

      // push local-repo .tgz to remote device: POST /api/remote-push { host, port?, filenames }
      if (rest === '/api/remote-push' && method === 'POST') {
        const body = await readBodyBuf(req)
        let input = {}
        try { input = JSON.parse(body.toString('utf8')) } catch (e) { input = {} }
        const host = input.host || null
        if (!host || !(input.filenames || input.filename)) {
          json(res, 400, { ok: false, error: 'host and filenames (or filename) required' }); return
        }
        const port = input.port || ''
        const files = Array.isArray(input.filenames)
          ? input.filenames
          : [input.filename].filter(Boolean)
        const { pushed, history } = await pushManyToRemote(host, port, files)
        json(res, 200, { ok: true, remoteHost: host, pushed, history }); return
      }

      // recent push log (persisted under repoDir/push-history.json)
      if (rest === '/api/push-history' && method === 'GET') {
        json(res, 200, { ok: true, entries: loadPushHistory() }); return
      }
      if (rest === '/api/push-history' && method === 'DELETE') {
        savePushHistory([])
        json(res, 200, { ok: true, entries: [] }); return
      }

      // install from repo into local profile: POST /api/install { filename, confirm? }
      if (rest === '/api/install' && method === 'POST') {
        const body = await readBodyBuf(req)
        let input = {}
        try { input = JSON.parse(body.toString('utf8')) } catch (e) { input = {} }
        const filename = input.filename
        if (!filename) { json(res, 400, { ok: false, error: 'filename required' }); return }
        try {
          if (!input.confirm) {
            json(res, 200, { ok: true, needConfirm: true, ...planInstall(filename) }); return
          }
          const out = doInstall(filename)
          const restart = afterInstallRestart(out.ok && !out.skipped ? 1 : 0)
          json(res, 200, { ok: true, needConfirm: false, ...out, ...restart }); return
        } catch (err) {
          const msg = String((err && err.message) || err)
          const code = /not in repository|invalid package filename/i.test(msg) ? 404 : 400
          json(res, code, { ok: false, error: msg }); return
        }
      }

      // bulk install from repo into local profile: POST /api/install-all { filenames, confirm }
      // (confirm must be true; each entry installs independently and reports result)
      if (rest === '/api/install-all' && method === 'POST') {
        const body = await readBodyBuf(req)
        let input = {}
        try { input = JSON.parse(body.toString('utf8')) } catch (e) { input = {} }
        const files = Array.isArray(input.filenames) ? input.filenames : []
        if (files.length === 0) { json(res, 400, { ok: false, error: 'filenames required' }); return }
        if (!input.confirm) {
          json(res, 200, {
            ok: true,
            needConfirm: true,
            filenames: files.map((f) => basename(String(f || ''))),
            plans: files.map((f) => {
              try { return planInstall(f) }
              catch (err) {
                return { filename: basename(String(f || '')), skip: true, skipReason: String((err && err.message) || err) }
              }
            }),
          }); return
        }
        const installed = []
        for (const filename of files) {
          try {
            const out = doInstall(filename)
            installed.push({ ok: !!out.ok, ...out })
          } catch (err) {
            installed.push({ ok: false, filename: basename(String(filename || '')), error: String((err && err.message) || err) })
          }
        }
        const okCount = installed.filter((x) => x.ok && !x.skipped).length
        const restart = afterInstallRestart(okCount)
        json(res, 200, { ok: true, needConfirm: false, installed, ...restart }); return
      }

      // delete: DELETE /api/packages/<key>
      const dm = /^\/api\/packages\/(.+)$/.exec(rest)
      if (dm && method === 'DELETE') {
        const key = decodeURIComponent(dm[1])
        const index = loadIndex()
        if (!index[key]) { json(res, 404, { ok: false, error: `package "${key}" not found` }); return }
        const filename = index[key].filename
        delete index[key]; saveIndex(index)
        try { const f = join(packagesDir, filename); if (existsSync(f)) unlinkSync(f) } catch (err) { /* gone */ }
        json(res, 200, { ok: true, name: key }); return
      }

      json(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      json(res, 500, { ok: false, error: String((err && err.message) || err) })
    }
  }

  ctx.effect(() => webServer.register({
    kind: 'prefix', path: ROUTE_PREFIX,
    handler: (req, res) => dispatch(req, res).catch((err) => {
      try { if (!res.headersSent) json(res, 500, { ok: false, error: String((err && err.message) || err) }); else res.destroy() }
      catch (e) { /* best effort */ }
    }),
  }), 'plugin-repo: route')

  // ---------- model tools ----------

  ctx.effect(() => tools.register(defineTool({
    name: 'repo_list',
    description: 'List the .tgz plugin packages hosted in this device\'s DSH plugin repository.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, count: { type: 'integer', required: true }, packages: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, version: { type: 'string' }, filename: { type: 'string', required: true }, size: { type: 'integer' } } } }, error: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute() { const packages = listRepoPackages(); return { ok: true, count: packages.length, packages } },
  })), 'plugin-repo: repo_list tool')

  ctx.effect(() => tools.register(defineTool({
    name: 'repo_installed',
    description: 'List the non-official plugins installed on THIS device (excludes @deepseek-ai/*) with their versions and source directories.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, installed: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, version: { type: 'string' }, dir: { type: 'string' } } } }, error: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute() { return { ok: true, installed: listInstalledWithRuntime(), ...runtimeMeta() } },
  })), 'plugin-repo: repo_installed tool')

  ctx.effect(() => tools.register(defineTool({
    name: 'repo_unofficial',
    description: 'Detect non-official plugins: installed on this device plus .tgz in the repository.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, installed: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, version: { type: 'string' }, dir: { type: 'string' } } } }, repo: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, version: { type: 'string' }, filename: { type: 'string', required: true }, size: { type: 'integer' } } } }, error: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute() {
      return { ok: true, installed: listInstalledWithRuntime(), repo: listRepoPackages(), ...runtimeMeta() }
    },
  })), 'plugin-repo: repo_unofficial tool')

  ctx.effect(() => tools.register(defineTool({
    name: 'repo_push',
    description: 'Upload a .tgz into this device\'s repository. Pass sourcePath (a local .tgz file) OR name (a non-official plugin installed on this device, which is auto-packed via npm pack).',
    parameters: { sourcePath: { type: 'string', description: 'Absolute local path of a .tgz plugin package to upload.' }, name: { type: 'string', description: 'Installed non-official plugin name to auto-pack and upload.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, name: { type: 'string' }, version: { type: 'string' }, filename: { type: 'string' }, size: { type: 'integer' }, error: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args) {
      try {
        if (args.name) { const out = packInstalled(args.name); return { ok: true, ...out } }
        const p = args.sourcePath
        if (!p || !existsSync(p)) return { ok: false, error: 'provide sourcePath (.tgz) or name (installed plugin)' }
        const out = saveRawTgz(readFileSync(p), basename(p))
        return { ok: true, ...out }
      } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
    },
  })), 'plugin-repo: repo_push tool')

  ctx.effect(() => tools.register(defineTool({
    name: 'repo_pull',
    description: 'Download a .tgz plugin package from this device\'s repository to a local file.',
    parameters: { filename: { type: 'string', required: true, description: 'Package filename in the repository (e.g. myplug-0.1.0.tgz).' }, targetPath: { type: 'string', required: true, description: 'Absolute local path to save the downloaded .tgz to.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, name: { type: 'string' }, targetPath: { type: 'string' }, size: { type: 'integer' }, error: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args) {
      const filename = basename(args.filename)
      const file = repoFile(filename)
      if (!existsSync(file)) return { ok: false, error: `package "${filename}" not found` }
      const buf = readFileSync(file)
      writeFileSync(args.targetPath, buf)
      return { ok: true, name: filename, targetPath: args.targetPath, size: buf.length }
    },
  })), 'plugin-repo: repo_pull tool')

  ctx.effect(() => tools.register(defineTool({
    name: 'repo_remote',
    description: 'List the plugin repository of ANOTHER DSH device by its host:port.',
    parameters: { host: { type: 'string', required: true, description: 'IP/host of the remote DSH device.' }, port: { type: 'string', description: 'Remote DSH web port (default 3080).' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, count: { type: 'integer', required: true }, packages: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, version: { type: 'string' }, filename: { type: 'string', required: true }, size: { type: 'integer' } } } }, error: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args) { try { const packages = await listRemoteRepo(args.host, args.port || ''); return { ok: true, count: packages.length, packages } } catch (e) { return { ok: false, count: 0, packages: [], error: String((e && e.message) || e) } } },
  })), 'plugin-repo: repo_remote tool')

  ctx.effect(() => tools.register(defineTool({
    name: 'repo_remote_pull',
    description: 'Download .tgz plugin(s) from ANOTHER DSH device\'s repository into THIS device\'s local repository (NOT auto-installed). Pass one filename or a comma-separated list.',
    parameters: { host: { type: 'string', required: true, description: 'IP/host of the remote DSH device.' }, port: { type: 'string', description: 'Remote DSH web port (default 3080).' }, filenames: { type: 'string', required: true, description: 'Comma-separated package filenames to pull.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, pulled: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, filename: { type: 'string' }, size: { type: 'integer' }, ok: { type: 'boolean' }, error: { type: 'string' } } } }, error: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args) {
      const files = String(args.filenames || '').split(',').map((s) => s.trim()).filter(Boolean)
      const pulled = []
      for (const filename of files) {
        try {
          const buf = await fetchRemoteTgz(args.host, args.port || '', filename)
          pulled.push({ ok: true, ...saveRawTgz(buf, filename) })
        } catch (e) { pulled.push({ ok: false, filename, error: String((e && e.message) || e) }) }
      }
      return { ok: true, pulled }
    },
  })), 'plugin-repo: repo_remote_pull tool')

  ctx.effect(() => tools.register(defineTool({
    name: 'repo_remote_push',
    description: 'Upload .tgz plugin(s) from THIS device\'s local repository into ANOTHER DSH device\'s repository. Pass one filename or a comma-separated list of local-repo filenames.',
    parameters: { host: { type: 'string', required: true, description: 'IP/host of the remote DSH device.' }, port: { type: 'string', description: 'Remote DSH web port (default 3080).' }, filenames: { type: 'string', required: true, description: 'Comma-separated local repository package filenames to push.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, pushed: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, filename: { type: 'string' }, size: { type: 'integer' }, ok: { type: 'boolean' }, error: { type: 'string' } } } }, error: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args) {
      const files = String(args.filenames || '').split(',').map((s) => s.trim()).filter(Boolean)
      try {
        const { pushed } = await pushManyToRemote(args.host, args.port || '', files)
        return { ok: true, pushed }
      } catch (e) {
        return { ok: false, pushed: [], error: String((e && e.message) || e) }
      }
    },
  })), 'plugin-repo: repo_remote_push tool')

  ctx.effect(() => tools.register(defineTool({
    name: 'repo_install',
    description: 'Install a .tgz from this device\'s repository into the LOCAL web profile (version-aware: newer wins, lower/equal is skipped). Requires installConfirm=true to actually modify the profile.',
    parameters: { filename: { type: 'string', required: true, description: 'Repository package filename to install.' }, installConfirm: { type: 'boolean', description: 'Must be true to actually modify the profile.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, needConfirm: { type: 'boolean' }, skipped: { type: 'boolean' }, reason: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' }, installedVersion: { type: 'string' }, actions: { type: 'array', items: { type: 'string' } }, error: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args) {
      try {
        if (!args.installConfirm) return { ok: true, needConfirm: true, ...planInstall(args.filename) }
        const out = doInstall(args.filename)
        const restart = afterInstallRestart(out.ok && !out.skipped ? 1 : 0)
        return { ok: out.ok, needConfirm: false, ...out, ...restart }
      } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
    },
  })), 'plugin-repo: repo_install tool')

  ctx.effect(() => tools.register(defineTool({
    name: 'repo_delete',
    description: 'Remove a .tgz plugin package from this device\'s repository by filename (does not uninstall anything).',
    parameters: { filename: { type: 'string', required: true, description: 'Repository package filename to delete.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, name: { type: 'string' }, error: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args) {
      const filename = basename(args.filename)
      const index = loadIndex()
      const hit = Object.keys(index).find((k) => index[k].filename === filename)
      if (hit) { delete index[hit]; saveIndex(index) }
      try { const f = join(packagesDir, filename); if (existsSync(f)) unlinkSync(f) } catch (e) { /* gone */ }
      return { ok: true, name: filename }
    },
  })), 'plugin-repo: repo_delete tool')

  if ((config.logLevel ?? 'info') !== 'silent') {
    ctx.logger.info(`dsh-plugin-repo: repository served at ${ROUTE_PREFIX}, repo dir ${repoDir}`)
  }
}

export { Config, apply, inject, name }
export default { name, inject, Config, apply }