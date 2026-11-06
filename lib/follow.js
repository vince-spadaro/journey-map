// Redraws the map with a branch for every answer, from what following the
// answers in the running prototype found (followAnswers in screenshots.js).
// Each version of a page the answers lead to is its own page on the map, with
// its own screenshot: "What type of client" branches into three "Which
// authorisation" pages, one for each type, and so on to the end. Branches join
// again where every screen from there on is the same, like a shared
// "Check your answers" and confirmation.

const crypto = require('crypto')
const { arrange } = require('./graph')
const { onMainFlow } = require('./layout')

// The answers as an address: ?clientService=TAX-VAT&clientType=business
function queryOf (answers) {
  const keys = Object.keys(answers).sort()
  return keys.length ? '?' + keys.map(k => encodeURIComponent(k) + '=' + encodeURIComponent(answers[k])).join('&') : ''
}

function paramsOf (query) {
  const params = {}
  for (const [key, value] of new URLSearchParams(String(query || '').replace(/^\?/, ''))) params[key] = value
  return params
}

// Does a state the page was photographed in belong to this version of it?
// Not if its address gives a different answer to one this version was given.
// `score` is how many answers it shares; `rest` is how many more it gives.
function matches (state, answers) {
  const params = paramsOf(state.query)
  delete params.error
  const keys = Object.keys(params)
  if (keys.some(k => k in answers && answers[k] !== params[k])) return { score: -1, rest: 0 }
  const score = keys.filter(k => answers[k] === params[k]).length
  return { score, rest: keys.length - score }
}

// A version of the page the answers don't reach, like one the prototype picks
// from data, goes with the most alike version: the most answers the same, then
// the most alike other answers (CBC-NONUK-ORG is most like CBC-ORG)
function closest (state, versions) {
  const params = paramsOf(state.query)
  delete params.error
  const alike = (a, b) => {
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    return i / Math.max(a.length, b.length, 1)
  }
  const score = v => Object.entries(params).reduce((sum, [k, value]) =>
    sum + (v.answers[k] === value ? 1 : k in v.answers ? alike(String(v.answers[k]), String(value)) / 2 : 0), 0)
  return versions.reduce((best, v) => score(v) > score(best) ? v : best, versions[0])
}

// Versions of a page that are the same screen (the same words and questions,
// whatever answers a summary list shows back), and lead on to the same screens the
// same ways, are one screen: the branches join there. Worked out from the end
// back, so a shared ending joins at its first screen. Each way on keeps
// whether it was the only answer from its page to its screen (`alone`).
function joinSame (followed) {
  const byKey = new Map(followed.versions.map(v => [v.key, v]))
  const outOf = new Map()
  const ways = new Map()
  for (const step of followed.steps) {
    if (!outOf.has(step.from)) outOf.set(step.from, [])
    outOf.get(step.from).push(step)
    const pair = step.from + ' ' + step.to
    ways.set(pair, (ways.get(pair) || new Set()).add(step.field ? step.value : ''))
  }
  const hash = text => crypto.createHash('sha1').update(text).digest('hex')
  // What each screen is: its words and questions (`look`), or else its screenshot
  const shots = new Map(followed.versions.map(v => [v.key, hash(v.page + '|' + (v.look || v.shot || ''))]))
  const looks = new Map()
  const going = new Set()
  const look = key => {
    if (looks.has(key)) return looks.get(key)
    if (going.has(key) || !byKey.has(key)) return 'to:' + key
    going.add(key)
    const onward = (outOf.get(key) || []).map(step => {
      const how = step.field ? step.field + '=' + step.value : (step.edge && step.edge.rule) || ''
      // A way back is the same if it goes back to the same page
      const where = step.back ? 'back:' + (byKey.get(step.to) || { page: step.to }).page : look(step.to)
      return how + '>' + where
    }).sort()
    going.delete(key)
    const sum = hash(shots.get(key) + '|' + onward.join(','))
    looks.set(key, sum)
    return sum
  }
  followed.versions.forEach(v => look(v.key))

  // One version for each look: the one with no answers, or else the first found.
  // It keeps only the answers every version joined into it shares.
  const groups = new Map()
  for (const v of followed.versions) {
    const sum = looks.get(v.key)
    if (!groups.has(sum)) groups.set(sum, [])
    groups.get(sum).push(v)
  }
  const into = new Map()
  const versions = []
  for (const group of groups.values()) {
    const kept = group.find(v => !Object.keys(v.answers).length) || group[0]
    const shared = Object.fromEntries(Object.entries(kept.answers).filter(([k, value]) => group.every(v => v.answers[k] === value)))
    versions.push(group.length > 1 ? { ...kept, answers: shared, url: kept.url, joined: group.length } : kept)
    group.forEach(v => into.set(v.key, kept.key))
  }
  const steps = followed.steps.map(step => ({
    ...step,
    alone: ways.get(step.from + ' ' + step.to).size === 1,
    from: into.get(step.from) || step.from,
    to: into.get(step.to) || step.to
  }))
  // Keep the address of the version kept, which opens the screen as it was photographed
  const opened = new Map(versions.map(v => [v.key, followed.versions.find(o => o.key === v.key).answers]))
  return { ...followed, versions, steps, opened }
}

