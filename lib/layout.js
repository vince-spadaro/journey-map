// Positions the nodes and routes the lines with ELK, once top to bottom and
// once left to right, so the viewer can switch without recalculating.
// Return links (Change links, loops) are left out of the layout and drawn as
// curves by the viewer, which keeps the rest reading as a tree.
// The map runs this file too (see render.js), to lay out an export again
// without the screens left out of it, so it mustn't use anything but ELK.

const ELK = require('elkjs/lib/elk.bundled.js')

const elk = new ELK()

// The viewer draws nodes with these same measurements
const PAGE_WIDTH = 248
// Screenshot thumbnails are 4:3, with a 10px gap below
const THUMB_HEIGHT = 165
const THUMB_SPACE = THUMB_HEIGHT + 10
const SMALL_WIDTH = 204
const LABEL_MAX = 48

// The Mural exports show each screenshot whole, however long the page, at
// the thumbnail's width. With all states, each state's screenshot is a card
// beside its page (or below it, left to right), with its name underneath.
const PICTURE_WIDTH = PAGE_WIDTH - 28
const pictureHeight = shot => shot && shot.shotWidth
  ? Math.round(PICTURE_WIDTH * shot.shotHeight / shot.shotWidth)
  : THUMB_HEIGHT
const STATE_GAP = 16
const STRIP_GAP = 24
const STATE_COLUMNS = 4
const STATE_LINE = 17
const stateCardHeight = card => 14 + card.picture + 32 + ((card.triggerLines || []).length + card.lines.length - 1) * STATE_LINE + 14

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

// File names: 10.5px monospace fits about 34 characters on a card, 13px a line
const FILE_CHARS = 34
const FILE_LINE = 13
const fileBlock = node => 3 + Math.max(1, node.fileLines.length) * FILE_LINE

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
  // Links back to the page with a query string, and addresses the index page lists
  const variants = node.shot ? states.filter(st => st.kind === 'variant').length : node.variants.length
  // Pages that look different after each answer: the ones photographed, or
  // without screenshots, every answer but the one the page opens with
  const answers = node.answerStates
    ? (node.shot ? states.filter(st => st.kind === 'answer').length : node.answerStates.options.length - 1)
    : 0
  const total = 1 + reveals + variants + answers
  if (total > 1) badges.push({ kind: 'states', text: `${total} states` })
  return badges.map(b => ({ ...b, width: Math.round(b.text.length * 6.6 + 18) }))
}

