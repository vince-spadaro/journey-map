# Instructions for Copilot

Journey map is a command-line tool for UX designers. You point it at a journey folder in a GOV.UK Prototype Kit prototype, and it makes one self-contained HTML file: a map of the journey's pages and branches, with a screenshot of every screen, used for design and content reviews.

The people using it are designers, not developers. The owner maintains the code; colleagues only install and run it.

## Rules that must not be broken

- **Never write anything into a prototype's folders.** The tool only reads a prototype's code. Maps go to a temporary folder or `--out`, notes live in the browser (and in downloaded maps), names files live in `~/.journey-map/names` or `--names`. Starting the prototype for screenshots is fine: it uses the prototype's own `node_modules`, and the Kit refreshes its own `.tmp` folder.
- **Never make up states or errors.** Error screenshots are only taken for pages whose routes show errors (a `res.render` with `errors`) or at addresses the journey's index page lists for the page (`listedStates`, like `?error=required`), and only kept when the page comes back with the prototype's own GOV.UK error messages.
- **The map file must work offline and on its own.** Everything (data, screenshots, CSS, JavaScript) is inlined into one HTML file. No CDNs, no network requests, no separate asset files.
- **Don't flag prototype problems.** Broken links and missing pages are normal in a prototype. There is no "things to check" list, and links to missing pages are left off the map (`showMissing` in `buildGraph` can bring them back).

## Words used in the interface

Use these words consistently in the map, the terminal and the README:

- **state**: another version of a screen. The page as it opens counts as a state, so a page with one extra state shows "2 states". No tag when a page has only its normal state. Extra states are conditional reveals (an option selected), links back to the same page with a query string (for example `?requestedNew=true`), and answers: when a page's template changes with an answer on the page before it (`conditionFields` in `views.js`, `answerStates` in `graph.js`), that page before it branches once per answer and the page is photographed after each answer (`?field=value`, in a private session).
- **error**: an error screen. Tag shows from "1 error". Never "error state".
- Branches are named in the words the user sees: radio, checkbox and select labels from the page that sends the form, for example “I want to use a different address”. Never show "otherwise": name the options left over, or use "Any other answer" (after a page) or "Any other result" (when a route works it out, `decided` edges), and list what it excludes in the side panel. The rule from the routes is kept as `code` and shown in small text as "Route rule:".
- Return links (Change links and links back to earlier pages) are labelled with the link's full words, including visually hidden text: "Change contact name", not "Change".

Write all text for designers in plain English, following the GOV.UK style: short sentences, sentence case, no jargon. Explain what something does for the designer, not how the code works.

## How it works

`bin/journey-map.js` → `lib/cli.js` runs these steps:

1. `lib/graph.js` `buildGraph()` builds the pages and connections:
   - `lib/prototype.js`: finds the prototype root (`app/views` + `package.json`), lists pages and route files, resolves URLs. Page URLs are normalised by `normaliseUrl()`: leading slash, no trailing slash, no `.html`, no `/index`.
   - `lib/views.js` `parsePage()`: title, links, forms and form choices (`fields`) from a template, with regular expressions (templates mix HTML and Nunjucks too freely for a strict parser). Handles plain HTML and GOV.UK macros, `{% if %}` conditions, and visually hidden text (`fullText`).
   - `lib/routes.js` `parseRoutes()`: reads route files with acorn and works out each `res.redirect` / `res.render` and the conditions around it (`if`/`else`, early returns, `switch`, ternaries, `&&`), following constants, template strings, helper functions and variables copied from `req.session.data`.
   - A route with no page of its own (a form's address that redirects, or a link to an address that redirects) isn't drawn: the page is joined straight to where the route sends it (`decided` edges). Don't bring back "decision" blocks; designers found them confusing.
   - Edges have a `kind`: `submit`, `redirect`, `link` or `change`. Change links and links that loop back are marked `return: true` and kept out of the layout.
   - The start page (`mainEntry`) is the first page the journey's `index.html` lists, even when other pages link to it (like "Start again" on a page that ends the journey); anything leading into it is a return link. Without an index page, it's the page nothing links to that reaches the most pages. When the journey is a loop and has no index page, it's a page named like `home`, `start` or `index`. Links are checked for "goes back" nearest the start first, so the link back home is the return link, not the way into the journey.
2. `lib/names.js` `nameBranches()` turns each edge's `rule` into a `label`. It runs again after screenshots, when labels the template builds from data are known (`renderedFields`). `--create-names` writes the names file for rules still shown as code.
3. `lib/screenshots.js` (unless `--no-screenshots`): starts its own copy of the prototype on a spare port (`NODE_ENV=development`, `USE_HTTPS=false`, `USE_AUTH=false`) or uses `--url`, then takes screenshots with puppeteer-core and the Chrome or Edge already installed. Screenshots are 2× WebP (thumbnails 2× JPEG). Details, accordions and tabs are opened before every screenshot. Error attempts run in a separate private browser context so they don't change the session used for other screenshots.
4. `lib/layout.js` lays out the map with ELK, top to bottom and left to right, with and without thumbnails, and adds each node's lines and badges. Node sizes here must match how `viewer/viewer.js` draws them. Two more are only for the Mural exports, which show whole screenshots (`card.picture` is the picture's height): `:full` for "SVG for Mural", and `:states` for "SVG for Mural with all states", where each page's box also holds its state cards (`stateCards`, positions in `cards`) and fixed ports keep the lines on the page card. The viewer draws the map in that layout only while saving (`state.exporting`), with the key from `drawKey()`.
   After the screenshots, `followAnswers()` goes through the journey from `mainEntry` in private sessions: it chooses each radio option on the page's main form, sends it and records the page that comes next, carrying the answers in the address (the kit stores them). Each page reached with different answers is a version of it (key: page + `queryOf(answers)`), photographed. A page already on the way there is a line back. When a form can't be followed (errors, no route), the map's own lines are used. If any page has more than one version, `lib/follow.js` `applyFollowed()` redraws the map. First `joinSame()` joins versions of a page that are the same screen (`screenLook()`: its text, questions and buttons, without summary list values, since pixels differ slightly between identical pages) and lead on to the same screens the same ways, worked out from the end back. Then: each version is its own node (the first keeps the page's id, so notes stay), states go with the version whose answers they were photographed with, and `arrange()` in `graph.js` works out return links, depth and the start again.