// `followed` is { versions: [{ key, page, answers, ...screenshot }], steps:
// [{ from, to, kind, field, value, edge }] }, with keys like page + queryOf(answers)
function applyFollowed (graph, followed) {
  if (!followed || !followed.versions.length) return graph
  followed = joinSame(followed)
  const pages = new Map(graph.nodes.map(n => [n.id, n]))
  const byPage = new Map()
  followed.versions.forEach(v => {
    if (!byPage.has(v.page)) byPage.set(v.page, [])
    byPage.get(v.page).push(v)
  })
  const branched = [...byPage.keys()].filter(id => pages.has(id))

  // The version with no answers, or else the first, keeps the page's own id
  const idOf = new Map()
  for (const id of branched) {
    const versions = byPage.get(id)
    versions.sort((a, b) => (Object.keys(a.answers).length === 0 ? 0 : 1) - (Object.keys(b.answers).length === 0 ? 0 : 1))
    versions.forEach((v, i) => idOf.set(v.key, i === 0 ? id : id + queryOf((followed.opened && followed.opened.get(v.key)) || v.answers)))
  }

  // Each answer in words: the page that asks it, and the option as the user sees it
  const asked = {}
  for (const v of followed.versions) {
    for (const [field, choice] of Object.entries(v.renderedFields || {})) {
      if (!asked[field]) asked[field] = { question: (pages.get(v.page) || {}).title || '', options: {} }
      Object.assign(asked[field].options, choice.options)
    }
  }
  const inWords = answers => Object.entries(answers)
    .filter(([field, value]) => asked[field] && asked[field].options[value])
    .map(([field, value]) => ({ question: asked[field].question, answer: asked[field].options[value] }))

  const nodes = graph.nodes.filter(n => !byPage.has(n.id))
  for (const id of branched) {
    const page = pages.get(id)
    const versions = byPage.get(id)
    // Each state goes with the version whose answers it was photographed with.
    // States that are this version, or the answers it branches on, aren't repeated.
    // Versions photographed with their own errors don't need the page's.
    const statesFor = new Map(versions.map(v => [v.key, [...(v.states || [])]]))
    const ownErrors = versions.some(v => v.triedErrors)
    for (const st of page.states || []) {
      if (st.kind === 'answer' || (st.kind === 'error' && ownErrors)) continue
      const scored = versions.map(v => ({ v, ...matches(st, v.answers) })).filter(x => x.score >= 0)
      // A version the index lists that the answers lead to is that version, not another state of it
      if (st.kind === 'variant' && st.query && scored.some(x => x.score > 0 && x.rest === 0)) continue
      const best = scored.sort((a, b) => b.score - a.score || a.rest - b.rest)[0]
      const version = best && best.score > 0 ? best.v : closest(st, versions)
      // A listed address that shows the page exactly as this version opens,
      // like ?new-search=true that only clears old answers, or ?factType=postcode
      // when postcode is what the page asks anyway, isn't another state. Compared
      // by words and questions: the pixels of the same screen can differ.
      if (st.kind !== 'error' && (st.screen && version.look ? st.screen === version.look : st.shot && st.shot === version.shot)) continue
      statesFor.get(version.key).push(st)
    }
    versions.forEach((v, i) => {
      const { key, page: _page, answers, renderedHeading, states: _states, triedErrors: _tried, look: _look, ...shot } = v
      nodes.push({
        ...page,
        ...shot,
        id: idOf.get(key),
        url: page.url + queryOf((followed.opened && followed.opened.get(key)) || answers),
        title: (page.titleFromFile || page.titleVaries) && /[a-z]{3}/i.test(renderedHeading || '') ? renderedHeading : page.title,
        answers,
        answersInWords: inWords(answers),
        states: statesFor.get(key),
        answerStates: null,
        listedStates: [],
        // The index page's words for the page's addresses, kept to name branches by (names.js)
        listedNames: (page.listedStates || []).map(({ text, query }) => ({ text, query })),
        variants: i === 0 ? page.variants : [],
        sameAsAnswer: null
      })
    })
  }

  // Lines between pages that were followed are replaced by the steps found.
  // Change links, links back, and lines to and from the rest stay with the
  // first version of the page, which keeps the page's id.
  const edges = graph.edges.filter(e => e.kind === 'change' || e.return || !(byPage.has(e.from) && byPage.has(e.to)))
  edges.forEach(e => { if (e.return) e.back = true })
  let next = 0
  const seen = new Set()
  // Different answers that lead to the same page are one line, not a branch
  const ways = new Map()
  for (const step of followed.steps) {
    const pair = step.from + ' ' + step.to
    ways.set(pair, (ways.get(pair) || new Set()).add(step.field ? step.value : ''))
  }
  for (const step of followed.steps) {
    const from = idOf.get(step.from)
    const to = idOf.get(step.to)
    if (!from || !to || from === to) continue
    const alone = step.alone ?? ways.get(step.from + ' ' + step.to).size === 1
    const rule = step.field && alone ? `${step.field} = '${step.value}'` : !step.field && step.edge ? step.edge.rule || '' : ''
    const key = [from, to, rule].join(' ')
    if (seen.has(key)) continue
    seen.add(key)
    const like = step.edge || {}
    edges.push({
      id: 'f' + next++,
      from,
      to,
      kind: step.kind || like.kind || 'submit',
      label: rule,
      rule,
      texts: like.texts || [],
      fullTexts: like.fullTexts || [],
      query: like.query || '',
      via: like.via || 'followed ' + from,
      decided: !!like.decided,
      // Back to a page earlier on the way there
      back: !!step.back || !!like.return
    })
  }

  graph.nodes = nodes
  graph.edges = edges
  return arrange(graph)
}

