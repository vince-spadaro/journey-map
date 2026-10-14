// Reads route files and finds, for each route, where it sends the user and
// under which conditions:
//
//   router.post(base + '/email-address', (req, res) => {
//     if (req.session.data.email === 'new') res.redirect(base + '/verify')
//     else res.redirect(base + '/address')
//   })
//
// becomes POST /…/email-address -> /…/verify (email = 'new'), /…/address (otherwise)

const acorn = require('acorn')
const walk = require('acorn-walk')
const { prettyCondition } = require('./conditions')
const { normaliseUrl } = require('./prototype')

const ROUTE_METHODS = new Set(['get', 'post', 'all'])
const MAX_VALUES = 32

function parseSource (src) {
  const options = {
    ecmaVersion: 'latest',
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true
  }
  try {
    return acorn.parse(src, { ...options, sourceType: 'script' })
  } catch (err) {
    return acorn.parse(src, { ...options, sourceType: 'module' })
  }
}

const isFunction = node => !!node && /Function/.test(node.type)

function bodyOf (node) {
  if (node.type === 'Program' || node.type === 'BlockStatement' || node.type === 'StaticBlock') return node.body
  if (node.type === 'SwitchCase') return node.consequent
  return null
}

// Finds what a name refers to by looking outwards through the enclosing scopes.
// `chain` is the list of nodes from the top of the file down to where the name is used.
function lookup (name, chain) {
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]
    if (isFunction(node) && node.params.some(p => p.type === 'Identifier' && p.name === name)) return null
    const body = bodyOf(node)
    if (!body) continue
    for (const statement of body) {
      if (statement.type === 'FunctionDeclaration' && statement.id && statement.id.name === name) {
        return { node: statement, chain: chain.slice(0, i + 1) }
      }
      const declaration = statement.type === 'VariableDeclaration'
        ? statement
        : statement.type === 'ExportNamedDeclaration' && statement.declaration && statement.declaration.type === 'VariableDeclaration'
          ? statement.declaration
          : null
      if (!declaration) continue
      for (const d of declaration.declarations) {
        if (d.id.type === 'Identifier' && d.id.name === name && d.init) {
          return { node: d.init, chain: chain.slice(0, i + 1) }
        }
      }
    }
  }
  return null
}

function alwaysExits (statement) {
  if (!statement) return false
  if (statement.type === 'ReturnStatement' || statement.type === 'ThrowStatement') return true
  if (statement.type === 'BlockStatement') return statement.body.some(alwaysExits)
  if (statement.type === 'IfStatement') return alwaysExits(statement.consequent) && alwaysExits(statement.alternate)
  return false
}

function combine (a, b) {
  if (!a || !b) return null
  const out = []
  for (const x of a) {
    for (const y of b) out.push({ value: x.value + y.value, conds: x.conds.concat(y.conds) })
  }
  return out.slice(0, MAX_VALUES)
}

function propertyName (prop) {
  if (prop.type !== 'Property') return null
  if (prop.key.type === 'Identifier') return prop.key.name
  if (prop.key.type === 'Literal') return String(prop.key.value)
  return null
}

