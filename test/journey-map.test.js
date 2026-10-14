const test = require('node:test')
const assert = require('node:assert')
const path = require('path')

const { buildGraph } = require('../lib/graph')
const { friendlyLabel, nameBranches, unnamed } = require('../lib/names')
const { addLayouts } = require('../lib/layout')
const { renderHtml } = require('../lib/render')
const { parseRoutes } = require('../lib/routes')
const { labelFor, prettyCondition } = require('../lib/conditions')

const root = path.join(__dirname, 'fixtures', 'kit')
const scopeDir = path.join(root, 'app', 'views', 'apply')

const short = id => id.replace('/apply/', '').replace(/^\/apply$/, 'index')
const edge = (graph, from, to) => graph.edges.find(e => short(e.from) === from && short(e.to) === to)
const node = (graph, name) => graph.nodes.find(n => short(n.id) === name)

test('maps the pages in the journey folder', () => {
  const graph = buildGraph({ root, scopeDir })
  const pages = graph.nodes.filter(n => n.type === 'page').map(n => short(n.id)).sort()
  assert.deepStrictEqual(pages, [
    'address', 'check-answers', 'choose-address', 'done', 'ineligible', 'name', 'no-address', 'orphan', 'start', 'where-do-you-live'
  ])
  assert.strictEqual(graph.meta.skippedIndex, 'app/views/apply/index.html')
})

test('uses the browser title, or the heading when there is none', () => {
  const graph = buildGraph({ root, scopeDir })
  assert.strictEqual(node(graph, 'start').title, 'Apply for a thing')
  assert.strictEqual(node(graph, 'where-do-you-live').title, 'Where do you live?')
})

test('follows links and macro buttons, but not back links, external links or comments', () => {
  const graph = buildGraph({ root, scopeDir })
  assert.strictEqual(edge(graph, 'start', 'name').kind, 'link')
  assert.deepStrictEqual(edge(graph, 'start', 'name').texts, ['Start now'])
  assert.ok(!edge(graph, 'name', 'start'), 'back link is ignored')
  assert.ok(!graph.nodes.some(n => n.id.includes('old-page')), 'commented-out link is ignored')
  assert.ok(!graph.nodes.some(n => n.id.includes('should-not-appear')), 'layouts are not pages')
  assert.deepStrictEqual(node(graph, 'start').externalLinks, [{ href: 'https://www.gov.uk/help', text: 'Help' }])
})

test('reads branches from the routes and names them with the radio labels', () => {
  const graph = buildGraph({ root, scopeDir })
  const england = edge(graph, 'where-do-you-live', 'check-answers')
  assert.strictEqual(england.label, '“England”')
  assert.strictEqual(england.code, "where-do-you-live = 'england'", 'the variable `answer` is traced back to the answer')
  const abroad = graph.edges.find(e => e.to === '/other/start')
  assert.strictEqual(abroad.label, '“Outside the UK”')
  assert.strictEqual(node(graph, '/other/start').type, 'exit')
})

test('names an "otherwise" branch on one question with the options left over', () => {
  const graph = buildGraph({ root, scopeDir })
  const rest = edge(graph, 'where-do-you-live', 'ineligible')
  assert.strictEqual(rest.label, '“Scotland”')
  assert.strictEqual(rest.code, 'otherwise')
})

test('reads choices from HTML radios and GOV.UK macros', () => {
  const graph = buildGraph({ root, scopeDir })
  assert.deepStrictEqual(node(graph, 'where-do-you-live').fields['where-do-you-live'], {
    question: 'Where do you live?',
    options: { england: 'England', abroad: 'Outside the UK', scotland: 'Scotland' }
  })
  assert.deepStrictEqual(node(graph, 'name').fields.contact, {
    question: 'How should we contact you?',
    options: { email: 'Email', post: 'Post' }
  })
})

