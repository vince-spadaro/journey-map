// Takes a screenshot of each page. Starts its own copy of the prototype on a
// spare port (so it doesn't clash with one you already have running), opens
// each page in Chrome or Edge, then stops the prototype again.

const fs = require('fs')
const net = require('net')
const http = require('http')
const path = require('path')
const { spawn, execFileSync } = require('child_process')
const { normaliseUrl } = require('./prototype')

const VIEWPORT = { width: 1280, height: 900 }
// Captured at 2x, like a retina screen, so text stays sharp when zoomed in
const PIXEL_RATIO = 2
// Thumbnail: the top of the page, 4:3, 640 by 480 pixels
const THUMB = { width: 1280, height: 960, scale: 0.25 }
// Full page: up to this tall (in CSS pixels). WebP keeps text sharp at about
// half the size of a JPEG, but can't be more than 16,383 pixels tall, so pages
// taller than WEBP_MAX / PIXEL_RATIO are taken at a lower pixel ratio
const FULL_MAX_HEIGHT = 16000
const WEBP_MAX = 16000
const FULL_QUALITY = 92
// One page at a time. The Kit's session store reads every session file
// whenever one is saved, and deletes any it can't read, so two pages saving
// at once can wipe the answers out of a session. Working one page at a time
// avoids that.
const CONCURRENCY = 1
// The folder the Kit keeps sessions in
const SESSIONS_DIR = ['.tmp', 'sessions']
const START_TIMEOUT = 120000

function findBrowser (explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH)

  if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser']) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`)
      candidates.push(path.join(process.env.HOME || '', `Applications/${app}.app/Contents/MacOS/${app}`))
    }
  } else if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
    for (const root of roots) {
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
      try {
        candidates.push(execFileSync('which', [name], { encoding: 'utf8' }).trim())
      } catch (err) {}
    }
  }
  return candidates.find(file => file && fs.existsSync(file)) || null
}

function freePort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function responds (url) {
  return new Promise(resolve => {
    const req = http.get(url, res => { res.resume(); resolve(true) })
    req.on('error', () => resolve(false))
    req.setTimeout(3000, () => { req.destroy(); resolve(false) })
  })
}

async function startPrototype (root) {
  const cli = path.join(root, 'node_modules', 'govuk-prototype-kit', 'bin', 'cli')
  if (!fs.existsSync(cli)) {
    throw new Error(`the prototype’s packages aren’t installed. Run “npm install” in ${root} first`)
  }

  const port = await freePort()
  const detached = process.platform !== 'win32'
  const child = spawn(process.execPath, [cli, 'serve'], {
    cwd: root,
    detached,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      USE_HTTPS: 'false',
      USE_AUTH: 'false',
      USE_BROWSER_SYNC: 'false'
    }
  })

  let output = ''
  const keep = chunk => { output = (output + chunk).slice(-4000) }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)

  let exited = false
  child.on('exit', () => { exited = true })

  const stop = () => {
    if (exited) return
    try {
      if (detached) process.kill(-child.pid)
      else child.kill()
    } catch (err) {}
  }
  process.once('exit', stop)

  const url = `http://localhost:${port}`
  const deadline = Date.now() + START_TIMEOUT
  while (!(await responds(url + '/'))) {
    if (exited || Date.now() > deadline) {
      stop()
      const lastLines = output.split('\n').filter(l => l.trim() && !/^\s+(node_modules|\.tmp)\//.test(l)).slice(-8).join('\n')
      throw new Error(`the prototype didn’t start${lastLines ? ':\n' + lastLines : ''}`)
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return { url, stop }
}

// The Kit keeps a file per browser session in the prototype's .tmp/sessions,
// and reads every one of them each time a page saves its answers. Lots of
// files make that slow enough for a page's answers to be lost, so the files
// this run creates are removed when it finishes. Files that were there
// before the run are left alone.
let sessionsBefore = null

function noteSessions (root) {
  try {
    sessionsBefore = new Set(fs.readdirSync(path.join(root, ...SESSIONS_DIR)))
  } catch (err) {
    sessionsBefore = new Set()
  }
}

function removeNewSessions (root) {
  if (!sessionsBefore) return
  const dir = path.join(root, ...SESSIONS_DIR)
  let files = []
  try { files = fs.readdirSync(dir) } catch (err) {}
  for (const file of files) {
    if (!sessionsBefore.has(file) && file.endsWith('.json')) {
      try { fs.rmSync(path.join(dir, file), { force: true }) } catch (err) {}
    }
  }
  sessionsBefore = null
}

async function closeContext (context) {
  await context.close().catch(() => {})
}

function dataUri (buffer, type = 'jpeg') {
  return `data:image/${type};base64,` + Buffer.from(buffer).toString('base64')
}

async function loadPage (page, url) {
  let status = 0
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })
    status = response ? response.status() : 0
  } catch (err) {
    // Slow pages: take what has loaded
    if (!/timeout/i.test(err.message)) throw err
  }

  page.lastExpanded = await settle(page)
  return status
}

