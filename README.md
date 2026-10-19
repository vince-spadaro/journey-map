# Journey map

Draws a GOV.UK Prototype Kit journey as a map of its pages and branches, so you can review a journey without clicking through every route.

It reads the prototype's code, then takes a screenshot of every page. You don't need to change the prototype or have it running, and it never writes anything into the prototype's folders: maps, notes and names are all kept outside it.

The map shows:

- every page in the journey, with a screenshot, its title and file name
- the Continue buttons, links and redirects between pages
- the branch rules from the routes, in the words the user sees: a rule like `where-do-you-live = 'england'` shows as “England”, the label of that radio on the page (the rule itself is still in the side panel)
- where a route sends the user when it has no page of its own (like an address lookup), drawn as a branch straight from the page before it
- the error messages each page can show
- Change links and links back to earlier pages (hidden until you switch them on), labelled with the link's words, including the hidden text screen readers hear: "Change contact name" rather than just "Change"

## Install

You need:

- Node.js 18.3 or later. You already have it if you can run the Prototype Kit.
- Google Chrome or Microsoft Edge, for the screenshots.

The installer sets everything up, including on work laptops where you don't have admin rights. It doesn't need any changes to your prototypes.

### On a Mac

Open Terminal and run:

```
curl -fsSL https://raw.githubusercontent.com/vince-spadaro/journey-map/main/install.sh | bash
```

This downloads journey-map to a `journey-map` folder in your home folder and installs it. When it says **Done**, close Terminal, open it again, and check:

```
journey-map --help
```

If you've already downloaded journey-map with GitHub Desktop, run the installer from its folder instead (in GitHub Desktop: **Repository › Open in Terminal**):

```
bash install.sh
```

### On Windows

Download journey-map with GitHub Desktop (**File › Clone repository…**, then paste `https://github.com/vince-spadaro/journey-map.git` in the **URL** tab), then open its folder and double-click `install.cmd`. When it says **Done**, open a new Command Prompt and check:

```
journey-map --help
```

### Updating

Run the installer again: the same `curl` line or `bash install.sh` on a Mac, or `install.cmd` on Windows. If you use GitHub Desktop, select **Fetch origin** and **Pull origin** first.

Maps you made before updating keep the old version. Run the tool again on a journey to get the latest features.

### What the installer does

1. Checks you have Node.js 18.3 or later.
2. Downloads journey-map, or gets the latest version if you already have it.
3. Installs the packages it needs.
4. If npm isn't allowed to install command-line tools in its usual place (common on work laptops), sets npm to use a `.npm-global` folder in your home folder instead. No admin rights needed.
5. Creates the `journey-map` command, and makes sure new terminals can find it by adding one line to your terminal's settings file (`.zshrc`, or `.bash_profile` for bash) if it isn't there already.
6. Checks for Chrome or Edge.

It's safe to run more than once.

### If something goes wrong

The installer says what went wrong and what to do. The most common problems:

- **npm install fails on a work network**: your organisation may need its own npm registry or a proxy. Ask IT or a developer on your team for the setting.
- **The `curl` line can't download journey-map**: download it with GitHub Desktop instead, then run `bash install.sh` from its folder.
- **"Couldn't find Chrome or Edge"**: give the browser's location when you map a journey, with `--browser "<path to Chrome>"`.
- **No screenshots, and the prototype didn't start**: run `npm install` in the prototype folder first.

<details>
<summary>Installing by hand</summary>

In the `journey-map` folder:

```
npm install
npm link
```

If `npm link` says you don't have permission:

```
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm link
```

</details>

## Use

Point it at a journey folder inside the prototype's `app/views`:

```
journey-map ~/prototypes/my-service/app/views/version-2/apply
```

The map opens in your browser. It's a single HTML file that works offline, so you can attach it to a ticket or send it to someone.

You can also run it from inside the folder:

```
cd ~/prototypes/my-service/app/views/version-2/apply
journey-map
```

### Screenshots

The tool starts its own copy of the prototype on a spare port, opens each page in Chrome or Edge, then stops the prototype again. It doesn't affect a copy of the prototype you already have running.

This takes a minute or two, longer for journeys with lots of error messages. Pages are opened one at a time on purpose: the Prototype Kit can lose a page's answers when two pages save at the same moment, which would give wrong screenshots. The tool also removes the session files it creates in the prototype's `.tmp/sessions` folder when it finishes, so they don't pile up and slow the prototype down.

The prototype's packages need to be installed: run `npm install` in the prototype folder once after cloning it.

With screenshots, the map file is usually 3 to 8 MB, which is still fine to attach to a ticket.

Screens are taken without any answers filled in, so pages like Check your answers can look empty. To show them with content, put sample answers in a JSON file and pass it with `--data`. Use the names from the prototype's form fields (`name="..."`):

```json
{
  "fullName": "Andrea Redwood",
  "sttEmailAddress": "info@abc-accountants.co.uk",
  "sttPostcode": "HP1 7JK"
}
```

