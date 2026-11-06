// Names for branches, in the words a designer would use.
//
// Each branch keeps its rule from the routes (`rule`), and its name (`label`)
// is worked out from it, in this order:
//   1. the journey's names file, if it names the rule or the branch. It lives
//      outside the prototype, in ~/.journey-map/names, or wherever --names says
//   2. the labels of the radios, checkboxes or selects on the page that sends
//      the form: `sttAddressRadio = 'new'` -> “I want to use a different address”
//   3. "otherwise" -> the options left over, or "Any other answer" (after a
//      page) / "Any other result" (after a decision in code), with the other
//      branches kept in `excludes` so the side panel can say what it rules out
// Naming runs again after screenshots, when labels built from data are known.

const { shortened } = require('./conditions')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Names files are kept out of the prototype: one per journey, in the user's
// home folder, under the prototype's folder name
const NAMES_DIR = path.join(os.homedir(), '.journey-map', 'names')
const HELP = 'Names for the journey map. Fill in the empty names; leave a name empty to keep the rule from the routes. "rules" names a rule wherever it appears; "branches" names one branch, from page → to page.'

// field = 'value' -> “Option label”; field ≠ 'value' -> not “Option label”;
// not field -> no answer to “Question”
// An option name in a branch label is cut at this length, so what decides
// the branch (after the dash) always shows in full
const OPTION_MAX = 40
const clip = text => text.length > OPTION_MAX
  ? text.slice(0, OPTION_MAX - 2).replace(/\s+\S*$/, '') + (text.endsWith('”') ? '…”' : '…')
  : text

// existingAgentRole -> existing agent role
const readable = name => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toLowerCase()

function friendlyLabel (label, fields) {
  if (!label || !Object.keys(fields).length) return label
  return label
    .replace(/(^|\b(?:if) )?([\w$-]+) (=|≠) (['"])(.*?)\4/g, (match, prefix, name, op, quote, value) => {
      const option = fields[name] && fields[name].options[value]
      if (!option) return match
      return (prefix || '') + (op === '=' ? '“' + option + '”' : 'not “' + option + '”')
    })
    .replace(/\bnot ([\w$-]+)(?= and | or |$)/g, (match, name) => {
      const field = fields[name]
      return field && field.question ? 'no answer to “' + field.question + '”' : match
    })
}

const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'journey'

// ~/.journey-map/names/govuk-prototype/new-prototype-architecture-…-agent.json
function defaultNamesFile (root, scopeDir) {
  const journey = path.relative(path.join(root, 'app', 'views'), scopeDir) || 'all-pages'
  return path.join(NAMES_DIR, slug(path.basename(root)), slug(journey) + '.json')
}

function readNames (file) {
  if (!fs.existsSync(file)) return { file, rules: {}, branches: {} }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`couldn’t read ${file}: ${err.message}`)
  }
  const clean = section => Object.fromEntries(
    Object.entries((parsed && parsed[section]) || {}).filter(([, name]) => typeof name === 'string' && name.trim())
  )
  return { file, exists: true, rules: clean('rules'), branches: clean('branches'), raw: parsed }
}

// The page or route name used for branches in the names file: contact-name
const shortName = id => id.split('#')[0].split('/').filter(Boolean).pop() || '/'
const branchKey = edge => shortName(edge.from) + ' → ' + shortName(edge.to)

// Choices from the template, with labels read from the real page (during
// screenshots) filling in the ones the template builds from data, then the
// words the journey's index page gives answers (`listed`)
function mergeFields (fields = {}, rendered = {}, listed = {}) {
  const merged = {}
  for (const name of new Set([...Object.keys(fields), ...Object.keys(rendered), ...Object.keys(listed)])) {
    const own = fields[name] || { question: '', options: {} }
    merged[name] = {
      question: own.question || (rendered[name] && rendered[name].question) || '',
      options: { ...own.options }
    }
    for (const source of [rendered, listed]) {
      for (const [value, text] of Object.entries((source[name] && source[name].options) || {})) {
        if (!(value in merged[name].options)) merged[name].options[value] = text
      }
    }
  }
  return merged
}

