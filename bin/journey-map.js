#!/usr/bin/env node
const { run } = require('../lib/cli')

run(process.argv.slice(2)).catch(err => {
  // Clear the "Creating your journey map…" line first
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K')
  console.error('journey-map: ' + err.message)
  process.exit(1)
})