// No animations or blinking cursors, and everything that folds away opened,
// so the screenshot shows all the content for review
async function settle (page) {
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; }' }).catch(() => {})
  const expanded = await page.evaluate(expandAll).catch(() => null)
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {})
  return expanded
}

// Runs in the page: opens details, accordions and tabs. Returns what it opened.
function expandAll () {
  const opened = { details: 0, accordions: 0, tabs: 0 }

  document.querySelectorAll('details').forEach(details => {
    if (!details.open) { details.open = true; opened.details++ }
  })

  document.querySelectorAll('.govuk-accordion').forEach(accordion => {
    const sections = accordion.querySelectorAll('.govuk-accordion__section')
    const closed = [...sections].filter(section => !section.classList.contains('govuk-accordion__section--expanded'))
    if (!closed.length) return
    // The accordion's own "Show all sections" button keeps its labels right
    const showAll = accordion.querySelector('.govuk-accordion__show-all')
    if (showAll && showAll.getAttribute('aria-expanded') !== 'true') showAll.click()
    // In case its JavaScript didn't run
    sections.forEach(section => {
      section.classList.add('govuk-accordion__section--expanded')
      const button = section.querySelector('.govuk-accordion__section-button')
      if (button) button.setAttribute('aria-expanded', 'true')
      const content = section.querySelector('.govuk-accordion__section-content')
      if (content) content.removeAttribute('hidden')
    })
    opened.accordions++
  })

  // Tabs: every panel shown, one after another, as they appear without JavaScript
  document.querySelectorAll('.govuk-tabs').forEach(tabs => {
    const hidden = tabs.querySelectorAll('.govuk-tabs__panel--hidden')
    if (!hidden.length) return
    hidden.forEach(panel => panel.classList.remove('govuk-tabs__panel--hidden'))
    opened.tabs++
  })

  return opened
}

async function fullShot (page) {
  const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0))
  const fullHeight = Math.min(Math.max(height, VIEWPORT.height), FULL_MAX_HEIGHT)
  const full = await page.screenshot({
    type: 'webp',
    quality: FULL_QUALITY,
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: VIEWPORT.width, height: fullHeight, scale: Math.min(1, WEBP_MAX / (fullHeight * PIXEL_RATIO)) }
  })
  // Width and height are the size to show it at; the image has twice the pixels
  return {
    shot: dataUri(full, 'webp'),
    shotWidth: VIEWPORT.width,
    shotHeight: fullHeight,
    cutOff: height > FULL_MAX_HEIGHT
  }
}

// Runs in the page. The GOV.UK radios and checkboxes whose option reveals more
// questions when it's selected (data-aria-controls -> a __conditional panel).
// Options that reveal nothing, or whose panel is already open, are skipped.
function findReveals () {
  const inputs = [...document.querySelectorAll('.govuk-radios__input, .govuk-checkboxes__input')]
  const panelFor = input => {
    const id = input.getAttribute('data-aria-controls') || input.getAttribute('aria-controls')
    if (!id) return null
    return [...document.querySelectorAll('[id="' + CSS.escape(id) + '"]')]
      .find(el => /(radios|checkboxes)__conditional/.test(el.className)) || null
  }
  return inputs.map((input, index) => {
    const panel = panelFor(input)
    if (!panel || !panel.querySelector('input, select, textarea, label, .govuk-hint, p')) return null
    const open = !/__conditional--hidden/.test(panel.className) && panel.offsetHeight > 0
    if (open) return null
    const label = input.id && document.querySelector('label[for="' + CSS.escape(input.id) + '"]')
    return {
      index,
      type: input.type,
      label: label ? label.textContent.trim().replace(/\s+/g, ' ') : input.value
    }
  }).filter(Boolean)
}

