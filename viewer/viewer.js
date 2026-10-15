(function () {
  'use strict'

  // The page exactly as it was opened, before anything is drawn. "Download map
  // with notes" saves this again with the notes inside.
  const pristineHtml = '<!doctype html>\n' + document.documentElement.outerHTML
  const data = JSON.parse(document.getElementById('journey-data').textContent)
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const $ = selector => document.querySelector(selector)

  const nodesById = new Map(data.nodes.map(n => [n.id, n]))
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
    set (key, value) { try { localStorage.setItem('journey-map:' + key, value) } catch (err) {} }
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
    notesFor: null,
    screenZoom: store.get('screen-zoom') || 'fit',
    matches: [],
    matchIndex: -1,
    view: { x: 0, y: 0, k: 1 }
  }

  function currentLayout () {
    return data.layouts[state.dir + (hasShots && state.thumbs ? ':thumbs' : '')]
  }

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
    Object.values(layers).forEach(layer => layer.replaceChildren())
    const lanes = {}
    // Pages and branch labels that return link labels must not cover
    const taken = Object.values(layout.nodes).map(b => ({ x: b.x, y: b.y, width: b.width, height: b.height }))
      .concat(Object.values(layout.edges).filter(g => g.label).map(g => ({ ...g.label })))

    for (const e of data.edges) {
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
          class: 'edge edge-return' + (outside ? ' is-outside' : ''),
          'data-edge': e.id,
          'marker-end': 'url(#arrow-return)'
        }, layers.returns)
        make('title', null, path, describeEdge(e) + ': ' + titleOf(e.from) + ' → ' + titleOf(e.to))
        const words = linkWords(e)
        const spot = placeLabel(curve, Math.round(words.length * 6.5 + 16), taken)
        const g = make('g', { class: 'label label-return' + (outside ? ' is-outside' : ''), 'data-edge': e.id }, layers.returns)
        make('title', null, g, describeEdge(e) + ': ' + titleOf(e.from) + ' → ' + titleOf(e.to))
        make('rect', { x: spot.x, y: spot.y, width: spot.width, height: 20, rx: 10 }, g)
        make('text', { x: spot.cx, y: spot.cy + 4, 'text-anchor': 'middle' }, g, words)
        continue
      }
      const geo = layout.edges[e.id]
      if (!geo) continue
      const path = make('path', {
        d: roundedPath(geo.points, 10),
        class: 'edge edge-' + e.kind + (outside ? ' is-outside' : ''),
        'data-edge': e.id,
        'marker-end': e.kind === 'link' ? 'url(#arrow-link)' : 'url(#arrow-flow)'
      }, layers.edges)
      make('title', null, path, describeEdge(e) + ': ' + titleOf(e.from) + ' → ' + titleOf(e.to))

      if (e.label && geo.label) {
        const g = make('g', { class: 'label' + (outside ? ' is-outside' : ''), 'data-edge': e.id }, layers.labels)
        make('title', null, g, e.label + (e.code && e.code !== 'otherwise' ? '\n' + e.code : ''))
        make('rect', { x: geo.label.x, y: geo.label.y, width: geo.label.width, height: geo.label.height, rx: 4 }, g)
        make('text', { x: geo.label.x + geo.label.width / 2, y: geo.label.y + 14, 'text-anchor': 'middle' }, g, e.shortLabel)
      }
    }

    for (const n of data.nodes) {
      const box = layout.nodes[n.id]
      if (box) drawNode(n, box)
    }
    updateThumbQuality(true)
    applyHighlights()
  }

  const THUMB_HEIGHT = 165
  const THUMB_SPACE = THUMB_HEIGHT + 10

  function drawThumb (n, g, box) {
    const width = box.width - 28
    const clipId = 'clip-' + n.id.replace(/[^a-z0-9]/gi, '-')
    const clip = make('clipPath', { id: clipId }, g)
    make('rect', { x: 14, y: 14, width, height: THUMB_HEIGHT, rx: 4 }, clip)
    if (n.thumb) {
      make('image', {
        class: 'thumb',
        href: n.thumb,
        x: 14,
        y: 14,
        width,
        height: THUMB_HEIGHT,
        preserveAspectRatio: 'xMidYMin slice',
        'clip-path': 'url(#' + clipId + ')'
      }, g)
    } else {
      make('rect', { class: 'thumb-empty', x: 14, y: 14, width, height: THUMB_HEIGHT, rx: 4 }, g)
      make('text', { class: 'thumb-empty-text', x: 14 + width / 2, y: 14 + THUMB_HEIGHT / 2 + 4, 'text-anchor': 'middle' }, g, 'No screenshot')
    }
    make('rect', { class: 'thumb-frame', x: 14, y: 14, width, height: THUMB_HEIGHT, rx: 4 }, g)
  }

  function drawNode (n, box) {
    const classes = ['node', 'node-' + n.type]
    if (n.entry) classes.push('is-entry')
    if (isOutside(n)) classes.push('is-outside')

    const g = make('g', {
      class: classes.join(' '),
      transform: 'translate(' + box.x + ' ' + box.y + ')',
      'data-id': n.id,
      tabindex: '0',
      role: 'button',
      'aria-label': KIND_LABEL[n.type] + ': ' + n.title
    }, layers.nodes)
    make('title', null, g, n.title + '\n' + (n.file || n.url))
    make('rect', { class: 'card', width: box.width, height: box.height, rx: 8 }, g)

    if (n.type === 'page') {
      const shift = hasShots && state.thumbs ? THUMB_SPACE : 0
      if (shift) drawThumb(n, g, box)
      n.lines.forEach((line, i) => make('text', { class: 'title', x: 14, y: shift + 30 + i * 19 }, g, line))
      const top = shift + 16 + n.lines.length * 19 + 4
      // The whole file name, one line or more (sizes match lib/layout.js)
      n.fileLines.forEach((line, i) => make('text', { class: 'file', x: 14, y: top + 11 + i * 13 }, g, line))
      const badgeTop = top + 3 + Math.max(1, n.fileLines.length) * 13 + 6
      let x = 14
      n.badges.forEach(badge => {
        make('rect', { class: 'badge badge-' + badge.kind, x, y: badgeTop, width: badge.width, height: 20, rx: 10 }, g)
        make('text', { class: 'badge-text badge-text-' + badge.kind, x: x + badge.width / 2, y: badgeTop + 14, 'text-anchor': 'middle' }, g, badge.text)
        x += badge.width + 6
      })
      drawNoteFlag(g, n, box)
    } else if (n.type === 'decision') {
      make('text', { class: 'kind', x: 14, y: 23 }, g, '◆ DECISION IN CODE')
      n.lines.forEach((line, i) => make('text', { class: 'title', x: 14, y: 41 + i * 18 }, g, line))
    } else {
      make('text', { class: 'kind', x: 12, y: 20 }, g, n.type === 'missing' ? '✕ PAGE NOT FOUND' : '↗ OUTSIDE THIS JOURNEY')
      n.lines.forEach((line, i) => make('text', { class: 'title', x: 12, y: 36 + i * 17 }, g, line))
    }
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
            h('button', { class: 'linkish', type: 'button', onclick: () => openScreen(n.id, 0) },
              n.sameAsAnswer ? 'As it opens, and after “' + n.sameAsAnswer + '”' : 'As it opens'),
            h('span', { class: 'panel__how' }, 'When the page is first opened' + (n.sameAsAnswer ? ', or after choosing “' + n.sameAsAnswer + '”' : ''))
          ),
          others.map(({ st, index }) => h('li', null,
            h('button', { class: 'linkish', type: 'button', onclick: () => openScreen(n.id, index) }, stateLabel(st)),
            h('span', { class: 'panel__how' },
              st.kind === 'variant' ? 'After the link “' + st.label + '” (' + st.query + ')'
                : st.kind === 'answer' ? 'After choosing “' + st.label + '”' + (st.question ? ' for “' + st.question + '”' : '')
                  : 'When this option is chosen')
          ))
        )
      ] : null,
      errors.length ? [
        h('p', { class: 'panel__states-group panel__states-group--error' }, 'Errors'),
        h('ul', null, errors.map(({ st, index }) => h('li', null,
          h('button', { class: 'linkish', type: 'button', onclick: () => openScreen(n.id, index) }, st.messages.join(' / ')),
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

  function vscodeLink (file) {
    const clean = file.replace(/\\/g, '/')
    return 'vscode://file' + (clean.startsWith('/') ? '' : '/') + encodeURI(clean)
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
      n.shot && n.states.length ? statesBox(n) : null,
      expandedNote(n),
      hasShots && n.type === 'page' && !n.shot ? h('p', { class: 'panel__empty' }, 'No screenshot' + (n.shotError ? ': ' + n.shotError : '')) : null,
      n.type === 'page' ? noteEditor(n.id, 'panel') : null,
      h('p', { class: 'panel__kind' }, KIND_LABEL[n.type] + (n.entry ? ' · Start' : '')),
      h('h2', null, n.title),
      n.heading && n.heading !== n.title ? h('p', { class: 'panel__heading' }, n.heading) : null,
      h('p', { class: 'panel__url' }, h('code', null, n.url)),
      h('div', { class: 'panel__actions' },
        n.type !== 'missing' ? h('a', { href: prototypeUrl, target: '_blank', rel: 'noopener' }, 'Open in prototype ↗') : null,
        n.absFile ? h('a', { class: 'secondary', href: vscodeLink(n.absFile) }, 'Open in VS Code') : null,
        n.absRouteFile ? h('a', { class: 'secondary', href: vscodeLink(n.absRouteFile) }, 'Open the routes in VS Code') : null
      ),
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
      img.setAttribute('href', sharp && n.shot ? n.shot : n.thumb)
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
    const node = event.target.closest('.node')
    if (node) select(node.getAttribute('data-id'))
    else clearSelection()
  })
  svg.addEventListener('keydown', event => {
    const node = event.target.closest && event.target.closest('.node')
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
    if (event.key === 'Escape') clearSelection()
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
    if (st.kind === 'variant' || st.kind === 'answer') return 'After “' + st.label + '”'
    if (st.kind === 'error') {
      return 'Error: ' + st.messages[0] + (st.messages.length > 1 ? ' (+' + (st.messages.length - 1) + ' more)' : '')
    }
    return st.label + (st.type === 'checkbox' ? ' ticked' : ' selected')
  }

  // stateIndex 0 is the page as it opens; 1 onwards are its other states
  function openScreen (id, stateIndex) {
    const n = nodesById.get(id)
    if (!n || !n.shot) return
    const states = [{ label: n.sameAsAnswer ? 'As it opens, and after “' + n.sameAsAnswer + '”' : 'As it opens', shot: n.shot, shotWidth: n.shotWidth, shotHeight: n.shotHeight, cutOff: n.cutOff }]
      .concat(n.states.map(st => ({ ...st, how: st.label, label: stateLabel(st) })))
    const current = Math.min(stateIndex || 0, states.length - 1)
    const view = states[current]
    state.viewing = id
    state.viewingState = current

    const index = screens.indexOf(n)
    $('#screen-title').textContent = n.title
    const e = n.expanded || {}
    $('#screen-meta').textContent = (n.fileName || n.url) + ' · ' + (index + 1) + ' of ' + screens.length +
      (e.details || e.accordions || e.tabs ? ' · Shown with folded content opened' : '') +
      (view.kind === 'error' ? ' · Error after: ' + view.how + ' · ' + view.messages.join(' · ') : '') +
      (view.cutOff ? ' · Only the top of this long page is shown' : '')

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
    $('#screen-prev').disabled = index <= 0
    $('#screen-next').disabled = index >= screens.length - 1
    applyScreenZoom()
    if (!$('#screen-notes').contains(document.activeElement) || state.notesFor !== id) {
      state.notesFor = id
      $('#screen-notes').replaceChildren(noteEditor(id, 'screen'))
    }
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
    state.notesFor = null
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

  // ---------------------------------------------------------------- notes
  //
  // One note per page, kept in this browser as you type (so they survive
  // closing the tab, and regenerating the map of the same journey). Notes
  // from a map someone sent you are read from the file and merged in, newest
  // first. "Download map with notes" writes them into a copy of the file.

  const NOTES_KEY = 'journey-map:notes:' + data.meta.scopeUrl
  const pages = data.nodes.filter(n => n.type === 'page')

  function readNotes (text) {
    try {
      const parsed = JSON.parse(text || '{}')
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (err) {
      return {}
    }
  }

  function readLocalNotes () {
    try { return readNotes(localStorage.getItem(NOTES_KEY)) } catch (err) { return {} }
  }

  function mergeNotes (...sets) {
    const merged = {}
    for (const set of sets) {
      for (const id in set) {
        const note = set[id]
        if (!note || typeof note.text !== 'string') continue
        if (!merged[id] || (note.updated || 0) > (merged[id].updated || 0)) merged[id] = note
      }
    }
    return merged
  }

  const notesTag = document.getElementById('journey-notes')
  let notes = mergeNotes(readNotes(notesTag && notesTag.textContent), readLocalNotes())

  const noteText = id => (notes[id] && notes[id].text) || ''
  const hasNote = id => noteText(id).trim() !== ''
  const notedPages = () => pages.filter(n => hasNote(n.id))

  let saveTimer = null
  let savedLocally = true

  function saveNotes () {
    try {
      // Someone may have added notes in another tab: keep the newest of each
      notes = mergeNotes(readLocalNotes(), notes)
      localStorage.setItem(NOTES_KEY, JSON.stringify(notes))
      savedLocally = true
    } catch (err) {
      savedLocally = false
    }
    document.querySelectorAll('.notes__status').forEach(el => { el.textContent = statusText() })
  }

  function statusText () {
    return savedLocally
      ? 'Saved in this browser'
      : 'Couldn’t save in this browser. Use Share › Download map with notes to keep them.'
  }

  function setNote (id, text) {
    notes[id] = { text, updated: Date.now() }
    document.querySelectorAll('.notes__status').forEach(el => { el.textContent = 'Saving…' })
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveNotes, 400)
    refreshNoteFlag(id)
    updateShareButton()
  }

  function noteEditor (id, where) {
    const n = nodesById.get(id)
    const fieldId = 'notes-' + where
    const field = h('textarea', {
      id: fieldId,
      class: 'notes__field',
      rows: where === 'screen' ? 12 : 5,
      placeholder: 'Type notes about this screen. They save as you type.',
      spellcheck: 'true'
    })
    field.value = noteText(id)
    field.addEventListener('input', () => setNote(id, field.value))
    field.addEventListener('blur', () => { clearTimeout(saveTimer); saveNotes() })
    return h('div', { class: 'notes notes--' + where },
      h('label', { class: 'notes__label', for: fieldId }, 'Notes', where === 'screen' ? h('span', null, ' on ' + n.title) : null),
      field,
      h('p', { class: 'notes__status', 'aria-live': 'polite' }, hasNote(id) ? statusText() : '')
    )
  }

  // A small yellow marker on the card's top-right corner. It sits on top of
  // the card, so adding a note never moves anything on the map.
  function drawNoteFlag (g, n, box) {
    if (!hasNote(n.id)) return
    const flag = make('g', { class: 'note-flag', transform: 'translate(' + (box.width - 22) + ' -10)' }, g)
    make('title', null, flag, 'Has notes')
    make('rect', { width: 30, height: 24, rx: 4 }, flag)
    make('path', { d: 'M8 8 H22 M8 12 H22 M8 16 H17' }, flag)
  }

  function refreshNoteFlag (id) {
    const g = layers.nodes.querySelector('.node[data-id="' + CSS.escape(id) + '"]')
    const box = currentLayout().nodes[id]
    if (!g || !box) return
    const old = g.querySelector('.note-flag')
    if (old) old.remove()
    drawNoteFlag(g, nodesById.get(id), box)
  }

  function notesAsText () {
    const noted = notedPages()
    const lines = [data.meta.name + ' – review notes', new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })]
    if (createdAt) lines.push('Map made ' + madeAt())
    lines.push('')
    noted.forEach(n => {
      lines.push((pages.indexOf(n) + 1) + '. ' + n.title + ' (' + (n.fileName || n.url) + ')')
      noteText(n.id).trim().split('\n').forEach(line => lines.push(line.trim() ? '   ' + line.trim() : ''))
      lines.push('')
    })
    return lines.join('\n').trim() + '\n'
  }

  async function copyText (text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (err) {
      const area = h('textarea', { style: 'position:fixed;opacity:0' })
      area.value = text
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    }
  }

  function downloadWithNotes () {
    clearTimeout(saveTimer)
    saveNotes()
    const json = JSON.stringify(notes).replace(/</g, '\\u003c')
    const html = pristineHtml.replace(
      /(<script type="application\/json" id="journey-notes">)[\s\S]*?(<\/script>)/,
      (match, open, close) => open + json + close
    )
    download(new Blob([html], { type: 'text/html' }), fileName('html'))
  }

  function showAllNotes () {
    state.selected = null
    applyHighlights()
    const noted = notedPages()
    fillPanel(
      h('button', { class: 'panel__close', type: 'button', 'aria-label': 'Close', onclick: clearSelection }, '×'),
      h('p', { class: 'panel__kind' }, 'Review'),
      h('h2', null, 'All notes'),
      noted.length
        ? [
            h('div', { class: 'panel__actions' },
              h('button', { type: 'button', class: 'btn', onclick: event => copyNotes(event.currentTarget) }, 'Copy as text'),
              h('button', { type: 'button', class: 'btn', onclick: downloadWithNotes }, 'Download map with notes')
            ),
            h('ul', null, noted.map(n => h('li', null,
              h('button', { class: 'linkish', type: 'button', onclick: () => select(n.id, true) }, (pages.indexOf(n) + 1) + '. ' + n.title),
              h('p', { class: 'notes__text' }, noteText(n.id).trim())
            )))
          ]
        : h('p', { class: 'panel__empty' }, 'No notes yet. Click a screen and type in its Notes box.')
    )
    panel.hidden = false
  }

  async function copyNotes (button) {
    const ok = await copyText(notesAsText())
    const label = button.textContent
    button.textContent = ok ? 'Copied' : 'Couldn’t copy'
    setTimeout(() => { button.textContent = label }, 1800)
  }

  const shareBtn = $('#share-btn')
  const shareMenu = $('#share-menu')

  function updateShareButton () {
    const count = notedPages().length
    $('#share-count').textContent = count ? String(count) : ''
    $('#share-count').hidden = !count
    $('#share-all-label').textContent = count ? 'See all notes (' + count + ')' : 'See all notes'
  }

  const closeShareMenu = () => { shareMenu.hidden = true; shareBtn.setAttribute('aria-expanded', 'false') }
  shareBtn.addEventListener('click', event => {
    event.stopPropagation()
    $('#export-menu').hidden = true
    shareMenu.hidden = !shareMenu.hidden
    shareBtn.setAttribute('aria-expanded', String(!shareMenu.hidden))
  })
  document.addEventListener('click', event => { if (!shareMenu.contains(event.target)) closeShareMenu() })
  shareMenu.addEventListener('click', event => {
    const btn = event.target.closest('[data-share]')
    if (!btn) return
    const kind = btn.dataset.share
    if (kind === 'copy') { copyNotes(btn.querySelector('strong') || btn); return }
    closeShareMenu()
    if (kind === 'download') downloadWithNotes()
    else showAllNotes()
  })

  // Notes typed in another tab of the same journey show up here too
  window.addEventListener('storage', event => {
    if (event.key !== NOTES_KEY) return
    notes = mergeNotes(notes, readNotes(event.newValue))
    pages.forEach(n => refreshNoteFlag(n.id))
    updateShareButton()
  })
  window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); saveNotes() })

  // ---------------------------------------------------------------- export

  const exportBtn = $('#export-btn')
  const exportMenu = $('#export-menu')
  const closeMenu = () => { exportMenu.hidden = true; exportBtn.setAttribute('aria-expanded', 'false') }
  exportBtn.addEventListener('click', event => {
    event.stopPropagation()
    $('#share-menu').hidden = true
    exportMenu.hidden = !exportMenu.hidden
    exportBtn.setAttribute('aria-expanded', String(!exportMenu.hidden))
  })
  document.addEventListener('click', event => { if (!exportMenu.contains(event.target)) closeMenu() })
  exportMenu.addEventListener('click', event => {
    const btn = event.target.closest('[data-export]')
    if (!btn) return
    closeMenu()
    const kind = btn.dataset.export
    if (kind === 'svg') download(new Blob([svgString()], { type: 'image/svg+xml' }), fileName('svg'))
    else if (kind === 'png') exportPng()
    else printMap()
  })

  function fileName (ext) {
    return data.meta.slug + '-journey-map-' + madeStamp() + '.' + ext
  }

  function contentBox () {
    const box = viewport.getBBox()
    const pad = 24
    return { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 }
  }

  // The map as a standalone SVG, at full size, without the current selection
  function svgString () {
    const box = contentBox()
    const clone = svg.cloneNode(true)
    clone.classList.remove('has-selection', 'is-searching', 'is-panning')
    clone.querySelector('#viewport').removeAttribute('transform')
    clone.setAttribute('viewBox', [box.x, box.y, box.width, box.height].join(' '))
    clone.setAttribute('width', Math.ceil(box.width))
    clone.setAttribute('height', Math.ceil(box.height))
    clone.removeAttribute('style')
    const background = document.createElementNS(SVG_NS, 'rect')
    ;[['x', box.x], ['y', box.y], ['width', box.width], ['height', box.height], ['fill', '#ffffff']]
      .forEach(([k, v]) => background.setAttribute(k, v))
    clone.insertBefore(background, clone.querySelector('#viewport'))
    clone.querySelectorAll('.node').forEach(el => { el.removeAttribute('tabindex'); el.classList.remove('is-selected', 'is-match') })
    clone.querySelectorAll('image.thumb').forEach(img => {
      img.setAttribute('href', nodesById.get(img.closest('.node').getAttribute('data-id')).thumb)
    })
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone)
  }

  function exportPng () {
    const box = contentBox()
    const scale = Math.min(2, 16000 / Math.max(box.width, box.height))
    const image = new Image()
    image.onload = () => {
      const c = document.createElement('canvas')
      c.width = Math.round(box.width * scale)
      c.height = Math.round(box.height * scale)
      const ctx = c.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.drawImage(image, 0, 0, c.width, c.height)
      c.toBlob(blob => download(blob, fileName('png')), 'image/png')
    }
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString())
  }

  function download (blob, name) {
    const url = URL.createObjectURL(blob)
    const a = h('a', { href: url, download: name })
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  function printMap () {
    const box = contentBox()
    const transform = viewport.getAttribute('transform')
    const restore = () => {
      svg.removeAttribute('viewBox')
      viewport.setAttribute('transform', transform)
      window.removeEventListener('afterprint', restore)
    }
    svg.setAttribute('viewBox', [box.x, box.y, box.width, box.height].join(' '))
    viewport.removeAttribute('transform')
    window.addEventListener('afterprint', restore)
    window.print()
  }

  // ---------------------------------------------------------------- start

  const legend = $('#legend')
  if (store.get('legend') === 'closed') legend.open = false
  legend.addEventListener('toggle', () => store.set('legend', legend.open ? 'open' : 'closed'))
  // The key only explains what's on this map
  const flows = e => e.kind === 'submit' || e.kind === 'redirect'
  const onMap = {
    flow: data.edges.some(e => flows(e) && !e.return),
    link: data.edges.some(e => e.kind === 'link' && !e.return),
    return: data.edges.some(e => e.return),
    branch: data.edges.some(e => flows(e) && e.label),
    decision: data.nodes.some(n => n.type === 'decision'),
    outside: data.nodes.some(n => n.type === 'exit'),
    missing: data.nodes.some(n => n.type === 'missing')
  }
  legend.querySelectorAll('[data-show]').forEach(row => { row.hidden = !onMap[row.dataset.show] })

  updateShareButton()
  fillHeader()
  applyReturn()
  applyOutside()
  document.querySelectorAll('[data-dir]').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.dir === state.dir)))
  draw()
  initialView()
})()
