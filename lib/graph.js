// Builds the journey graph: a node for each page (and for each route that
// makes a decision without a page of its own), and an edge for each way the
// user can move between them.

const fs = require('fs')
const path = require('path')
const {
  listViews, listRouteFiles, normaliseUrl, viewUrl, isIndexFile, findView, resolveHref, humanise
} = require('./prototype')
const { parsePage, findTitle } = require('./views')
const { parseRoutes } = require('./routes')
const { labelFor } = require('./conditions')
const { nameBranches, readNames, defaultNamesFile } = require('./names')

// Order in which edges are followed: the main path first, Change links last
const KIND_ORDER = { submit: 0, redirect: 0, link: 1, change: 2 }

function lastSegment (url) {
  return url.split('/').filter(Boolean).pop() || '/'
}

function buildGraph ({ root, scopeDir, start, includeIndex, showMissing = false, namesFile }) {
  const viewsDir = path.join(root, 'app', 'views')
  const scopeUrl = normaliseUrl('/' + path.relative(viewsDir, scopeDir))
  const inScope = url => scopeUrl === '/' || url === scopeUrl || url.startsWith(scopeUrl + '/')
  const relative = file => path.relative(root, file).split(path.sep).join('/')
  const problems = []

  // Routes from every route file in the prototype
  const routes = []
  for (const file of listRouteFiles(root)) {
    try {
      routes.push(...parseRoutes(fs.readFileSync(file, 'utf8'), file))
    } catch (err) {
      problems.push(`Could not read ${relative(file)}: ${err.message}`)
    }
  }
  const handlersFor = (method, url) => routes.filter(r => r.path === url && (r.method === method || r.method === 'ALL'))

  const viewCache = new Map()
  const viewFile = url => {
    if (!viewCache.has(url)) viewCache.set(url, findView(viewsDir, url))
    return viewCache.get(url)
  }

  const nodes = new Map()
  const edges = []

  function addNode (id, props) {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id, url: id, title: lastSegment(id), heading: '', warnings: [], errorStates: [], variants: [], notes: [], ...props
      })
    }
    return nodes.get(id)
  }

  let nextEdgeId = 0
  function addEdge (from, to, kind, label, extra = {}) {
    if (from === to) return
    const existing = edges.find(e => e.from === from && e.to === to && e.kind === kind && e.label === label)
    if (existing) {
      if (extra.text && !existing.texts.includes(extra.text)) existing.texts.push(extra.text)
      if (extra.fullText && !existing.fullTexts.includes(extra.fullText)) existing.fullTexts.push(extra.fullText)
      return
    }
    edges.push({
      id: 'e' + nextEdgeId++,
      from,
      to,
      kind,
      label,
      texts: extra.text ? [extra.text] : [],
      // With the text only screen readers hear: "Change contact name"
      fullTexts: extra.fullText ? [extra.fullText] : [],
      query: extra.query || ''
    })
  }

  // Links that leave the prototype, such as GOV.UK guidance, listed on the page
  function addExternal (node, href, text) {
    node.externalLinks = node.externalLinks || []
    if (!node.externalLinks.some(l => l.href === href && l.text === text)) node.externalLinks.push({ href, text })
  }

  function pageNode (url, file, info) {
    return addNode(url, {
      type: 'page',
      title: info.title,
      heading: info.heading,
      file: relative(file),
      absFile: file,
      fileName: path.basename(file),
      fields: info.fields,
      conditionFields: info.conditionFields
    })
  }

  // The node a link or redirect to `url` lands on, created if needed
  const connected = new Set()
  function targetNode (url) {
    if (nodes.has(url)) return url
    const file = viewFile(url)
    if (file) {
      const { title, heading } = findTitle(fs.readFileSync(file, 'utf8'), file)
      if (inScope(url)) {
        // A page in the journey that isn't mapped itself, such as the index page
        addNode(url, { type: 'page', title, heading, file: relative(file), absFile: file, fileName: path.basename(file), unmapped: true })
      } else {
        addNode(url, { type: 'exit', title, heading, file: relative(file), absFile: file, fileName: path.basename(file), outside: true })
      }
      return url
    }
    const getRoutes = handlersFor('GET', url).filter(r => r.targets.some(t => t.kind === 'redirect'))
    if (getRoutes.length) {
      if (!inScope(url)) {
        addNode(url, { type: 'exit', title: path.posix.relative(scopeUrl, url), outside: true })
      } else {
        const node = addNode(url, { type: 'decision', routeFile: relative(getRoutes[0].file), absRouteFile: getRoutes[0].file })
        connectHandlers(node, getRoutes, url, 'redirect', null)
      }
      return url
    }
    addNode(url, { type: 'missing', title: inScope(url) ? lastSegment(url) : path.posix.relative(scopeUrl, url), outside: !inScope(url) })
    return url
  }

  // Edges for the redirects in route handlers. Renders of the page the user
  // came from (with errors) become that page's error states, not edges.
  function connectHandlers (from, handlers, requestUrl, kind, page) {
    if (connected.has(from.id + ' ' + requestUrl + ' ' + kind)) return
    connected.add(from.id + ' ' + requestUrl + ' ' + kind)

    for (const route of handlers) {
      for (const target of route.targets) {
        const label = labelFor(target.conds)
        if (target.dynamic) {
          from.warnings.push(`Goes to an address worked out in code (${target.source}), so it isn't on the map`)
          continue
        }
        let url
        if (target.kind === 'render') {
          url = normaliseUrl('/' + target.url.replace(/^\/+/, ''))
          if (route.method === 'GET' && url === route.path) continue
          const errorPage = page || from
          if (target.errors || url === errorPage.id || url === route.path) {
            const owner = nodes.has(url) && nodes.get(url).type === 'page' ? nodes.get(url) : errorPage
            owner.errorStates.push({ when: label, messages: target.errors ? target.errors.messages : [] })
            continue
          }
        } else {
          const resolved = resolveHref(target.url, requestUrl)
          if (!resolved || resolved.dynamic) continue
          if (resolved.external) {
            addExternal(from, target.url, label ? 'Redirect, ' + label : 'Redirect')
            continue
          }
          url = resolved.url
        }
        addEdge(from.id, targetNode(url), kind, label)
      }
    }
  }

  // 1. A node for every page in the journey folder
  const pages = []
  let indexPage = null
  for (const file of listViews(scopeDir)) {
    const url = viewUrl(viewsDir, file)
    const info = parsePage(fs.readFileSync(file, 'utf8'), file)
    if (url === scopeUrl && isIndexFile(file) && !includeIndex) {
      // The journey's index page usually lists every page, which would hide the real flow
      indexPage = { url, file, info }
      continue
    }
    pages.push({ node: pageNode(url, file, info), file, info })
  }

  // 2. Links, forms and redirects from each page
  for (const { node: page, file, info } of pages) {
    const base = isIndexFile(file) && page.id !== '/' ? page.id + '/' : page.id

    for (const link of info.links) {
      const resolved = resolveHref(link.href, base)
      if (!resolved) continue
      if (resolved.dynamic) { page.dynamicLinks = (page.dynamicLinks || 0) + 1; continue }
      if (resolved.external) { addExternal(page, link.href, link.text); continue }
      if (resolved.url === page.id) {
        if (resolved.query) page.variants.push({ query: resolved.query, text: link.text })
        continue
      }
      const kind = link.change ? 'change' : 'link'
      addEdge(page.id, targetNode(resolved.url), kind, link.cond ? 'if ' + link.cond : '', { text: link.text, fullText: link.fullText, query: resolved.query })
    }

    for (const form of info.forms) {
      const resolved = form.action ? resolveHref(form.action, base) : { url: page.id }
      if (!resolved || resolved.external) continue
      if (resolved.dynamic) {
        page.warnings.push('A form sends to an address worked out in the template, so it isn’t on the map')
        continue
      }
      const method = form.method === 'get' ? 'GET' : 'POST'
      const handlers = handlersFor(method, resolved.url).filter(r => r.targets.length)

      if (handlers.length) {
        let from = page
        if (resolved.url !== page.id && !viewFile(resolved.url)) {
          // A route with no page of its own, like /find-address-router: show it as a decision
          from = nodes.get(resolved.url) ||
            addNode(resolved.url, { type: 'decision', routeFile: relative(handlers[0].file), absRouteFile: handlers[0].file })
          addEdge(page.id, from.id, 'submit', form.cond ? 'if ' + form.cond : '')
        }
        connectHandlers(from, handlers, resolved.url, from === page ? 'submit' : 'redirect', page)
      } else if (method === 'POST' && resolved.url === page.id) {
        page.warnings.push('The form has no route, so pressing the button reloads this page')
      } else if (resolved.url !== page.id) {
        addEdge(page.id, targetNode(resolved.url), 'submit', form.cond ? 'if ' + form.cond : '')
      }
    }

    // A route that redirects away from this page when it's opened
    const getRedirects = handlersFor('GET', page.id)
      .map(route => ({ ...route, targets: route.targets.filter(t => t.kind === 'redirect') }))
      .filter(route => route.targets.length)
    if (getRedirects.length) connectHandlers(page, getRedirects, page.id, 'redirect', page)
  }

  // A page that shows different content depending on an answer on the page
  // before it is, for review, a branch: one line for each answer, and a
  // screenshot of the page after each answer (answerStates)
  const onwardFrom = id => edges.filter(e => e.from === id && (e.kind === 'submit' || e.kind === 'redirect'))
  for (const edge of [...edges]) {
    if (edge.kind !== 'submit' && edge.kind !== 'redirect') continue
    // Only the way on that has no condition: no rule, or "otherwise" once
    // errors are ruled out with nothing else to choose from
    const lone = edge.label === 'otherwise' && onwardFrom(edge.from).every(e => e === edge || !e.label)
    if (edge.label && !lone) continue
    const from = nodes.get(edge.from)
    const to = nodes.get(edge.to)
    if (!from || !to || from.type !== 'page' || to.type !== 'page' || !(to.conditionFields || []).length) continue
    const choices = from.fields || {}
    const name = to.conditionFields.find(f => choices[f] && Object.keys(choices[f].options).length >= 2)
    if (!name) continue
    const options = Object.entries(choices[name].options).map(([value, label]) => ({ value, label }))
    to.answerStates = { field: name, question: choices[name].question, from: from.id, options }
    edges.splice(edges.indexOf(edge), 1)
    options.forEach(option => addEdge(edge.from, edge.to, edge.kind, `${name} = '${option.value}'`))
  }

  // Keep each branch's rule as written; its name is worked out from it (names.js)
  edges.forEach(e => { e.rule = e.label })
  for (const node of nodes.values()) node.errorStates.forEach(errorState => { errorState.rule = errorState.when })

  // A page outside the journey gets its own copy next to each page that links
  // to it, so its lines don't cross the whole map
  for (const node of [...nodes.values()]) {
    if (!node.outside) continue
    const into = edges.filter(e => e.to === node.id)
    const sources = [...new Set(into.map(e => e.from))]
    if (sources.length < 2) continue
    sources.forEach((from, i) => {
      const id = node.id + '#' + (i + 1)
      nodes.set(id, { ...node, id, warnings: [], errorStates: [], variants: [], notes: [] })
      into.filter(e => e.from === from).forEach(e => { e.to = id })
    })
    nodes.delete(node.id)
  }

  // Links to pages that don't exist yet are common in a prototype, so they're
  // left off the map (showMissing brings them back)
  if (!showMissing) {
    for (const node of [...nodes.values()]) {
      if (node.type !== 'missing') continue
      nodes.delete(node.id)
      for (let i = edges.length - 1; i >= 0; i--) if (edges[i].to === node.id) edges.splice(i, 1)
    }
  }

  // 3. Narrow to one journey when a start page is given
  let nodeList = [...nodes.values()]
  let edgeList = edges
  let startId = null
  let hiddenCount = 0
  if (start) {
    startId = findStart(start, nodeList, viewsDir)
    const keep = reachable([startId], edgeList)
    hiddenCount = nodeList.filter(n => !keep.has(n.id) && n.type === 'page').length
    nodeList = nodeList.filter(n => keep.has(n.id))
    edgeList = edgeList.filter(e => keep.has(e.from) && keep.has(e.to))
  }

  // 4. Entry points, return links and depth
  const incomingCount = new Map(nodeList.map(n => [n.id, 0]))
  edgeList.forEach(e => incomingCount.set(e.to, incomingCount.get(e.to) + 1))
  // The journey's index page usually lists pages in journey order
  const indexLinks = []
  if (indexPage) {
    const base = indexPage.url === '/' ? '/' : indexPage.url + '/'
    indexPage.info.links.forEach(link => {
      const resolved = resolveHref(link.href, base)
      if (resolved && resolved.url && !indexLinks.includes(resolved.url)) indexLinks.push(resolved.url)
    })
  }
  const indexOrder = id => indexLinks.includes(id) ? indexLinks.indexOf(id) : Infinity
  const nameHint = id => /(^|[-/])(start|index|landing|home)([-/]|$)/.test(lastSegment(id)) ? 0 : 1

  // The entry point that reaches the most pages is the main one; ties go to the
  // one listed first on the index page. Following it first means loops are
  // broken where they go back, not on the main path.
  const forward = edgeList.filter(e => e.kind !== 'change')
  const roots = startId
    ? [startId]
    : nodeList
      .filter(n => n.type === 'page' && !n.unmapped && incomingCount.get(n.id) === 0)
      .map(n => ({ id: n.id, reach: reachable([n.id], forward).size }))
      .sort((a, b) => b.reach - a.reach || indexOrder(a.id) - indexOrder(b.id) || nameHint(a.id) - nameHint(b.id))
      .map(r => r.id)
  markReturnLinks(nodeList, edgeList, roots)
  const depth = depths(nodeList, edgeList, roots)

  for (const node of nodeList) {
    node.entry = roots.includes(node.id)
    node.depth = depth.get(node.id) ?? 0
    if (node.type === 'page' && !node.unmapped && incomingCount.get(node.id) === 0 && !startId) {
      node.notes.push(indexLinks.includes(node.id)
        ? 'Starting point: only the journey’s index page links here'
        : 'Starting point: no page in this journey links here')
    }
    if (node.type === 'missing') {
      const from = edgeList.filter(e => e.to === node.id).map(e => nodes.get(e.from).title)
      node.warnings.push(`There’s no page or route at this address. Linked from: ${[...new Set(from)].join(', ')}`)
    }
    if (node.variants.length) {
      const seen = new Set()
      node.variants = node.variants.filter(v => !seen.has(v.query) && seen.add(v.query))
    }
  }

  // Lay out the main path first, then branches, then everything else
  nodeList.sort((a, b) => a.depth - b.depth)

  const pageCount = nodeList.filter(n => n.type === 'page').length
  const graph = {
    meta: {
      name: humanise(path.basename(scopeDir === viewsDir ? root : scopeDir)),
      scope: relative(scopeDir) || 'app/views',
      scopeUrl,
      prototypeRoot: root,
      start: startId,
      mainEntry: roots[0] || null,
      skippedIndex: indexPage ? relative(indexPage.file) : null,
      hiddenCount,
      problems,
      stats: {
        pages: pageCount,
        decisions: nodeList.filter(n => n.type === 'decision').length,
        connections: edgeList.filter(e => !e.return).length,
        branches: edgeList.filter(e => e.label && (e.kind === 'submit' || e.kind === 'redirect')).length,
        warnings: nodeList.reduce((sum, n) => sum + n.warnings.length, 0) + problems.length
      }
    },
    nodes: nodeList,
    edges: edgeList
  }

  // Names for the branches, from the names file and the form labels
  graph.names = readNames(namesFile || defaultNamesFile(root, scopeDir))
  nameBranches(graph, graph.names)
  graph.meta.stats.branches = edgeList.filter(e => e.label && (e.kind === 'submit' || e.kind === 'redirect')).length
  return graph
}