// Runs in the page: selects one option and makes sure its panel is shown,
// even if the page's JavaScript didn't load
function reveal (index) {
  const inputs = [...document.querySelectorAll('.govuk-radios__input, .govuk-checkboxes__input')]
  const input = inputs[index]
  if (!input) return false
  if (!input.checked) input.click()
  const id = input.getAttribute('data-aria-controls') || input.getAttribute('aria-controls')
  const panel = [...document.querySelectorAll('[id="' + CSS.escape(id) + '"]')]
    .find(el => /(radios|checkboxes)__conditional/.test(el.className))
  if (panel) panel.classList.remove('govuk-radios__conditional--hidden', 'govuk-checkboxes__conditional--hidden')
  if (document.activeElement) document.activeElement.blur()
  return true
}

// Ways to get a form wrong. Only pages whose routes show errors are tried.
// Each is tried on a freshly loaded page, and only the ones that come back
// with the prototype's own GOV.UK error messages are photographed.
const ERROR_TRIES = [
  { label: 'Nothing entered', fill: 'empty' },
  { label: 'Characters that aren’t allowed', fill: 'symbols' },
  { label: 'Too much text', fill: 'long' }
]

// Runs in the page: the form that's sent with POST and has the most fields
function mainForm () {
  const forms = [...document.querySelectorAll('form')]
    .filter(form => (form.getAttribute('method') || '').toLowerCase() === 'post')
    .sort((a, b) => b.elements.length - a.elements.length)
  if (!forms.length) return null
  return { action: new URL(forms[0].action || location.href, location.href).pathname }
}

// Runs in the page: fills the main form in one of the ways above and sends it.
// Options are cleared in every case, so required questions are left unanswered.
// `option`, if given, is an option that reveals more questions: it's chosen
// after everything is cleared, so the revealed field's own errors show
function fillAndSend ({ fill, option }) {
  const form = [...document.querySelectorAll('form')]
    .filter(f => (f.getAttribute('method') || '').toLowerCase() === 'post')
    .sort((a, b) => b.elements.length - a.elements.length)[0]
  if (!form) return false
  const textTypes = ['', 'text', 'email', 'tel', 'number', 'search', 'password', 'url']
  let textFields = 0
  for (const el of form.elements) {
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (type === 'radio' || type === 'checkbox') el.checked = false
    else if (tag === 'select') el.selectedIndex = 0
    else if (tag === 'textarea' || (tag === 'input' && textTypes.includes(type))) {
      el.value = fill === 'empty' ? '' : fill === 'symbols' ? '!@#$%^&*<>' : 'a'.repeat(300)
      textFields++
    }
  }
  if (option != null) {
    const input = [...document.querySelectorAll('.govuk-radios__input, .govuk-checkboxes__input')][option]
    if (!input) return false
    input.checked = true
  }
  // Symbols and long text only test text fields
  if (fill !== 'empty' && !textFields) return false
  form.setAttribute('novalidate', '')
  const button = form.querySelector('button:not([type]), button[type="submit"], input[type="submit"]')
  if (button) button.click()
  else form.submit()
  return true
}

// Runs in the page: the error messages it shows, from the error summary or,
// failing that, the messages next to the fields
function errorMessages () {
  const clean = el => el.textContent.replace(/^\s*Error:\s*/, '').trim().replace(/\s+/g, ' ')
  const summary = [...document.querySelectorAll('.govuk-error-summary__list li')].map(clean)
  const inline = [...document.querySelectorAll('.govuk-error-message')].map(clean)
  return [...new Set((summary.length ? summary : inline).filter(Boolean))]
}

