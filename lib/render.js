// Puts the graph and the viewer into one self-contained HTML file that works
// offline and can be shared as an attachment.

const fs = require('fs')
const path = require('path')

const VIEWER_DIR = path.join(__dirname, '..', 'viewer')
const ELK_FILE = require.resolve('elkjs/lib/elk.bundled.js')

function read (name) {
  return fs.readFileSync(path.join(VIEWER_DIR, name), 'utf8')
}

function escapeHtml (text) {
  return String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

// Only what the viewer needs, so the file stays small
function viewerData (graph, options) {
  return {
    meta: { ...graph.meta, port: options.port, slug: options.slug, createdAt: new Date().toISOString() },
    nodes: graph.nodes.map(n => ({
      id: n.id,
      url: n.url,
      type: n.type,
      title: n.title,
      heading: n.heading,
      file: n.file || null,
      fileName: n.fileName || '',
      fileLines: n.fileLines || [],
      absFile: n.absFile || null,
      routeFile: n.routeFile || null,
      absRouteFile: n.absRouteFile || null,
      entry: n.entry,
      outside: !!n.outside,
      lines: n.lines,
      badges: n.badges,
      warnings: n.warnings,
      notes: n.notes,
      errorStates: n.errorStates,
      variants: n.variants,
      answerStates: n.answerStates || null,
      externalLinks: n.externalLinks || [],
      status: n.status || 0,
      thumb: n.thumb || null,
      shot: n.shot || null,
      shotWidth: n.shotWidth || 0,
      shotHeight: n.shotHeight || 0,
      cutOff: !!n.cutOff,
      shotError: n.shotError || null,
      states: n.states || [],
      stateCards: n.stateCards || [],
      answersInWords: n.answersInWords || [],
      sameAsAnswer: n.sameAsAnswer || null,
      expanded: n.expanded || null
    })),
    edges: graph.edges.map(e => ({
      id: e.id,
      from: e.from,
      to: e.to,
      kind: e.kind,
      label: e.label,
      code: e.code || '',
      named: !!e.named,
      excludes: e.excludes || [],
      shortLabel: e.shortLabel,
      texts: e.texts,
      fullTexts: e.fullTexts || [],
      query: e.query,
      return: e.return
    })),
    layouts: graph.layouts
  }
}

// ELK and lib/layout.js, so the map can lay out an export again without the
// screens left out of it. layout.js is CommonJS: it gets its own `module`,
// and `require` gives it the ELK the first script defines.
function layoutScript () {
  return fs.readFileSync(ELK_FILE, 'utf8') +
    '\n;window.journeyLayout = (function () {\nconst module = { exports: {} }\nconst require = () => window.ELK\n' +
    fs.readFileSync(path.join(__dirname, 'layout.js'), 'utf8') +
    '\nreturn module.exports\n})()\n'
}

function renderHtml (graph, options) {
  const json = JSON.stringify(viewerData(graph, options))
    .replace(/</g, '\\u003c')
    .replace(/[\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16))

  // Replacer functions, so $ in the content is never treated as a pattern
  return read('template.html')
    .replace('__TITLE__', () => escapeHtml(graph.meta.name))
    .replace('/*__CSS__*/', () => read('viewer.css'))
    .replace('/*__SVG_CSS__*/', () => read('map.css'))
    .replace('__DATA__', () => json)
    .replace('/*__LAYOUT__*/', layoutScript)
    .replace('/*__JS__*/', () => read('viewer.js'))
}

module.exports = { renderHtml }