test('turns a re-render with errors into an error state, not a branch', () => {
  const graph = buildGraph({ root, scopeDir })
  const name = node(graph, 'name')
  assert.strictEqual(name.errorStates.length, 1)
  assert.strictEqual(name.errorStates[0].when, 'not name', 'a text input has no options to name')
  assert.deepStrictEqual(name.errorStates[0].messages, ['Enter your name'])
  const onward = edge(graph, 'name', 'where-do-you-live')
  assert.strictEqual(onward.label, '', 'a lone "otherwise" is dropped')
})

test('shows a route with no page as a decision, with a ternary redirect', () => {
  const graph = buildGraph({ root, scopeDir })
  const decision = node(graph, 'lookup-router')
  assert.strictEqual(decision.type, 'decision')
  assert.strictEqual(edge(graph, 'address', 'lookup-router').kind, 'submit')
  assert.strictEqual(edge(graph, 'lookup-router', 'choose-address').label, 'found')
  const rest = edge(graph, 'lookup-router', 'no-address')
  assert.strictEqual(rest.label, 'Any other result', '"otherwise" after a decision in code')
  assert.deepStrictEqual(rest.excludes, ['found'])
})

test('labels links inside {% if %} blocks', () => {
  // These links go to pages that don't exist in the sample prototype
  const graph = buildGraph({ root, scopeDir, showMissing: true })
  assert.strictEqual(edge(graph, 'address', 'manual-address').label, "if show-manual = 'yes'")
  assert.strictEqual(edge(graph, 'address', 'help-with-address').label, "if show-manual ≠ 'yes'")
})

test('leaves links to missing pages off the map, unless asked', () => {
  assert.ok(!node(buildGraph({ root, scopeDir }), 'manual-address'))
  assert.ok(!buildGraph({ root, scopeDir }).edges.some(e => e.to.endsWith('/manual-address')))
  assert.strictEqual(node(buildGraph({ root, scopeDir, showMissing: true }), 'manual-address').type, 'missing')
})

test('notes forms with no route', () => {
  const graph = buildGraph({ root, scopeDir })
  assert.match(node(graph, 'orphan').warnings[0], /no route/)
})

test('treats Change links as return links and keeps self-links as variants', () => {
  const graph = buildGraph({ root, scopeDir })
  const change = edge(graph, 'check-answers', 'name')
  assert.strictEqual(change.kind, 'change')
  assert.deepStrictEqual(change.fullTexts, ['Change name'], 'includes the text only screen readers hear')
  assert.strictEqual(change.return, true)
  assert.deepStrictEqual(node(graph, 'check-answers').variants, [{ query: '?preview=true', text: 'Preview' }])
  assert.strictEqual(edge(graph, 'check-answers', 'done').kind, 'submit')
})

test('picks the start page and marks pages nothing links to', () => {
  const graph = buildGraph({ root, scopeDir })
  assert.strictEqual(graph.meta.mainEntry, '/apply/start')
  assert.ok(node(graph, 'orphan').entry)
})

test('--start narrows the map to what is reachable from that page', () => {
  const graph = buildGraph({ root, scopeDir, start: 'address' })
  const names = graph.nodes.map(n => short(n.id)).sort()
  assert.ok(names.includes('choose-address'))
  assert.ok(!names.includes('start'))
  assert.ok(!names.includes('orphan'))
  assert.throws(() => buildGraph({ root, scopeDir, start: 'nope' }), /No page called “nope”/)
})

test('lays out and renders a self-contained HTML file', async () => {
  const graph = await addLayouts(buildGraph({ root, scopeDir }))
  for (const dir of ['DOWN', 'RIGHT']) {
    assert.strictEqual(Object.keys(graph.layouts[dir].nodes).length, graph.nodes.length)
  }
  const html = renderHtml(graph, { port: 3000, slug: 'apply' })
  assert.match(html, /<title>Apply – Journey map<\/title>/)
  assert.ok(!html.includes('/*__JS__*/') && !html.includes('__DATA__'))
  const json = html.match(/<script type="application\/json" id="journey-data">([\s\S]*?)<\/script>/)[1]
  assert.strictEqual(JSON.parse(json).nodes.length, graph.nodes.length)
})

