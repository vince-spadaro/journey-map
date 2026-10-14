#!/usr/bin/env node
const { run } = require('../lib/cli')

run(process.argv.slice(2)).catch(err => {
  console.error('journey-map: ' + err.message)
  process.exit(1)
})
