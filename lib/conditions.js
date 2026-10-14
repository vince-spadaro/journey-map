// Turns a condition from route code or a Nunjucks {% if %} into a short label
// a designer can read, for example
//   req.session.data.sttAddressRadio === 'new'  ->  sttAddressRadio = 'new'

const MAX_LENGTH = 70

function prettyCondition (code) {
  let text = String(code)
    .replace(/req\.session\.data\[\s*(['"])(.+?)\1\s*\]/g, '$2')
    .replace(/req\.session\.data\.([\w$]+)/g, '$1')
    .replace(/\b(?:data|sessionData)\[\s*(['"])(.+?)\1\s*\]/g, '$2')
    .replace(/\b(?:data|sessionData)\.([\w$]+)/g, '$1')
    .replace(/req\.(?:query|body|params)\.([\w$]+)/g, '$1')
    .replace(/Object\.keys\(\s*([\w$.]+)(\(.*?\))?\s*\)\.length(\s*>\s*0)?/g, 'has $1')
    .replace(/\s*!==?\s*/g, ' ≠ ')
    .replace(/\s*(?<![<>!=])===?(?!>)\s*/g, ' = ')
    .replace(/\s*&&\s*/g, ' and ')
    .replace(/\s*\|\|\s*/g, ' or ')
    .replace(/!\s*(?=[\w$(/])/g, 'not ')
    .replace(/\s+/g, ' ')
    .trim()

  if (/^\(.*\)$/.test(text) && !/\).*\(/.test(text.slice(1, -1))) text = text.slice(1, -1).trim()
  return text.length > MAX_LENGTH ? text.slice(0, MAX_LENGTH - 1) + '…' : text
}

function negate (text) {
  if (!text) return text
  if (/^not /.test(text)) return text.slice(4)
  if (/^[^ ]+ = [^ ]+$/.test(text)) return text.replace(' = ', ' ≠ ')
  if (/^[^ ]+ ≠ [^ ]+$/.test(text)) return text.replace(' ≠ ', ' = ')
  return 'not (' + text + ')'
}

// conds: [{ text, otherwise }] from the enclosing ifs. A redirect under an
// `else`, or after earlier `if (...) return`, reads as "otherwise".
function labelFor (conds) {
  const positive = conds.filter(c => !c.otherwise && c.text).map(c => c.text)
  if (positive.length) return positive.join(' and ')
  return conds.length ? 'otherwise' : ''
}

module.exports = { prettyCondition, negate, labelFor }
