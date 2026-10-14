const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { parseArgs } = require('util')

const { findPrototypeRoot } = require('./prototype')
const { buildGraph } = require('./graph')
const { addLayouts } = require('./layout')
const { nameBranches, unnamed, writeNamesFile } = require('./names')
const { renderHtml } = require('./render')
const pkg = require('../package.json')

const USAGE = `
Draws a GOV.UK Prototype Kit journey as a map of pages and branches.

Usage
  journey-map [folder] [options]

  folder   A journey folder inside the prototype's app/views.
           Defaults to the current folder. Give a page file instead
           to map the journey from that page.

Options
  --start <page>     Only show pages reachable from this page, for example
                     --start contact-name
  --out <file>       Where to save the map (.html). By default it's saved in
                     a temporary folder and opened in your browser.
  --port <number>    Port the prototype runs on, for "Open in prototype"
                     links (default 3000)
  --include-index    Include the folder's index.html (left out by default,
                     because it usually lists every page)
  --no-screenshots   Don't take screenshots. Without this, the tool starts
                     its own copy of the prototype and photographs each page
  --url <address>    Take screenshots from a prototype that's already
                     running, for example --url http://localhost:3000
  --data <file>      Sample answers to fill in before the screenshots, as
                     JSON: { "fullName": "Andrea Redwood", "email": "a@b.com" }
  --browser <path>   Chrome or Edge to use, if it isn't found by itself
  --create-names     Write the journey's names file, listing every branch
                     rule that's still shown as code, ready for you to name.
                     Names already in it are kept. The map uses this file
                     whenever it's there. It's kept outside the prototype,
                     in ~/.journey-map/names
  --names <file>     Use a names file somewhere else, for example one your
                     team shares
  --json             Save the journey as JSON instead of a map
  --no-open          Don't open the map in the browser
  -h, --help         Show this help
  -v, --version      Show the version

Examples
  journey-map app/views/version-1/apply
  journey-map ~/prototypes/my-service/app/views/v2 --start start-page
  journey-map . --out ~/Desktop/review.html
`

function plural (n, word, many) {
  return n + ' ' + (n === 1 ? word : many || word + 's')
}

function slugify (text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'journey'
}

function openInBrowser (file) {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [file]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', file]]
      : ['xdg-open', [file]]
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
  } catch (err) {
    // The file path is printed anyway
  }
}