```
journey-map app/views/version-2/apply --data answers.json
```

If you already have the prototype running with the answers you want, use `--url http://localhost:3000` to take the screenshots from that copy instead.

If screenshots can't be taken, for example because the prototype won't start, the tool says why and still makes the map. Use `--no-screenshots` to skip them; the map is then made in about a second.

### Map part of a journey

To show only the pages you can reach from one page, use `--start`:

```
journey-map app/views/version-2/apply --start find-your-address
```

You can also give the page file directly:

```
journey-map app/views/version-2/apply/find-your-address.html
```

### Naming branches

Branches are named from the form labels where possible. Rules that aren't about a form answer, like `tooLong` or `result.type = 'no-results'`, have no label to borrow, and a branch the routes reach with "otherwise" is shown as **Any other answer** (or **Any other result** when the route works it out, like an address lookup). The side panel lists what it rules out.

To give these clearer names, run:

```
journey-map app/views/version-2/apply --create-names
```

This writes the journey's names file, listing everything still shown as code. The terminal shows where it is. It's kept outside the prototype, in `~/.journey-map/names/<prototype>/<journey>.json`:

```json
{
  "rules": {
    "tooLong": "An address line is over 40 characters",
    "result.type = 'no-results'": "No addresses found"
  },
  "branches": {
    "correspondence-address → check-your-answers": "Trading address that fits"
  }
}
```

Fill in the names you want and leave the rest empty. `rules` names a rule wherever it appears; `branches` names one branch, from page → to page. The map uses the file whenever it's there, and running `--create-names` again adds anything new without touching your names.

To share names with your team, keep the file somewhere you all use, like a shared drive or the journey-map repo, and point to it with `--names <file>`.

### Options

| Option | What it does |
|---|---|
| `--start <page>` | Only show pages reachable from this page |
| `--out <file>` | Save the map somewhere specific, for example `--out ~/Desktop/review.html` |
| `--no-screenshots` | Make the map without screenshots |
| `--data <file>` | Sample answers to fill in before taking screenshots (JSON) |
| `--url <address>` | Take screenshots from a prototype that's already running, for example `http://localhost:3000` |
| `--browser <path>` | The Chrome or Edge to use, if it isn't found by itself |
| `--port <number>` | The port your prototype runs on, for the "Open in prototype" links (default 3000) |
| `--create-names` | Write the journey's names file, listing the branch rules to name (see above) |
| `--names <file>` | Use a names file somewhere else, for example one your team shares |
| `--include-index` | Include the folder's `index.html`. It's left out by default because it usually lists every page, which hides the real flow |
| `--json` | Save the journey as JSON instead of a map |
| `--no-open` | Don't open the browser |

## Using the map

- **When it was made**: the top of the map shows the date and time the map was made, and the browser tab (and any bookmark of it) shows the date. Downloaded and exported files are named with it too, like `apply-journey-map-2026-10-15-1606.html`, so saved copies sort in the order they were made.
- **Drag** or **scroll** to move around. Hold **⌘** (Mac) or **Ctrl** and scroll to zoom. Press **F** to fit the whole map.
- **Click a page** to see its screenshot, the external websites it links to (under "Links to N external websites"), where it goes and under which conditions, where it comes from, its error messages, and links to open it in the prototype or in VS Code. The path that leads to it is highlighted.
- **Full screen** (on the screenshot in the side panel) shows the whole page at a readable size. Use **←** and **→** to step through every screen in journey order, for content reviews. **Fit / 100% / 150% / 200%** (or **+** and **−**) zoom in to read small text. **Open in VS Code** opens the page's template, to fix what you've spotted.
- Screenshots are taken at retina (2×) quality. Zoom in on the map and the cards switch to the sharp full-size screenshots.
- **Screen states**: every page can have more than one screenshot. Switch between them with the tabs in the full-screen view, or with **↑** and **↓**. The side panel lists them all.
  - **States** (shown as an "N states" tag, counting the page as it opens, so a page with one other state shows "2 states"; a page with only its normal state has no tag):
    - when a radio or checkbox option shows more questions once it's selected (a GOV.UK conditional reveal), the page is also photographed with that option selected, so you can review the revealed field, its label and hint. Options that reveal nothing don't get an extra screenshot.
    - when a link on the page goes back to the same page with something added to the address, like "request a new code" (`?requestedNew=true`), the page is also photographed that way.
    - when a page shows different content depending on an answer on the page before it (its template has `{% if %}` blocks using that answer, directly or through a `{% set %}` variable), the page before it branches once for each answer on the map, and the page is photographed after each answer. If the page looks the same as it opens as after one of the answers, that's one screenshot, not two.
  - **Errors**: when a page's routes show errors (they re-render the page with `errors`), its form is sent with nothing entered, with symbols, and with too much text. Each one that comes back with the prototype's own error messages is photographed and labelled with those messages. Shown as an "N errors" tag (from "1 error"), and as red tabs in the full-screen view. Pages with no validation in their routes aren't tried, so no error screens are made up. These are tried in a separate private browser session, so they don't change the answers used for the other screenshots.