function findStart (start, nodeList, viewsDir) {
  const pages = nodeList.filter(n => n.type === 'page')
  let wanted = start.trim()
  if (path.isAbsolute(wanted) && fs.existsSync(wanted)) wanted = viewUrl(viewsDir, wanted)
  wanted = wanted.replace(/\.(html|njk)$/, '').replace(/^\.?\/+/, '')
  const exact = pages.find(n => n.id === normaliseUrl(wanted))
  if (exact) return exact.id
  const matches = pages.filter(n => n.id.endsWith('/' + wanted) ||
    (n.file && ('/' + n.file.replace(/\.(html|njk)$/, '')).endsWith('/' + wanted)))
  if (matches.length === 1) return matches[0].id
  const names = pages.map(n => '  ' + n.id.split('/').pop()).sort().join('\n')
  if (matches.length > 1) {
    throw new Error(`More than one page matches “${start}”:\n${matches.map(n => '  ' + n.id).join('\n')}`)
  }
  throw new Error(`No page called “${start}” in this folder. The pages are:\n${names}`)
}

function reachable (startIds, edges) {
  const seen = new Set(startIds)
  const queue = [...startIds]
  while (queue.length) {
    const id = queue.shift()
    for (const e of edges) {
      if (e.from === id && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to) }
    }
  }
  return seen
}