function parseRoutes (src, file) {
  const ast = parseSource(src)
  const code = node => src.slice(node.start, node.end)
  const condText = (node, chain) => prettyCondition(withAliases(node, chain))

  // `const answer = req.session.data['where-do-you-live']; if (answer === 'x')`
  // reads as `where-do-you-live = 'x'`, so it can be matched to the form
  function withAliases (node, chain) {
    let text = code(node)
    if (!chain) return text
    const names = new Set()
    walk.simple(node, { Identifier (id) { names.add(id.name) } })
    for (const name of names) {
      const found = lookup(name, chain)
      if (!found || found.node.type !== 'MemberExpression') continue
      const source = code(found.node)
      if (!/(^|\.)session\.data\b|^(data|sessionData)\b/.test(source)) continue
      const escaped = name.replace(/\$/g, '\\$')
      text = text.replace(new RegExp('(^|[^\\w$.])' + escaped + '(?![\\w$])', 'g'), (match, before) => before + source)
    }
    return text
  }

  function resolveNode (node, chain, depth = 0) {
    if (node && node.type === 'Identifier' && depth < 10) {
      const found = lookup(node.name, chain)
      return found ? resolveNode(found.node, found.chain, depth + 1) : null
    }
    return node ? { node, chain } : null
  }

  // Works out the possible string values of an expression, with the conditions
  // under which each applies. Returns null when it can't be known without running the code.
  function evaluate (node, chain, depth = 0) {
    if (!node || depth > 12) return null
    switch (node.type) {
      case 'Literal':
        return typeof node.value === 'string' || typeof node.value === 'number'
          ? [{ value: String(node.value), conds: [] }]
          : null
      case 'TemplateLiteral': {
        let acc = [{ value: '', conds: [] }]
        node.quasis.forEach((quasi, i) => {
          acc = combine(acc, [{ value: quasi.value.cooked ?? quasi.value.raw, conds: [] }])
          if (i < node.expressions.length) acc = combine(acc, evaluate(node.expressions[i], chain, depth + 1))
        })
        return acc
      }
      case 'BinaryExpression':
        return node.operator === '+'
          ? combine(evaluate(node.left, chain, depth + 1), evaluate(node.right, chain, depth + 1))
          : null
      case 'Identifier': {
        const found = lookup(node.name, chain)
        return found && !isFunction(found.node) ? evaluate(found.node, found.chain, depth + 1) : null
      }
      case 'MemberExpression': {
        // paths.start where paths = { start: '/x' }
        const key = node.computed ? (node.property.type === 'Literal' ? String(node.property.value) : null) : node.property.name
        const target = resolveNode(node.object, chain)
        if (!key || !target || target.node.type !== 'ObjectExpression') return null
        const prop = target.node.properties.find(p => propertyName(p) === key)
        return prop ? evaluate(prop.value, target.chain, depth + 1) : null
      }
      case 'ConditionalExpression': {
        const text = condText(node.test, chain)
        const yes = evaluate(node.consequent, chain, depth + 1)
        const no = evaluate(node.alternate, chain, depth + 1)
        if (!yes && !no) return null
        return [
          ...(yes || []).map(v => ({ value: v.value, conds: [{ text }, ...v.conds] })),
          ...(no || []).map(v => ({ value: v.value, conds: [{ text, otherwise: true }, ...v.conds] }))
        ]
      }
      default:
        return null
    }
  }

  // The conditions that must hold to reach the last node in `chain`, looking
  // only at the nodes from `from` onwards (the handler, not the whole file)
  function conditionsFor (chain, from = 0) {
    const conds = []
    const condText = (node, i) => prettyCondition(withAliases(node, chain.slice(0, i + 1)))
    for (let i = from; i < chain.length - 1; i++) {
      const node = chain[i]
      const child = chain[i + 1]
      if ((node.type === 'IfStatement' || node.type === 'ConditionalExpression') && child !== node.test) {
        conds.push({ text: condText(node.test, i), otherwise: child === node.alternate })
      } else if (node.type === 'SwitchCase' && i > 0 && chain[i - 1].type === 'SwitchStatement') {
        conds.push(node.test
          ? { text: prettyCondition(code(chain[i - 1].discriminant) + ' === ' + code(node.test)) }
          : { text: '', otherwise: true })
      } else if (node.type === 'LogicalExpression' && node.operator === '&&' && child === node.right) {
        conds.push({ text: condText(node.left, i) })
      }

      // Code after `if (x) { return ... }` only runs when x is false
      const body = bodyOf(node)
      if (body) {
        const index = body.indexOf(child)
        for (let j = 0; j < index; j++) {
          const statement = body[j]
          if (statement.type === 'IfStatement' && !statement.alternate && alwaysExits(statement.consequent)) {
            conds.push({ text: condText(statement.test, i), otherwise: true })
          }
        }
      }
    }
    return conds
  }

  // The error messages passed to res.render(view, { errors: { … } })
  function errorMessages (optionsNode, chain) {
    const options = resolveNode(optionsNode, chain)
    if (!options || options.node.type !== 'ObjectExpression') return null
    const props = options.node.properties
    const errorsProp = props.find(p => /^errors?$/i.test(propertyName(p) || '')) ||
      props.find(p => /error/i.test(propertyName(p) || ''))
    if (!errorsProp) return null

    const messages = []
    const addValues = (node, nodeChain) => {
      const values = evaluate(node, nodeChain)
      if (values) messages.push(...values.map(v => v.value))
    }
    for (const prop of props.filter(p => /error/i.test(propertyName(p) || ''))) {
      const value = resolveNode(prop.value, options.chain)
      if (!value) continue
      if (value.node.type === 'ObjectExpression') {
        value.node.properties.forEach(p => p.type === 'Property' && addValues(p.value, value.chain))
      } else if (value.node.type === 'ArrayExpression') {
        value.node.elements.forEach(el => {
          if (el && el.type === 'ObjectExpression') {
            const text = el.properties.find(p => propertyName(p) === 'text')
            if (text) addValues(text.value, value.chain)
          }
        })
      } else {
        addValues(value.node, value.chain)
      }
    }
    return { messages: [...new Set(messages)] }
  }

  // Every res.redirect / res.render a handler can reach, including through
  // helper functions it calls
  function collectTargets (fn, outerChain, depth) {
    const targets = []
    const base = [...outerChain, fn]
    walk.ancestor(fn.body, {
      CallExpression (node, _state, inner) {
        const chain = base.concat(inner)
        const local = base.length - 1
        const callee = node.callee
        const name = callee.type === 'MemberExpression' && !callee.computed ? callee.property.name : null

        if (name === 'redirect' || name === 'render') {
          const arg = name === 'redirect' ? node.arguments[node.arguments.length - 1] : node.arguments[0]
          if (!arg) return
          const conds = conditionsFor(chain, local)
          const values = evaluate(arg, chain)
          const errors = name === 'render' ? errorMessages(node.arguments[1], chain) : null
          if (!values) {
            targets.push({ kind: name, dynamic: true, source: code(arg), conds })
          } else {
            values.forEach(v => targets.push({ kind: name, url: v.value, conds: conds.concat(v.conds), errors }))
          }
        } else if (callee.type === 'Identifier' && depth < 4) {
          const found = lookup(callee.name, chain)
          if (found && isFunction(found.node) && found.node !== fn) {
            const conds = conditionsFor(chain, local)
            collectTargets(found.node, found.chain, depth + 1)
              .forEach(t => targets.push({ ...t, conds: conds.concat(t.conds) }))
          }
        }
      }
    })
    return targets
  }

  // router.get('/x', fn), router.post(...), router.route('/x').get(fn).post(fn)
  function routeRegistration (node) {
    const callee = node.callee
    if (callee.type !== 'MemberExpression' || callee.computed || !ROUTE_METHODS.has(callee.property.name)) return null
    const method = callee.property.name.toUpperCase()
    let object = callee.object
    while (object.type === 'CallExpression' && object.callee.type === 'MemberExpression' &&
      ROUTE_METHODS.has(object.callee.property.name)) {
      object = object.callee.object
    }
    if (object.type === 'CallExpression' && object.callee.type === 'MemberExpression' &&
      object.callee.property.name === 'route') {
      return { method, pathNode: object.arguments[0], handlers: node.arguments }
    }
    if (node.arguments.length < 2) return null
    return { method, pathNode: node.arguments[0], handlers: node.arguments.slice(1) }
  }

  const routes = []
  walk.ancestor(ast, {
    CallExpression (node, _state, ancestors) {
      const registration = routeRegistration(node)
      if (!registration || !registration.pathNode) return

      const pathNodes = registration.pathNode.type === 'ArrayExpression'
        ? registration.pathNode.elements
        : [registration.pathNode]
      const paths = pathNodes
        .flatMap(p => evaluate(p, ancestors) || [])
        .map(v => v.value)
        .filter(p => p.startsWith('/') && !/[:*()]/.test(p))
      if (!paths.length) return

      const targets = []
      for (const handler of registration.handlers) {
        let fn = null
        let fnChain = ancestors
        if (isFunction(handler)) {
          fn = handler
        } else if (handler.type === 'Identifier') {
          const found = lookup(handler.name, ancestors)
          if (found && isFunction(found.node)) { fn = found.node; fnChain = found.chain }
        }
        if (fn) targets.push(...collectTargets(fn, fnChain, 0))
      }

      paths.forEach(p => routes.push({ method: registration.method, path: normaliseUrl(p), targets, file }))
    }
  })
  return routes
}

module.exports = { parseRoutes }