- **Screenshots** turns the thumbnails on the map on and off.
- **Find a page** searches titles, headings, URLs and file names. Press Enter to jump between matches, or **/** to start searching.
- **Top to bottom / Left to right** changes the direction of the map.
- **Change and return links** shows the links that go back to earlier pages.
- **Notes**: every screen has a Notes box, in the side panel and next to the screenshot in full screen. Type while you review; notes save in your browser as you type, and a yellow marker shows on each screen that has notes. Drag the box's bottom corner to make it bigger or smaller; it stays that size. When a screen has more than one state or error, each one has its own notes: pick a state's tab in full screen to write about it. States with notes are tagged **Notes**. They stay if you close the tab. Each map keeps its own notes: when you make a new map of the same journey it starts with no notes, and the older map keeps the notes typed in it.
- **Share**:
  - **Download map with notes** saves a copy of the map with your notes inside. Send that file: whoever opens it sees the notes and can add their own.
  - **Copy notes as text** copies every note, in journey order, to paste into Jira, Confluence, Teams or an email.
  - **See all notes** lists every note in the side panel.
- **Export** saves the map as an SVG for Mural.
- **SVG for Mural with all states** saves the map with every state and error of each page next to it, each with its name, so a whole review fits on one Mural board. Errors have a red border. It's in the Export menu on maps with screenshots of other states or errors (make the map again if you don't see it).

## Reviewing in a call

Open the map and share your browser window. Click through the screens (full screen and **←** **→** work well for this) and type notes as people talk. Afterwards, use **Share › Download map with notes** and send the file, or **Copy notes as text** to paste the actions somewhere.

Notes are saved in the browser you typed them in. A colleague only sees them once you send them the downloaded map.

## How it works

1. It reads every page in the folder for links (`<a href>` and macro `href:` options) and forms. Back links, external links and commented-out code are ignored. Links inside `{% if %}` blocks are labelled with the condition.
2. It reads `app/routes.js`, `app/routes/*.js` and any `_routes.js` file under `app/views`, and works out where each `res.redirect()` goes and under which `if`, `else`, `switch` or `? :` condition. It understands variables like `const base = '/version-2'`, template strings and helper functions.
3. It reads the radios, checkboxes and selects on each page (HTML or GOV.UK macros, plus labels read from the real page during screenshots) and uses their labels to name the branches. When every branch from a page tests the same question, "otherwise" is named with the options left over; otherwise it's "Any other answer". Names from the journey's names file come first.
4. When a route re-renders a page with `errors`, that's shown as an error on the page, not as a branch.
5. It starts the prototype and photographs each page with [Puppeteer](https://pptr.dev/), using the Chrome or Edge already on your computer.
6. It lays the map out with [ELK](https://eclipse.dev/elk/).

## Limitations

- It reads the code; it doesn't run it. If a redirect address is built at run time, for example from the user's answers, that page shows a warning and the link isn't drawn.
- Routes with parameters (`/:page`) and routers mounted with `router.use('/prefix', ...)` aren't followed yet.
- Links added by JavaScript in the browser aren't found.
- Error screens are found by sending each form empty, with symbols and with too much text. Errors that need a specific wrong answer (for example a date in the past, or a wrong security code) only appear if one of those triggers them. The error rules from the routes are still listed in the side panel.
- Conditional reveals are found from the GOV.UK Frontend pattern (`data-aria-controls` pointing at a `govuk-radios__conditional` or `govuk-checkboxes__conditional` panel). Reveals built another way aren't found.
- Details components, accordions and tabs are photographed opened, so all their content can be reviewed. The side panel says when a page's screenshot shows them opened.
- Very long pages are cut off after 16,000 pixels. Pages over 8,000 pixels tall are photographed at standard rather than retina sharpness.
- Pointing it at a whole prototype works, but the map gets busy. Mapping one journey or version folder at a time works best.

## Development

```
npm install
npm test
```

`test/fixtures/kit` is a small prototype with the patterns the tests cover. When you find a prototype the map gets wrong, add the pattern there with a test.

| File | What it does |
|---|---|
| `lib/prototype.js` | Finds the prototype, its pages and route files, and resolves URLs |
| `lib/views.js` | Reads a page's title, links and forms |
| `lib/routes.js` | Reads route files for redirects and their conditions |
| `lib/graph.js` | Builds the pages and connections, and finds start pages and return links |
| `lib/screenshots.js` | Starts the prototype and takes the screenshots |
| `lib/layout.js` | Positions everything with ELK |
| `lib/render.js` | Builds the HTML file |
| `viewer/` | The map page: HTML, CSS and JavaScript |