function isInside (child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function readData (file) {
  if (!file) return null
  const full = path.resolve(file)
  let data
  try {
    data = JSON.parse(fs.readFileSync(full, 'utf8'))
  } catch (err) {
    throw new Error(`couldn’t read the answers in ${full}: ${err.message}`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${full} should hold answers like { "fullName": "Andrea Redwood" }`)
  }
  return data
}

// Screenshots are a bonus: if they can't be taken, the map is still made
async function takeScreenshots (graph, root, values) {
  const { addScreenshots } = require('./screenshots')
  const progress = (done, total) => {
    if (process.stderr.isTTY) process.stderr.write(`\r  Taking screenshots… ${done} of ${total}`)
  }
  process.stderr.write(values.url ? '  Opening the prototype…' : '  Starting the prototype…')
  try {
    await addScreenshots(graph, { root, url: values.url, data: readData(values.data), browser: values.browser, onProgress: progress })
    process.stderr.write(process.stderr.isTTY ? '\r\x1b[K' : ' done\n')
  } catch (err) {
    process.stderr.write('\n')
    console.warn(`  No screenshots: ${err.message}`)
    console.warn('  (use --no-screenshots to skip them)')
  }
}

async function run (argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      start: { type: 'string' },
      out: { type: 'string', short: 'o' },
      port: { type: 'string', default: '3000' },
      'include-index': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
      'no-screenshots': { type: 'boolean', default: false },
      url: { type: 'string' },
      browser: { type: 'string' },
      data: { type: 'string' },
      'create-names': { type: 'boolean', default: false },
      names: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false }
    }
  })

  if (values.help) { console.log(USAGE); return }
  if (values.version) { console.log(pkg.version); return }
  if (positionals.length > 1) throw new Error('Give one folder. Run journey-map --help to see how.')

  const target = path.resolve(positionals[0] || '.')
  if (!fs.existsSync(target)) throw new Error(`Can't find ${target}`)

  let scopeDir = target
  let start = values.start
  if (fs.statSync(target).isFile()) {
    scopeDir = path.dirname(target)
    start = start || target
  }

  const root = findPrototypeRoot(scopeDir)
  if (!root) {
    throw new Error(`${scopeDir} isn't inside a Prototype Kit prototype (no app/views folder above it).`)
  }
  const viewsDir = path.join(root, 'app', 'views')
  if (scopeDir === root || scopeDir === path.join(root, 'app')) scopeDir = viewsDir
  if (!isInside(scopeDir, viewsDir)) throw new Error('Choose a folder inside the prototype’s app/views.')

  const port = parseInt(values.port, 10)
  if (!Number.isInteger(port) || port <= 0) throw new Error('--port must be a number, like 3000')

  const graph = buildGraph({
    root,
    scopeDir,
    start,
    includeIndex: values['include-index'],
    namesFile: values.names ? path.resolve(values.names) : null
  })
  const stats = graph.meta.stats
  if (!stats.pages) throw new Error(`No pages found in ${path.relative(root, scopeDir) || scopeDir}`)

  const slug = slugify(path.basename(scopeDir) + (graph.meta.start ? '-from-' + graph.meta.start.split('/').pop() : ''))
  let out
  let content
  if (values.json) {
    out = values.out ? path.resolve(values.out) : path.join(os.tmpdir(), 'journey-map', slug + '.json')
    content = JSON.stringify(graph, (key, value) => key === 'absFile' || key === 'absRouteFile' ? undefined : value, 2)
  } else {
    if (!values['no-screenshots']) {
      await takeScreenshots(graph, root, values)
      // Labels read from the real pages can name more branches
      nameBranches(graph, graph.names)
    }
    await addLayouts(graph)
    out = values.out ? path.resolve(values.out) : path.join(os.tmpdir(), 'journey-map', slug + '.html')
    content = renderHtml(graph, { port, slug })
  }
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, content)

  let namesMessage = ''
  if (values['create-names']) {
    const added = writeNamesFile(graph, graph.names)
    namesMessage = added
      ? `  Added ${plural(added, 'name')} to fill in to ${graph.names.file}`
      : `  Nothing new to name. The names file is ${graph.names.file}`
  } else {
    const todo = unnamed(graph)
    const count = todo.rules.length + todo.branches.length
    if (count) {
      namesMessage = `  ${plural(count, 'branch rule')} could have a clearer name. Run again with --create-names to name ${count === 1 ? 'it' : 'them'}.`
    }
  }

  const lines = [
    '',
    `  ${graph.meta.name}`,
    `  ${plural(stats.pages, 'page')} · ${plural(stats.branches, 'branch', 'branches')} · ${plural(stats.decisions, 'decision')}` +
      (graph.meta.hiddenCount ? ` · ${graph.meta.hiddenCount} pages not reachable from the start page left out` : '')
  ]
  if (graph.meta.skippedIndex) lines.push('  Left out the index page (use --include-index to show it)')
  // Route files the tool couldn't read leave gaps in the map itself
  if (graph.meta.problems.length) {
    lines.push('', '  Parts of the map may be missing:')
    graph.meta.problems.forEach(problem => lines.push('  - ' + problem))
  }
  if (graph.names.exists) lines.push(`  Using names from ${graph.names.file}`)
  if (namesMessage) lines.push('', namesMessage)
  lines.push('', `  Saved to ${out}`, '')
  console.log(lines.join('\n'))

  if (!values.json && !values['no-open']) openInBrowser(out)
}

module.exports = { run }
