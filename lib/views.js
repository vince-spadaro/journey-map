// Reads a page template: its title, the links on it and the forms it submits.
// Regular expressions are enough here; templates mix HTML and Nunjucks too
// freely for a strict HTML parser.

const path = require('path')
const { prettyCondition, negate } = require('./conditions')
const { humanise } = require('./prototype')

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', pound: '£', hellip: '…'
}

function decodeEntities (text) {
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) ? String.fromCodePoint(n) : match
    }
    return ENTITIES[code.toLowerCase()] ?? match
  })
}

// keepHidden keeps text only screen readers hear, like "Change<span …> contact name</span>"
function cleanText (html, keepHidden = false) {
  return decodeEntities(String(html)
    .replace(/<span[^>]*govuk-visually-hidden[^>]*>[\s\S]*?<\/span>/gi, match => keepHidden ? match : '')
    .replace(/\{\{[\s\S]*?\}\}/g, '…')
    .replace(/\{%[\s\S]*?%\}/g, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/(…\s*){2,}/g, '… ')
    .trim()
}

// Comments are blanked rather than removed so positions stay the same
function blankComments (src) {
  return src.replace(/<!--[\s\S]*?-->|\{#[\s\S]*?#\}/g, match => match.replace(/[^\n]/g, ' '))
}

function attr (attrs, name) {
  const match = attrs.match(new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'))
  return match ? (match[1] ?? match[2] ?? match[3]) : null
}

function meaningful (text) {
  return !!text && /[a-z]{3}/i.test(text) && !/prototype kit/i.test(text) &&
    !/^(error:?\s*)?(question page|example page|page|home|untitled)$/i.test(text)
}

function findTitle (src, file) {
  const heading = [...src.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map(match => cleanText(match[1]))
    .find(meaningful) || ''

  // The browser title is usually shorter than the heading: "Contact name – Service – GOV.UK"
  const block = src.match(/\{%-?\s*block\s+pageTitle\s*-?%\}([\s\S]*?)\{%-?\s*endblock/)
  const fromBlock = block
    ? cleanText(block[1]).replace(/^error:\s*/i, '').split(/\s+[–—|-]\s+/)[0].replace(/…/g, '').trim()
    : ''

  const title = meaningful(fromBlock) ? fromBlock : heading || humanise(path.basename(file))
  return { title, heading }
}

// The {% if %} blocks around a position, as a readable label
function nunjucksTags (src) {
  return [...src.matchAll(/\{%-?\s*(if|elif|elseif|else|endif|for|endfor)\b([\s\S]*?)-?%\}/g)]
    .map(match => ({ pos: match.index, tag: match[1], expr: match[2].trim() }))
}

function conditionAt (tags, pos) {
  const stack = []
  for (const tag of tags) {
    if (tag.pos >= pos) break
    if (tag.tag === 'if') stack.push({ expr: tag.expr, negated: false })
    else if (tag.tag === 'for') stack.push(null)
    else if (tag.tag === 'elif' || tag.tag === 'elseif') {
      if (stack.length) stack[stack.length - 1] = { expr: tag.expr, negated: false }
    } else if (tag.tag === 'else') {
      const top = stack[stack.length - 1]
      if (top) top.negated = true
    } else {
      stack.pop()
    }
  }
  return stack
    .filter(Boolean)
    .map(frame => frame.negated ? negate(prettyCondition(frame.expr)) : prettyCondition(frame.expr))
    .join(' and ')
}

// The object literal around a position, for macro options like { href: "x", text: "Change" }
function enclosingObject (src, pos) {
  let start = pos
  let depth = 0
  for (let i = pos; i >= 0 && pos - i < 2000; i--) {
    if (src[i] === '}') depth++
    else if (src[i] === '{') {
      if (depth === 0) { start = i; break }
      depth--
    }
  }
  let end = pos
  depth = 0
  for (let i = pos; i < src.length && i - pos < 2000; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      if (depth === 0) { end = i; break }
      depth--
    }
  }
  return src.slice(start, end + 1)
}

function lastMacroBefore (src, pos) {
  const calls = [...src.slice(Math.max(0, pos - 3000), pos).matchAll(/\{\{-?\s*(\w+)\s*\(/g)]
  return calls.length ? calls[calls.length - 1][1] : null
}

function makeLink (href, text, pos, tags, button, fullText) {
  return {
    href: decodeEntities(href),
    text,
    fullText: fullText || text,
    button,
    change: /^change\b/i.test(text),
    cond: conditionAt(tags, pos)
  }
}

function findLinks (src, tags) {
  const links = []

  for (const match of src.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(match[1], 'href')
    if (href == null) continue
    const cls = attr(match[1], 'class') || ''
    const text = cleanText(match[2])
    if (/govuk-back-link/.test(cls) || /^back$/i.test(text)) continue
    links.push(makeLink(href, text, match.index, tags, /govuk-button/.test(cls), cleanText(match[2], true)))
  }

  // Nunjucks macros: govukButton({ href: "x" }), summary list actions, and so on
  for (const match of src.matchAll(/\bhref\s*:\s*(["'])(.*?)\1/g)) {
    const macro = lastMacroBefore(src, match.index)
    if (macro === 'govukBackLink') continue
    const object = enclosingObject(src, match.index)
    const textMatch = object.match(/\b(?:text|html|name)\s*:\s*(["'])(.*?)\1/)
    const hiddenMatch = object.match(/\bvisuallyHiddenText\s*:\s*(["'])(.*?)\1/)
    const text = textMatch ? cleanText(textMatch[2]) : ''
    if (/^back$/i.test(text)) continue
    const fullText = hiddenMatch ? (text + ' ' + cleanText(hiddenMatch[2])).trim() : text
    links.push(makeLink(match[2], text, match.index, tags, macro === 'govukButton', fullText))
  }

  return links
}

function findForms (src, tags) {
  return [...src.matchAll(/<form\b([^>]*)>/gi)].map(match => ({
    action: attr(match[1], 'action'),
    method: (attr(match[1], 'method') || 'get').toLowerCase(),
    cond: conditionAt(tags, match.index)
  }))
}

// The object passed to a macro call, such as govukRadios({ … }), from its "{"
function balancedObject (src, start) {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  return src.slice(start)
}

// An object's own text, without the objects inside it (like an item's hint)
function topLevel (objectText) {
  let out = ''
  let depth = 0
  for (const c of objectText) {
    if (c === '{') depth++
    if (depth <= 1) out += c
    if (c === '}') depth--
  }
  return out
}

const quoted = (text, key) => {
  const match = text.match(new RegExp('\\b' + key + '\\s*:\\s*(["\'])((?:\\\\.|(?!\\1).)*)\\1'))
  return match ? match[2] : null
}

// The choices on a page – radios, checkboxes and selects – so branch rules
// like `sttAddressRadio = 'new'` can be shown with the words the user sees:
// { sttAddressRadio: { question, options: { new: 'I want to use a different address' } } }
function findFields (src) {
  const fields = {}
  const field = name => (fields[name] = fields[name] || { question: '', options: {} })
  const labels = {}
  for (const match of src.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const target = attr(match[1], 'for')
    if (target && !labels[target]) labels[target] = cleanText(match[2])
  }
  const legendBefore = pos => {
    const legends = [...src.slice(Math.max(0, pos - 4000), pos).matchAll(/<legend\b[^>]*>([\s\S]*?)<\/legend>/gi)]
    return legends.length ? cleanText(legends[legends.length - 1][1]) : ''
  }

  // <input type="radio" name="x" value="y" id="z"> with <label for="z">
  for (const match of src.matchAll(/<input\b([^>]*)>/gi)) {
    const type = (attr(match[1], 'type') || '').toLowerCase()
    if (type !== 'radio' && type !== 'checkbox') continue
    const name = attr(match[1], 'name')
    const value = attr(match[1], 'value')
    if (!name || value == null || /\{\{/.test(name)) continue
    const id = attr(match[1], 'id')
    const label = (id && labels[id]) || ''
    const f = field(name)
    if (/[a-z0-9]/i.test(label) && !f.options[value]) f.options[value] = label
    if (!f.question) f.question = legendBefore(match.index)
  }

  // <select name="x"><option value="y">Label</option></select>
  for (const match of src.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attr(match[1], 'name')
    if (!name) continue
    const f = field(name)
    const id = attr(match[1], 'id')
    if (!f.question && id && labels[id]) f.question = labels[id]
    for (const option of match[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
      const value = attr(option[1], 'value') ?? cleanText(option[2])
      const text = cleanText(option[2])
      if (/[a-z0-9]/i.test(text) && !f.options[value]) f.options[value] = text
    }
  }

  // GOV.UK macros: govukRadios({ name: "x", items: [{ value: "y", text: "Label" }] })
  for (const match of src.matchAll(/\{\{-?\s*(govukRadios|govukCheckboxes|govukSelect)\s*\(\s*\{/g)) {
    const options = balancedObject(src, match.index + match[0].length - 1)
    const name = quoted(topLevel(options), 'name')
    if (!name) continue
    const f = field(name)
    if (!f.question) {
      const legend = options.match(/\b(?:legend|label)\s*:\s*\{([^{}]*)\}/)
      const text = legend && (quoted(legend[1], 'text') || quoted(legend[1], 'html'))
      if (text) f.question = cleanText(text)
    }
    for (const value of options.matchAll(/\bvalue\s*:\s*(["'])(.*?)\1/g)) {
      const item = topLevel(enclosingObject(options, value.index))
      const text = quoted(item, 'text') || quoted(item, 'html')
      if (text && /[a-z0-9]/i.test(cleanText(text)) && !f.options[value[2]]) f.options[value[2]] = cleanText(text)
    }
  }

  for (const name of Object.keys(fields)) {
    if (!fields[name].question && !Object.keys(fields[name].options).length) delete fields[name]
  }
  return fields
}

// The answers the template shows different content for, in {% if %} blocks,
// directly (data['search-by']) or through {% set %} variables:
//   {% set searchedByArn = data["search-by"] != "tax-service-agent-code" %}
//   {% if searchedByArn %}  ->  ['search-by']
function conditionFields (src) {
  const aliases = {}
  const fieldsIn = expr => {
    const found = new Set()
    for (const match of expr.matchAll(/\bdata\s*(?:\[\s*(['"])(.+?)\1\s*\]|\.([\w$]+))/g)) found.add(match[2] || match[3])
    for (const [name, fields] of Object.entries(aliases)) {
      if (new RegExp('(^|[^\\w$.])' + name.replace(/\$/g, '\\$') + '(?![\\w$])').test(expr)) fields.forEach(f => found.add(f))
    }
    return found
  }
  for (const match of src.matchAll(/\{%-?\s*set\s+([\w$]+)\s*=\s*([\s\S]*?)-?%\}/g)) {
    const fields = fieldsIn(match[2])
    if (fields.size) aliases[match[1]] = fields
  }
  const used = new Set()
  for (const match of src.matchAll(/\{%-?\s*(?:if|elif|elseif)\s+([\s\S]*?)-?%\}/g)) fieldsIn(match[1]).forEach(f => used.add(f))
  return [...used]
}

function parsePage (rawSrc, file) {
  const src = blankComments(rawSrc)
  const tags = nunjucksTags(src)
  return {
    ...findTitle(src, file),
    links: findLinks(src, tags),
    forms: findForms(src, tags),
    fields: findFields(src),
    conditionFields: conditionFields(src)
  }
}

module.exports = { parsePage, findTitle, cleanText }