// A state is the same screen in another state, which one screenshot can't
// show: an option's conditional reveal, a tab, an error. Everything else the
// page was photographed as is another version of the page: an address the
// journey's index page lists (?view=agent-suspended), a link back to the
// same page (?requestedNew=true) or an answer on the page before. Each of
// those becomes a screen of its own, with its own thumbnail, on a branch from
// where it's reached:
// - a version the index page lists: from each page that leads to this one,
//   as another way it can turn out
// - a link back to the same page: from the page, with the link's words
// - an answer on the page before: from the page that asks it
// A page nothing leads to branches from itself. A version screen carries on
// with the page's own ways on, but only those it shows: a version with no
// form has no Continue. Where the next page has a version with the same
// answers (a trust's consent leading to a trust's confirmation), it goes there.
const VERSION_KINDS = new Set(['variant', 'answer'])

// Only pages on the way through the journey from the start branch: a page
// nothing in the journey leads to, like one the index page lists as not
// shown in this journey, keeps its versions as variants (tabs in full screen)
function splitVersions (graph) {
  const flow = onMainFlow(graph)
  const pages = graph.nodes.filter(n => n.type === 'page' && (!flow || flow.has(n.id)) && (n.states || []).some(st => VERSION_KINDS.has(st.kind)))
  if (!pages.length) return graph
  const ids = new Set(graph.nodes.map(n => n.id))
  const made = []
  let next = 0
  for (const page of pages) {
    const into = graph.edges.filter(e => e.to === page.id && e.from !== page.id && !e.back && !e.return && e.kind !== 'change')
    const asker = page.answerStates && page.answerStates.from
    page.states.filter(st => VERSION_KINDS.has(st.kind)).forEach((st, i) => {
      const { kind: _kind, label, question: _question, query, listed, thumb, heading, ways, renderedFields, ...shot } = st
      // The page's own answers (a version the journey led to has some) and the version's, as one address
      const [path, own] = page.url.split('?')
      const address = query ? queryOf({ ...paramsOf(own), ...paramsOf(query) }) : (own ? '?' + own : '')
      let id = page.id.split('?')[0] + (query ? address : (own ? '?' + own + '&' : '?') + 'version=' + (i + 1))
      while (ids.has(id)) id += '~'
      ids.add(id)
      graph.nodes.push({
        ...page,
        ...shot,
        id,
        url: path + address,
        // A heading picked by the answers is the one this version shows
        title: (page.titleVaries && /[a-z]{3}/i.test(heading || '') ? heading : page.title) + ' – ' + label,
        version: { of: page.id, label, from: st.kind === 'answer' ? 'answer' : listed ? 'listed' : 'link' },
        thumb: thumb || page.thumb,
        states: [],
        answerStates: null,
        listedStates: [],
        variants: [],
        sameAsAnswer: null,
        entry: false,
        // Its own options, like "Yes, I want to become their main agent instead"
        ...(renderedFields && Object.keys(renderedFields).length
          ? { renderedFields, fields: ownOptions(page.fields, renderedFields) }
          : {})
      })
      made.push({ id, page, answers: paramsOf(address), ways })
      // Where the branch starts
      let from
      if (st.kind === 'answer' && asker && ids.has(asker)) from = [{ from: asker, kind: 'submit' }]
      else if (listed && into.length) from = into
      else from = [{ from: page.id, kind: 'link' }]
      const seen = new Set()
      for (const e of from) {
        if (seen.has(e.from)) continue
        seen.add(e.from)
        graph.edges.push({
          id: 'v' + next++,
          from: e.from,
          to: id,
          kind: e.kind || 'link',
          label,
          rule: '',
          texts: st.kind === 'variant' && !listed ? [label] : [],
          fullTexts: [],
          query: query || '',
          via: 'version of ' + page.id,
          decided: false,
          version: true,
          back: false
        })
      }
    })
    // The page keeps answerStates, which names the answers on the page that asks them
    page.states = page.states.filter(st => !VERSION_KINDS.has(st.kind))
    page.sameAsAnswer = null
    page.versionsSplit = true
  }
  carryOn(graph, made, () => 'v' + next++)
  return arrange(graph)
}

