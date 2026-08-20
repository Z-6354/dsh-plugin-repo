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
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import os from 'node:os'

const name = 'plugin-repo'
// schemastery: fields are optional unless `.required()` — do NOT use zod's `.optional()`.
const Config = z.object({
  repoDir: z.string(),
  port: z.number(),
  logLevel: z.union(['silent', 'info']).default('info'),
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

  // ---------- repo state ----------

  function listRepoPackages() {
    const index = loadIndex()
    return Object.keys(index).sort().map((key) => {
      const e = index[key]
      return {
        name: e.name, version: e.version || '', filename: e.filename,
        size: e.size, uploadedAt: e.uploadedAt, official: false,
      }
    })
  }

  // ---------- version helpers ----------

  function parseVersionFromFilename(filename) {
    let base = filename
    if (base.endsWith('.tgz')) base = base.slice(0, -4)
    const m = /^(.*)-(\d+\.\d+(?:\.\d+)?(?:[-+].*)?)$/.exec(base)
    return m ? { name: m[1], version: m[2] } : { name: base, version: '' }
  }
  function versionTuple(v) {
    const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v || '').trim())
    if (!m) return [0, 0, 0]
    return [Number(m[1]), Number(m[2]), Number(m[3] || 0)]
  }
  function isNewer(a, b) {
    const ta = versionTuple(a), tb = versionTuple(b)
    for (let i = 0; i < 3; i++) { if (ta[i] !== tb[i]) return ta[i] > tb[i] }
    return false
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
            if (pkg.name && !isOfficial(pkg.name) && !found.has(pkg.name)) {
              found.set(pkg.name, { name: pkg.name, version: pkg.version || '', dir: abs })
            }
            // a plugin dir can itself nest other plugins; keep descending
          } catch (err) { /* bad package.json; descend anyway */ }
        }
        collectPluginsUnder(abs, found)
      } catch (err) { /* best effort */ }
    }
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
          if (entry.startsWith('.') || entry === '@deepseek-ai' || entry === '.pnpm') continue
          const abs = join(root, entry)
          try {
            if (!statSync(abs).isDirectory()) continue
            const pj = join(abs, 'package.json')
            if (!existsSync(pj)) continue
            const pkg = JSON.parse(readFileSync(pj, 'utf8'))
            if (!pkg.name || isOfficial(pkg.name)) continue
            if (!found.has(pkg.name)) found.set(pkg.name, { name: pkg.name, version: pkg.version || '', dir: abs })
          } catch (err) { /* best effort */ }
        }
      } else {
        collectPluginsUnder(root, found, 6)
      }
    }
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  function installedVersionOf(pkgName) {
    const f = scanInstalledNonOfficial().find((p) => p.name === pkgName)
    return f ? f.version : ''
  }

  // ---------- auto-pack an installed plugin into the repo ----------

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
    saveIndex(index)
    return { name: index[key].name, version: index[key].version, filename, size }
  }

  function saveRawTgz(buf, filename) {
    filename = basename(filename)
    if (!filename.endsWith('.tgz')) filename += '.tgz'
    const key = filename.replace(/\.tgz$/, '')
    const parsed = parseVersionFromFilename(filename)
    ensureDirs()
    writeFileSync(join(packagesDir, filename), buf)
    const index = loadIndex()
    index[key] = {
      name: parsed.name || key, version: parsed.version || 'unknown',
      filename, size: buf.length, uploadedAt: new Date().toISOString(),
    }
    saveIndex(index)
    return { name: index[key].name, version: index[key].version, filename, size: buf.length }
  }

  function repoFile(filename) { return join(packagesDir, basename(filename)) }

  // ---------- remote device (another DSH's repo) ----------

  async function listRemoteRepo(rawHost, rawPort) {
    const port = rawPort ? String(rawPort) : '3080'
    const base = `http://${rawHost}:${port}${ROUTE_PREFIX}`
    const res = await fetch(`${base}/api/packages`)
    if (!res.ok) throw new Error(`remote ${base}/api/packages -> HTTP ${res.status}`)
    const data = await res.json()
    return (data && Array.isArray(data.packages)) ? data.packages : []
  }

  async function fetchRemoteTgz(rawHost, rawPort, filename) {
    const port = rawPort ? String(rawPort) : '3080'
    const url = `http://${rawHost}:${port}${ROUTE_PREFIX}/download/${encodeURIComponent(basename(filename))}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`remote download -> HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  // ---------- install from repo into local profile (confirm-gated) ----------

  function planInstall(filename) {
    const file = repoFile(filename)
    if (!existsSync(file)) throw new Error(`package "${filename}" not in repository`)
    const index = loadIndex()
    const key = filename.replace(/\.tgz$/, '')
    const meta = index[key]
    const parsed = parseVersionFromFilename(filename)
    const candidateVersion = (meta && meta.version) || parsed.version || 'unknown'
    const candidateName = (meta && meta.name) || parsed.name || key
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
        `把 ${candidateName} 加入 web profile 的 bundles 与 dependencies`,
        `在 web profile 执行 pnpm install（下次重启生效）`,
      ],
    }
  }

  function doInstall(filename) {
    const plan = planInstall(filename)
    if (plan.skip) return { ok: false, skipped: true, reason: plan.skipReason, ...plan }
    const profile = webProfileDir()
    const src = repoFile(filename)
    const pluginsHome = join(dshHome(), 'plugins')
    if (!existsSync(pluginsHome)) mkdirSync(pluginsHome, { recursive: true })
    const dest = join(pluginsHome, filename)
    copyFileSync(src, dest)
    const pjPath = join(profile, 'package.json')
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
    const bundles = pj.dsh.profile.bundles || []
    if (!bundles.includes(plan.name)) bundles.push(plan.name)
    pj.dsh.profile.bundles = bundles
    const deps = pj.dependencies || {}
    const winUser = String(os.homedir()).split(/[\\/]/).pop() || 'han'
    deps[plan.name] = `file:C://Users//${winUser}//.dsh//plugins//${filename}`
    pj.dependencies = deps
    writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n')
    const r = spawnSync('pnpm', ['install'], { cwd: profile, encoding: 'utf8', shell: process.platform === 'win32' })
    const output = ((r.stdout || '') + (r.stderr || '')).slice(0, 800)
    return { ok: r.status === 0, skipped: false, ...plan, dest, profile, output }
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
        json(res, 200, { ok: true, installed: scanInstalledNonOfficial(), roots: allSearchRoots() }); return
      }

      if (rest === '/api/unofficial' && method === 'GET') {
        json(res, 200, { ok: true, installed: scanInstalledNonOfficial(), repo: listRepoPackages(), roots: allSearchRoots() }); return
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

      // raw .tgz upload: POST /api/upload (body = tgz) ?name=
      if (rest === '/api/upload' && method === 'POST') {
        const buf = await readBodyBuf(req)
        if (buf.length === 0) { json(res, 400, { ok: false, error: 'empty body' }); return }
        let filename = null
        const q = queryOf(req.url)
        filename = q && q.get('name') ? `${q.get('name')}.tgz` : null
        if (!filename) {
          const cd = req.headers['content-disposition'] || ''
          const m = /filename="?([^";]+)"?/.exec(cd)
          if (m) filename = m[1]
        }
        if (!filename) filename = `package-${Date.now()}.tgz`
        const out = saveRawTgz(buf, filename)
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
        const port = q ? q.get('port') : '3080'
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
        const port = input.port || '3080'
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

      // install from repo into local profile: POST /api/install { filename, confirm? }
      if (rest === '/api/install' && method === 'POST') {
        const body = await readBodyBuf(req)
        let input = {}
        try { input = JSON.parse(body.toString('utf8')) } catch (e) { input = {} }
        const filename = input.filename
        if (!filename) { json(res, 400, { ok: false, error: 'filename required' }); return }
        if (!input.confirm) {
          json(res, 200, { ok: true, needConfirm: true, ...planInstall(filename) }); return
        }
        json(res, 200, { ok: true, needConfirm: false, ...doInstall(filename) }); return
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
    async execute() { return { ok: true, installed: scanInstalledNonOfficial() } },
  })), 'plugin-repo: repo_installed tool')

  ctx.effect(() => tools.register(defineTool({
    name: 'repo_unofficial',
    description: 'Detect non-official plugins: installed on this device plus .tgz in the repository.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, installed: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, version: { type: 'string' }, dir: { type: 'string' } } } }, repo: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, version: { type: 'string' }, filename: { type: 'string', required: true }, size: { type: 'integer' } } } }, error: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute() { return { ok: true, installed: scanInstalledNonOfficial(), repo: listRepoPackages() } },
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
    async execute(args) { try { const packages = await listRemoteRepo(args.host, args.port || '3080'); return { ok: true, count: packages.length, packages } } catch (e) { return { ok: false, count: 0, packages: [], error: String((e && e.message) || e) } } },
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
          const buf = await fetchRemoteTgz(args.host, args.port || '3080', filename)
          pulled.push({ ok: true, ...saveRawTgz(buf, filename) })
        } catch (e) { pulled.push({ ok: false, filename, error: String((e && e.message) || e) }) }
      }
      return { ok: true, pulled }
    },
  })), 'plugin-repo: repo_remote_pull tool')

  ctx.effect(() => tools.register(defineTool({
    name: 'repo_install',
    description: 'Install a .tgz from this device\'s repository into the LOCAL web profile (version-aware: newer wins, lower/equal is skipped). Requires installConfirm=true to actually modify the profile.',
    parameters: { filename: { type: 'string', required: true, description: 'Repository package filename to install.' }, installConfirm: { type: 'boolean', description: 'Must be true to actually modify the profile.' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, needConfirm: { type: 'boolean' }, skipped: { type: 'boolean' }, reason: { type: 'string' }, name: { type: 'string' }, version: { type: 'string' }, installedVersion: { type: 'string' }, actions: { type: 'array', items: { type: 'string' } }, error: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args) {
      try {
        if (!args.installConfirm) return { ok: true, needConfirm: true, ...planInstall(args.filename) }
        const out = doInstall(args.filename)
        return { ok: out.ok, needConfirm: false, ...out }
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