# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The project's rules, wording, architecture and lessons learned are kept in one place, shared with Copilot. Keep them there, not here:

@.github/copilot-instructions.md

## Commands

```
npm test                                                          # all tests
node --test --test-name-pattern="loops back" test/journey-map.test.js   # one test, by name
node bin/journey-map.js <journey folder> --no-screenshots --out <scratch file>.html   # quick check, about a second
node bin/journey-map.js <journey folder> --json --out <scratch file>.json             # inspect nodes, edges, depth, mainEntry
```

No build or lint step.

## Checking changes on the owner's prototypes

- The owner's prototype is `~/Desktop/govuk-prototype`. Its journeys follow the new prototype architecture: each journey folder under `app/views/new-prototype-architecture/mapping/<version>/` is self-contained, with its own `_routes.js` and an `index.html` that lists the journey's pages in order, the start page first.
- **Always pass `--out` to a scratch file when checking a change.** Without it the map overwrites the owner's own map in `$TMPDIR/journey-map/<journey>.html`, the one they review (a `--no-screenshots` check run once wiped their screenshots). Only write there when asked to make their map again.
- The global `journey-map` command must be `npm link`ed to this repo. If the owner says a change doesn't show up, run `readlink -f $(which journey-map)` first: testing `install.sh` in another folder re-links it to that copy.
- Changes only show in a newly made map: a map file is fixed when it's made.