test('keeps route constants in their own scope', () => {
  const routes = parseRoutes(`
    function a (router) { const base = '/a'; router.post(base + '/x', (req, res) => res.redirect(base + '/y')) }
    function b (router) { const base = '/b'; router.post(base + '/x', (req, res) => res.redirect(base + '/y')) }
  `, 'routes.js')
  assert.deepStrictEqual(routes.map(r => r.path + '>' + r.targets[0].url), ['/a/x>/a/y', '/b/x>/b/y'])
})

test('follows helper functions and switch statements', () => {
  const routes = parseRoutes(`
    function goTo (res, page) { res.redirect('/journey/' + page) }
    function fail (res) { res.render('journey/q', { errors: { q: 'Answer the question' } }) }
    router.post('/journey/q', (req, res) => {
      if (!req.session.data.q) return fail(res)
      switch (req.session.data.q) {
        case 'yes': return res.redirect('/journey/yes')
        default: res.redirect('/journey/no')
      }
    })
  `, 'routes.js')
  const targets = routes[0].targets.map(t => [t.kind, t.url || t.source, labelFor(t.conds)])
  assert.deepStrictEqual(targets, [
    ['render', 'journey/q', 'not q'],
    ['redirect', '/journey/yes', "q = 'yes'"],
    ['redirect', '/journey/no', 'otherwise']
  ])
})

test('names rules and branches from the names file', () => {
  const graph = buildGraph({ root, scopeDir })
  const todo = unnamed(graph)
  assert.deepStrictEqual(todo.rules.sort(), ['found', 'not name'])
  assert.deepStrictEqual(todo.branches, ['lookup-router → no-address'])
  nameBranches(graph, {
    rules: { found: 'Addresses found' },
    branches: { 'lookup-router → no-address': 'No addresses found' }
  })
  assert.strictEqual(edge(graph, 'lookup-router', 'choose-address').label, 'Addresses found')
  assert.strictEqual(edge(graph, 'lookup-router', 'choose-address').code, 'found')
  assert.strictEqual(edge(graph, 'lookup-router', 'no-address').label, 'No addresses found')
  assert.deepStrictEqual(unnamed(graph).branches, [])
})

test('labels read from the real page name options built from data', () => {
  const graph = buildGraph({ root, scopeDir })
  // As if the screenshots found a fourth option whose label the template builds
  node(graph, 'where-do-you-live').renderedFields = { 'where-do-you-live': { question: '', options: { wales: 'Wales' } } }
  nameBranches(graph, { rules: {}, branches: {} })
  assert.strictEqual(edge(graph, 'where-do-you-live', 'ineligible').label, '“Scotland” or “Wales”')
})

test('friendly labels keep rules they cannot name', () => {
  const fields = { colour: { question: 'What colour?', options: { red: 'Red' } } }
  assert.strictEqual(friendlyLabel("colour = 'red'", fields), '“Red”')
  assert.strictEqual(friendlyLabel("colour ≠ 'red'", fields), 'not “Red”')
  assert.strictEqual(friendlyLabel("colour = 'blue'", fields), "colour = 'blue'")
  assert.strictEqual(friendlyLabel('not colour', fields), 'no answer to “What colour?”')
  assert.strictEqual(friendlyLabel("tooLong and colour = 'red'", fields), 'tooLong and “Red”')
})

test('makes conditions readable', () => {
  assert.strictEqual(prettyCondition("req.session.data['has-passport'] === 'yes'"), "has-passport = 'yes'")
  assert.strictEqual(prettyCondition('data.age >= 18 && !data.blocked'), 'age >= 18 and not blocked')
  assert.strictEqual(prettyCondition('Object.keys(errors).length > 0'), 'has errors')
})
