// Finding things inside a GOV.UK Prototype Kit prototype: its root folder,
// its pages (views), its route files, and the URL each page is served at.

const fs = require('fs')
const path = require('path')

const VIEW_EXT = /\.(html|njk)$/
// Folders under app/views that hold templates, not pages
const SKIP_DIRS = new Set(['layouts', 'includes', 'partials', 'components', 'macros', 'node_modules'])

function findPrototypeRoot (start) {
  let dir = path.resolve(start)
  for (;;) {
    if (fs.existsSync(path.join(dir, 'app', 'views')) && fs.existsSync(path.join(dir, 'package.json'))) {
      return dir
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function listFiles (dir, accept) {
  if (!fs.existsSync(dir)) return []
  const found = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...listFiles(full, accept))
    } else if (accept(entry.name)) {
      found.push(full)
    }
  }
  return found.sort()
}

// Pages are .html or .njk files; names starting with _ are partials
function listViews (dir) {
  return listFiles(dir, name => VIEW_EXT.test(name) && !name.startsWith('_'))
}

// The kit loads app/routes.js. Prototypes often keep more routes in
// app/routes/*.js or next to their pages in _routes.js files.
function listRouteFiles (root) {
  const app = path.join(root, 'app')
  const files = []
  if (fs.existsSync(path.join(app, 'routes.js'))) files.push(path.join(app, 'routes.js'))
  files.push(...listFiles(path.join(app, 'routes'), name => name.endsWith('.js')))
  files.push(...listFiles(path.join(app, 'views'), name => name === '_routes.js' || name === 'routes.js'))
  return files
}

// One spelling for every URL: leading slash, no trailing slash, no .html, no /index
function normaliseUrl (url) {
  let clean = String(url)
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(VIEW_EXT, '')
    .replace(/\/index$/, '')
    .replace(/\/$/, '')
  if (!clean.startsWith('/')) clean = '/' + clean
  return clean
}

function viewUrl (viewsDir, file) {
  return normaliseUrl('/' + path.relative(viewsDir, file))
}

function isIndexFile (file) {
  return /^index\.(html|njk)$/.test(path.basename(file))
}

function findView (viewsDir, url) {
  const base = path.join(viewsDir, ...url.split('/').filter(Boolean))
  const candidates = url === '/'
    ? [path.join(viewsDir, 'index.html'), path.join(viewsDir, 'index.njk')]
    : [base + '.html', base + '.njk', path.join(base, 'index.html'), path.join(base, 'index.njk')]
  return candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile()) || null
}

// Resolves a link or redirect the way a browser would, from the page at `base`.
// Returns { url, query }, { external: true }, or null for links that go nowhere.
function resolveHref (href, base) {
  const raw = String(href || '').trim()
  if (!raw || raw === 'back' || raw.startsWith('#')) return null
  if (/^(javascript|mailto|tel|data|sms):/i.test(raw)) return null
  if (raw.includes('{{') || raw.includes('{%')) return { dynamic: true }
  if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(raw)) {
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(raw)
      ? resolveHref(raw.replace(/^https?:\/\/[^/]+/i, ''), base)
      : { external: true }
  }
  const resolved = new URL(raw, 'http://prototype.local' + base)
  let pathname = resolved.pathname
  try { pathname = decodeURIComponent(pathname) } catch (err) {}
  return { url: normaliseUrl(pathname), query: resolved.search }
}

function humanise (name) {
  const words = String(name)
    .replace(/\.(html|njk)$/, '')
    .replace(/(\d)[-_](?=\d)/g, '$1.')
    .replace(/[-_]+/g, ' ')
    .trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

module.exports = {
  findPrototypeRoot,
  listViews,
  listRouteFiles,
  normaliseUrl,
  viewUrl,
  isIndexFile,
  findView,
  resolveHref,
  humanise
}
