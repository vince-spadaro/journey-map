// Takes a screenshot of each page. Starts its own copy of the prototype on a
// spare port (so it doesn't clash with one you already have running), opens
// each page in Chrome or Edge, then stops the prototype again.

const fs = require('fs')
const net = require('net')
const http = require('http')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

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
const CONCURRENCY = 3
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
function fillAndSend (fill) {
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

// Sends the page's form in each of the ways above, in a private browser
// session so the answers used for the other screenshots aren't changed
async function captureErrors (browser, url, seed) {
  const context = await browser.createBrowserContext()
  const states = []
  try {
    const page = await context.newPage()
    await page.setViewport({ ...VIEWPORT, deviceScaleFactor: PIXEL_RATIO })
    if (seed) await page.goto(seed, { waitUntil: 'load', timeout: 30000 })
    const seen = new Set()
    for (const attempt of ERROR_TRIES) {
      const status = await loadPage(page, url)
      if (status >= 400) break
      const form = await page.evaluate(mainForm)
      if (!form) break
      const before = new URL(url).pathname
      const [sent] = await Promise.all([
        page.evaluate(fillAndSend, attempt.fill),
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
    await context.close().catch(() => {})
  }
  return states
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

  return { status, thumb: dataUri(thumb), ...main, states, expanded, renderedFields }
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

  const puppeteer = require('puppeteer-core')
  const prototype = url ? { url: url.replace(/\/$/, ''), stop () {} } : await startPrototype(root)
  let browser
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
          if (node.status >= 400) node.warnings.push(`The page shows an error (${node.status}) when it’s opened`)
          // Only pages whose routes show errors: nothing is made up for pages without validation
          else if (node.errorStates.length) node.states.push(...(await captureErrors(browser, prototype.url + node.url, seed)))
        } catch (err) {
          node.shotError = err.message.split('\n')[0]
        }
        done++
        if (onProgress) onProgress(done, pages.length)
      }
      await tab.close()
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pages.length) }, worker))
  } finally {
    if (browser) await browser.close().catch(() => {})
    prototype.stop()
  }
  graph.meta.screenshots = true
  return graph
}

module.exports = { addScreenshots, findBrowser }