// Adds lines, badges and size to each node
function measure (node) {
  if (node.type === 'page') {
    node.lines = wrapText(node.title, 28, 3)
    // The whole file name, wrapped at hyphens if it's too long for one line
    node.fileLines = node.fileName ? wrapPath(node.fileName, FILE_CHARS, 3) : []
    node.badges = badgesFor(node)
    node.width = PAGE_WIDTH
    node.height = 16 + node.lines.length * 19 + 4 + fileBlock(node) + (node.badges.length ? 26 : 0) + 12
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

// The words under each state's screenshot, for states that were photographed
// What makes an error show, in words, as in the viewer's full-screen tabs:
// from the page's address, like ?error=required, or what the tool typed
const DATE_PARTS = ['day', 'month', 'year']
function errorTrigger (st) {
  const value = st.query ? new URLSearchParams(st.query.replace(/^\?/, '')).get('error') : null
  if (!value) return /index page/.test(st.label || '') ? '' : st.label || ''
  if (value === 'required') return 'Nothing entered'
  if (value === 'invalid') return 'Entered in the wrong format'
  const missing = value.match(/^([a-z-]+)-required$/)
  if (missing) {
    const parts = missing[1].split('-')
    if (parts.every(p => DATE_PARTS.includes(p))) return 'Date entered with no ' + parts.join(' or ')
    return 'Nothing entered for ' + parts.join(' ')
  }
  const words = value.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// The page as it opens is state 1, so other states count from 2, as on its tag
function stateCardsFor (node) {
  let states = 1
  let errors = 0
  return (node.states || []).map((st, i) => {
    const error = st.kind === 'error'
    const kind = error ? 'Error ' + ++errors : 'State ' + ++states
    if (!st.shot) return null
    const text = error ? st.messages.join(' / ')
      : st.kind === 'reveal' ? st.label + (st.type === 'checkbox' ? ' ticked' : ' selected')
        : st.kind === 'answer' ? 'After choosing “' + st.label + '”'
          : st.listed ? st.label
            : 'After the link “' + st.label + '”'
    // Errors say what makes them show above the message, so the two can be compared
    const trigger = error ? errorTrigger(st) : ''
    return { index: i + 1, error, kind, triggerLines: trigger ? wrapText(trigger + ':', 30, 2) : [], lines: wrapText(text, 30, 4), picture: pictureHeight(st) }
  }).filter(Boolean)
}

// Where the page card and its state cards go inside the page's box. Top to
// bottom, the states sit in rows to the right and the card stretches to the
// full height, so lines join the card; left to right, they're stacked below.
function stateBox (node, direction) {
  const picture = pictureHeight(node)
  const pageHeight = node.height + picture + 10
  // Cards in a row are as tall as the tallest one in it
  const perRow = direction === 'DOWN' ? STATE_COLUMNS : 1
  const rows = []
  node.stateCards.forEach((card, i) => {
    const row = Math.floor(i / perRow)
    rows[row] = Math.max(rows[row] || 0, stateCardHeight(card))
  })
  const rowTop = row => (direction === 'DOWN' ? 0 : pageHeight + STRIP_GAP) +
    rows.slice(0, row).reduce((sum, height) => sum + height + STATE_GAP, 0)
  const cards = node.stateCards.map((card, i) => {
    const col = i % perRow
    const row = Math.floor(i / perRow)
    return {
      x: direction === 'DOWN' ? PAGE_WIDTH + STRIP_GAP + col * (PAGE_WIDTH + STATE_GAP) : 0,
      y: rowTop(row),
      width: PAGE_WIDTH,
      height: rows[row],
      picture: card.picture
    }
  })
  const right = Math.max(...cards.map(c => c.x + c.width))
  const bottom = Math.max(pageHeight, ...cards.map(c => c.y + c.height))
  const card = { width: PAGE_WIDTH, height: direction === 'DOWN' ? bottom : pageHeight, picture }
  // Lines go in and out at the page card, not in the middle of the states
  const ports = direction === 'DOWN'
    ? [{ id: node.id + ':in', x: PAGE_WIDTH / 2, y: 0 }, { id: node.id + ':out', x: PAGE_WIDTH / 2, y: bottom }]
    : [{ id: node.id + ':in', x: 0, y: pageHeight / 2 }, { id: node.id + ':out', x: PAGE_WIDTH, y: pageHeight / 2 }]
  return { width: right, height: bottom, card, cards, ports }
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
  // Lines don't cross, so the map is easy to scan. Pages keep the order given
  // (branches in the options' order) wherever that doesn't make lines cross:
  // a page out of that order counts as half a crossing.
  'elk.layered.considerModelOrder.crossingCounterNodeInfluence': '0.5',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  'elk.separateConnectedComponents': 'true',
  'elk.spacing.componentComponent': '80'
}

// `pictures` is 'thumbs' for the map's thumbnails, 'full' for whole
// screenshots, or 'states' for whole screenshots with every state beside them
async function layoutOne (graph, direction, pictures) {
  const boxes = new Map(pictures === 'states'
    ? graph.nodes.filter(n => n.stateCards && n.stateCards.length).map(n => [n.id, stateBox(n, direction)])
    : [])
  const whole = pictures === 'full' || pictures === 'states'
  const extra = n => n.type !== 'page' || !pictures ? 0 : whole ? pictureHeight(n) + 10 : THUMB_SPACE
  const end = (id, side) => boxes.has(id) ? id + ':' + side : id
  const result = await elk.layout({
    id: 'root',
    layoutOptions: { ...OPTIONS, 'elk.direction': direction },
    children: graph.nodes.map(n => {
      const box = boxes.get(n.id)
      if (box) {
        return {
          id: n.id,
          width: box.width,
          height: box.height,
          layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
          ports: box.ports.map(p => ({ ...p, width: 0, height: 0 }))
        }
      }
      return { id: n.id, width: n.width, height: n.height + extra(n) }
    }),
    edges: graph.edges.filter(e => !e.return).map(e => ({
      id: e.id,
      sources: [end(e.from, 'out')],
      targets: [end(e.to, 'in')],
      labels: e.label
        ? [{ id: e.id + ':label', text: e.shortLabel, width: Math.round(e.shortLabel.length * 6.5 + 16), height: 20 }]
        : []
    }))
  })

  const nodes = {}
  for (const child of result.children) {
    nodes[child.id] = { x: child.x, y: child.y, width: child.width, height: child.height }
    const box = boxes.get(child.id)
    const n = graph.nodes.find(node => node.id === child.id)
    if (box) Object.assign(nodes[child.id], { card: box.card, cards: box.cards })
    else if (whole && n.type === 'page') nodes[child.id].card = { width: child.width, height: child.height, picture: pictureHeight(n) }
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

// Branches in the order the options are on the page: A, B then C from left to
// right top to bottom, or from top to bottom left to right. Each page's lines
// are sorted by the option they're for ("Any other answer" where the options
// it stands for are, or last), then the
// pages are put in journey order following them, which ELK keeps unless it
// would make lines cross.
function orderBranches (graph) {
  const nodesById = new Map(graph.nodes.map(n => [n.id, n]))
  const optionsOf = node => {
    const order = []
    // As the real page shows them (from screenshots), then as the template has them
    for (const source of [node.renderedFields || {}, node.fields || {}]) {
      for (const [field, choice] of Object.entries(source)) {
        for (const value of Object.keys(choice.options || {})) if (!order.includes(field + '=' + value)) order.push(field + '=' + value)
      }
    }
    return order
  }
  const ruleOf = e => (e.rule || '').match(/^([\w$-]+) = (['"])(.*)\2$/)
  const place = new Map()
  graph.edges.forEach((e, i) => {
    const from = nodesById.get(e.from)
    const options = from ? optionsOf(from) : []
    const rule = ruleOf(e)
    let option = rule ? options.indexOf(rule[1] + '=' + rule[3]) : -1
    let last = 0
    if (/^(otherwise|Any other)/.test(e.rule || e.label || '')) {
      // The first option the other branches from this page don't name
      const named = graph.edges.filter(o => o.from === e.from && o !== e).map(ruleOf).filter(Boolean)
      const field = named.length && named.every(m => m[1] === named[0][1]) ? named[0][1] : null
      option = field ? options.findIndex(o => o.startsWith(field + '=') && !named.some(m => o === field + '=' + m[3])) : -1
      if (option < 0) last = 1
    }
    place.set(e, [last, option >= 0 ? option : Infinity, i])
  })
  const byPlace = (a, b) => {
    const [x, y] = [place.get(a), place.get(b)]
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  }
  graph.edges.sort(byPlace)

  // Journey order: from the start, following each page's lines in that order
  const starts = graph.nodes.filter(n => n.entry).sort((a, b) => (b.id === graph.meta.mainEntry) - (a.id === graph.meta.mainEntry))
  const seen = new Set()
  const order = []
  const queue = starts.map(n => n.id)
  queue.forEach(id => seen.add(id))
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    for (const e of graph.edges) {
      if (e.from !== id || e.return || seen.has(e.to)) continue
      seen.add(e.to)
      queue.push(e.to)
    }
  }
  const rank = new Map(order.map((id, i) => [id, i]))
  const before = new Map(graph.nodes.map((n, i) => [n.id, i]))
  graph.nodes.sort((a, b) => (rank.has(a.id) ? rank.get(a.id) : order.length + before.get(a.id)) -
    (rank.has(b.id) ? rank.get(b.id) : order.length + before.get(b.id)))
}

async function addLayouts (graph) {
  orderBranches(graph)
  graph.nodes.forEach(measure)
  graph.edges.forEach(e => { e.shortLabel = e.label ? shortLabel(e.label) : '' })
  graph.layouts = {
    DOWN: await layoutOne(graph, 'DOWN', false),
    RIGHT: await layoutOne(graph, 'RIGHT', false)
  }
  if (graph.meta.screenshots) {
    for (const dir of ['DOWN', 'RIGHT']) {
      graph.layouts[dir + ':thumbs'] = await layoutOne(graph, dir, 'thumbs')
      graph.layouts[dir + ':full'] = await layoutOne(graph, dir, 'full')
    }
    graph.nodes.forEach(n => { if (n.type === 'page') n.stateCards = stateCardsFor(n) })
    if (graph.nodes.some(n => n.stateCards && n.stateCards.length)) {
      for (const dir of ['DOWN', 'RIGHT']) graph.layouts[dir + ':states'] = await layoutOne(graph, dir, 'states')
    }
  }
  return graph
}

module.exports = { addLayouts, wrapText, errorTrigger, measure, stateCardsFor, layoutOne }
