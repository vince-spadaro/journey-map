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
  assert.deepStrictEqual(edge(graph, 'start', 'name').texts.sort(), ['Begin', 'Carry on', 'Start now'])
  assert.strictEqual(graph.edges.filter(e => short(e.from) === 'start' && short(e.to) === 'name').length, 1, 'the same link in an if and its else is one line')
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
  const onward = edge(graph, 'start', 'name')
  assert.strictEqual(onward.label, '', 'a link with no condition has no name')
})

test('joins a page straight to where a route with no page sends it', () => {
  const graph = buildGraph({ root, scopeDir })
  assert.ok(!node(graph, 'lookup-router'), 'no block for the route itself')
  assert.strictEqual(edge(graph, 'address', 'choose-address').kind, 'submit')
  assert.strictEqual(edge(graph, 'address', 'choose-address').label, 'found')
  const rest = edge(graph, 'address', 'no-address')
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

test('a page that changes with an earlier answer branches once for each answer', () => {
  const graph = buildGraph({ root, scopeDir })
  const into = graph.edges.filter(e => short(e.from) === 'name' && short(e.to) === 'where-do-you-live')
  assert.deepStrictEqual(into.map(e => e.label), ['“Email”', '“Post”'])
  assert.deepStrictEqual(node(graph, 'where-do-you-live').answerStates.options.map(o => o.value), ['email', 'post'])
})

test('knows the answers that lead to a page, for trying its errors', () => {
  const { answersLeadingTo } = require('../lib/screenshots')
  const graph = buildGraph({ root, scopeDir })
  assert.deepStrictEqual(answersLeadingTo(graph, node(graph, 'check-answers')), { 'where-do-you-live': 'england' })
  // Two ways in with different answers: neither is set
  assert.deepStrictEqual(answersLeadingTo(graph, node(graph, 'where-do-you-live')), {})
})

test('a link back up the journey is the return link, not the button that leads on', () => {
  const graph = buildGraph({ root, scopeDir })
  assert.strictEqual(edge(graph, 'check-answers', 'done').return, false, 'the button stays on the main flow')
  assert.strictEqual(edge(graph, 'done', 'check-answers').return, true, 'Cancel is drawn as a return link')
})

test('picks the start page and marks pages nothing links to', () => {
  const graph = buildGraph({ root, scopeDir })
  assert.strictEqual(graph.meta.mainEntry, '/apply/start')
  assert.ok(node(graph, 'start').entry)
  // The orphan page has no links in or out, so it isn't a start
  assert.ok(!node(graph, 'orphan').entry)
  assert.match(node(graph, 'orphan').notes[0], /Not connected to any other page/)
})

test('starts a journey that loops back to its first page from the first page the index lists', () => {
  const loop = buildGraph({ root, scopeDir: path.join(root, 'app', 'views', 'loop') })
  const find = name => loop.edges.find(e => e.from === '/loop/' + name[0] && e.to === '/loop/' + name[1])
  assert.strictEqual(loop.meta.mainEntry, '/loop/home')
  assert.ok(loop.nodes.find(n => n.id === '/loop/home').entry)
  assert.strictEqual(find(['home', 'question']).return, false, 'the link into the journey stays on the main flow')
  assert.strictEqual(find(['done', 'home']).return, true, 'the link back home is a return link')
})

test('starts from the first page the index lists, even when a page that ends the journey links back to it', () => {
  const graph = buildGraph({ root, scopeDir: path.join(root, 'app', 'views', 'listed') })
  const find = (from, to) => graph.edges.filter(e => e.from === '/listed/' + from && e.to === '/listed/' + to)
  assert.strictEqual(graph.meta.mainEntry, '/listed/choose')
  assert.strictEqual(find('kickout', 'choose')[0].return, true, '“Start again” goes back to the start')
  assert.ok(!graph.nodes.find(n => n.id === '/listed/kickout').entry)
  // "No" goes to /start, which redirects back to the first page
  const again = find('confirm', 'choose')
  assert.strictEqual(again.length, 1)
  assert.strictEqual(again[0].rule, "confirm = 'false'")
  assert.strictEqual(again[0].return, true)
  // so "Yes" is still named as the answer left over
  nameBranches(graph)
  assert.strictEqual(find('confirm', 'check')[0].label, '“Yes - this is right”')
})

test('branches once for each answer the index page lists the next page with', () => {
  const graph = buildGraph({ root, scopeDir: path.join(root, 'app', 'views', 'listed') })
  nameBranches(graph)
  const branches = graph.edges.filter(e => e.from === '/listed/choose' && e.to === '/listed/confirm')
  assert.deepStrictEqual(branches.map(e => e.label), ['“An individual”', '“A trust”'])
  const confirm = graph.nodes.find(n => n.id === '/listed/confirm')
  assert.strictEqual(confirm.answerStates.field, 'type')
  assert.strictEqual(confirm.listedStates.length, 0, 'photographed as answers, not twice')
})

test('draws each version of a page the answers lead to as its own branch', () => {
  const { applyFollowed } = require('../lib/follow')
  const graph = buildGraph({ root, scopeDir: path.join(root, 'app', 'views', 'listed') })
  const shot = name => ({ shot: 'data:' + name, thumb: 'data:' + name, status: 200 })
  const confirm = graph.nodes.find(n => n.id === '/listed/confirm')
  confirm.states = [{ kind: 'error', query: '?type=trust&error=required', messages: ['Select yes'] }]
  applyFollowed(graph, {
    versions: [
      { key: '/listed/choose', page: '/listed/choose', answers: {}, ...shot('choose') },
      { key: '/listed/confirm?type=personal', page: '/listed/confirm', answers: { type: 'personal' }, ...shot('personal') },
      { key: '/listed/confirm?type=trust', page: '/listed/confirm', answers: { type: 'trust' }, ...shot('trust') },
      { key: '/listed/check?type=personal', page: '/listed/check', answers: { type: 'personal' }, ...shot('check') },
      { key: '/listed/check?type=trust', page: '/listed/check', answers: { type: 'trust' }, ...shot('check') }
    ],
    steps: [
      { from: '/listed/choose', to: '/listed/confirm?type=personal', kind: 'submit', field: 'type', value: 'personal' },
      { from: '/listed/choose', to: '/listed/confirm?type=trust', kind: 'submit', field: 'type', value: 'trust' },
      { from: '/listed/confirm?type=personal', to: '/listed/check?type=personal', kind: 'submit', field: 'confirm', value: 'true' },
      { from: '/listed/confirm?type=trust', to: '/listed/check?type=trust', kind: 'submit', field: 'confirm', value: 'true' },
      { from: '/listed/confirm?type=trust', to: '/listed/choose', kind: 'submit', field: 'confirm', value: 'false' }
    ]
  })
  const ids = graph.nodes.map(n => n.id)
  assert.ok(ids.includes('/listed/confirm') && ids.includes('/listed/confirm?type=trust'))
  const out = graph.edges.filter(e => e.from === '/listed/choose' && !e.return).map(e => e.to + ' ' + e.rule)
  assert.deepStrictEqual(out.sort(), ["/listed/confirm type = 'personal'", "/listed/confirm?type=trust type = 'trust'"])
  // Each version has its own screenshot and the error photographed with its answers
  const trust = graph.nodes.find(n => n.id === '/listed/confirm?type=trust')
  assert.strictEqual(trust.shot, 'data:trust')
  assert.strictEqual(trust.url, '/listed/confirm?type=trust')
  assert.strictEqual(trust.states.length, 1)
  // "No" goes back to the start: a line back, not another version
  assert.strictEqual(graph.edges.find(e => e.from === '/listed/confirm?type=trust' && e.to === '/listed/choose').return, true)
  assert.strictEqual(graph.meta.mainEntry, '/listed/choose')
  assert.ok(graph.nodes.find(n => n.id === '/listed/choose').entry)
})

test('gives each version its own errors, and leaves out listed versions that are the same screen', () => {
  const { applyFollowed } = require('../lib/follow')
  const graph = buildGraph({ root, scopeDir: path.join(root, 'app', 'views', 'listed') })
  const confirm = graph.nodes.find(n => n.id === '/listed/confirm')
  confirm.states = [
    { kind: 'variant', listed: true, label: 'A trust', query: '?type=trust' },
    { kind: 'error', query: '?type=trust&error=required', messages: ['Select yes'] }
  ]
  const error = answer => ({ kind: 'error', query: '?error=required&type=' + answer, messages: ['Select yes for ' + answer] })
  applyFollowed(graph, {
    versions: [
      { key: '/listed/choose', page: '/listed/choose', answers: {}, shot: 'c' },
      { key: '/listed/confirm?type=personal', page: '/listed/confirm', answers: { type: 'personal' }, shot: 'p', states: [error('personal')], triedErrors: true },
      { key: '/listed/confirm?type=trust', page: '/listed/confirm', answers: { type: 'trust' }, shot: 't', states: [error('trust')], triedErrors: true }
    ],
    steps: [
      { from: '/listed/choose', to: '/listed/confirm?type=personal', kind: 'submit', field: 'type', value: 'personal' },
      { from: '/listed/choose', to: '/listed/confirm?type=trust', kind: 'submit', field: 'type', value: 'trust' }
    ]
  })
  const states = id => graph.nodes.find(n => n.id === id).states.map(st => st.messages ? st.messages[0] : st.label)
  assert.deepStrictEqual(states('/listed/confirm'), ['Select yes for personal'])
  assert.deepStrictEqual(states('/listed/confirm?type=trust'), ['Select yes for trust'])
})

test('leaves out a listed state that looks exactly like the version it goes with', () => {
  const { applyFollowed } = require('../lib/follow')
  const graph = buildGraph({ root, scopeDir: path.join(root, 'app', 'views', 'listed') })
  // Like ?new-search=true, which only clears old answers
  graph.nodes.find(n => n.id === '/listed/confirm').states = [
    { kind: 'variant', listed: true, label: 'Start again', query: '?fresh=true', shot: 'p' },
    { kind: 'variant', listed: true, label: 'Another way', query: '?other=true', shot: 'x' }
  ]
  applyFollowed(graph, {
    versions: [
      { key: '/listed/choose', page: '/listed/choose', answers: {}, shot: 'c' },
      { key: '/listed/confirm?type=personal', page: '/listed/confirm', answers: { type: 'personal' }, shot: 'p' },
      { key: '/listed/confirm?type=trust', page: '/listed/confirm', answers: { type: 'trust' }, shot: 't' }
    ],
    steps: [
      { from: '/listed/choose', to: '/listed/confirm?type=personal', kind: 'submit', field: 'type', value: 'personal' },
      { from: '/listed/choose', to: '/listed/confirm?type=trust', kind: 'submit', field: 'type', value: 'trust' }
    ]
  })
  const labels = graph.nodes.filter(n => n.id.startsWith('/listed/confirm')).flatMap(n => n.states.map(st => st.label))
  assert.deepStrictEqual(labels, ['Another way'])

  // Like ?factType=postcode when postcode is what the page asks anyway: the
  // same words and questions, even when the pixels differ a little
  const again = buildGraph({ root, scopeDir: path.join(root, 'app', 'views', 'listed') })
  again.nodes.find(n => n.id === '/listed/confirm').states = [
    { kind: 'variant', listed: true, label: 'Postcode', query: '?type=personal&fact=postcode', shot: 'p2', screen: 'Postcode?|text:postcode' },
    { kind: 'variant', listed: true, label: 'Country', query: '?type=personal&fact=country', shot: 'p3', screen: 'Country?|select:country' }
  ]
  applyFollowed(again, {
    versions: [
      { key: '/listed/choose', page: '/listed/choose', answers: {}, shot: 'c' },
      { key: '/listed/confirm?type=personal', page: '/listed/confirm', answers: { type: 'personal' }, shot: 'p', look: 'Postcode?|text:postcode' },
      { key: '/listed/confirm?type=trust', page: '/listed/confirm', answers: { type: 'trust' }, shot: 't' }
    ],
    steps: [
      { from: '/listed/choose', to: '/listed/confirm?type=personal', kind: 'submit', field: 'type', value: 'personal' },
      { from: '/listed/choose', to: '/listed/confirm?type=trust', kind: 'submit', field: 'type', value: 'trust' }
    ]
  })
  const kept = again.nodes.filter(n => n.id.startsWith('/listed/confirm')).flatMap(n => n.states.map(st => st.label))
  assert.deepStrictEqual(kept, ['Country'])
})

test('puts a version the answers never reach with the most alike version', () => {
  const { applyFollowed } = require('../lib/follow')
  const graph = buildGraph({ root, scopeDir: path.join(root, 'app', 'views', 'listed') })
  graph.nodes.find(n => n.id === '/listed/confirm').states = [
    { kind: 'variant', listed: true, label: 'Outside the UK', query: '?type=CBC-NONUK-ORG' }
  ]
  applyFollowed(graph, {
    versions: [
      { key: '/listed/choose', page: '/listed/choose', answers: {}, shot: 'c' },
      { key: '/listed/confirm?type=TAX-IT', page: '/listed/confirm', answers: { type: 'TAX-IT' }, shot: 'a' },
      { key: '/listed/confirm?type=CBC-ORG', page: '/listed/confirm', answers: { type: 'CBC-ORG' }, shot: 'b' }
    ],
    steps: [
      { from: '/listed/choose', to: '/listed/confirm?type=TAX-IT', kind: 'submit', field: 'type', value: 'TAX-IT' },
      { from: '/listed/choose', to: '/listed/confirm?type=CBC-ORG', kind: 'submit', field: 'type', value: 'CBC-ORG' }
    ]
  })
  assert.strictEqual(graph.nodes.find(n => n.id === '/listed/confirm?type=CBC-ORG').states.length, 1)
  assert.strictEqual(graph.nodes.find(n => n.id === '/listed/confirm').states.length, 0)
})

test('joins branches again where every screen from there on is the same', () => {
  const { applyFollowed } = require('../lib/follow')
  const graph = buildGraph({ root, scopeDir: path.join(root, 'app', 'views', 'listed') })
  const v = (page, type, shot) => ({ key: '/listed/' + page + (type ? '?type=' + type : ''), page: '/listed/' + page, answers: type ? { type } : {}, shot })
  applyFollowed(graph, {
    versions: [
      v('choose', '', 'c'),
      v('confirm', 'personal', 'confirm for a person'),
      v('confirm', 'trust', 'confirm for a trust'),
      v('check', 'personal', 'check'),
      v('check', 'trust', 'check'),
      v('done', 'personal', 'done'),
      v('done', 'trust', 'done')
    ],
    steps: [
      { from: '/listed/choose', to: '/listed/confirm?type=personal', kind: 'submit', field: 'type', value: 'personal' },
      { from: '/listed/choose', to: '/listed/confirm?type=trust', kind: 'submit', field: 'type', value: 'trust' },
      { from: '/listed/confirm?type=personal', to: '/listed/check?type=personal', kind: 'submit', field: 'confirm', value: 'true' },
      { from: '/listed/confirm?type=trust', to: '/listed/check?type=trust', kind: 'submit', field: 'confirm', value: 'true' },
      { from: '/listed/check?type=personal', to: '/listed/done?type=personal', kind: 'link' },
      { from: '/listed/check?type=trust', to: '/listed/done?type=trust', kind: 'link' }
    ]
  })
  const versions = page => graph.nodes.filter(n => n.id.startsWith('/listed/' + page)).length
  assert.strictEqual(versions('confirm'), 2, 'the screens that differ stay apart')
  assert.strictEqual(versions('check'), 1, 'both branches join at the shared “Check your answers”')
  assert.strictEqual(versions('done'), 1)
  const intoCheck = graph.edges.filter(e => e.to === '/listed/check' && !e.return)
  assert.deepStrictEqual(intoCheck.map(e => e.from).sort(), ['/listed/confirm', '/listed/confirm?type=trust'])
  // Joined screens keep only the answers every branch shares
  assert.deepStrictEqual(graph.nodes.find(n => n.id === '/listed/check').answers, {})
})

test('tells answers that change a page from ones that only pick a record', () => {
  const { parsePage } = require('../lib/views')
  const page = parsePage(`
    {% set type = data.clientType %}
    {% if type == "trust" %}<p>Trust</p>{% endif %}
    {% if data["search-by"] != "arn" %}<p>Code</p>{% endif %}
    {% for item in items %}{% if item.code == data["unmap-agent-code"] %}<p>{{ item.code }}</p>{% endif %}{% endfor %}
  `, 'page.html')
  assert.deepStrictEqual(page.choiceFields.sort(), ['clientType', 'search-by'])
})

test('finds headings set with {% set %} and shown with GOV.UK macros', () => {
  const graph = buildGraph({ root, scopeDir: path.join(root, 'app', 'views', 'listed') })
  const title = name => graph.nodes.find(n => n.id === '/listed/' + name).title
  assert.strictEqual(title('choose'), 'What type of client is it?')
  assert.strictEqual(title('confirm'), 'Is this for …?')
  assert.strictEqual(title('done'), 'Authorisation cancelled')
})

test('photographs the states and errors the index page lists for each page', () => {
  const graph = buildGraph({ root, scopeDir: path.join(root, 'app', 'views', 'listed') })
  const choose = graph.nodes.find(n => n.id === '/listed/choose')
  assert.deepStrictEqual(choose.listedStates, [
    { query: '?type=trust', text: 'For a trust' },
    { query: '?type=trust&error=required', text: 'Select yes if this is right' }
  ])
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

test('lays out every state and error beside its page for the Mural export', async () => {
  const graph = buildGraph({ root, scopeDir })
  graph.meta.screenshots = true
  const page = node(graph, 'where-do-you-live')
  page.shot = 'data:image/webp;base64,'
  // A long page: the exports show it whole
  page.shotWidth = 1280
  page.shotHeight = 3200
  page.states = [
    { kind: 'error', label: 'Continue with nothing chosen', messages: ['Select where you live'], shot: 'data:image/webp;base64,' },
    { kind: 'reveal', label: 'Abroad', type: 'radio', shot: 'data:image/webp;base64,' }
  ]
  await addLayouts(graph)
  assert.deepStrictEqual(page.stateCards.map(c => [c.kind, c.error, c.lines.join(' ')]), [
    ['Error 1', true, 'Select where you live'],
    ['State 2', false, 'Abroad selected']
  ])
  for (const dir of ['DOWN', 'RIGHT']) {
    const layout = graph.layouts[dir + ':states']
    const box = layout.nodes[page.id]
    assert.strictEqual(box.cards.length, 2)
    // The states sit inside the page's box, clear of the page card
    for (const card of box.cards) {
      assert.ok(card.x + card.width <= box.width && card.y + card.height <= box.height)
      assert.ok(card.x >= box.card.width || card.y >= box.card.height)
    }
    // Lines join the page card, not the states
    const into = graph.edges.find(e => e.to === page.id && !e.return)
    const end = layout.edges[into.id].points.slice(-1)[0]
    if (dir === 'DOWN') assert.strictEqual(end.x, box.x + box.card.width / 2)
    else assert.strictEqual(end.y, box.y + box.card.height / 2)
    assert.strictEqual(box.card.picture, 550)
    assert.strictEqual(graph.layouts[dir + ':full'].nodes[page.id].card.picture, 550)
  }
})

test('lets the map lay out an export again without the screens left out', async () => {
  const vm = require('vm')
  const graph = buildGraph({ root, scopeDir })
  graph.meta.screenshots = true
  const page = node(graph, 'where-do-you-live')
  page.shot = 'data:image/webp;base64,'
  page.states = [
    { kind: 'error', label: 'Continue with nothing chosen', messages: ['Select where you live'], shot: 'data:image/webp;base64,' },
    { kind: 'error', label: 'Something else', messages: ['Select one option'], shot: 'data:image/webp;base64,' },
    { kind: 'reveal', label: 'Abroad', type: 'radio', shot: 'data:image/webp;base64,' }
  ]
  await addLayouts(graph)
  assert.deepStrictEqual(page.badges.map(b => b.text), ['2 errors', '2 states'])
  // The layout code the map carries, run as the browser would (its arrays
  // are another window's, so they're copied before comparing)
  const html = renderHtml(graph, { port: 3000, slug: 'apply' })
  const code = html.split('<script>').find(part => part.includes('window.journeyLayout ='))
  const window = vm.createContext({ setTimeout, clearTimeout, console })
  window.window = window
  vm.runInContext(code.slice(0, code.lastIndexOf('</script>')), window)
  const layout = window.journeyLayout
  // Leaving out an error: the tag counts only the one kept
  const copy = { ...page, states: page.states.slice(1), errorStates: [] }
  layout.measure(copy)
  copy.stateCards = layout.stateCardsFor(copy)
  assert.deepStrictEqual(Array.from(copy.badges, b => b.text), ['1 error', '2 states'])
  assert.deepStrictEqual(Array.from(copy.stateCards, c => c.kind), ['Error 1', 'State 2'])
  // Leaving out a page: it and its lines are gone, and the rest is laid out again
  const gone = node(graph, 'ineligible').id
  const nodes = graph.nodes.filter(n => n.id !== gone).map(n => n === page ? copy : n)
  const edges = graph.edges.filter(e => e.from !== gone && e.to !== gone)
  const result = await layout.layoutOne({ nodes, edges }, 'DOWN', 'states')
  assert.ok(!result.nodes[gone])
  assert.strictEqual(result.nodes[page.id].cards.length, 2)
  assert.strictEqual(Object.keys(result.nodes).length, nodes.length)
})

test('says what makes each error show, for the Mural export', () => {
  const { errorTrigger } = require('../lib/layout')
  assert.strictEqual(errorTrigger({ query: '?clientType=personal&error=required' }), 'Nothing entered')
  assert.strictEqual(errorTrigger({ query: '?error=invalid' }), 'Entered in the wrong format')
  assert.strictEqual(errorTrigger({ query: '?error=month-year-required' }), 'Date entered with no month or year')
  assert.strictEqual(errorTrigger({ query: '?error=too-long' }), 'Too long')
  // Errors the tool made by typing into the form say what it typed
  assert.strictEqual(errorTrigger({ label: 'Characters that aren’t allowed' }), 'Characters that aren’t allowed')
  assert.strictEqual(errorTrigger({ query: '?a=b', label: 'Opening the page from the journey’s index page' }), '')
})

test('lays out branches in the order the options are on the page', async () => {
  const graph = buildGraph({ root, scopeDir })
  const from = node(graph, 'where-do-you-live')
  // The routes check "abroad" before "england"; the page lists England first
  const branches = graph.edges.filter(e => e.from === from.id && /^where-do-you-live = /.test(e.rule))
  branches.reverse().forEach(e => { graph.edges.splice(graph.edges.indexOf(e), 1); graph.edges.push(e) })
  await addLayouts(graph)
  const target = value => branches.find(e => e.rule.includes(value)).to
  const down = graph.layouts.DOWN.nodes
  const right = graph.layouts.RIGHT.nodes
  assert.ok(down[target('england')].x < down[target('abroad')].x, 'top to bottom: England on the left')
  assert.ok(right[target('england')].y < right[target('abroad')].y, 'left to right: England at the top')
})

test('shows the whole file name, wrapped at hyphens when it is long', async () => {
  const graph = buildGraph({ root, scopeDir })
  const page = node(graph, 'where-do-you-live')
  page.fileName = 'what-is-the-full-name-of-the-person-we-should-contact.html'
  await addLayouts(graph)
  assert.deepStrictEqual(page.fileLines, ['what-is-the-full-name-of-the-', 'person-we-should-contact.html'])
  assert.ok(page.height > node(graph, 'start').height - 30, 'the card grows to fit')
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
  assert.deepStrictEqual(todo.branches, ['address → no-address'])
  nameBranches(graph, {
    rules: { found: 'Addresses found' },
    branches: { 'address → no-address': 'No addresses found' }
  })
  assert.strictEqual(edge(graph, 'address', 'choose-address').label, 'Addresses found')
  assert.strictEqual(edge(graph, 'address', 'choose-address').code, 'found')
  assert.strictEqual(edge(graph, 'address', 'no-address').label, 'No addresses found')
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

test('follows what a helper function is given, like the page to show errors on', () => {
  const routes = parseRoutes(`
    module.exports = function (router) {
      var base = '/help'
      function renderWithErrors (res, page, errors) {
        res.render(base + '/' + page, { errors: errors })
      }
      router.post(base + '/search', function (req, res) {
        var errors = {}
        if (!req.session.data.q) errors.q = 'Enter something'
        if (Object.keys(errors).length) {
          return renderWithErrors(res, 'search', errors)
        }
        res.redirect(base + '/results')
      })
    }
  `, 'routes.js')
  const targets = routes[0].targets.map(t => [t.kind, t.url, labelFor(t.conds), !!t.errors])
  assert.deepStrictEqual(targets, [
    ['render', '/help/search', 'has errors', true],
    ['redirect', '/help/results', 'otherwise', false]
  ])
})

test('reads a base address worked out from the folder', () => {
  const routes = parseRoutes(`
    var path = require('path')
    module.exports = function (router) {
      var base = '/' + __dirname.split(path.sep + 'views' + path.sep).pop().split(path.sep).join('/')
      router.post(base + '/start', (req, res) => res.redirect(base + '/next'))
    }
  `, '/somewhere/my-prototype/app/views/epic/version-1-0/journey/_routes.js')
  assert.strictEqual(routes[0].path, '/epic/version-1-0/journey/start')
  assert.strictEqual(routes[0].targets[0].url, '/epic/version-1-0/journey/next')
})

test('makes conditions readable', () => {
  assert.strictEqual(prettyCondition("req.session.data['has-passport'] === 'yes'"), "has-passport = 'yes'")
  assert.strictEqual(prettyCondition('data.age >= 18 && !data.blocked'), 'age >= 18 and not blocked')
  assert.strictEqual(prettyCondition('Object.keys(errors).length > 0'), 'has errors')
})

test('keeps links to the same page with different answers in the address apart, and carries those answers on', () => {
  const { linkAnswers } = require('../lib/follow')
  const graph = buildGraph({ root, scopeDir: path.join(root, 'app', 'views', 'choice') })
  const links = graph.edges.filter(e => e.from === '/choice/start' && e.to === '/choice/sign-in')
  assert.deepStrictEqual(links.map(e => e.query).sort(), ['?startChoice=decline', '?startChoice=start'])
  assert.deepStrictEqual(links.map(e => e.texts[0]).sort(), ['I do not want this agent', 'Start now'])
  // The route after sign in uses the answer, so following each link carries it on
  const used = new Set(['startChoice'])
  const decline = links.find(e => e.query === '?startChoice=decline')
  assert.deepStrictEqual(linkAnswers(decline, used), { startChoice: 'decline' })
  // Answers the journey doesn't use, and error addresses, aren't carried
  assert.deepStrictEqual(linkAnswers({ kind: 'link', query: '?preview=true&error=required' }, used), {})
  assert.deepStrictEqual(linkAnswers({ kind: 'submit', query: '?startChoice=decline' }, used), {})
  // Two ways on from the start page: each link is named with its words
  assert.deepStrictEqual(links.map(e => e.label).sort(), ['“I do not want this agent”', '“Start now”'])
  // After sign in, a branch on an answer given before is followed, unless it
  // contradicts the answer given on the way here
  const { ruleAnswer } = require('../lib/follow')
  const toDecline = graph.edges.find(e => e.from === '/choice/sign-in' && e.to === '/choice/decline')
  assert.deepStrictEqual(ruleAnswer(toDecline, {}), { field: 'startChoice', value: 'decline' })
  assert.deepStrictEqual(ruleAnswer(toDecline, { startChoice: 'decline' }), { field: 'startChoice', value: 'decline' })
  assert.strictEqual(ruleAnswer(toDecline, { startChoice: 'start' }), null)
  assert.strictEqual(ruleAnswer({ rule: 'otherwise' }, {}), null)
  const out = graph.edges.filter(e => e.from === '/choice/sign-in').map(e => e.to + ' ' + e.rule)
  assert.deepStrictEqual(out.sort(), ["/choice/consent otherwise", "/choice/decline startChoice = 'decline'"])
})

test('draws links to "#" as ways out of the journey, named with their words', () => {
  const graph = buildGraph({ root, scopeDir: path.join(root, 'app', 'views', 'leave') })
  const leaving = graph.nodes.filter(n => n.nowhere && !/^Continues in /.test(n.title))
  // Like other pages outside the journey, each page that links there gets its own copy
  assert.deepStrictEqual(leaving.map(n => n.title).sort(), ['Cancel your authorisation', 'Start new request', 'Start new request'])
  assert.ok(leaving.every(n => n.type === 'exit' && n.outside))
  const into = title => graph.edges.filter(e => leaving.some(n => n.id === e.to && n.title === title)).map(e => e.from).sort()
  assert.deepStrictEqual(into('Start new request'), ['/leave/requests', '/leave/resend'])
  assert.deepStrictEqual(into('Cancel your authorisation'), ['/leave/requests'])
  // Links that open in a new tab, skip links and links with no words aren't ways out
  assert.ok(!graph.nodes.some(n => /guidance|sign your client up|skip/i.test(n.title)))
  assert.ok(graph.edges.some(e => e.from === '/leave/requests' && e.to === '/leave/resend'))
})

test('draws "#continues-in-<folder>" links and redirects as the journey to open next', () => {
  const graph = buildGraph({ root, scopeDir: path.join(root, 'app', 'views', 'leave') })
  const continuing = graph.nodes.filter(n => /^Continues in /.test(n.title || ''))
  assert.deepStrictEqual(continuing.map(n => n.title).sort(), ['Continues in create-request', 'Continues in manage-requests'])
  assert.ok(continuing.every(n => n.type === 'exit' && n.outside && n.nowhere))
  const into = title => graph.edges.filter(e => continuing.some(n => n.id === e.to && n.title === title))
  // A link, named with its words
  assert.deepStrictEqual(into('Continues in manage-requests').map(e => e.from + ' ' + e.kind), ['/leave/resend link'])
  // A redirect, on the answer that leads there
  assert.deepStrictEqual(into('Continues in create-request').map(e => e.from + ' ' + e.kind + ' ' + e.rule), ["/leave/resend submit resendTo = 'new'"])
  // Not also drawn as a way out named with the link's words
  assert.ok(!graph.nodes.some(n => n.title === 'See all your requests'))
})

test('makes other versions of a page screens of their own, and keeps reveals, tabs and errors as states', () => {
  const { splitVersions } = require('../lib/follow')
  const page = (id, states = [], extra = {}) => ({ id, type: 'page', url: id, title: id, thumb: 'thumb:' + id, shot: 'shot:' + id, states, variants: [], listedStates: [], errorStates: [], warnings: [], ...extra })
  const line = (from, to, kind = 'submit') => ({ id: from + to, from, to, kind, label: '', rule: '', texts: [] })
  const graph = {
    meta: { mainEntry: '/details', stats: {} },
    nodes: [
      page('/details'),
      page('/other-way'),
      page('/confirm', [
        { kind: 'reveal', label: 'Yes', shot: 'shot:reveal' },
        { kind: 'tab', label: 'History', shot: 'shot:tab' },
        { kind: 'error', label: 'Nothing entered', messages: ['Select one'], shot: 'shot:error' },
        { kind: 'variant', listed: true, label: 'Agent suspended', query: '?view=agent-suspended', thumb: 'thumb:suspended', shot: 'shot:suspended' }
      ]),
      page('/code', [{ kind: 'variant', label: 'Request a new code', query: '?requestedNew=true', thumb: 'thumb:new', shot: 'shot:new' }]),
      page('/result', [{ kind: 'answer', label: 'A trust', question: 'Who is it for?', thumb: 'thumb:trust', shot: 'shot:trust' }], { answerStates: { from: '/details', field: 'who', options: [] } })
    ],
    edges: [line('/details', '/confirm'), line('/other-way', '/confirm'), line('/details', '/other-way'), line('/confirm', '/code', 'link'), line('/code', '/result')]
  }
  splitVersions(graph)
  const byId = id => graph.nodes.find(n => n.id === id)

  assert.deepStrictEqual(byId('/confirm').states.map(st => st.kind), ['reveal', 'tab', 'error'], 'reveals, tabs and errors stay states')
  const suspended = byId('/confirm?view=agent-suspended')
  assert.ok(suspended, 'a version the index page lists is a screen of its own')
  assert.strictEqual(suspended.thumb, 'thumb:suspended')
  assert.strictEqual(suspended.shot, 'shot:suspended')
  assert.strictEqual(suspended.title, '/confirm – Agent suspended')
  assert.deepStrictEqual(suspended.states, [])
  assert.deepStrictEqual(graph.edges.filter(e => e.to === suspended.id).map(e => e.from).sort(), ['/details', '/other-way'], 'it branches from every page that leads to the page')
  assert.ok(graph.edges.filter(e => e.to === suspended.id).every(e => e.label === 'Agent suspended' && e.version))

  const code = graph.edges.filter(e => e.to === '/code?requestedNew=true')
  assert.deepStrictEqual(code.map(e => [e.from, e.kind, e.texts[0]]), [['/code', 'link', 'Request a new code']], 'a link back to the page branches from the page')

  const trust = graph.edges.filter(e => e.to === '/result?version=1')
  assert.deepStrictEqual(trust.map(e => e.from), ['/details'], 'an answer on an earlier page branches from the page that asks it')
  assert.ok(byId('/result').answerStates, 'the page keeps what names the answers')

  assert.deepStrictEqual(graph.edges.filter(e => e.from === suspended.id && !e.version).map(e => e.to), ['/code'], 'a version screen carries on with the page’s own ways on')

  // A version of a screen the journey already led to with answers gets one address with both
  const followed = {
    meta: { mainEntry: '/a', stats: {} },
    nodes: [page('/a'), page('/b?service=CBC', [{ kind: 'variant', listed: true, label: 'Outside the UK', query: '?service=CBC&where=non-uk', shot: 's' }], { url: '/b?service=CBC' })],
    edges: [line('/a', '/b?service=CBC')]
  }
  splitVersions(followed)
  const outside = followed.nodes.find(n => n.version)
  assert.strictEqual(outside.id, '/b?service=CBC&where=non-uk')
  assert.strictEqual(outside.url, '/b?service=CBC&where=non-uk')
})

test('counts only reveals and tabs as states, and versions on maps without screenshots', () => {
  const { measure } = require('../lib/layout')
  const page = { id: '/p', type: 'page', title: 'P', states: [{ kind: 'reveal' }, { kind: 'tab' }], variants: [], listedStates: [{ query: '?a=1' }], errorStates: [], warnings: [], fileName: 'p.html' }
  measure(page)
  assert.deepStrictEqual(page.badges.map(b => b.text), ['3 states', '2 versions'])
  const photographed = { ...page, shot: 'shot', versionsSplit: true }
  measure(photographed)
  assert.deepStrictEqual(photographed.badges.map(b => b.text), ['3 states'], 'photographed versions are screens of their own, not counted')
})

test('keeps versions of a page that isn’t on the way through the journey as variants, not branches', () => {
  const { splitVersions } = require('../lib/follow')
  const { measure, onMainFlow } = require('../lib/layout')
  const page = (id, states = []) => ({ id, type: 'page', url: id, title: id, thumb: 't', shot: 's', states, variants: [], listedStates: [], errorStates: [], warnings: [], fileName: id + '.html' })
  const variant = (label, query) => ({ kind: 'variant', listed: true, label, query, thumb: 't', shot: 's' })
  const line = (from, to, kind, extra = {}) => ({ id: from + to, from, to, kind, label: '', rule: '', texts: [], ...extra })
  const graph = {
    meta: { mainEntry: '/start', stats: {} },
    nodes: [
      page('/start'),
      page('/select', [variant('Trust', '?clientType=trust')]),
      page('/already-exists', [variant('VAT', '?clientService=VAT'), variant('Income record', '?clientService=IR')])
    ],
    edges: [line('/start', '/select', 'submit'), line('/already-exists', '/start', 'link', { return: true })]
  }
  assert.deepStrictEqual([...onMainFlow(graph)].sort(), ['/select', '/start'], 'return links don’t count')
  splitVersions(graph)
  assert.ok(graph.nodes.some(n => n.id === '/select?clientType=trust'), 'a page on the way through still branches')
  const exists = graph.nodes.find(n => n.id === '/already-exists')
  assert.deepStrictEqual(exists.states.map(st => st.label), ['VAT', 'Income record'], 'its versions stay with the page')
  assert.ok(!graph.nodes.some(n => n.id.startsWith('/already-exists?')))
  assert.ok(!graph.edges.some(e => e.from === '/already-exists' && e.version))
  measure(exists)
  assert.deepStrictEqual(exists.badges.map(b => b.text), ['3 variants'])

  // Without screenshots, the same page says variants, not versions
  const unphotographed = { ...page('/p'), shot: null, listedStates: [{ query: '?a=1' }], offFlow: true }
  measure(unphotographed)
  assert.deepStrictEqual(unphotographed.badges.map(b => b.text), ['2 variants'])
})

test('keeps version branches named, and gives each version the heading it shows when the heading depends on the answers', () => {
  const { splitVersions } = require('../lib/follow')
  const { findTitle } = require('../lib/views')
  const src = '{% set pageName = "Request declined" if declined else "Agent authorised" %}\n{{ govukPanel({ titleText: pageName }) }}'
  const info = findTitle(src, 'complete.html')
  assert.strictEqual(info.titleVaries, true, 'a heading picked with if … else depends on the answers')
  assert.strictEqual(findTitle('<h1>Agent authorised</h1>', 'complete.html').titleVaries, undefined)

  const page = {
    id: '/complete', type: 'page', url: '/complete', title: 'Agent authorised', titleVaries: true, thumb: 't', shot: 's',
    variants: [], listedStates: [], errorStates: [], warnings: [],
    states: [{ kind: 'variant', listed: true, label: 'Client declines', query: '?accepted=false', heading: 'Request declined', thumb: 't2', shot: 's2' }]
  }
  const graph = {
    meta: { mainEntry: '/consent', stats: {} },
    nodes: [{ id: '/consent', type: 'page', url: '/consent', title: 'Consent', states: [], variants: [], listedStates: [], errorStates: [], warnings: [] }, page],
    edges: [{ id: 'e1', from: '/consent', to: '/complete', kind: 'submit', label: '', rule: '', texts: [] }]
  }
  splitVersions(graph)
  const declined = graph.nodes.find(n => n.id === '/complete?accepted=false')
  assert.strictEqual(declined.title, 'Request declined – Client declines')
  nameBranches(graph)
  assert.strictEqual(graph.edges.find(e => e.to === declined.id).label, 'Client declines', 'naming the branches keeps the version’s name')
})

test('carries version screens on only where they show a way on, to the next page’s matching version', () => {
  const { splitVersions } = require('../lib/follow')
  const page = (id, states = []) => ({ id, type: 'page', url: id, title: id, thumb: 't', shot: 's', states, variants: [], listedStates: [], errorStates: [], warnings: [] })
  const line = (from, to, kind, rule = '') => ({ id: from + to, from, to, kind, label: '', rule, texts: [] })
  const both = { links: ['/select-service'], forms: ['/consent'] }
  const graph = {
    meta: { mainEntry: '/confirm', stats: {} },
    nodes: [
      page('/select-service'),
      page('/confirm', [{ kind: 'variant', listed: true, label: 'Agent suspended', query: '?view=agent-suspended', ways: { links: ['/select-service'], forms: [] }, thumb: 't', shot: 's1' }]),
      page('/consent', [{ kind: 'variant', listed: true, label: 'A trust', query: '?type=trust', ways: both, thumb: 't', shot: 's2' }]),
      page('/complete', [
        { kind: 'variant', listed: true, label: 'Declined', query: '?accepted=false', ways: both, thumb: 't', shot: 's3' },
        { kind: 'variant', listed: true, label: 'A trust', query: '?type=trust', ways: both, thumb: 't', shot: 's4' }
      ])
    ],
    edges: [
      line('/confirm', '/consent', 'submit'),
      line('/confirm', '/select-service', 'link'),
      line('/consent', '/complete', 'submit', "accepted = 'true'"),
      line('/consent', '/complete?accepted=false', 'submit', "accepted = 'false'")
    ]
  }
  splitVersions(graph)
  const from = id => graph.edges.filter(e => e.from === id && !e.version).map(e => e.to).sort()
  assert.deepStrictEqual(from('/confirm?view=agent-suspended'), ['/select-service'], 'no form, so no Continue: only the link it shows')
  assert.deepStrictEqual(from('/consent?type=trust'), ['/complete?accepted=false', '/complete?type=trust'], 'Yes goes to the trust’s version of the next page')
  assert.ok(!graph.edges.some(e => e.version && e.from === '/consent' && e.to === '/complete?type=trust'), 'the trust’s confirmation is reached from the trust’s consent, not the page')
  assert.ok(graph.edges.filter(e => e.from === '/consent?type=trust').every(e => e.rule), 'the branches keep their rules, to be named')
})

test('gives a version screen the links it shows that its own page has no line for', () => {
  const { splitVersions } = require('../lib/follow')
  const page = (id, url, states = []) => ({ id, type: 'page', url, title: id, thumb: 't', shot: 's', states, variants: [], listedStates: [], errorStates: [], warnings: [] })
  const line = (from, to, kind) => ({ id: from + to, from, to, kind, label: '', rule: '', texts: ['Start again'] })
  const graph = {
    meta: { mainEntry: '/confirm', stats: {} },
    nodes: [
      page('/select-service', '/select-service'),
      page('/consent', '/consent'),
      page('/confirm', '/confirm'),
      page('/confirm?service=CBC', '/confirm?service=CBC', [{ kind: 'variant', listed: true, label: 'Agent suspended', query: '?service=CBC&view=agent-suspended', ways: { links: ['/select-service', '/confirm'], forms: [] }, thumb: 't', shot: 's1' }])
    ],
    edges: [line('/confirm', '/select-service', 'link'), line('/select-service', '/confirm?service=CBC', 'submit'), line('/confirm', '/consent', 'submit'), line('/confirm?service=CBC', '/consent', 'submit')]
  }
  splitVersions(graph)
  const out = graph.edges.filter(e => e.from === '/confirm?service=CBC&view=agent-suspended').map(e => [e.to, e.kind])
  assert.deepStrictEqual(out, [['/select-service', 'link']])
})

test('draws pages that can show anywhere on their own, in a row above the journey', async () => {
  const { parsePage } = require('../lib/views')
  const { layoutOne, measure } = require('../lib/layout')
  assert.strictEqual(parsePage('{# journey-map: anywhere #}\n<h1>You have been signed out</h1>', 'iv-timed-out.html').anywhere, true)
  assert.strictEqual(parsePage('<h1>Start</h1>', 'start.html').anywhere, undefined)

  const page = (id, extra = {}) => ({ id, type: 'page', title: id, file: id, fileLines: [id], states: [], errorStates: [], variants: [], listedStates: [], warnings: [], notes: [], ...extra })
  const graph = {
    meta: {},
    nodes: [page('/start', { entry: true }), page('/end'), page('/signed-out', { anywhere: true })],
    edges: [{ id: 'e1', from: '/start', to: '/end', kind: 'link', label: '' }]
  }
  graph.nodes.forEach(measure)
  assert.ok(graph.nodes[2].badges.some(b => b.text === 'Any page'))
  const layout = await layoutOne(graph, 'DOWN', false)
  const alone = layout.nodes['/signed-out']
  assert.ok(alone, 'it’s on the map')
  assert.ok(alone.y + alone.height < layout.nodes['/start'].y, 'above the journey')
  assert.ok(layout.edges.e1.points.every(p => p.y > alone.y + alone.height), 'the journey’s lines move down with it')
})

test('only the main start is tagged Start, not pages nothing leads to', () => {
  const { arrange } = require('../lib/graph')
  const page = id => ({ id, type: 'page', title: id, states: [], errorStates: [], variants: [], listedStates: [], warnings: [], notes: [] })
  const graph = {
    meta: { mainEntry: '/start', stats: {} },
    nodes: [page('/start'), page('/end'), page('/kickout')],
    edges: [
      { id: 'e1', from: '/start', to: '/end', kind: 'submit', label: '' },
      { id: 'e2', from: '/kickout', to: '/end', kind: 'link', label: '' }
    ]
  }
  arrange(graph)
  const byId = id => graph.nodes.find(n => n.id === id)
  assert.ok(byId('/start').entry)
  assert.ok(!byId('/kickout').entry, 'a page nothing leads to, with a link on, isn’t a start')
  assert.ok(byId('/kickout').root, 'but the map still walks from it')
})

test('gives each version only the branches its answers allow, named with its own options', () => {
  const { splitVersions } = require('../lib/follow')
  const page = (id, states = [], extra = {}) => ({ id, type: 'page', url: id, title: id, thumb: 't', shot: 's', states, variants: [], listedStates: [], errorStates: [], warnings: [], ...extra })
  const line = (to, rule) => ({ id: to + rule, from: '/agent-role', to, kind: 'submit', label: '', rule, texts: [] })
  const ways = { links: [], forms: ['/agent-role'] }
  const own = { agentRole: { question: '', options: { main: 'No', supp: 'Yes, I want to become their supporting agent instead' } } }
  const graph = {
    meta: { mainEntry: '/agent-role', stats: {} },
    nodes: [
      page('/agent-role', [
        { kind: 'variant', listed: true, label: 'Already the main agent', query: '?existing=main', ways, renderedFields: own, thumb: 't', shot: 's1' }
      ], { renderedFields: { agentRole: { question: '', options: { main: 'As their main agent', supp: 'As a supporting agent' } } } }),
      page('/check'), page('/no-change')
    ],
    edges: [
      line('/no-change', "existing = 'main' and agentRole = 'main'"),
      line('/no-change', "existing = 'supp' and agentRole = 'supp'"),
      line('/check', "agentRole = 'supp'"),
      line('/check', "agentRole = 'main'")
    ]
  }
  splitVersions(graph)
  const from = id => graph.edges.filter(e => e.from === id && !e.version).map(e => e.to + ' ' + e.rule).sort()
  assert.deepStrictEqual(from('/agent-role'), ["/check agentRole = 'main'", "/check agentRole = 'supp'"], 'a new client can’t get “no change”')
  assert.deepStrictEqual(from('/agent-role?existing=main'), ["/check agentRole = 'supp'", "/no-change agentRole = 'main'"], 'only the main agent’s “no change”, which catches “No” before the line to check, named without the answer the version already has')
  const version = graph.nodes.find(n => n.id === '/agent-role?existing=main')
  assert.strictEqual(version.fields.agentRole.options.supp, 'Yes, I want to become their supporting agent instead')
})

test('names an option with more than one way on as “Option” – what decides it, in full', () => {
  const page = (id, extra = {}) => ({ id, type: 'page', title: id, states: [], errorStates: [], variants: [], listedStates: [], warnings: [], notes: [], fields: {}, ...extra })
  const graph = {
    meta: {},
    nodes: [
      page('/role', {
        fields: { agentRole: { question: 'How do you want to act?', options: { main: 'No', supp: 'Yes, I want to become their supporting agent instead of their main agent' } } },
        listedStates: [{ text: 'Already the client’s main agent', query: '?existingAgentRole=main' }]
      }),
      page('/check'), page('/no-change')
    ],
    edges: [
      { id: 'a', from: '/role', to: '/no-change', kind: 'submit', rule: "existingAgentRole = 'main' and agentRole = 'main'", texts: [] },
      { id: 'b', from: '/role', to: '/check', kind: 'submit', rule: "agentRole = 'main'", texts: [] },
      { id: 'c', from: '/role', to: '/check', kind: 'submit', rule: "existingAgentRole = 'main' and agentRole = 'supp'", texts: [] },
      { id: 'd', from: '/role', to: '/check', kind: 'submit', rule: "signedUp = 'false'", texts: [] }
    ]
  }
  nameBranches(graph)
  const label = id => graph.edges.find(e => e.id === id).label
  assert.strictEqual(label('a'), '“No” – Already the client’s main agent', 'the condition named as the index page names its address')
  assert.strictEqual(label('b'), '“No”')
  assert.ok(/^“Yes, I want to become their.*…” – Already the client’s main agent$/.test(label('c')), 'a long option is cut, what decides it never is: ' + label('c'))
  assert.strictEqual(label('d'), 'signed up is false', 'a condition with no other name is put in words')

  const { addLayouts } = require('../lib/layout')
  return addLayouts({ meta: {}, nodes: graph.nodes.map(n => ({ ...n, fileLines: [n.id] })), edges: graph.edges.map(e => ({ ...e, label: 'A label that is a good deal longer than one line of a branch label' })) })
    .then(g => {
      assert.ok(g.edges[0].labelLines.length > 1, 'a long label wraps')
      assert.ok(g.edges[0].labelLines.every(l => !l.endsWith('…')), 'and isn’t cut')
    })
})
