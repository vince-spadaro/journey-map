// Positions the nodes and routes the lines with ELK, once top to bottom and
// once left to right, so the viewer can switch without recalculating.
// Return links (Change links, loops) are left out of the layout and drawn as
// curves by the viewer, which keeps the rest reading as a tree.

const ELK = require('elkjs/lib/elk.bundled.js')

const elk = new ELK()

// The viewer draws nodes with these same measurements
const PAGE_WIDTH = 248
// Screenshot thumbnails are 4:3, with a 10px gap below
const THUMB_HEIGHT = 165
const THUMB_SPACE = THUMB_HEIGHT + 10
const SMALL_WIDTH = 204
const LABEL_MAX = 48

function wrapText (text, maxChars, maxLines) {
  const lines = []
  let line = ''
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (!line) line = word
    else if ((line + ' ' + word).length <= maxChars) line += ' ' + word
    else { lines.push(line); line = word }
  }
  if (line) lines.push(line)

  const fitted = lines.flatMap(l => l.length <= maxChars ? [l] : l.match(new RegExp('.{1,' + maxChars + '}', 'g')))
  if (fitted.length > maxLines) {
    fitted.length = maxLines
    fitted[maxLines - 1] = fitted[maxLines - 1].slice(0, maxChars - 1).replace(/\s+\S*$/, '') + '…'
  }
  return fitted.length ? fitted : ['']
}

// Paths have no spaces, so break them after / and -
function wrapPath (text, maxChars, maxLines) {
  const lines = []
  let line = ''
  for (const part of String(text).split(/(?<=[/-])/)) {
    if ((line + part).length <= maxChars) line += part
    else { if (line) lines.push(line); line = part }
  }
  if (line) lines.push(line)
  return wrapText(lines.join(' '), maxChars, maxLines).map(l => l.replace(/([/-]) /g, '$1'))
}

// Keeps the start and the end of a long file name: index-not-ma…enrolled.html
function shorten (text, maxChars) {
  if (text.length <= maxChars) return text
  const tail = Math.ceil((maxChars - 1) / 2)
  return text.slice(0, maxChars - 1 - tail) + '…' + text.slice(-tail)
}

function badgesFor (node) {
  const badges = []
  if (node.entry) badges.push({ kind: 'entry', text: 'Start' })
  // Error screens photographed, or the error states found in the routes if more
  const states = node.states || []
  const errors = Math.max(node.errorStates.length, states.filter(st => st.kind === 'error').length)
  if (errors) badges.push({ kind: 'errors', text: errors === 1 ? '1 error' : `${errors} errors` })
  // States: the page as it opens, plus options that reveal more questions and
  // links that show the page another way (counted even without screenshots).
  // A page with only its normal state gets no tag.
  const reveals = states.filter(st => st.kind === 'reveal').length
  const total = 1 + reveals + node.variants.length
  if (total > 1) badges.push({ kind: 'states', text: `${total} states` })
  return badges.map(b => ({ ...b, width: Math.round(b.text.length * 6.6 + 18) }))
}

// Adds lines, badges and size to each node
function measure (node) {
  if (node.type === 'page') {
    node.lines = wrapText(node.title, 28, 3)
    node.fileLabel = shorten(node.fileName || '', 30)
    node.badges = badgesFor(node)
    node.width = PAGE_WIDTH
    node.height = 16 + node.lines.length * 19 + 4 + 16 + (node.badges.length ? 26 : 0) + 12
  } else if (node.type === 'decision') {
    node.lines = wrapPath(node.title, 24, 2)
    node.badges = []
    node.width = SMALL_WIDTH
    node.height = 12 + 16 + node.lines.length * 18 + 12
  } else {
    node.lines = node.type === 'missing' || !node.file ? wrapPath(node.title, 24, 2) : wrapText(node.title, 26, 2)
    node.badges = []
    node.width = SMALL_WIDTH
    node.height = 10 + 14 + node.lines.length * 17 + 10
  }
}

function shortLabel (text) {
  return text.length > LABEL_MAX ? text.slice(0, LABEL_MAX - 1) + '…' : text
}

const OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.layered.spacing.nodeNodeBetweenLayers': '64',
  'elk.spacing.nodeNode': '36',
  'elk.spacing.edgeNode': '18',
  'elk.spacing.edgeEdge': '12',
  'elk.spacing.edgeLabel': '6',
  'elk.layered.spacing.edgeNodeBetweenLayers': '18',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': '80'
}

async function layoutOne (graph, direction, withThumbs) {
  const result = await elk.layout({
    id: 'root',
    layoutOptions: { ...OPTIONS, 'elk.direction': direction },
    children: graph.nodes.map(n => ({
      id: n.id,
      width: n.width,
      height: n.height + (withThumbs && n.type === 'page' ? THUMB_SPACE : 0)
    })),
    edges: graph.edges.filter(e => !e.return).map(e => ({
      id: e.id,
      sources: [e.from],
      targets: [e.to],
      labels: e.label
        ? [{ id: e.id + ':label', text: e.shortLabel, width: Math.round(e.shortLabel.length * 6.5 + 16), height: 20 }]
        : []
    }))
  })

  const nodes = {}
  for (const child of result.children) {
    nodes[child.id] = { x: child.x, y: child.y, width: child.width, height: child.height }
  }
  const edges = {}
  for (const edge of result.edges || []) {
    const section = edge.sections && edge.sections[0]
    if (!section) continue
    const label = edge.labels && edge.labels[0]
    edges[edge.id] = {
      points: [section.startPoint, ...(section.bendPoints || []), section.endPoint].map(p => ({ x: p.x, y: p.y })),
      label: label ? { x: label.x, y: label.y, width: label.width, height: label.height } : null
    }
  }
  return { nodes, edges, width: result.width, height: result.height }
}

async function addLayouts (graph) {
  graph.nodes.forEach(measure)
  graph.edges.forEach(e => { e.shortLabel = e.label ? shortLabel(e.label) : '' })
  graph.layouts = {
    DOWN: await layoutOne(graph, 'DOWN', false),
    RIGHT: await layoutOne(graph, 'RIGHT', false)
  }
  if (graph.meta.screenshots) {
    graph.layouts['DOWN:thumbs'] = await layoutOne(graph, 'DOWN', true)
    graph.layouts['RIGHT:thumbs'] = await layoutOne(graph, 'RIGHT', true)
  }
  return graph
}

module.exports = { addLayouts, wrapText }
