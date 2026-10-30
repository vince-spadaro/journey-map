(function () {
  'use strict'

  // The page exactly as it was opened, before anything is drawn, for
  // "Interactive map (HTML)" to save again
  const pristineHtml = '<!doctype html>\n' + document.documentElement.outerHTML
  const data = JSON.parse(document.getElementById('journey-data').textContent)
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const $ = selector => document.querySelector(selector)

  const nodesById = new Map(data.nodes.map(n => [n.id, n]))
  const edgesById = new Map(data.edges.map(e => [e.id, e]))
  const outgoing = new Map(data.nodes.map(n => [n.id, []]))
  const incoming = new Map(data.nodes.map(n => [n.id, []]))
  data.edges.forEach(e => { outgoing.get(e.from).push(e); incoming.get(e.to).push(e) })

  const svg = $('#map')
  const viewport = $('#viewport')
  const canvas = $('#canvas')
  const panel = $('#panel')
  const layers = { edges: $('#edges'), returns: $('#return-edges'), labels: $('#labels'), nodes: $('#nodes') }

  // Remembered per viewer; the page works without it
  const store = {
    get (key) { try { return localStorage.getItem('journey-map:' + key) } catch (err) { return null } },
    set (key, value) { try { localStorage.setItem('journey-map:' + key, value) } catch (err) {} },
    remove (key) { try { localStorage.removeItem('journey-map:' + key) } catch (err) {} }
  }

  const hasShots = !!data.meta.screenshots
  // Pages in journey order, for stepping through screenshots
  const screens = data.nodes.filter(n => n.type === 'page' && n.shot)

  const state = {
    dir: store.get('dir') === 'RIGHT' ? 'RIGHT' : 'DOWN',
    selected: null,
    thumbs: hasShots && store.get('thumbs') !== 'false',
    viewing: null,
    viewingState: 0,
    sharp: false,
    screenZoom: store.get('screen-zoom') || 'fit',
    matches: [],
    matchIndex: -1,
    view: { x: 0, y: 0, k: 1 },
    // Only while a Mural export draws the map to save it: which layout
    // ('full' or 'states') and the screenshots to put in it, and when screens
    // are left out, the pages and lines kept and where they go
    exporting: null,
    // Choosing screens to export: the map is shown as the export will be,
    // with every state, and a tick box on each screen
    choosing: false
  }

  function currentLayout () {
    const thumbs = data.layouts[state.dir + (hasShots && state.thumbs ? ':thumbs' : '')]
    if (state.exporting && state.exporting.positions) return state.exporting.positions
    // Maps made before whole screenshots were exported keep their thumbnails' shape
    if (state.exporting) return data.layouts[state.dir + ':' + state.exporting.layout] || thumbs
    if (state.choosing) return (hasShots && (data.layouts[state.dir + ':states'] || data.layouts[state.dir + ':full'])) || data.layouts[state.dir]
    return thumbs
  }

  // Tick boxes show while choosing, but never in an export
  const choosing = () => state.choosing && !state.exporting

  // What's drawn: the whole map, or while exporting, the screens kept
  const drawn = () => state.exporting && state.exporting.nodes ? state.exporting : data

  const KIND_LABEL = { page: 'Page', decision: 'Decision made in code', exit: 'Outside this journey', missing: 'Page not found' }

  function make (tag, attrs, parent, text) {
    const el = document.createElementNS(SVG_NS, tag)
    for (const key in attrs) if (attrs[key] != null) el.setAttribute(key, attrs[key])
    if (text != null) el.textContent = text
    if (parent) parent.appendChild(el)
    return el
  }

  function h (tag, props, ...children) {
    const el = document.createElement(tag)
    for (const key in props || {}) {
      const value = props[key]
      if (value == null || value === false) continue
      if (key === 'class') el.className = value
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
      else el.setAttribute(key, value)
    }
    children.flat(Infinity).forEach(child => {
      if (child == null || child === false || child === '') return
      el.append(child.nodeType ? child : String(child))
    })
    return el
  }

  // ---------------------------------------------------------------- header

  function plural (n, word, many) { return n + ' ' + (n === 1 ? word : many || word + 's') }

  // When the map was made, in the reader's own time. Maps made before this was
  // added don't have it.
  const createdAt = data.meta.createdAt ? new Date(data.meta.createdAt) : null
  const madeOn = () => createdAt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  const madeAt = () => madeOn() + ', ' + createdAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  // For file names, so saved copies sort in the order they were made
  const pad = n => String(n).padStart(2, '0')
  const madeStamp = () => createdAt
    ? createdAt.getFullYear() + '-' + pad(createdAt.getMonth() + 1) + '-' + pad(createdAt.getDate()) + '-' + pad(createdAt.getHours()) + pad(createdAt.getMinutes())
    : new Date().toISOString().slice(0, 10)

  function fillHeader () {
    const s = data.meta.stats
    $('#journey-name').textContent = data.meta.name
    document.title = data.meta.name + ' – Journey map' + (createdAt ? ' – ' + madeOn() : '')
    const parts = [plural(s.pages, 'page'), plural(s.branches, 'branch', 'branches')]
    if (s.decisions) parts.push(plural(s.decisions, 'decision'))
    parts.push(data.meta.scope)
    if (data.meta.start) parts.push('from ' + data.meta.start.split('/').pop())
    if (createdAt) parts.push('made ' + madeAt())
    $('#journey-meta').textContent = parts.join(' · ')
  }

  // ---------------------------------------------------------------- drawing

  function roundedPath (points, radius) {
    let d = 'M' + points[0].x + ' ' + points[0].y
    for (let i = 1; i < points.length - 1; i++) {
      const p0 = points[i - 1]
      const p1 = points[i]
      const p2 = points[i + 1]
      const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y)
      const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y)
      if (!d1 || !d2) { d += ' L' + p1.x + ' ' + p1.y; continue }
      const r = Math.min(radius, d1 / 2, d2 / 2)
      const ax = p1.x - (p1.x - p0.x) / d1 * r
      const ay = p1.y - (p1.y - p0.y) / d1 * r
      const bx = p1.x + (p2.x - p1.x) / d2 * r
      const by = p1.y + (p2.y - p1.y) / d2 * r
      d += ' L' + ax + ' ' + ay + ' Q' + p1.x + ' ' + p1.y + ' ' + bx + ' ' + by
    }
    const last = points[points.length - 1]
    return d + ' L' + last.x + ' ' + last.y
  }

  // Return links curve out to the side, so they don't cross the main flow
  // `lane` separates several return links between the same two pages
  function returnPath (from, to, lane = 0) {
    if (state.dir === 'DOWN') {
      const sx = from.x + from.width
      const sy = from.y + from.height / 2
      const tx = to.x + to.width
      const ty = to.y + to.height / 2
      const out = Math.max(sx, tx) + 40 + Math.min(240, Math.abs(sy - ty) * 0.2) + lane * 48
      return {
        d: 'M' + sx + ' ' + sy + ' C' + out + ' ' + sy + ' ' + out + ' ' + ty + ' ' + tx + ' ' + ty,
        points: [{ x: sx, y: sy }, { x: out, y: sy }, { x: out, y: ty }, { x: tx, y: ty }]
      }
    }
    const sx = from.x + from.width / 2
    const sy = from.y + from.height
    const tx = to.x + to.width / 2
    const ty = to.y + to.height
    const out = Math.max(sy, ty) + 40 + Math.min(240, Math.abs(sx - tx) * 0.1) + lane * 48
    return {
      d: 'M' + sx + ' ' + sy + ' C' + sx + ' ' + out + ' ' + tx + ' ' + out + ' ' + tx + ' ' + ty,
      points: [{ x: sx, y: sy }, { x: sx, y: out }, { x: tx, y: out }, { x: tx, y: ty }]
    }
  }

  // A point part-way along a curve (t from 0 to 1)
  function pointOn (c, t) {
    const u = 1 - t
    const at = key => u * u * u * c[0][key] + 3 * u * u * t * c[1][key] + 3 * u * t * t * c[2][key] + t * t * t * c[3][key]
    return { x: at('x'), y: at('y') }
  }

  // Where a return link's label goes: the first spot along its curve, from
  // the middle outwards, that doesn't cover a page or another label
  const LABEL_SPOTS = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.45, 0.55, 0.35, 0.65, 0.25, 0.75]
  function placeLabel (curve, width, taken) {
    const box = t => {
      const p = pointOn(curve.points, t)
      return { x: p.x - width / 2, y: p.y - 10, width, height: 20, cx: p.x, cy: p.y }
    }
    const clear = b => !taken.some(o => b.x < o.x + o.width + 4 && o.x < b.x + b.width + 4 && b.y < o.y + o.height + 3 && o.y < b.y + b.height + 3)
    const spot = LABEL_SPOTS.map(box).find(clear) || box(0.5)
    taken.push(spot)
    return spot
  }

  // The words on the link or button, as on the page: "Change contact name"
  function linkWords (e) {
    const words = e.fullTexts && e.fullTexts.length ? e.fullTexts : e.texts
    if (!words.length) return describeEdge(e)
    const first = words[0].length > 40 ? words[0].slice(0, 39) + '…' : words[0]
    return first + (words.length > 1 ? ' (+' + (words.length - 1) + ')' : '')
  }

  function isOutside (node) { return !!node.outside }

  function draw () {
    const layout = currentLayout()
    const { nodes, edges } = drawn()
    Object.values(layers).forEach(layer => layer.replaceChildren())
    const lanes = {}
    // Pages and branch labels that return link labels must not cover
    const taken = Object.values(layout.nodes).map(b => ({ x: b.x, y: b.y, width: b.width, height: b.height }))
      .concat(Object.values(layout.edges).filter(g => g.label).map(g => ({ ...g.label })))

    for (const e of edges) {
      const outside = isOutside(nodesById.get(e.to)) || isOutside(nodesById.get(e.from))
      if (e.return) {
        const from = layout.nodes[e.from]
        const to = layout.nodes[e.to]
        if (!from || !to) continue
        const pair = e.from + ' ' + e.to
        lanes[pair] = (lanes[pair] ?? -1) + 1
        const curve = returnPath(from, to, lanes[pair])
        const path = make('path', {
          d: curve.d,
          class: 'edge edge-return' + (outside ? ' is-outside' : '') + leftOutClass(e),
          'data-edge': e.id,
          'marker-end': 'url(#arrow-return)'
        }, layers.returns)
        make('title', null, path, describeEdge(e) + ': ' + titleOf(e.from) + ' → ' + titleOf(e.to))
        const words = linkWords(e)
        const spot = placeLabel(curve, Math.round(words.length * 6.5 + 16), taken)
        const g = make('g', { class: 'label label-return' + (outside ? ' is-outside' : '') + leftOutClass(e), 'data-edge': e.id }, layers.returns)
        make('title', null, g, describeEdge(e) + ': ' + titleOf(e.from) + ' → ' + titleOf(e.to))
        make('rect', { x: spot.x, y: spot.y, width: spot.width, height: 20, rx: 10 }, g)
        make('text', { x: spot.cx, y: spot.cy + 4, 'text-anchor': 'middle' }, g, words)
        continue
      }
      const geo = layout.edges[e.id]
      if (!geo) continue
      const path = make('path', {
        d: roundedPath(geo.points, 10),
        class: 'edge edge-' + e.kind + (outside ? ' is-outside' : '') + leftOutClass(e),
        'data-edge': e.id,
        'marker-end': e.kind === 'link' ? 'url(#arrow-link)' : 'url(#arrow-flow)'
      }, layers.edges)
      make('title', null, path, describeEdge(e) + ': ' + titleOf(e.from) + ' → ' + titleOf(e.to))

      if (e.label && geo.label) {
        const g = make('g', { class: 'label' + (outside ? ' is-outside' : '') + leftOutClass(e), 'data-edge': e.id }, layers.labels)
        make('title', null, g, e.label + (e.code && e.code !== 'otherwise' ? '\n' + e.code : ''))
        make('rect', { x: geo.label.x, y: geo.label.y, width: geo.label.width, height: geo.label.height, rx: 4 }, g)
        make('text', { x: geo.label.x + geo.label.width / 2, y: geo.label.y + 14, 'text-anchor': 'middle' }, g, e.shortLabel)
      }
    }

    for (const n of nodes) {
      const box = layout.nodes[n.id]
      if (box) drawNode(n, box)
    }
    updateThumbQuality(true)
    applyHighlights()
  }

  const leftOutClass = e => choosing() && (leftOut.has(e.from) || leftOut.has(e.to)) ? ' is-left-out' : ''

  const THUMB_HEIGHT = 165

  function drawThumb (n, g, box, height) {
    const width = box.width - 28
    const clipId = 'clip-' + n.id.replace(/[^a-z0-9]/gi, '-')
    const clip = make('clipPath', { id: clipId }, g)
    make('rect', { x: 14, y: 14, width, height, rx: 4 }, clip)
    if (n.thumb) {
      make('image', {
        class: 'thumb',
        href: state.choosing && n.shot ? n.shot : n.thumb,
        x: 14,
        y: 14,
        width,
        height,
        preserveAspectRatio: 'xMidYMin slice',
        'clip-path': 'url(#' + clipId + ')'
      }, g)
    } else {
      make('rect', { class: 'thumb-empty', x: 14, y: 14, width, height, rx: 4 }, g)
      make('text', { class: 'thumb-empty-text', x: 14 + width / 2, y: 14 + height / 2 + 4, 'text-anchor': 'middle' }, g, 'No screenshot')
    }
    make('rect', { class: 'thumb-frame', x: 14, y: 14, width, height, rx: 4 }, g)
  }

  function drawNode (n, box) {
    const classes = ['node', 'node-' + n.type]
    if (n.entry) classes.push('is-entry')
    if (isOutside(n)) classes.push('is-outside')
    if (choosing() && leftOut.has(n.id)) classes.push('is-left-out')

    const g = make('g', {
      class: classes.join(' '),
      transform: 'translate(' + box.x + ' ' + box.y + ')',
      'data-id': n.id,
      tabindex: '0',
      role: 'button',
      'aria-label': KIND_LABEL[n.type] + ': ' + n.title
    }, layers.nodes)
    make('title', null, g, n.title + '\n' + (n.file || n.url))
    // In the Mural exports the screenshot is whole, and with all states the
    // page's box also holds its state cards
    const card = box.card || box
    make('rect', { class: 'card', width: card.width, height: card.height, rx: 8 }, g)

    if (n.type === 'page') {
      const picture = (state.exporting || state.choosing) && card.picture ? card.picture : THUMB_HEIGHT
      const shift = hasShots && (state.exporting ? state.exporting.layout : state.choosing || state.thumbs) ? picture + 10 : 0
      if (shift) drawThumb(n, g, card, picture)
      n.lines.forEach((line, i) => make('text', { class: 'title', x: 14, y: shift + 30 + i * 19 }, g, line))
      const top = shift + 16 + n.lines.length * 19 + 4
      // The whole file name, one line or more (sizes match lib/layout.js)
      n.fileLines.forEach((line, i) => make('text', { class: 'file', x: 14, y: top + 11 + i * 13 }, g, line))
      const badgeTop = top + 3 + Math.max(1, n.fileLines.length) * 13 + 6
      let x = 14
      // While choosing, tags count only the states and errors ticked
      const badges = choosing() ? keptCopy(n).badges : n.badges
      badges.forEach(badge => {
        make('rect', { class: 'badge badge-' + badge.kind, x, y: badgeTop, width: badge.width, height: 20, rx: 10 }, g)
        make('text', { class: 'badge-text badge-text-' + badge.kind, x: x + badge.width / 2, y: badgeTop + 14, 'text-anchor': 'middle' }, g, badge.text)
        x += badge.width + 6
      })
      if (box.cards) n.stateCards.forEach((sc, i) => drawStateCard(n, sc, box.cards[i], g))
      if (choosing()) drawCheck(g, n.id, n.title)
    } else if (n.type === 'decision') {
      make('text', { class: 'kind', x: 14, y: 23 }, g, '◆ DECISION IN CODE')
      n.lines.forEach((line, i) => make('text', { class: 'title', x: 14, y: 41 + i * 18 }, g, line))
    } else {
      make('text', { class: 'kind', x: 12, y: 20 }, g, n.type === 'missing' ? '✕ PAGE NOT FOUND' : '↗ OUTSIDE THIS JOURNEY')
      n.lines.forEach((line, i) => make('text', { class: 'title', x: 12, y: 36 + i * 17 }, g, line))
    }
    return g
  }

  // A tick box on the corner of a screen, state or error while choosing what to export
  function drawCheck (g, key, name) {
    const kept = !leftOut.has(key)
    const box = make('g', { class: 'export-check', 'data-key': key, transform: 'translate(-11 -11)', tabindex: '0', role: 'checkbox', 'aria-checked': String(kept), 'aria-label': 'Export ' + name }, g)
    make('title', null, box, kept ? 'In the export. Click to leave it out.' : 'Left out of the export. Click to put it back.')
    make('rect', { width: 26, height: 26, rx: 5 }, box)
    if (kept) make('path', { d: 'M7 13.5 L11.5 18 L19.5 8.5' }, box)
  }

  // A state's screenshot with its name underneath (sizes match lib/layout.js)
  function drawStateCard (n, sc, box, parent) {
    const key = n.id + '#' + sc.index
    const g = make('g', {
      class: 'state-card' + (sc.error ? ' state-card-error' : '') + (choosing() && leftOut.has(key) ? ' is-left-out' : ''),
      transform: 'translate(' + box.x + ' ' + box.y + ')',
      'data-key': key
    }, parent)
    const triggerLines = sc.triggerLines || []
    make('title', null, g, n.title + ': ' + sc.kind + '\n' + triggerLines.concat(sc.lines).join(' '))
    make('rect', { class: 'card', width: box.width, height: box.height, rx: 8 }, g)
    const width = box.width - 28
    const clipId = 'clip-' + n.id.replace(/[^a-z0-9]/gi, '-') + '-' + sc.index
    const height = box.picture
    make('rect', { x: 14, y: 14, width, height, rx: 4 }, make('clipPath', { id: clipId }, g))
    make('image', {
      class: 'state-thumb',
      href: state.exporting ? state.exporting.pictures.get(key) : n.states[sc.index - 1].shot,
      x: 14,
      y: 14,
      width,
      height,
      preserveAspectRatio: 'xMidYMin slice',
      'clip-path': 'url(#' + clipId + ')'
    }, g)
    make('rect', { class: 'thumb-frame', x: 14, y: 14, width, height, rx: 4 }, g)
    const top = 14 + height + 18
    make('text', { class: 'kind', x: 14, y: top }, g, sc.kind.toUpperCase())
    // What makes an error show, in bold, then the message (sizes match lib/layout.js)
    triggerLines.forEach((line, i) => make('text', { class: 'state-text state-trigger', x: 14, y: top + 18 + i * 17 }, g, line))
    sc.lines.forEach((line, i) => make('text', { class: 'state-text', x: 14, y: top + 18 + (triggerLines.length + i) * 17 }, g, line))
    if (choosing()) drawCheck(g, key, n.title + ', ' + sc.kind)
  }

  // ---------------------------------------------------------------- text

  function titleOf (id) { return nodesById.get(id).title }

  function quoteList (texts) {
    return texts.map(t => '“' + t + '”').join(', ')
  }

  function describeEdge (e) {
    const words = e.fullTexts && e.fullTexts.length ? e.fullTexts : e.texts
    if (e.kind === 'change') return words.length ? 'Change link ' + quoteList(words) : 'Change link'
    if (e.kind === 'redirect') return 'Redirect'
    if (e.kind === 'submit') return 'Continue'
    return words.length ? 'Link ' + quoteList(words) : 'Link'
  }

  function conditionText (label, e) {
    if (!label) return ''
    if (e && e.named) return label
    if (/^Any other (answer|result)$/.test(label)) return label
    if (label === 'otherwise') return 'Otherwise'
    if (label.startsWith('“')) return 'If they choose ' + label
    if (label.startsWith('not “')) return 'If they don’t choose ' + label.slice(4)
    if (label.startsWith('no answer to')) return 'If there’s ' + label
    return label.startsWith('if ') ? 'If ' + label.slice(3) : 'When ' + label
  }

  // Screenshots show folded-away content opened; say so, as the page opens closed
  function expandedNote (n) {
    const e = n.expanded
    if (!n.shot || !e) return null
    const parts = []
    if (e.details) parts.push(plural(e.details, 'details component'))
    if (e.accordions) parts.push(plural(e.accordions, 'accordion'))
    if (e.tabs) parts.push(e.tabs === 1 ? 'all tabs' : 'all tabs in ' + e.tabs + ' tab sets')
    if (!parts.length) return null
    return h('p', { class: 'panel__note' }, 'Screenshots show ' + parts.join(', ') + ' opened, so all the content can be reviewed. On the page they start closed.')
  }

  // Every screen state of a page, each opening in the full-screen view
  function stateButton (n, index, label) {
    return h('button', { class: 'linkish', type: 'button', onclick: () => openScreen(n.id, index) }, label)
  }

  function statesBox (n) {
    const indexed = n.states.map((st, i) => ({ st, index: i + 1 }))
    const others = indexed.filter(x => x.st.kind !== 'error')
    const errors = indexed.filter(x => x.st.kind === 'error')
    // The page as it opens counts as a state, as on the map's tags
    const parts = [plural(others.length + 1, 'state')]
    if (errors.length) parts.push(plural(errors.length, 'error'))
    return h('div', { class: 'panel__states' },
      h('p', null, h('strong', null, parts.join(' · '))),
      others.length ? [
        h('p', { class: 'panel__states-group' }, 'States'),
        h('ul', null,
          h('li', null,
            stateButton(n, 0, openingLabel(n)),
            h('span', { class: 'panel__how' }, 'When the page is first opened' + (n.sameAsAnswer ? ', or after choosing “' + n.sameAsAnswer + '”' : ''))
          ),
          others.map(({ st, index }) => h('li', null,
            stateButton(n, index, stateLabel(st)),
            h('span', { class: 'panel__how' },
              st.listed ? 'Listed on the journey’s index page'
                : st.kind === 'variant' ? 'After the link “' + st.label + '” (' + st.query + ')'
                : st.kind === 'answer' ? 'After choosing “' + st.label + '”' + (st.question ? ' for “' + st.question + '”' : '')
                  : 'When this option is chosen')
          ))
        )
      ] : null,
      errors.length ? [
        h('p', { class: 'panel__states-group panel__states-group--error' }, 'Errors'),
        h('ul', null, errors.map(({ st, index }) => h('li', null,
          stateButton(n, index, st.messages.join(' / ')),
          h('span', { class: 'panel__how' }, 'After: ' + st.label)
        )))
      ] : null
    )
  }

  // The rule from the routes, for designers who want to check the code
  function codeNote (code) {
    return code ? h('span', { class: 'panel__code' }, 'Route rule: ', h('code', null, code)) : null
  }

  // ---------------------------------------------------------------- selection

  // The selected page, every page on the way to it, and the pages it leads to next
  function related (id) {
    const nodes = new Set([id])
    const edges = new Set()
    const queue = [id]
    while (queue.length) {
      const current = queue.shift()
      for (const e of incoming.get(current)) {
        if (e.return) continue
        edges.add(e.id)
        if (!nodes.has(e.from)) { nodes.add(e.from); queue.push(e.from) }
      }
    }
    for (const e of outgoing.get(id)) { edges.add(e.id); nodes.add(e.to) }
    for (const e of incoming.get(id)) if (e.return) { edges.add(e.id); nodes.add(e.from) }
    return { nodes, edges }
  }

  function applyHighlights () {
    const sel = state.selected ? related(state.selected) : null
    svg.classList.toggle('has-selection', !!sel)
    svg.querySelectorAll('.node').forEach(el => {
      const id = el.getAttribute('data-id')
      el.classList.toggle('is-related', !!sel && sel.nodes.has(id))
      el.classList.toggle('is-selected', id === state.selected)
      el.classList.toggle('is-match', state.matches.includes(id))
    })
    svg.querySelectorAll('[data-edge]').forEach(el => {
      el.classList.toggle('is-related', !!sel && sel.edges.has(el.getAttribute('data-edge')))
    })
    svg.classList.toggle('is-searching', state.matches.length > 0)
  }

  function select (id, centre) {
    state.selected = id
    applyHighlights()
    showDetails(nodesById.get(id))
    if (centre) centreOn(id)
  }

  function clearSelection () {
    state.selected = null
    applyHighlights()
    panel.hidden = true
  }

  // ---------------------------------------------------------------- panel

  function nodeButton (id) {
    return h('button', { class: 'linkish', type: 'button', onclick: () => select(id, true) }, titleOf(id))
  }

  function edgeItem (e, otherId) {
    const condition = conditionText(e.label, e)
    return h('li', null,
      nodeButton(otherId),
      h('span', { class: 'panel__how' },
        describeEdge(e),
        e.query ? ' (' + e.query + ')' : '',
        condition ? h('span', null, ' · ', h('b', null, condition)) : null
      ),
      e.excludes && e.excludes.length
        ? h('span', { class: 'panel__how' }, 'Not: ' + e.excludes.map(x => conditionText(x).replace(/^(If they choose |When )/, '')).join('; '))
        : null,
      codeNote(e.code)
    )
  }

  // Like replaceChildren, but skips empty values and flattens lists
  function fillPanel (...children) {
    panel.replaceChildren(...children.flat(Infinity).filter(child => child != null && child !== false && child !== ''))
  }

  function section (title, items, empty) {
    if (!items.length && !empty) return null
    return [h('h3', null, title), items.length ? h('ul', null, items) : h('p', { class: 'panel__empty' }, empty)]
  }

  // VS Code needs the file's full path, which is where the prototype was on
  // the computer that made the map. Someone with their own copy somewhere
  // else says where it is once, and it's remembered in their browser for
  // every map of that prototype.
  const madeIn = data.meta.prototypeRoot || ''
  const FOLDER_KEY = 'prototype-folder:' + madeIn
  const slashes = path => path.replace(/\\/g, '/').replace(/\/+$/, '')
  const prototypeFolder = () => store.get(FOLDER_KEY) || madeIn

  function vscodeLink (file) {
    let clean = slashes(file)
    const from = slashes(madeIn)
    if (from && clean.startsWith(from + '/')) clean = slashes(prototypeFolder()) + clean.slice(from.length)
    return 'vscode://file' + (clean.startsWith('/') ? '' : '/') + encodeURI(clean)
  }

  // Under the VS Code links: which copy of the prototype they open, and a way
  // to use your own
  function folderNote (n) {
    if (!madeIn || !(n.absFile || n.absRouteFile)) return null
    const own = store.get(FOLDER_KEY)
    const box = h('div', { class: 'panel__folder' })
    const showNote = () => box.replaceChildren(
      h('span', null, 'Opens files in ', h('code', null, prototypeFolder()), '. '),
      h('button', { class: 'linkish', type: 'button', onclick: showForm }, own ? 'Change' : 'Use my copy of the prototype')
    )
    function showForm () {
      const field = h('input', { type: 'text', id: 'prototype-folder', class: 'panel__folder-field', spellcheck: 'false', autocomplete: 'off' })
      field.value = prototypeFolder()
      const save = value => {
        const folder = slashes(value.trim())
        if (!folder || folder === slashes(madeIn)) store.remove(FOLDER_KEY)
        else store.set(FOLDER_KEY, folder)
        showDetails(n)
      }
      box.replaceChildren(h('form', { onsubmit: event => { event.preventDefault(); save(field.value) } },
        h('label', { for: 'prototype-folder' }, 'Where is your copy of the prototype?'),
        h('p', { class: 'panel__how' }, 'On a Mac, right-click the prototype folder in Finder, hold Option and choose “Copy as Pathname”. On Windows, hold Shift, right-click the folder and choose “Copy as path”. Then paste it here.'),
        field,
        h('div', { class: 'panel__folder-actions' },
          h('button', { class: 'btn', type: 'submit' }, 'Save'),
          own ? h('button', { class: 'linkish', type: 'button', onclick: () => save('') }, 'Use the original folder') : null,
          h('button', { class: 'linkish', type: 'button', onclick: showNote }, 'Cancel')
        )
      ))
      field.focus()
      field.select()
    }
    showNote()
    return box
  }

  function showDetails (n) {
    const out = outgoing.get(n.id).slice().sort((a, b) => a.return - b.return)
    const into = incoming.get(n.id).slice().sort((a, b) => a.return - b.return)
    const prototypeUrl = 'http://localhost:' + data.meta.port + n.url

    fillPanel(
      h('button', { class: 'panel__close', type: 'button', 'aria-label': 'Close', onclick: clearSelection }, '×'),
      n.shot ? h('button', { class: 'panel__shot', type: 'button', 'aria-label': 'Show the full screenshot', onclick: () => openScreen(n.id) },
        h('img', { src: n.shot, alt: 'Screenshot of ' + n.title }),
        h('span', null, 'Full screen')
      ) : null,
      expandedNote(n),
      hasShots && n.type === 'page' && !n.shot ? h('p', { class: 'panel__empty' }, 'No screenshot' + (n.shotError ? ': ' + n.shotError : '')) : null,
      n.shot && n.states.length ? statesBox(n) : null,
      h('p', { class: 'panel__kind' }, KIND_LABEL[n.type] + (n.entry ? ' · Start' : '')),
      h('h2', null, n.title),
      n.heading && n.heading !== n.title ? h('p', { class: 'panel__heading' }, n.heading) : null,
      // This version of the page, after these answers
      (n.answersInWords || []).length ? h('div', { class: 'panel__answers' },
        h('p', { class: 'panel__states-group' }, 'After these answers'),
        h('ul', null, n.answersInWords.map(a => h('li', null, h('strong', null, a.answer), h('span', { class: 'panel__how' }, a.question))))
      ) : null,
      h('p', { class: 'panel__url' }, h('code', null, n.url)),
      h('div', { class: 'panel__actions' },
        n.type !== 'missing' ? h('a', { href: prototypeUrl, target: '_blank', rel: 'noopener' }, 'Open in prototype ↗') : null,
        n.absFile ? h('a', { class: 'secondary', href: vscodeLink(n.absFile) }, 'Open in VS Code') : null,
        n.absRouteFile ? h('a', { class: 'secondary', href: vscodeLink(n.absRouteFile) }, 'Open the routes in VS Code') : null
      ),
      folderNote(n),
      n.file ? h('p', null, h('code', null, n.file)) : null,
      n.routeFile ? h('p', null, 'The route in ', h('code', null, n.routeFile), ' decides where to go next.') : null,
      n.notes.map(text => h('p', { class: 'panel__note' }, text)),
      section('Goes to', out.map(e => edgeItem(e, e.to)), n.type === 'page' ? 'Nothing – this is the end of the journey.' : ''),
      section('Comes from', into.map(e => edgeItem(e, e.from)), n.type === 'page' && !n.entry ? 'No page links here.' : ''),
      // The errors the routes can show, only when they weren't photographed:
      // photographed errors are already in the states box above
      section('Errors', (n.states.some(st => st.kind === 'error') ? [] : n.errorStates).map(state => h('li', { class: 'panel__error' },
        state.messages.length ? state.messages.map(m => h('strong', { style: 'display:block' }, m)) : h('strong', null, 'Shows an error message'),
        h('span', { class: 'panel__how' }, hasShots ? 'Not photographed: the tool couldn’t make this error appear' : 'Run the tool with screenshots to see this error')
      ))),
      // Photographed versions are in the states box; without screenshots, list the links
      section('Other versions of this page', (n.states.some(st => st.kind === 'variant') ? [] : n.variants).map(v => h('li', null,
        h('a', { href: prototypeUrl + v.query, target: '_blank', rel: 'noopener' }, v.query),
        v.text ? h('span', { class: 'panel__how' }, 'Link “' + v.text + '”') : null
      ))),
      externalLinks(n)
    )
    panel.hidden = false
    panel.scrollTop = 0
  }

  // Links that leave the prototype, collapsed so they don't crowd the panel
  function externalLinks (n) {
    if (!n.externalLinks.length) return null
    const count = n.externalLinks.length
    return h('details', { class: 'panel__details' },
      h('summary', null, 'Links to ' + plural(count, 'external website')),
      h('ul', null, n.externalLinks.map(link => {
        let site = link.href
        try { site = new URL(link.href).hostname.replace(/^www\./, '') } catch (err) {}
        return h('li', null,
          h('a', { href: link.href, target: '_blank', rel: 'noopener noreferrer', class: 'panel__external' },
            (link.text || link.href) + ' ↗'),
          h('span', { class: 'panel__how' }, site)
        )
      }))
    )
  }

  // ---------------------------------------------------------------- pan and zoom

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  function applyView () {
    const v = state.view
    viewport.setAttribute('transform', 'translate(' + v.x + ' ' + v.y + ') scale(' + v.k + ')')
    $('#zoom-level').textContent = Math.round(v.k * 100) + '%'
    updateThumbQuality()
  }

  // Thumbnails are small. Zoomed in, cards switch to the full screenshot,
  // which shows the same top of the page with far more detail.
  const SHARP_ZOOM = 1.3
  function updateThumbQuality (force) {
    const sharp = state.view.k >= SHARP_ZOOM
    if (sharp === state.sharp && !force) return
    state.sharp = sharp
    layers.nodes.querySelectorAll('image.thumb').forEach(img => {
      const n = nodesById.get(img.closest('.node').getAttribute('data-id'))
      img.setAttribute('href', (sharp || state.choosing) && n.shot ? n.shot : n.thumb)
    })
  }

  function zoomAt (cx, cy, factor) {
    const v = state.view
    const k = clamp(v.k * factor, 0.1, 3)
    v.x = cx - (cx - v.x) * (k / v.k)
    v.y = cy - (cy - v.y) * (k / v.k)
    v.k = k
    applyView()
  }

  function visibleWidth () {
    const rect = canvas.getBoundingClientRect()
    return panel.hidden ? rect.width : Math.max(200, rect.width - panel.offsetWidth - 24)
  }

  function fit () {
    const box = viewport.getBBox()
    const rect = canvas.getBoundingClientRect()
    if (!box.width || !rect.width) return
    const pad = 40
    const k = clamp(Math.min((visibleWidth() - pad * 2) / box.width, (rect.height - pad * 2) / box.height), 0.1, 1)
    state.view = {
      k,
      x: (visibleWidth() - box.width * k) / 2 - box.x * k,
      y: Math.max(pad, (rect.height - box.height * k) / 2) - box.y * k
    }
    applyView()
  }

  // Brings the given pages into view: zoomed out just enough to show them all,
  // and no bigger than full size
  function showPages (ids) {
    const layout = currentLayout()
    const hideOutside = svg.classList.contains('hide-outside')
    const boxes = ids
      .filter(id => !(hideOutside && nodesById.get(id).outside))
      .map(id => layout.nodes[id])
      .filter(Boolean)
    if (!boxes.length) return
    const rect = canvas.getBoundingClientRect()
    const pad = 60
    const x1 = Math.min(...boxes.map(b => b.x))
    const y1 = Math.min(...boxes.map(b => b.y))
    const x2 = Math.max(...boxes.map(b => b.x + b.width))
    const y2 = Math.max(...boxes.map(b => b.y + b.height))
    const k = clamp(Math.min((visibleWidth() - pad * 2) / (x2 - x1), (rect.height - pad * 2) / (y2 - y1)), 0.1, 1)
    state.view = {
      k,
      x: visibleWidth() / 2 - ((x1 + x2) / 2) * k,
      y: rect.height / 2 - ((y1 + y2) / 2) * k
    }
    applyView()
  }

  // Opens on the start of the journey at a readable size, or the whole map if it fits
  function initialView () {
    const box = viewport.getBBox()
    const rect = canvas.getBoundingClientRect()
    if (!box.width || !rect.width) return
    const pad = 40
    const fitAll = Math.min((visibleWidth() - pad * 2) / box.width, (rect.height - pad * 2) / box.height)
    const start = currentLayout().nodes[data.meta.mainEntry]
    if (fitAll >= 0.6 || !start) return fit()
    const k = 0.9
    state.view = state.dir === 'DOWN'
      ? { k, x: visibleWidth() / 2 - (start.x + start.width / 2) * k, y: pad - start.y * k }
      : { k, x: pad - start.x * k, y: rect.height / 2 - (start.y + start.height / 2) * k }
    applyView()
  }

  function centreOn (id) {
    const box = currentLayout().nodes[id]
    if (!box) return
    const rect = canvas.getBoundingClientRect()
    const k = Math.max(state.view.k, 0.7)
    state.view = { k, x: visibleWidth() / 2 - (box.x + box.width / 2) * k, y: rect.height / 2 - (box.y + box.height / 2) * k }
    applyView()
  }

  canvas.addEventListener('wheel', event => {
    event.preventDefault()
    const rect = canvas.getBoundingClientRect()
    if (event.ctrlKey || event.metaKey) {
      zoomAt(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-clamp(event.deltaY, -50, 50) * 0.01))
    } else {
      const scale = event.deltaMode === 1 ? 20 : 1
      state.view.x -= event.deltaX * scale
      state.view.y -= event.deltaY * scale
      applyView()
    }
  }, { passive: false })

  let drag = null
  let suppressClick = false
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    drag = { x: event.clientX, y: event.clientY, vx: state.view.x, vy: state.view.y, moved: false, pointer: event.pointerId }
  })
  svg.addEventListener('pointermove', event => {
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true
      svg.setPointerCapture(drag.pointer)
      svg.classList.add('is-panning')
    }
    if (drag.moved) {
      state.view.x = drag.vx + dx
      state.view.y = drag.vy + dy
      applyView()
    }
  })
  const endDrag = () => {
    if (drag && drag.moved) suppressClick = true
    svg.classList.remove('is-panning')
    drag = null
  }
  svg.addEventListener('pointerup', endDrag)
  svg.addEventListener('pointercancel', endDrag)
  svg.addEventListener('click', event => {
    if (suppressClick) { suppressClick = false; return }
    if (state.choosing) {
      // A click anywhere on a screen, state or error ticks or unticks it
      const target = event.target.closest('.export-check, .state-card, .node')
      if (target) toggleLeftOut(target.getAttribute('data-key') || target.getAttribute('data-id'))
      return
    }
    const node = event.target.closest('.node')
    if (node) select(node.getAttribute('data-id'))
    else clearSelection()
  })
  svg.addEventListener('keydown', event => {
    const node = event.target.closest && event.target.closest('.node')
    if (state.choosing && (event.key === 'Enter' || event.key === ' ')) {
      const check = event.target.closest('.export-check')
      if (check || node) { event.preventDefault(); toggleLeftOut(check ? check.getAttribute('data-key') : node.getAttribute('data-id')) }
      return
    }
    if (node && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      select(node.getAttribute('data-id'))
    }
  })

  function zoomCentre (factor) {
    const rect = canvas.getBoundingClientRect()
    zoomAt(visibleWidth() / 2, rect.height / 2, factor)
  }
  $('#zoom-in').addEventListener('click', () => zoomCentre(1.25))
  $('#zoom-out').addEventListener('click', () => zoomCentre(0.8))
  $('#zoom-fit').addEventListener('click', fit)

  document.addEventListener('keydown', event => {
    if (state.viewing) {
      if (event.target.matches('input, textarea')) {
        if (event.key === 'Escape') event.target.blur()
        return
      }
      const zooms = ['fit', '1', '1.5', '2']
      if (event.key === 'Escape') closeScreen()
      else if (event.key === '+' || event.key === '=') setScreenZoom(zooms[Math.min(zooms.length - 1, zooms.indexOf(state.screenZoom) + 1)])
      else if (event.key === '-') setScreenZoom(zooms[Math.max(0, zooms.indexOf(state.screenZoom) - 1)])
      else if (event.key === 'ArrowRight') stepScreen(1)
      else if (event.key === 'ArrowLeft') stepScreen(-1)
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const n = nodesById.get(state.viewing)
        const next = state.viewingState + (event.key === 'ArrowDown' ? 1 : -1)
        if (next >= 0 && next <= n.states.length) { event.preventDefault(); openScreen(n.id, next) }
      }
      return
    }
    if (event.target.matches('input, textarea')) {
      if (event.key === 'Escape') event.target.blur()
      return
    }
    if (event.key === 'Escape') state.choosing ? stopChoosing() : clearSelection()
    else if (event.key === '+' || event.key === '=') zoomCentre(1.25)
    else if (event.key === '-') zoomCentre(0.8)
    else if (event.key === '0' || event.key === 'f') fit()
    else if (event.key === '/') { event.preventDefault(); $('#search').focus() }
  })

  // ---------------------------------------------------------------- controls

  function setDirection (dir) {
    state.dir = dir
    store.set('dir', dir)
    document.querySelectorAll('[data-dir]').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.dir === dir)))
    draw()
    initialView()
  }
  document.querySelectorAll('[data-dir]').forEach(btn => btn.addEventListener('click', () => setDirection(btn.dataset.dir)))

  const showReturn = $('#show-return')
  showReturn.checked = store.get('return') === 'true'
  const applyReturn = () => { svg.classList.toggle('show-return', showReturn.checked); store.set('return', showReturn.checked) }
  showReturn.addEventListener('change', applyReturn)

  const showThumbs = $('#show-thumbs')
  if (hasShots) {
    showThumbs.closest('label').hidden = false
    showThumbs.checked = state.thumbs
    showThumbs.addEventListener('change', () => {
      state.thumbs = showThumbs.checked
      store.set('thumbs', state.thumbs)
      draw()
      if (state.selected) centreOn(state.selected)
      else initialView()
    })
  }

  // ---------------------------------------------------------------- full screenshots

  const viewer = $('#screen')

  // How a state is named in tabs and lists
  function stateLabel (st) {
    if (st.listed) return st.label
    if (st.kind === 'variant' || st.kind === 'answer') return 'After “' + st.label + '”'
    if (st.kind === 'error') {
      return 'Error: ' + st.messages[0] + (st.messages.length > 1 ? ' (+' + (st.messages.length - 1) + ' more)' : '')
    }
    return st.label + (st.type === 'checkbox' ? ' ticked' : ' selected')
  }

  // What makes an error show, in words: from the page's address, like
  // ?error=required, or what the tool typed when it tried the form itself
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

  // Full-screen tabs say what makes each error show, so a message can be
  // checked against it: "Nothing entered: Enter your client’s …"
  function screenTabLabel (st) {
    const trigger = st.kind === 'error' ? errorTrigger(st) : ''
    return trigger ? trigger + ': ' + st.messages[0] + (st.messages.length > 1 ? ' (+' + (st.messages.length - 1) + ' more)' : '') : stateLabel(st)
  }

  const openingLabel = n => n.sameAsAnswer ? 'As it opens, and after “' + n.sameAsAnswer + '”' : 'As it opens'

  // stateIndex 0 is the page as it opens; 1 onwards are its other states
  function openScreen (id, stateIndex) {
    const n = nodesById.get(id)
    if (!n || !n.shot) return
    const states = [{ label: openingLabel(n), shot: n.shot, shotWidth: n.shotWidth, shotHeight: n.shotHeight, cutOff: n.cutOff }]
      .concat(n.states.map(st => ({ ...st, how: errorTrigger(st), label: screenTabLabel(st) })))
    const current = Math.min(stateIndex || 0, states.length - 1)
    const view = states[current]
    state.viewing = id
    state.viewingState = current

    const index = screens.indexOf(n)
    $('#screen-title').textContent = n.title
    const e = n.expanded || {}
    $('#screen-meta').textContent = (n.fileName || n.url) + ' · ' + (index + 1) + ' of ' + screens.length +
      (e.details || e.accordions || e.tabs ? ' · Shown with folded content opened' : '') +
      (view.kind === 'error' ? ' · ' + (view.how ? view.how + ': ' : 'Error: ') + view.messages.join(' · ') : '') +
      (view.cutOff ? ' · Only the top of this long page is shown' : '')
    // The line is cut short to fit: hovering shows all of it
    $('#screen-meta').title = $('#screen-meta').textContent

    const tabs = $('#screen-states')
    tabs.hidden = states.length < 2
    tabs.replaceChildren(...(states.length < 2 ? [] : states.map((st, i) => h('button', {
      type: 'button',
      class: 'screen__state' + (st.kind === 'error' ? ' screen__state--error' : ''),
      title: st.kind === 'error' ? st.messages.join('\n') : null,
      'aria-pressed': String(i === current),
      onclick: () => openScreen(id, i)
    }, st.label))))

    const img = $('#screen-img')
    img.src = view.shot
    img.dataset.width = view.shotWidth
    img.alt = 'Screenshot of ' + n.title + (current ? ', ' + view.label : '')
    img.width = view.shotWidth
    img.height = view.shotHeight
    $('#screen-open').href = 'http://localhost:' + data.meta.port + n.url
    const code = $('#screen-code')
    code.hidden = !n.absFile
    if (n.absFile) code.href = vscodeLink(n.absFile)
    $('#screen-prev').disabled = index <= 0
    $('#screen-next').disabled = index >= screens.length - 1
    applyScreenZoom()
    const wasOpen = !viewer.hidden
    viewer.hidden = false
    if (!wasOpen) {
      $('#screen-body').scrollTop = 0
      $('#screen-close').focus()
    }
  }

  // Fit shows the whole width; 100% is the page at its real size in the browser
  function applyScreenZoom () {
    const img = $('#screen-img')
    const zoom = state.screenZoom
    if (zoom === 'fit') {
      img.style.width = ''
      img.style.maxWidth = '100%'
    } else {
      img.style.width = Math.round(Number(img.dataset.width) * Number(zoom)) + 'px'
      img.style.maxWidth = 'none'
    }
    $('#screen-body').classList.toggle('is-zoomed', zoom !== 'fit')
    document.querySelectorAll('[data-screen-zoom]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.screenZoom === zoom))
    })
  }

  function setScreenZoom (zoom) {
    const body = $('#screen-body')
    // Keep the same part of the page in view
    const ratio = body.scrollHeight > body.clientHeight ? body.scrollTop / (body.scrollHeight - body.clientHeight) : 0
    state.screenZoom = zoom
    store.set('screen-zoom', zoom)
    applyScreenZoom()
    body.scrollTop = ratio * (body.scrollHeight - body.clientHeight)
    body.scrollLeft = (body.scrollWidth - body.clientWidth) / 2
  }

  document.querySelectorAll('[data-screen-zoom]').forEach(btn => {
    btn.addEventListener('click', () => setScreenZoom(btn.dataset.screenZoom))
  })

  function stepScreen (by) {
    const index = screens.findIndex(n => n.id === state.viewing)
    const next = screens[index + by]
    if (!next) return
    openScreen(next.id)
    select(next.id, true)
  }

  function closeScreen () {
    const id = state.viewing
    state.viewing = null
    viewer.hidden = true
    if (state.selected) showDetails(nodesById.get(state.selected))
    const back = panel.querySelector('.panel__shot')
    if (back && state.selected === id) back.focus()
  }

  $('#screen-close').addEventListener('click', closeScreen)
  $('#screen-prev').addEventListener('click', () => stepScreen(-1))
  $('#screen-next').addEventListener('click', () => stepScreen(1))
  viewer.addEventListener('click', event => { if (event.target === viewer) closeScreen() })

  const showOutside = $('#show-outside')
  // Nothing to show or hide on a map with no pages outside the journey
  if (!data.nodes.some(n => n.outside)) showOutside.closest('label').hidden = true
  showOutside.checked = store.get('outside') !== 'false'
  const applyOutside = () => { svg.classList.toggle('hide-outside', !showOutside.checked); store.set('outside', showOutside.checked) }
  showOutside.addEventListener('change', applyOutside)

  const search = $('#search')
  let searchTimer = null
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase()
    state.matches = q
      ? data.nodes.filter(n => [n.title, n.heading, n.url, n.file].some(v => v && v.toLowerCase().includes(q))).map(n => n.id)
      : []
    state.matchIndex = -1
    applyHighlights()
    // Once typing pauses, bring every matching page into view
    clearTimeout(searchTimer)
    if (state.matches.length) searchTimer = setTimeout(() => showPages(state.matches), 350)
  })
  search.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !state.matches.length) return
    state.matchIndex = (state.matchIndex + 1) % state.matches.length
    select(state.matches[state.matchIndex], true)
  })

  // Pages in journey order
  const pages = data.nodes.filter(n => n.type === 'page')

  // ---------------------------------------------------------------- export

  const exportBtn = $('#export-btn')
  const exportMenu = $('#export-menu')
  const closeMenu = () => { exportMenu.hidden = true; exportBtn.setAttribute('aria-expanded', 'false') }
  exportBtn.addEventListener('click', event => {
    event.stopPropagation()
    exportMenu.hidden = !exportMenu.hidden
    exportBtn.setAttribute('aria-expanded', String(!exportMenu.hidden))
  })
  document.addEventListener('click', event => { if (!exportMenu.contains(event.target)) closeMenu() })
  exportMenu.addEventListener('click', event => {
    const btn = event.target.closest('[data-export]')
    if (!btn) return
    closeMenu()
    const kind = btn.dataset.export
    if (kind === 'html') exportMap()
    else if (kind === 'svg') busy(exportSvg)
    else if (kind === 'svg-states') busy(exportWithStates)
    else if (kind === 'choose') startChoosing()
  })

  // The map itself, to keep, open on any computer, upload to Confluence or
  // present from. "Open in prototype" and the VS Code links stay: they work
  // on any computer with the prototype in the same place.
  function exportMap () {
    download(new Blob([pristineHtml], { type: 'text/html' }), fileName('html'))
  }

  // Laying the map out again can take a few seconds on a big journey
  async function busy (work) {
    const label = exportBtn.textContent
    exportBtn.textContent = 'Exporting…'
    exportBtn.disabled = true
    try {
      await work()
    } finally {
      exportBtn.textContent = label
      exportBtn.disabled = false
    }
  }

  function fileName (ext) {
    return data.meta.slug + '-journey-map-' + madeStamp() + '.' + ext
  }

  function contentBox () {
    const box = viewport.getBBox()
    const pad = 24
    return { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 }
  }

  // The map as a standalone SVG, at full size, without the current selection,
  // with the key on the right. `pictures` has each page's screenshot, by id.
  function svgString (pictures) {
    const map = contentBox()
    const clone = svg.cloneNode(true)
    const key = drawKey(map.x + map.width, map.y + 24)
    const box = { x: map.x, y: map.y, width: map.width + key.width + 24, height: Math.max(map.height, key.height + 48) }
    clone.classList.remove('has-selection', 'is-searching', 'is-panning', 'is-choosing')
    clone.querySelector('#viewport').removeAttribute('transform')
    clone.setAttribute('viewBox', [box.x, box.y, box.width, box.height].join(' '))
    clone.setAttribute('width', Math.ceil(box.width))
    clone.setAttribute('height', Math.ceil(box.height))
    clone.removeAttribute('style')
    const background = document.createElementNS(SVG_NS, 'rect')
    ;[['x', box.x], ['y', box.y], ['width', box.width], ['height', box.height], ['fill', '#ffffff']]
      .forEach(([k, v]) => background.setAttribute(k, v))
    clone.insertBefore(background, clone.querySelector('#viewport'))
    clone.appendChild(key.g)
    clone.querySelectorAll('.node').forEach(el => { el.removeAttribute('tabindex'); el.classList.remove('is-selected', 'is-match') })
    clone.querySelectorAll('image.thumb').forEach(img => {
      const n = nodesById.get(img.closest('.node').getAttribute('data-id'))
      img.setAttribute('href', pictures.get(n.id) || n.thumb)
    })
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone)
  }

  // Maps made before this was added have no room for the states
  const canExportStates = !!data.layouts['DOWN:states']
  $('#export-states').hidden = !canExportStates

  // The whole screenshot at the page's real size: clear enough to read in a
  // design review on a Mural board without the file getting huge. JPEG, as
  // Mural may not read WebP.
  function sharpPicture (src) {
    return new Promise(resolve => {
      const image = new Image()
      image.onload = () => {
        const c = document.createElement('canvas')
        c.width = Math.min(image.naturalWidth, 1280)
        c.height = Math.round(c.width * image.naturalHeight / image.naturalWidth)
        const ctx = c.getContext('2d')
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, c.width, c.height)
        ctx.drawImage(image, 0, 0, c.width, c.height)
        resolve(c.toDataURL('image/jpeg', 0.85))
      }
      image.onerror = () => resolve(src)
      image.src = src
    })
  }

  async function pagePictures (nodes) {
    const pictures = new Map()
    for (const n of nodes) if (n.shot) pictures.set(n.id, await sharpPicture(n.shot))
    return pictures
  }

  // Draws the map again in the export's layout just long enough to save it.
  // `kept` has the pages and lines kept, and where they go, when screens
  // are left out.
  function saveDrawnAs (layout, pictures, name, kept) {
    state.exporting = { layout, pictures, ...kept }
    try {
      draw()
      download(new Blob([svgString(pictures)], { type: 'image/svg+xml' }), name)
    } finally {
      state.exporting = null
      draw()
    }
  }

  // The map as it is on screen, with whole screenshots when they're showing
  async function exportSvg () {
    const whole = hasShots && state.thumbs
    const kept = await keptScreens(whole ? 'full' : false)
    if (!whole && !kept) {
      download(new Blob([svgString(new Map())], { type: 'image/svg+xml' }), fileName('svg'))
      return
    }
    const nodes = kept ? kept.nodes : data.nodes
    saveDrawnAs(whole ? 'full' : null, whole ? await pagePictures(nodes) : new Map(), fileName('svg'), kept)
  }

  // The map with every state and error beside its page
  async function exportWithStates () {
    const kept = await keptScreens('states')
    const nodes = kept ? kept.nodes : data.nodes
    const pictures = await pagePictures(nodes)
    for (const n of nodes) {
      for (const sc of n.stateCards || []) pictures.set(n.id + '#' + sc.index, await sharpPicture(n.states[sc.index - 1].shot))
    }
    saveDrawnAs('states', pictures, data.meta.slug + '-journey-map-all-states-' + madeStamp() + '.svg', kept)
  }

  // ---------------------------------------------------------------- screens to export

  // Screens, states and errors left out of the Mural exports: page ids, and
  // `<page id>#<state number>` for the page's other states. Kept in this
  // browser for each map: a new map of the same journey starts with all ticked.
  const LEAVE_OUT_KEY = 'journey-map:leave-out:' + data.meta.scopeUrl + (data.meta.createdAt ? ':' + data.meta.createdAt : '')
  const leftOut = new Set()
  try {
    const saved = JSON.parse(localStorage.getItem(LEAVE_OUT_KEY) || '[]')
    if (Array.isArray(saved)) saved.forEach(key => leftOut.add(key))
  } catch (err) {}

  function saveLeftOut () {
    try {
      if (leftOut.size) localStorage.setItem(LEAVE_OUT_KEY, JSON.stringify([...leftOut]))
      else localStorage.removeItem(LEAVE_OUT_KEY)
    } catch (err) {}
  }

  // A page as the export has it: only the states and errors kept, with its
  // tags counted again
  function keptCopy (n) {
    const layout = window.journeyLayout
    const all = n.states || []
    const out = (st, i) => leftOut.has(n.id + '#' + (i + 1))
    // Each page's size, as in the map's layout without screenshots
    const { width, height } = data.layouts.DOWN.nodes[n.id]
    if (!layout || n.type !== 'page' || !all.some(out)) return { ...n, width, height }
    const copy = { ...n, states: all.filter((st, i) => !out(st, i)) }
    // Errors the routes have but that weren't photographed only count while every error is kept
    if (all.some((st, i) => st.kind === 'error' && out(st, i))) copy.errorStates = []
    layout.measure(copy)
    copy.stateCards = hasShots ? layout.stateCardsFor(copy) : []
    return copy
  }

  // The map made again with the code that made it (lib/layout.js, put in
  // the file with ELK), without the screens left out, so lines close up and
  // tags count only what's kept. Nothing when every screen is kept, or the
  // map is too old to have that code.
  async function keptScreens (pictures) {
    const layout = window.journeyLayout
    if (!layout || !leftOut.size) return null
    const nodes = data.nodes.filter(n => !leftOut.has(n.id)).map(keptCopy)
    const ids = new Set(nodes.map(n => n.id))
    const edges = data.edges.filter(e => ids.has(e.from) && ids.has(e.to))
    const positions = await layout.layoutOne({ nodes, edges }, state.dir, pictures)
    return { nodes, edges, positions }
  }

  const chooseBar = $('#choose-bar')
  $('#export-choose').hidden = !window.journeyLayout

  function startChoosing () {
    if (state.viewing) closeScreen()
    clearSelection()
    state.choosing = true
    chooseBar.hidden = false
    svg.classList.add('is-choosing')
    draw()
    initialView()
  }

  function stopChoosing () {
    state.choosing = false
    chooseBar.hidden = true
    svg.classList.remove('is-choosing')
    draw()
    initialView()
  }

  // Draws only the page again, so the map doesn't jump, then greys its lines
  function toggleLeftOut (key) {
    if (leftOut.has(key)) leftOut.delete(key)
    else leftOut.add(key)
    saveLeftOut()
    updateChooseCount()
    const id = key.includes('#') ? key.slice(0, key.lastIndexOf('#')) : key
    const old = layers.nodes.querySelector('.node[data-id="' + CSS.escape(id) + '"]')
    const box = currentLayout().nodes[id]
    if (old && box) {
      old.replaceWith(drawNode(nodesById.get(id), box))
      updateThumbQuality(true)
    }
    svg.querySelectorAll('[data-edge]').forEach(el => {
      const e = edgesById.get(el.getAttribute('data-edge'))
      el.classList.toggle('is-left-out', !!leftOutClass(e))
    })
    const check = layers.nodes.querySelector('.export-check[data-key="' + CSS.escape(key) + '"]')
    if (check) check.focus({ preventScroll: true })
  }

  $('#choose-done').addEventListener('click', stopChoosing)
  $('#choose-all').addEventListener('click', () => {
    leftOut.clear()
    saveLeftOut()
    updateChooseCount()
    draw()
  })

  // "Leaving out 2 screens and 1 error", counting states and errors only on screens kept
  function updateChooseCount () {
    const counts = { screen: 0, state: 0, error: 0 }
    for (const n of pages) {
      if (leftOut.has(n.id)) { counts.screen++; continue }
      ;(n.states || []).forEach((st, i) => {
        if (leftOut.has(n.id + '#' + (i + 1))) counts[st.kind === 'error' ? 'error' : 'state']++
      })
    }
    const parts = Object.entries(counts).filter(([, count]) => count).map(([word, count]) => plural(count, word))
    const text = parts.length ? 'Leaving out ' + parts.join(', ').replace(/, ([^,]*)$/, ' and $1') : 'All screens'
    $('#choose-count').textContent = text
    $('#export-choose-note').textContent = text
  }
  updateChooseCount()

  // The key for an exported map: the journey's name and date, then a row for
  // each kind of line, card and tag on it, like the key on the map
  function drawKey (left, top) {
    const width = 300
    const g = make('g', { class: 'key', transform: 'translate(' + (left + 24) + ' ' + top + ')' })
    const showsReturn = svg.classList.contains('show-return')
    const showsOutside = !svg.classList.contains('hide-outside')
    const { nodes, edges } = drawn()
    const onMap = whatsOn(nodes, edges)
    const pagesWith = kind => nodes.some(n => n.badges && n.badges.some(b => b.kind === kind))
    const cards = state.exporting && state.exporting.layout === 'states'
      ? nodes.flatMap(n => n.stateCards || [])
      : []
    const line = (stroke, strokeWidth, dash) => row => make('line', { x1: 16, y1: row + 1, x2: 64, y2: row + 1, stroke, 'stroke-width': strokeWidth, 'stroke-dasharray': dash }, g)
    const box = (fill, stroke, dash) => row => make('rect', { x: 16, y: row - 8, width: 48, height: 18, rx: 4, fill, stroke, 'stroke-width': 1.5, 'stroke-dasharray': dash }, g)
    const tag = (kind, text) => row => {
      make('rect', { class: 'badge badge-' + kind, x: 16, y: row - 9, width: 60, height: 20, rx: 10 }, g)
      make('text', { class: 'badge-text badge-text-' + kind, x: 46, y: row + 5, 'text-anchor': 'middle' }, g, text)
    }
    const rows = [
      [nodes.some(n => n.entry), box('#fff', '#00703c'), 'Start page'],
      [onMap.flow, line('#505a5f', 2), 'Continue button or redirect'],
      [onMap.link, line('#1d70b8', 1.5), 'Link'],
      [onMap.return && showsReturn, line('#912b88', 1.5, '5 3'), 'Change or return link'],
      [onMap.branch, box('#fff', '#f47738'), 'Branch, named by the answer'],
      [pagesWith('states'), tag('states', '2 states'), 'Versions of the screen, counting the page as it opens'],
      [pagesWith('errors'), tag('errors', '1 error'), 'Error screens'],
      [cards.some(c => !c.error), box('#f8f8f8', '#b1b4b6'), 'Another state of the page beside it'],
      [cards.some(c => c.error), box('#fdf4f2', '#d4351c'), 'Error screen of the page beside it'],
      [onMap.decision, box('#fff4e8', '#f47738'), 'Decision made in code'],
      [onMap.outside && showsOutside, box('#f3f2f1', '#b1b4b6', '4 3'), 'Outside this journey'],
      [onMap.missing, box('#fdecea', '#d4351c', '4 3'), 'Page not found']
    ].filter(([shown]) => shown)

    const bg = make('rect', { class: 'key-box', width, rx: 8 }, g)
    const nameLines = wrapWords(data.meta.name, 30)
    nameLines.forEach((text, i) => make('text', { class: 'key-name', x: 16, y: 30 + i * 20 }, g, text))
    let y = 30 + (nameLines.length - 1) * 20
    if (createdAt) make('text', { class: 'key-meta', x: 16, y: y += 20 }, g, 'Made ' + madeAt())
    make('text', { class: 'key-heading', x: 16, y: y += 34 }, g, 'Key')
    y += 10
    rows.forEach(([, swatch, text]) => {
      const lines = wrapWords(text, 26)
      const middle = y + 14 + (lines.length - 1) * 8
      swatch(middle)
      lines.forEach((l, i) => make('text', { class: 'key-text', x: 88, y: y + 19 + i * 16 }, g, l))
      y += 14 + lines.length * 16
    })
    const height = y + 16
    bg.setAttribute('height', height)
    return { g, width: width + 24, height }
  }

  function wrapWords (text, max) {
    const lines = []
    for (const word of String(text).split(/\s+/)) {
      const last = lines.length - 1
      if (last >= 0 && (lines[last] + ' ' + word).length <= max) lines[last] += ' ' + word
      else lines.push(word)
    }
    return lines
  }

  function download (blob, name) {
    const url = URL.createObjectURL(blob)
    const a = h('a', { href: url, download: name })
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  // ---------------------------------------------------------------- start

  const legend = $('#legend')
  if (store.get('legend') === 'closed') legend.open = false
  legend.addEventListener('toggle', () => store.set('legend', legend.open ? 'open' : 'closed'))
  // The key only explains what's on this map
  const flows = e => e.kind === 'submit' || e.kind === 'redirect'
  function whatsOn (nodes, edges) {
    return {
      flow: edges.some(e => flows(e) && !e.return),
      link: edges.some(e => e.kind === 'link' && !e.return),
      return: edges.some(e => e.return),
      branch: edges.some(e => flows(e) && e.label),
      decision: nodes.some(n => n.type === 'decision'),
      outside: nodes.some(n => n.type === 'exit'),
      missing: nodes.some(n => n.type === 'missing')
    }
  }
  const onMap = whatsOn(data.nodes, data.edges)
  legend.querySelectorAll('[data-show]').forEach(row => { row.hidden = !onMap[row.dataset.show] })

  fillHeader()
  applyReturn()
  applyOutside()
  document.querySelectorAll('[data-dir]').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.dir === state.dir)))
  draw()
  initialView()
})()