function nameBranches (graph, names = { rules: {}, branches: {} }) {
  const nodesById = new Map(graph.nodes.map(n => [n.id, n]))
  // The ways on that a route decides: buttons and redirects, and links that
  // open a route which redirects (like Cancel going back to the right results)
  const onward = id => graph.edges.filter(e => e.from === id && (e.kind === 'submit' || e.kind === 'redirect' || e.decided))

  // Every choice in the journey, for rules about an answer given on an
  // earlier page, like Cancel going back to the results for "Agent code"
  // Answers the index page lists a page with, named in its words, for the page that asks them
  const listedFor = {}
  for (const node of graph.nodes) {
    const answers = node.answerStates
    if (!answers) continue
    const fields = listedFor[answers.from] = listedFor[answers.from] || {}
    fields[answers.field] = { question: answers.question, options: Object.fromEntries(answers.options.map(o => [o.value, o.label])) }
  }
  const choicesOn = node => mergeFields(node.fields, node.renderedFields, listedFor[node.id])

  const everyField = {}
  for (const node of graph.nodes) {
    if (node.type !== 'page') continue
    for (const [name, field] of Object.entries(choicesOn(node))) {
      if (!everyField[name]) everyField[name] = field
    }
  }

  const fieldsFor = (id, seen = new Set()) => {
    const node = nodesById.get(id)
    if (!node || seen.has(id)) return {}
    seen.add(id)
    if (node.type === 'page') return { ...everyField, ...choicesOn(node) }
    // A decision in code: the choices on the pages that send their form to it
    return graph.edges
      .filter(e => e.to === id && e.kind === 'submit')
      .reduce((all, e) => Object.assign(all, fieldsFor(e.from, seen)), {})
  }

  // The choices on the page a branch starts from: a page's own, or for a
  // decision in code, those of the pages that send their form to it
  const ownFieldsFor = (id, seen = new Set()) => {
    const node = nodesById.get(id)
    if (!node || seen.has(id)) return {}
    seen.add(id)
    if (node.type === 'page') return choicesOn(node)
    return graph.edges
      .filter(e => e.to === id && e.kind === 'submit')
      .reduce((all, e) => Object.assign(all, ownFieldsFor(e.from, seen)), {})
  }

  // Names for answers that aren't chosen on the page, from the words the
  // journey's index page gives the address that sets them, like
  // existingAgentRole = 'TAX-IT' -> “Already the client’s main agent”.
  // The page's own first, then any page's.
  const listedNames = new Map()
  for (const node of graph.nodes) {
    if (node.type !== 'page') continue
    for (const listed of [...(node.listedStates || []), ...(node.listedNames || []), ...(node.variants || [])]) {
      const params = [...new URLSearchParams(String(listed.query || '').replace(/^\?/, ''))].filter(([k]) => k !== 'error')
      if (params.length !== 1 || !listed.text) continue
      const key = `${params[0][0]} = '${params[0][1]}'`
      if (!listedNames.has(node.id + ' ' + key)) listedNames.set(node.id + ' ' + key, listed.text)
      if (!listedNames.has(key)) listedNames.set(key, listed.text)
    }
  }
  // …or the words of a link that gives the answer, like “I do not want … to act for me”
  // going to sign-in?startPageChoice=decline
  const linkNames = new Map()
  for (const edge of graph.edges) {
    if (edge.kind !== 'link' || !(edge.texts || []).length) continue
    const params = [...new URLSearchParams(String(edge.query || '').replace(/^\?/, ''))].filter(([k]) => k !== 'error')
    if (params.length !== 1) continue
    const key = `${params[0][0]} = '${params[0][1]}'`
    if (!linkNames.has(key)) linkNames.set(key, '“' + edge.texts[0] + '”')
  }
  // The answers each page's form sends, even when its options are built from data
  const sentBy = id => {
    const node = nodesById.get(id)
    if (!node) return new Set()
    if (node.type === 'page') return new Set(node.fieldNames || [])
    return new Set(graph.edges.filter(e => e.to === id && e.kind === 'submit').flatMap(e => [...sentBy(e.from)]))
  }

  const nameRule = (rule, fields, from) => {
    if (!rule) return { label: '', code: '', named: false }
    // Names files from before rules were kept whole have long rules cut short
    const saved = names.rules[rule] || names.rules[shortened(rule)]
    if (saved) return { label: saved, code: rule, named: true }
    if (rule === 'otherwise') return { label: friendlyLabel(rule, fields), code: '', named: false }
    const parts = rule.split(' and ').map(part => part.trim())
    const own = ownFieldsFor(from)
    const answerOf = part => part.match(/^([\w$-]+) (=|≠) (['"])(.*)\3$/)
    const sent = sentBy(from)
    const isOption = part => {
      const m = answerOf(part)
      return !!(m && m[2] === '=' && ((own[m[1]] && own[m[1]].options[m[4]]) || sent.has(m[1])))
    }
    const nameOf = part => {
      if (names.rules[part]) return names.rules[part]
      // An option is named as the page shows it; anything else as the index page names its address
      const friendly = friendlyLabel(part, fields)
      if (isOption(part) && friendly !== part) return friendly
      const listed = listedNames.get(from + ' ' + part) || linkNames.get(part) || listedNames.get(part)
      if (listed) return listed
      if (friendly !== part) return friendly
      const m = answerOf(part)
      return m ? readable(m[1]) + (m[2] === '=' ? ' is ' : ' is not ') + m[4] : part
    }
    const options = parts.filter(isOption)
    const others = parts.filter(part => !isOption(part))
    // An option with more than one way on: “Option” – what decides it
    const label = options.length && others.length
      ? clip(options.map(nameOf).join(' and '), OPTION_MAX) + ' – ' + others.map(nameOf).join(' and ')
      : parts.map(nameOf).join(' and ')
    return { label, code: label !== rule ? rule : '', named: parts.some(part => names.rules[part]) }
  }

  for (const edge of graph.edges) {
    // A version screen's branch is named after the version (lib/follow.js splitVersions)
    if (edge.version) { Object.assign(edge, { code: '', named: false, excludes: [] }); continue }
    Object.assign(edge, nameRule(edge.rule, fieldsFor(edge.from), edge.from), { excludes: [] })
  }
  for (const node of graph.nodes) {
    for (const errorState of node.errorStates) {
      const named = nameRule(errorState.rule, fieldsFor(node.id), node.id)
      errorState.when = named.label
      errorState.code = named.code
    }
  }

  for (const node of graph.nodes) {
    const branches = onward(node.id)
    for (const edge of branches.filter(e => e.rule === 'otherwise')) {
      // Only branches from the same route: opening an address and sending a
      // form to it can each have their own
      const others = branches.filter(e => e.rule && e.rule !== 'otherwise' && (e.via || '') === (edge.via || ''))
      // The only way on once errors are ruled out: no name needed
      if (!others.length) { Object.assign(edge, { label: '', code: '' }); continue }
      edge.code = 'otherwise'
      edge.excludes = others.map(e => e.label)

      // Every other branch tests the same question: name the options left over
      const tested = others.map(e => e.rule.match(/^([\w$-]+) = (['"])(.*?)\2$/))
      const field = tested.every(Boolean) && new Set(tested.map(m => m[1])).size === 1 && fieldsFor(node.id)[tested[0][1]]
      const remaining = field
        ? Object.entries(field.options).filter(([value]) => !tested.some(m => m[3] === value)).map(([, text]) => '“' + text + '”')
        : []
      if (remaining.length && remaining.length <= 2) {
        edge.label = remaining.join(' or ')
        edge.excludes = []
      } else {
        edge.label = node.type === 'decision' || edge.decided ? 'Any other result' : 'Any other answer'
      }
    }
  }

  // Links have no rule to name them by. When a page has more than one way on,
  // like “Start now” and “I do not want this agent” on a start page, each link
  // is named with its words, so the branches can be told apart
  for (const node of graph.nodes) {
    const ways = graph.edges.filter(e => e.from === node.id && !e.return && !e.back && e.kind !== 'change')
    if (ways.length < 2) continue
    for (const edge of ways) {
      if (edge.kind !== 'link' || edge.label || !(edge.texts || []).length) continue
      edge.label = edge.texts.map(text => '“' + text + '”').join(' or ')
    }
  }

  // A name for one particular branch beats everything else
  for (const edge of graph.edges) {
    const name = names.branches[branchKey(edge)]
    if (name && (edge.rule || edge.label)) {
      Object.assign(edge, { label: name, code: edge.code || edge.rule, named: true, excludes: edge.excludes || [] })
    }
  }
  return graph
}

// Rules still shown as code, and "Any other …" branches: what the names file
// is for
function unnamed (graph) {
  const rules = new Set()
  const branches = new Set()
  const looksLikeCode = (label, rule) => rule && rule !== 'otherwise' && label === rule
  for (const edge of graph.edges) {
    if (edge.named) continue
    if (looksLikeCode(edge.label, edge.rule)) rules.add(edge.rule)
    if (/^Any other (answer|result)$/.test(edge.label)) branches.add(branchKey(edge))
  }
  for (const node of graph.nodes) {
    for (const errorState of node.errorStates) {
      if (looksLikeCode(errorState.when, errorState.rule) && !/^has errors$/.test(errorState.rule)) rules.add(errorState.rule)
    }
  }
  return { rules: [...rules], branches: [...branches] }
}

// Writes the names file with every unnamed rule and branch, keeping any names
// already in it. Returns how many new entries were added.
function writeNamesFile (graph, names) {
  const existing = (names.raw && typeof names.raw === 'object') ? names.raw : {}
  const rules = { ...(existing.rules || {}) }
  const branches = { ...(existing.branches || {}) }
  const todo = unnamed(graph)
  let added = 0
  todo.rules.forEach(rule => { if (!(rule in rules)) { rules[rule] = ''; added++ } })
  todo.branches.forEach(key => { if (!(key in branches)) { branches[key] = ''; added++ } })
  fs.mkdirSync(path.dirname(names.file), { recursive: true })
  fs.writeFileSync(names.file, JSON.stringify({ _help: HELP, rules, branches }, null, 2) + '\n')
  return added
}

module.exports = { friendlyLabel, readNames, defaultNamesFile, nameBranches, unnamed, writeNamesFile }