// The answers every way into a page agrees on, from branch rules like
// `search-by = 'tax-service-agent-code'`. A field with different answers on
// different ways in is left out.
function answersLeadingTo (graph, node) {
  const answers = {}
  const clash = new Set()
  for (const edge of graph.edges) {
    if (edge.to !== node.id || edge.return) continue
    const match = (edge.rule || '').match(/^([\w$-]+) = (['"])(.*)\2$/)
    if (!match) continue
    const [, field, , value] = match
    if (field in answers && answers[field] !== value) clash.add(field)
    answers[field] = value
  }
  clash.forEach(field => delete answers[field])
  return answers
}

// Sends the page's form in each of the ways above, in a private browser
// session so the answers used for the other screenshots aren't changed
// `answers` are the answers that lead to the page, like
// { 'search-by': 'tax-service-agent-code' }: they're set first, so the route
// treats the form the way it would for someone who got here
async function captureErrors (browser, url, seed, answers = {}) {
  const context = await browser.createBrowserContext()
  const states = []
  let page = null
  try {
    page = await context.newPage()
    await page.setViewport({ ...VIEWPORT, deviceScaleFactor: PIXEL_RATIO })
    if (seed) await page.goto(seed, { waitUntil: 'load', timeout: 30000 })
    if (Object.keys(answers).length) {
      await page.goto(new URL(url).origin + '/?' + new URLSearchParams(answers).toString(), { waitUntil: 'load', timeout: 30000 })
    }

    // The same tries again with each option that reveals more questions
    // chosen, since errors on a revealed field only show once it's chosen
    await loadPage(page, url)
    const reveals = await page.evaluate(findReveals).catch(() => [])
    const attempts = ERROR_TRIES.concat(reveals.flatMap(option => [
      { label: '“' + option.label + '” chosen, nothing entered', fill: 'empty', option: option.index },
      { label: '“' + option.label + '” chosen, characters that aren’t allowed', fill: 'symbols', option: option.index }
    ]))

    const seen = new Set()
    for (const attempt of attempts) {
      const status = await loadPage(page, url)
      if (status >= 400) break
      const form = await page.evaluate(mainForm)
      if (!form) break
      const before = new URL(url).pathname
      const [sent] = await Promise.all([
        page.evaluate(fillAndSend, { fill: attempt.fill, option: attempt.option ?? null }),
        page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => null)
      ])
      if (!sent) continue
      // An error is shown on the same page, or at the address the form sent to
      const now = new URL(page.url()).pathname
      if (now !== before && now !== form.action) continue
      const messages = await page.evaluate(errorMessages)
      const key = messages.join('|')
      if (!messages.length || seen.has(key)) continue
      seen.add(key)
      await settle(page)
      states.push({ kind: 'error', type: 'error', label: attempt.label, messages, ...(await fullShot(page)) })
    }
  } finally {
    await closeContext(context)
  }
  return states
}

// The page after each answer that changes what it shows. The kit stores
// anything in the address as an answer, so ?search-by=arn shows the page as
// it is after choosing that option. Each is taken in a private session. An
// answer that looks the same as the page as it opens isn't kept twice.
async function captureAnswers (browser, url, seed, node) {
  const { field, question, options } = node.answerStates
  const states = []
  for (const option of options) {
    const context = await browser.createBrowserContext()
    let page = null
    try {
      page = await context.newPage()
      await page.setViewport({ ...VIEWPORT, deviceScaleFactor: PIXEL_RATIO })
      if (seed) await page.goto(seed, { waitUntil: 'load', timeout: 30000 })
      const status = await loadPage(page, url + '?' + encodeURIComponent(field) + '=' + encodeURIComponent(option.value))
      if (status >= 400) continue
      const shot = await fullShot(page)
      if (shot.shot === node.shot) { node.sameAsAnswer = option.label; continue }
      states.push({ kind: 'answer', label: option.label, question, ...shot })
    } finally {
      await closeContext(context)
    }
  }
  return states
}

// The page opened at each address the journey's index page lists for it,
// like ?clientType=trust or ?error=required, each in a private session as
// the kit stores the address as answers. It's an error only if the page
// shows the prototype's own GOV.UK error messages; otherwise another state.
async function captureListed (browser, url, seed, node) {
  const states = []
  const errors = []
  const seen = new Set()
  for (const listed of node.listedStates) {
    const context = await browser.createBrowserContext()
    try {
      const page = await context.newPage()
      await page.setViewport({ ...VIEWPORT, deviceScaleFactor: PIXEL_RATIO })
      if (seed) await page.goto(seed, { waitUntil: 'load', timeout: 30000 })
      const status = await loadPage(page, url + listed.query)
      if (status >= 400) continue
      const messages = await page.evaluate(errorMessages)
      const shot = await fullShot(page)
      if (shot.shot === node.shot || seen.has(shot.shot)) continue
      seen.add(shot.shot)
      if (messages.length) errors.push({ kind: 'error', type: 'error', label: 'Opening the page from the journey’s index page', query: listed.query, messages, ...shot })
      else states.push({ kind: 'variant', listed: true, label: listed.text || listed.query, query: listed.query, ...shot })
    } finally {
      await closeContext(context)
    }
  }
  return states.concat(errors)
}

// `variants` are links back to the same page with a different query string,
// like ?requestedNew=true, which show the page in another state
// Runs in the page: the choices as the user sees them, including labels the
// template builds from data, like an address on the account
function renderedChoices () {
  const fields = {}
  const field = name => (fields[name] = fields[name] || { question: '', options: {} })
  const labelFor = el => {
    const label = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')
    return label ? label.textContent.trim().replace(/\s+/g, ' ') : ''
  }
  document.querySelectorAll('input[type="radio"], input[type="checkbox"]').forEach(input => {
    const text = labelFor(input)
    if (input.name && text) field(input.name).options[input.value] = text
  })
  document.querySelectorAll('select[name]').forEach(select => {
    ;[...select.options].forEach(option => {
      const text = option.textContent.trim().replace(/\s+/g, ' ')
      if (text) field(select.name).options[option.value] = text
    })
  })
  return fields
}

async function capturePage (page, url, variants = []) {
  const status = await loadPage(page, url)
  const thumb = await page.screenshot({
    type: 'jpeg',
    quality: 85,
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: THUMB.width, height: THUMB.height, scale: THUMB.scale }
  })
  const main = await fullShot(page)
  const expanded = page.lastExpanded
  const renderedFields = await page.evaluate(renderedChoices).catch(() => ({}))
  const renderedHeading = await page.evaluate(() => {
    const h1 = document.querySelector('main h1, h1')
    return h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : ''
  }).catch(() => '')

  // One more screenshot for each option that reveals extra questions,
  // starting from a freshly loaded page each time
  const states = []
  const reveals = await page.evaluate(findReveals).catch(() => [])
  for (const option of reveals) {
    await loadPage(page, url)
    if (!(await page.evaluate(reveal, option.index))) continue
    states.push({ kind: 'reveal', label: option.label, type: option.type, ...(await fullShot(page)) })
  }

  for (const variant of variants) {
    const status = await loadPage(page, url + variant.query)
    if (status >= 400) continue
    states.push({ kind: 'variant', label: variant.text || variant.query, query: variant.query, ...(await fullShot(page)) })
  }

  return { status, thumb: dataUri(thumb), ...main, states, expanded, renderedFields, renderedHeading }
}

// ---------------------------------------------------------------- answers

// Runs in the page: the question the main form asks with radios, if any
function choiceQuestion () {
  const form = [...document.querySelectorAll('form')]
    .filter(f => (f.getAttribute('method') || '').toLowerCase() === 'post')
    .sort((a, b) => b.elements.length - a.elements.length)[0]
  if (!form) return null
  const groups = {}
  form.querySelectorAll('input[type="radio"]').forEach(input => {
    if (input.name && input.value) (groups[input.name] = groups[input.name] || []).push(input.value)
  })
  const name = Object.keys(groups).find(n => new Set(groups[n]).size >= 2)
  return { name: name || null, values: name ? [...new Set(groups[name])] : [] }
}

// Runs in the page: chooses an answer, if given, and sends the main form as it is
function chooseAndSend (answer) {
  const form = [...document.querySelectorAll('form')]
    .filter(f => (f.getAttribute('method') || '').toLowerCase() === 'post')
    .sort((a, b) => b.elements.length - a.elements.length)[0]
  if (!form) return false
  if (answer) {
    const input = [...form.querySelectorAll('input[type="radio"]')].find(i => i.name === answer.name && i.value === answer.value)
    if (!input) return false
    input.checked = true
  }
  form.setAttribute('novalidate', '')
  const button = form.querySelector('button:not([type]), button[type="submit"], input[type="submit"]')
  if (button) button.click()
  else form.submit()
  return true
}

// Runs in the page: what the screen is, to tell versions apart. Its words,
// questions and buttons, but not the answers a summary list shows back, so
// "Check your answers" is one screen whatever was entered.
function screenLook () {
  const main = document.querySelector('main') || document.body
  const copy = main.cloneNode(true)
  copy.querySelectorAll('.govuk-summary-list__value, script, style').forEach(el => el.remove())
  const fields = [...main.querySelectorAll('input, select, textarea')].map(el => (el.type || el.tagName) + ':' + el.name)
  return copy.textContent.replace(/\s+/g, ' ').trim() + '|' + fields.join(',')
}

// Most versions of pages to follow, so a journey with many answers still finishes
const MAX_VERSIONS = 150

// Follows every answer from the start page, the way a user would: chooses
// each option, sends the form and sees which page comes next. The answers so
// far go in the address, which the kit stores as answers, in a private
// session each time. Each page reached with different answers is a version
// of it, photographed. A page that ends the way on (an error, a text answer
// the prototype checks) carries on along the map's own lines instead.
async function followAnswers (browser, graph, base, seed, onProgress) {
  const { queryOf } = require('./follow')
  const start = graph.meta.mainEntry
  if (!start) return null
  const pageIds = new Set(graph.nodes.filter(n => n.type === 'page').map(n => n.id))
  const keyOf = (page, answers) => page + queryOf(answers)
  // Answers the prototype uses to change the journey: ones its routes or
  // templates check, or that the index page lists versions of pages for.
  // Others, like which record to change, are followed but don't split the map.
  const used = new Set()
  for (const edge of graph.edges) for (const [, field] of (edge.rule || '').matchAll(/([\w$-]+)\s*(?:=|!=|<|>|is\b)/g)) used.add(field)
  for (const node of graph.nodes) {
    ;(node.choiceFields || []).forEach(field => used.add(field))
    if (node.answerStates) used.add(node.answerStates.field)
    for (const st of node.listedStates || []) for (const [field] of new URLSearchParams(st.query.slice(1))) used.add(field)
    for (const st of node.states || []) for (const [field] of new URLSearchParams(String(st.query || '').slice(1))) used.add(field)
  }
  used.delete('error')
  const versions = new Map([[start, { key: start, page: start, answers: {} }]])
  const steps = []
  const queue = [{ key: start, path: [] }]
  let limited = false

  const goTo = (from, page, answers, path, step) => {
    // Back to a page earlier on this way: a line back, not another version
    const earlier = path.find(key => versions.get(key).page === page)
    if (earlier) { steps.push({ ...step, from: from.key, to: earlier, back: true }); return }
    const key = keyOf(page, answers)
    if (!versions.has(key)) {
      if (versions.size >= MAX_VERSIONS) { limited = true; return }
      versions.set(key, { key, page, answers })
      queue.push({ key, path: [...path, from.key] })
    }
    steps.push({ ...step, from: from.key, to: key })
  }

  while (queue.length) {
    const { key, path } = queue.shift()
    const version = versions.get(key)
    const url = base + key
    const context = await browser.createBrowserContext()
    let followed = 0
    try {
      const tab = await context.newPage()
      await tab.setViewport({ ...VIEWPORT, deviceScaleFactor: PIXEL_RATIO })
      if (seed) await tab.goto(seed, { waitUntil: 'load', timeout: 30000 })
      const status = await loadPage(tab, url)
      if (status >= 400) continue
      const thumb = await tab.screenshot({
        type: 'jpeg',
        quality: 85,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: THUMB.width, height: THUMB.height, scale: THUMB.scale }
      })
      Object.assign(version, {
        status,
        thumb: dataUri(thumb),
        ...(await fullShot(tab)),
        expanded: tab.lastExpanded,
        renderedFields: await tab.evaluate(renderedChoices).catch(() => ({})),
        look: await tab.evaluate(screenLook).catch(() => ''),
        renderedHeading: await tab.evaluate(() => {
          const h1 = document.querySelector('main h1, h1')
          return h1 ? h1.textContent.replace(/\s+/g, ' ').trim() : ''
        }).catch(() => '')
      })

      // This version's own errors: the error addresses the index lists for the
      // page, with this version's answers, and the errors its routes show
      const node = graph.nodes.find(n => n.id === version.page)
      const extras = new Map()
      for (const st of node.states || []) {
        if (st.kind !== 'error' || !st.query) continue
        const extra = {}
        for (const [field, value] of new URLSearchParams(st.query.slice(1))) if (!used.has(field)) extra[field] = value
        if (Object.keys(extra).length) extras.set(queryOf(extra), extra)
      }
      version.states = []
      version.triedErrors = extras.size > 0 || node.errorStates.length > 0
      const seenErrors = new Set()
      for (const extra of extras.values()) {
        const query = queryOf({ ...version.answers, ...extra })
        if ((await loadPage(tab, base + version.page + query)) >= 400) continue
        const messages = await tab.evaluate(errorMessages)
        if (!messages.length || seenErrors.has(messages.join('|'))) continue
        seenErrors.add(messages.join('|'))
        version.states.push({ kind: 'error', type: 'error', label: 'Opening the page from the journey’s index page', query, messages, ...(await fullShot(tab)) })
      }
      if (node.errorStates.length) {
        for (const st of await captureErrors(browser, base + version.page, seed, version.answers)) {
          if (!seenErrors.has(st.messages.join('|'))) { seenErrors.add(st.messages.join('|')); version.states.push(st) }
        }
      }

      const question = await tab.evaluate(choiceQuestion)
      const answers = question ? (question.name ? question.values.map(value => ({ name: question.name, value })) : [null]) : []
      for (const answer of answers) {
        await loadPage(tab, url)
        const [sent] = await Promise.all([
          tab.evaluate(chooseAndSend, answer),
          tab.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => null)
        ])
        if (!sent) continue
        const now = normaliseUrl(new URL(tab.url()).pathname)
        if ((await tab.evaluate(errorMessages)).length || !pageIds.has(now) || now === version.page) continue
        followed++
        const given = answer && used.has(answer.name) ? { ...version.answers, [answer.name]: answer.value } : version.answers
        goTo(version, now, given, path, { kind: 'submit', field: answer && answer.name, value: answer && answer.value })
      }
    } catch (err) {
      // Carry on along the map's own lines
    } finally {
      await closeContext(context)
    }

    // Links on to other pages, and the map's own lines where the form couldn't be followed
    for (const edge of graph.edges) {
      if (edge.from !== version.page || edge.return || !pageIds.has(edge.to)) continue
      if (edge.kind === 'link' || (!followed && (edge.kind === 'submit' || edge.kind === 'redirect'))) {
        // A branch the routes give, like search-by = 'arn', carries that answer on
        // or, for "not this one", the only other option
        const rule = (edge.rule || '').match(/^([\w$-]+) (!?=) (['"])(.*)\3$/)
        let value = rule && rule[2] === '=' ? rule[4] : null
        let field = rule && rule[1]
        const optionsOf = name => Object.keys(((version.renderedFields || {})[name] || {}).options || {})
        if (rule && rule[2] === '!=') {
          const others = optionsOf(field).filter(v => v !== rule[4])
          if (others.length === 1) value = others[0]
        }
        // "Otherwise": the one option the other branches from here don't name
        if (edge.rule === 'otherwise') {
          const named = graph.edges
            .filter(e => e.from === edge.from && e.via === edge.via && e !== edge)
            .map(e => (e.rule || '').match(/^([\w$-]+) = (['"])(.*)\2$/))
          if (named.length && named.every(m => m && m[1] === named[0][1])) {
            field = named[0][1]
            const others = optionsOf(field).filter(v => !named.some(m => m[3] === v))
            if (others.length === 1) value = others[0]
          }
        }
        const given = value != null && used.has(field) ? { ...version.answers, [field]: value } : version.answers
        goTo(version, edge.to, given, path, { kind: edge.kind, edge })
      }
    }
    if (onProgress) onProgress(versions.size - queue.length, versions.size)
  }
  return { versions: [...versions.values()].filter(v => v.shot), steps, limited }
}

// Adds thumb, shot and status to each page node. `data` is sample answers to
// load first; `onProgress(done, total)` reports progress
async function addScreenshots (graph, { root, url, data, browser: browserPath, onProgress }) {
  const executablePath = findBrowser(browserPath)
  if (!executablePath) {
    throw new Error('couldn’t find Chrome or Edge. Install one, or give its location with --browser')
  }

  if (url && !(await responds(url.replace(/\/$/, '') + '/'))) {
    throw new Error(`nothing is running at ${url}. Start the prototype, or leave out --url`)
  }

  // With --url the prototype is someone's own running copy, whose sessions
  // could be theirs: leave them alone
  if (!url) noteSessions(root)
  const puppeteer = require('puppeteer-core')
  const prototype = url ? { url: url.replace(/\/$/, ''), stop () {} } : await startPrototype(root)
  let browser
  let followed = null
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-extensions']
    })

    // Sample answers: the kit stores anything in the query string as session data
    let seed = null
    if (data && Object.keys(data).length) {
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(data)) {
        ;(Array.isArray(value) ? value : [value]).forEach(v => query.append(key, typeof v === 'object' ? JSON.stringify(v) : String(v)))
      }
      seed = prototype.url + '/?' + query.toString()
      const tab = await browser.newPage()
      await tab.goto(seed, { waitUntil: 'load', timeout: 30000 })
      await tab.close()
    }

    const pages = graph.nodes.filter(n => n.type === 'page')
    let done = 0
    let next = 0
    const worker = async () => {
      const tab = await browser.newPage()
      await tab.setViewport({ ...VIEWPORT, deviceScaleFactor: PIXEL_RATIO })
      while (next < pages.length) {
        const node = pages[next++]
        try {
          Object.assign(node, await capturePage(tab, prototype.url + node.url, node.variants))
          // A page named after its file, as its heading comes from data, gets the heading the user sees
          if (node.titleFromFile && node.status < 400 && /[a-z]{3}/i.test(node.renderedHeading)) node.title = node.renderedHeading
          if (node.status >= 400) node.warnings.push(`The page shows an error (${node.status}) when it’s opened`)
          // Errors only for pages whose routes show them, or at addresses the
          // index page lists: nothing is made up for pages without validation
          else {
            if (node.answerStates) {
              // Each answer named as on the page that asks it, when that page builds its options from data
              const asked = graph.nodes.find(n => n.id === node.answerStates.from)
              const seen = asked && asked.renderedFields && asked.renderedFields[node.answerStates.field]
              if (seen) node.answerStates.options.forEach(o => { o.label = seen.options[o.value] || o.label })
              node.states.unshift(...(await captureAnswers(browser, prototype.url + node.url, seed, node)))
            }
            if (node.errorStates.length) node.states.push(...(await captureErrors(browser, prototype.url + node.url, seed, answersLeadingTo(graph, node))))
            if (node.listedStates) node.states.push(...(await captureListed(browser, prototype.url + node.url, seed, node)))
          }
        } catch (err) {
          node.shotError = err.message.split('\n')[0]
        }
        done++
        if (onProgress) onProgress(done, pages.length)
      }
      await tab.close()
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pages.length) }, worker))

    // A branch for every answer, when answers lead to different versions of pages
    if (onProgress) onProgress(0, 1, 'Following each answer')
    followed = await followAnswers(browser, graph, prototype.url, seed, (done, total) => onProgress && onProgress(done, total, 'Following each answer'))
  } finally {
    if (browser) await browser.close().catch(() => {})
    removeNewSessions(root)
    prototype.stop()
  }
  graph.meta.screenshots = true
  const versionsOf = new Map()
  if (followed) followed.versions.forEach(v => versionsOf.set(v.page, (versionsOf.get(v.page) || 0) + 1))
  if ([...versionsOf.values()].some(count => count > 1)) {
    require('./follow').applyFollowed(graph, followed)
    graph.meta.followed = { versions: followed.versions.length, limited: followed.limited }
  }
  return graph
}

module.exports = { addScreenshots, findBrowser, answersLeadingTo }
