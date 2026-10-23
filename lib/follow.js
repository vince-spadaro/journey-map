// Redraws the map with a branch for every answer, from what following the
// answers in the running prototype found (followAnswers in screenshots.js).
// Each version of a page the answers lead to is its own page on the map, with
// its own screenshot: "What type of client" branches into three "Which
// authorisation" pages, one for each type, and so on to the end. Branches join
// again where every screen from there on is the same, like a shared
// "Check your answers" and confirmation.

const crypto = require('crypto')
const { arrange } = require('./graph')

// The answers as an address: ?clientService=HMRC-MTD-VAT&clientType=business
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
// the most alike other answers (HMRC-CBC-NONUK-ORG is most like HMRC-CBC-ORG)
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

  // The version with no answers, or else the first, keeps the page's own id,
  // so notes stay with it
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
      statesFor.get((best && best.score > 0 ? best.v : closest(st, versions)).key).push(st)
    }
    versions.forEach((v, i) => {
      const { key, page: _page, answers, renderedHeading, states: _states, triedErrors: _tried, look: _look, ...shot } = v
      nodes.push({
        ...page,
        ...shot,
        id: idOf.get(key),
        url: page.url + queryOf((followed.opened && followed.opened.get(key)) || answers),
        title: page.titleFromFile && /[a-z]{3}/i.test(renderedHeading || '') ? renderedHeading : page.title,
        answers,
        answersInWords: inWords(answers),
        states: statesFor.get(key),
        answerStates: null,
        listedStates: [],
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

module.exports = { applyFollowed, queryOf }