5. `lib/render.js` inlines the data and `viewer/` files into one HTML page, with ELK and `lib/layout.js` (as `window.journeyLayout`), so the map can lay out an export again without the screens left out of it ("Choose screens to export": `state.choosing` shows the `:states` layout with a tick box on every card, `keptScreens()` lays out the export). That's why `layout.js` must only use ELK. Left-out screens are saved in `localStorage` per map, like notes (`journey-map:leave-out:…`, page ids and `<page id>#<state number>`).

The viewer (`viewer/`) is plain JavaScript with no build step and no libraries:

- `viewer/template.html`: page structure.
- `viewer/viewer.css`: page styles. `viewer/map.css`: styles inside the SVG, so they go with an exported SVG.
- `viewer/viewer.js`: drawing, pan and zoom, side panel, full-screen view with state tabs, notes, Share and Export.
- Notes are saved in `localStorage` per map (`journey-map:notes:<scope URL>:<createdAt>`, or without `:<createdAt>` for older maps), so a new map of the same journey starts with no notes and older versions keep theirs. Each state has its own note: the page as it opens uses the page id, other states use `<page id>#<state number>` (`noteKey()`), so notes from older maps still show on the page as it opens. They're saved as you type, and written into a downloaded copy of the map by "Download map with notes". Always wrap storage in `try`/`catch`: the map must work without it.
- Build DOM with the `h()` and `make()` helpers and `textContent`, never `innerHTML` with page content.
- The key (`#legend`) only shows rows for what's on the map: each row has a `data-show` that `viewer.js` checks against the data.
- `meta.createdAt` (set in `render.js`) is when the map was made. It's shown in the header and tab title, and used in download and export file names. Older maps don't have it, so check before using it.

## Installing (for helping colleagues)

The README's Install section is the source of truth; keep it, `install.sh`, `install.cmd` and this summary in step.

- Mac: `curl -fsSL https://raw.githubusercontent.com/vince-spadaro/journey-map/main/install.sh | bash`, or `bash install.sh` from a copy downloaded with GitHub Desktop. Windows: double-click `install.cmd`.
- `install.sh` checks Node.js 18.3+, clones to `~/journey-map` (or `JOURNEY_MAP_DIR`) or pulls the latest, runs `npm install`, and if npm's global folder isn't writable sets `npm config set prefix ~/.npm-global`. It runs `npm link`, adds `export PATH="$HOME/.npm-global/bin:$PATH"` to `~/.zshrc` (or `~/.bash_profile` / `~/.bashrc` for bash) only if missing, checks the command runs, and looks for Chrome or Edge. It must stay safe to run again: that's how people update.
- It needs no admin rights and must never use `sudo` or write into a prototype.
- After installing, a new terminal is needed if the PATH line was added.
- Screenshots need Chrome or Edge (or `--browser <path>`), and `npm install` run in the prototype.
- Colleagues use the tool but don't change it. Don't suggest they push changes; suggest they tell the owner.

## Things learned the hard way

- **Screenshots must be taken one page at a time (`CONCURRENCY = 1` in `screenshots.js`).** The Kit's session file store reads every file in `.tmp/sessions` each time a session is saved and deletes any it can't read. Pages saving at the same time (and a page's own CSS and JavaScript requests) then lose answers, giving wrong error screenshots. Three at a time was tried and gave wrong results.
- **Clean up sessions.** Each private browser context makes a session file. The tool notes the files that exist before a run and removes only new ones afterwards (not with `--url`, where the sessions may be the user's own). Hundreds of leftover files make every page save slow, which makes the problem above much worse, for the tool and for the designer's own `npm run dev`.
- **Set the answers that lead to a page before trying its errors** (`answersLeadingTo`), so the route treats the form as it would for a real user. Otherwise a shared route can show another page's error.
- **Everything must be generic.** Prototypes differ: plain HTML and macros, routes in `app/routes.js` or `_routes.js`, a fixed `base` or one worked out from `__dirname`, helpers that render errors or pick the next page. When a journey reveals a new pattern, handle the pattern, add it to `test/fixtures/kit` with a test, and check the other journeys still map the same.

## Working on the code

- Node.js 18.3 or later, CommonJS (`require`), no TypeScript, no build step.
- Dependencies are kept to `acorn`, `acorn-walk`, `elkjs` and `puppeteer-core`. Don't add more without a good reason, and never one that downloads a browser.
- Match the existing style: 2-space indents, no semicolons, single quotes, short functions with a one-line comment saying why when it isn't obvious.
- Run the tests with `npm test`. They use Node's built-in test runner and the small sample prototype in `test/fixtures/kit`. When a real prototype gets something wrong, add that pattern to the sample prototype and a test for it.
- The tests don't cover screenshots or the viewer. After changing either, run the tool on a real journey and check the map in a browser:
  ```
  node bin/journey-map.js <journey folder> --out /tmp/map.html
  ```
  Use `--no-screenshots` for a quick check of the map and labels (about a second).
- Keep the README up to date when behaviour or options change. It's written for designers.
- Must work on macOS and Windows: use `path.join`, don't rely on shell commands (see `findBrowser()` and `openInBrowser()`).