// Change links, and links that loop back to an earlier page, are "return"
// links. They're drawn separately so the rest reads as a tree.
function markReturnLinks (nodeList, edges, roots) {
  const adjacent = new Map(nodeList.map(n => [n.id, []]))
  edges
    .slice()
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    .forEach(e => adjacent.get(e.from).push(e))

  const state = new Map()
  const visit = id => {
    state.set(id, 'active')
    for (const e of adjacent.get(id)) {
      if (e.kind === 'change') { e.return = true; continue }
      const s = state.get(e.to)
      if (s === 'active') e.return = true
      else if (!s) visit(e.to)
    }
    state.set(id, 'done')
  }
  roots.forEach(id => { if (!state.has(id)) visit(id) })
  nodeList.forEach(n => { if (!state.has(n.id)) visit(n.id) })
  edges.forEach(e => { e.return = !!e.return })
}

// Longest path from an entry point, so a page sits below everything that leads to it
function depths (nodeList, edges, roots) {
  const forward = edges.filter(e => !e.return)
  const incoming = new Map(nodeList.map(n => [n.id, 0]))
  forward.forEach(e => incoming.set(e.to, incoming.get(e.to) + 1))
  const depth = new Map(nodeList.map(n => [n.id, 0]))
  const queue = nodeList.filter(n => incoming.get(n.id) === 0).map(n => n.id)
  queue.sort((a, b) => roots.indexOf(b) - roots.indexOf(a))
  while (queue.length) {
    const id = queue.shift()
    for (const e of forward) {
      if (e.from !== id) continue
      depth.set(e.to, Math.max(depth.get(e.to), depth.get(id) + 1))
      incoming.set(e.to, incoming.get(e.to) - 1)
      if (incoming.get(e.to) === 0) queue.push(e.to)
    }
  }
  return depth
}

module.exports = { buildGraph }