// The template's questions, with the options this version of the page shows
function ownOptions (fields = {}, rendered = {}) {
  const own = { ...fields }
  for (const [name, field] of Object.entries(rendered)) {
    own[name] = { ...(fields[name] || { question: '' }), question: (fields[name] && fields[name].question) || field.question || '', options: { ...field.options } }
  }
  return own
}

// Whether a branch's rule can't happen with these answers, like
// existingAgentRole = 'TAX-IT' on the version for an existing supporting
// agent. `versionFields` are the answers the page's versions are told apart
// by: the page as it opens has none of them, so a rule that needs one is for
// a version, not for it.
function ruledOut (edge, answers, versionFields) {
  const parts = String(edge.rule || '').split(' and ')
  return parts.some(part => {
    const m = part.trim().match(/^([\w$-]+) = (['"])(.*)\2$/)
    if (!m) return false
    const [, field, , value] = m
    if (field in answers) return answers[field] !== value
    return versionFields.has(field)
  })
}

// The parts of a rule, like { existingAgentRole: 'TAX-IT', agentRole: 'TAX-IT' }, or null
// for one that isn't made only of answers
function ruleParts (rule) {
  if (!rule || rule === 'otherwise') return null
  const parts = {}
  for (const part of String(rule).split(' and ')) {
    const m = part.trim().match(/^([\w$-]+) = (['"])(.*)\2$/)
    if (!m) return null
    parts[m[1]] = m[3]
  }
  return parts
}

// Whether a more particular branch of the same form always takes this
// branch's answers instead: with answers { existingAgentRole: 'TAX-IT' },
// agentRole = 'TAX-IT' is caught by existingAgentRole = 'TAX-IT'
// and agentRole = 'TAX-IT'. Routes test the particular case first, and
// the order of the lines isn't the route's once the journey has been followed.
function caughtByAnother (edge, others, answers) {
  const mine = ruleParts(edge.rule)
  if (!mine) return false
  const known = { ...answers, ...mine }
  return others.some(other => {
    // Lines from following the journey and from the routes are the same form's, whatever their via
    if (other === edge || other.kind !== edge.kind) return false
    const theirs = ruleParts(other.rule)
    if (!theirs || Object.keys(theirs).length <= Object.keys(mine).length) return false
    return Object.entries(theirs).every(([field, value]) => known[field] === value)
  })
}

// A rule without the parts this version's answers always meet: on the
// version for an existing main agent, existingAgentRole = 'TAX-IT' and
// agentRole = 'TAX-IT' is just agentRole = 'TAX-IT'
function withoutGiven (rule, answers) {
  if (!ruleParts(rule)) return rule
  const left = String(rule).split(' and ').filter(part => {
    const m = part.trim().match(/^([\w$-]+) = (['"])(.*)\2$/)
    return !(m && answers[m[1]] === m[3])
  })
  return left.length ? left.join(' and ') : rule
}

// The ways on from each version screen (see splitVersions)
function carryOn (graph, made, newId) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]))
  const pathOf = id => String(id).split('?')[0]
  const versionsOf = new Map()
  for (const node of graph.nodes) {
    if (!node.version) continue
    const of = pathOf(node.version.of)
    if (!versionsOf.has(of)) versionsOf.set(of, [])
    versionsOf.get(of).push(node)
  }
  // The version of the next page with all these answers, if there is one
  const matching = (to, answers) => {
    const wanted = { ...answers, ...paramsOf(String(to).split('?')[1]) }
    return (versionsOf.get(pathOf(to)) || []).find(n => {
      const has = paramsOf(n.id.split('?')[1])
      return Object.entries(wanted).every(([k, v]) => has[k] === v)
    })
  }
  const shows = (edge, ways) => {
    if (!ways) return true
    if (edge.kind === 'submit') return ways.forms.length > 0
    if (edge.kind !== 'link') return true
    const target = byId.get(edge.to)
    if (!target || target.type !== 'page' || target.outside || !target.url) return true
    return ways.links.includes(pathOf(target.url))
  }
  // The answers each page's versions are told apart by
  const versionFields = new Map()
  for (const { page, answers } of made) {
    const own = paramsOf(page.url.split('?')[1])
    const fields = versionFields.get(page.id) || new Set()
    for (const field of Object.keys(answers)) if (!(field in own) && field !== 'error') fields.add(field)
    versionFields.set(page.id, fields)
  }
  const added = []
  const replaced = []
  for (const { id, page, answers, ways } of made) {
    const onward = graph.edges.filter(e => e.from === page.id && !e.version && e.kind !== 'change')
    const possible = onward.filter(edge => shows(edge, ways) && !ruledOut(edge, answers, versionFields.get(page.id)))
    const kept = possible.filter(edge => !caughtByAnother(edge, possible, answers))
    for (const edge of kept) {
      const next = matching(edge.to, answers)
      if (next) replaced.push([page.id, next.id])
      added.push({ ...edge, id: newId(), from: id, to: next ? next.id : edge.to, rule: withoutGiven(edge.rule, answers) })
    }
    // A link the version shows that this version of the page has no line for,
    // like Start again: the line another version of the page has for it
    for (const link of new Set((ways && ways.links) || [])) {
      if (link === pathOf(page.url)) continue
      if (kept.some(e => e.kind === 'link' && pathOf((byId.get(e.to) || {}).url || '') === link)) continue
      const same = graph.edges.find(e => e.kind === 'link' && !e.version && pathOf(e.from) === pathOf(page.id) &&
        pathOf((byId.get(e.to) || {}).url || '') === link)
      if (same) added.push({ ...same, id: newId(), from: id })
    }
  }
  // A version reached from another version isn't also a branch from the page it's a version of.
  // The page as it opens loses the branches only its versions can take.
  graph.edges = graph.edges
    .filter(e => !(e.version && replaced.some(([from, to]) => e.from === from && e.to === to)))
    .filter(e => {
      const fields = versionFields.get(e.from)
      if (!fields || !fields.size || e.version) return true
      const node = byId.get(e.from)
      return !ruledOut(e, paramsOf(((node && node.url) || '').split('?')[1]), fields)
    })
    .concat(added)
}

// The answers a link gives in its address, like ?startChoice=decline, that the
// journey uses. Following the link carries them on, as a chosen radio would be.
function linkAnswers (edge, used) {
  const answers = {}
  if (edge.kind !== 'link') return answers
  for (const [field, value] of Object.entries(paramsOf(edge.query))) {
    if (field !== 'error' && used.has(field)) answers[field] = value
  }
  return answers
}

// The answer a route's branch depends on, like signInOutcome = 'wrong-user-id',
// for following that branch from a form with no question on it. Null when the
// branch isn't about one answer, or contradicts an answer already given on the
// way here, like startPageChoice = 'decline' after choosing “Start now”.
function ruleAnswer (edge, answers) {
  const rule = (edge.rule || '').match(/^([\w$-]+) = (['"])(.*)\2$/)
  if (!rule) return null
  const [, field, , value] = rule
  if (field in answers && answers[field] !== value) return null
  return { field, value }
}

module.exports = { applyFollowed, splitVersions, queryOf, linkAnswers, ruleAnswer }
