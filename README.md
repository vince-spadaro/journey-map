# Journey map

Draws a GOV.UK Prototype Kit journey as a map of its pages and branches, so you can review a journey without clicking through every route.

It reads the prototype's code, then takes a screenshot of every page. You don't need to change the prototype or have it running, and it never writes anything into the prototype's folders: maps and names are both kept outside it.

The map shows:

- every page in the journey, with a screenshot, its title and file name
- the Continue buttons, links and redirects between pages. When a page has more than one way on, links are named with their words, like “Start now” and “I do not want this agent”
- the branch rules from the routes, in the words the user sees: a rule like `where-do-you-live = 'england'` shows as “England”, the label of that radio on the page (hover over a branch's name to see the rule)
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

Branches are named from the form labels where possible. Rules that aren't about a form answer, like `tooLong` or `result.type = 'no-results'`, have no label to borrow, and a branch the routes reach with "otherwise" is shown as **Any other answer** (or **Any other result** when the route works it out, like an address lookup).

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

- **When it was made**: the top of the map shows the date and time the map was made, and the browser tab (and any bookmark of it) shows the date. Exported files are named with it too, like `apply-journey-map-2026-10-15-1606.svg`, so saved copies sort in the order they were made.
- **Drag** or **scroll** to move around. Hold **⌘** (Mac) or **Ctrl** and scroll to zoom. Press **F** to fit the whole map.
- **Click a page** to highlight the path that leads to it. A bar at the bottom of the map has three buttons: **View full screen**, **Open in prototype** and **Open in VS Code**. Click the map or press Escape to close it.
- **View full screen** (the green button in the bar at the bottom) opens the screen as a page of its own, showing the whole page at a readable size. **← Back to map**, Escape or your browser's back button takes you back. Use **←** and **→** to step through every screen in journey order, for content reviews. **Fit / 100% / 150% / 200%** (or **+** and **−**) zoom in to read small text. **Open in VS Code** opens the page's template, to fix what you've spotted.
- Screenshots are taken at retina (2×) quality. Zoom in on the map and the cards switch to the sharp full-size screenshots.
- **A branch for every answer**: when you take screenshots, the tool also goes through the journey the way a user would. From the start page it picks each option on each page, presses Continue and sees which page comes next, carrying the answers along. Each version of a page that the answers lead to is its own screen on the map, with its own screenshot, branching from the option that led there. For example, "What type of client" branches into three "Which authorisation" screens, one for each type of client, and each of those carries on to the end of the journey. Branches join again where the screens become the same: when every screen from a point on has the same words, questions and buttons whichever way you came (only the answers shown back on "Check your answers" can differ), it's drawn once and every branch leads into it. Only answers that change the journey branch: ones the prototype's routes or pages check, or that the journey's index page lists versions for. A version the index page lists that no answer leads to is a screen of its own too (see **States and versions**). Links that put an answer in the address, like a start page's “I do not want this agent” going to `sign-in?choice=decline`, are followed with that answer, so a branch the routes make later on (after sign in, say) leads to the right screens. A form with no question to answer, like sign in, is followed where it goes and also along the other branches its routes give (like `signInOutcome = 'wrong-user-id'`), from every way into it, leaving out any that contradict an answer given earlier. An answer that only picks something, like which agent code to unlink, is followed but doesn't split the map. A way back to an earlier page, like "No, I need to start again", is a return link. Each screen has its own errors: the page's errors are tried again with that screen's answers, so every version that shows an error message has it photographed. In the full-screen view, each error's tab says what makes it show, like "Nothing entered", "Entered in the wrong format" or "Date entered with no day", next to the message, so you can check the message fits. Where a page stops the user (it shows an error, because it needs an answer typed in), that branch carries on along the routes instead, still carrying the answer each route is for. Maps made with `--no-screenshots` don't have these branches.
- **Ways out of the journey**: a link to another journey or service usually goes to `#` in a prototype, so each journey folder works on its own. Each one is drawn as a grey "Outside this journey" box named with the link's words, like "Start new request", so you can see every way out. Links that open in a new tab, like guidance, aren't drawn: the user stays on the page. Untick **Pages outside this journey** to hide them.
- **Where the journey carries on**: when a journey goes on in another journey folder, link to `#continues-in-` and the folder's name, like `href="#continues-in-your-contact-details"`. A route can do the same by redirecting back to the page with it on the end, like `res.redirect(base + '/sign-in#continues-in-your-contact-details')`. In the prototype it goes nowhere, like `#`, so the folder still works on its own. On the map it's an "Outside this journey" box called "Continues in your-contact-details", so you know which journey to open next.
- **Branch names**: every branch is named in full, wrapping onto as many lines as it needs. Options are named as the page shows them, like “Yes, I want to become their main agent instead”. Other answers that decide a branch are named with the words the journey's index page gives the address that sets them (“Already the client’s main agent” for `?existingAgentRole=TAX-IT`), or the words of a link that gives the answer, or else put in words (“signed up is false”). When an option has more than one way on, each is named “Option” – what decides it, like “No” – Already the client’s main agent. A very long option is shortened with “…”; what decides it never is. A names file (`--create-names`) still beats all of these.
- **Screens that can show on any page**: some screens aren't on one branch, like "You have been signed out" or "We could not confirm your identity", which can show wherever the user is. Mark the page's template with `{# journey-map: anywhere #}` and it's drawn on its own in a row above the journey, with an "Any page" tag and no lines in or out.
- **Start page**: only the journey's start page has the green "Start" tag. A page that nothing in the journey leads to, like an exit page with a "Start again" link, stays on the map with a note saying no page links to it, but isn't tagged as a start.
- **States and versions**: the map tells apart the same screen in another state from another version of the screen.
  - **States** are the same screen in a state one screenshot can't show. They're extra screenshots of the page, not screens on the map: switch between them with the tabs in the full-screen view, or with **↑** and **↓**. Shown as an "N states" tag, counting the page as it opens, so a page with one other state shows "2 states"; a page with only its normal state has no tag.
    - when a page has tabs (the GOV.UK tabs component), the page is photographed with each tab selected, as well as with the tab it opens on. Each one is named after the tab, like “History” tab.
    - when a radio or checkbox option shows more questions once it's selected (a GOV.UK conditional reveal), the page is also photographed with that option selected, so you can review the revealed field, its label and hint. Options that reveal nothing don't get an extra screenshot.
    - errors (below) are states too.
  - **Versions** are the page showing something different: another scenario, not another state. Each version is a screen of its own on the map, with its own thumbnail, named after the page and the version, like “Confirm the client’s details – the service has suspended the agent”. It's on a branch from where it's reached, labelled with the version's name. A version screen carries on with the page's own ways on, but only the ones it shows: a version with no form, like “The service has suspended the agent”, has no Continue, only its links. Where the next page has a version with the same answers, it goes there: the consent screen for a trust leads to the confirmation for a trust. When a page's heading depends on the answers, each version is named with the heading it shows. Two screens count as the same when they have the same words, the same GOV.UK components and the same questions. Differences in how they look, like a wider text box, a bigger heading or a grey button, don't make them different screens.
    - **Versions listed on the journey's index page**: when the index page links to a page with something added to the address, like `select-service?clientType=trust`, the page is opened at that address and photographed, in a private browser session. It's named with the link's words on the index page, and branches from every page that leads to the page, as another way the page can turn out. If it comes back with the prototype's own error messages, like `client-type?error=required`, it's an error instead. This is how prototypes that don't check answers can still show every version and error on the map.
    - when a link on the page goes back to the same page with something added to the address, like "request a new code" (`?requestedNew=true`), the page is also photographed that way, branching from the page with the link's words.
    - when a page shows different content depending on an answer on the page before it (its template has `{% if %}` blocks using that answer, directly or through a `{% set %}` variable), the page is photographed after each answer, branching from the page that asks. If the page looks the same as it opens as after one of the answers, that's one screenshot, not two.
    - versions that the answers lead to when the tool follows the journey are their own screens too (see **A branch for every answer**), carrying on to the end of the journey.
    - maps made with `--no-screenshots` can't photograph versions, so they show an "N versions" tag instead.
  - **Variants** are versions of a page that isn't on the way through the journey from the start page, like a page the index page lists as not shown in this journey. Branches are only drawn on the way through the journey, so these stay with the page: it shows an "N variants" tag, counting the page as it opens, and you switch between them with the tabs in the full-screen view.
  - **Errors**: when a page's routes show errors (they re-render the page with `errors`), its form is sent with nothing entered, with symbols, and with too much text. Each one that comes back with the prototype's own error messages is photographed and labelled with those messages. Shown as an "N errors" tag (from "1 error"), and as red tabs in the full-screen view. Pages with no validation in their routes aren't tried, so no error screens are made up. These are tried in a separate private browser session, so they don't change the answers used for the other screenshots.
- **Screenshots** turns the thumbnails on the map on and off.
- **Find a page** searches titles, headings, URLs and file names. Press Enter to jump between matches, or **/** to start searching.
- **Top to bottom / Left to right** changes the direction of the map. Lines on the map don't cross, so it's easy to scan. A page's branches are in the same order as its options (from left to right when the map runs top to bottom, from top to bottom when it runs left to right) wherever that doesn't make lines cross.
- **Change and return links** shows the links that go back to earlier pages.
- **Interactive map (HTML)**, in the Export menu, saves a copy of the map to keep on your laptop, present from or upload to Confluence. It works offline on any computer, with the screenshots, full-screen view, states and errors. **Open in prototype** and **Open in VS Code** stay in the copy. Open in prototype works for anyone with the prototype running. Open in VS Code only works on a computer with the prototype in the same folder as the computer that made the map. Confluence shows an uploaded HTML file as an attachment to download and open, not inside the page.
- **Export** also saves the map as an SVG for Mural. Screenshots are shown whole, however long the page, sharp enough to read when you zoom in, and the key is on the right with the journey's name and the date the map was made.
- **SVG for Mural with all states** saves the map with every state and error of each page next to it, each with its name, so a whole review fits on one Mural board. Errors have a red border, and say what makes them show (like "Nothing entered") above the message, as in the full-screen view. It's in the Export menu on maps with screenshots of other states or errors (make the map again if you don't see it).
- **Choose screens to export**, in the Export menu, lets you leave screens, states and errors out of both SVGs. The map shows every state and error next to its page, with a tick box on each one, all ticked to start with. Click a screen, state or error to untick it (it fades), and click again to put it back. Tags count only what's ticked. Click **Done** when you've finished, then export. The export closes up the gaps, and lines to and from a screen you left out go too. Your choice is kept for that map in your browser. It opens on the screen you were looking at, and goes back there when you click **Done**, so you don't have to find it again. Back on the map, a dot at the right of a screen's tags shows what you've left out: a solid dot when the whole screen is left out, a ring when some of its states or errors are. Hover over the dot to see what's left out.

## Reviewing in a call

Open the map and share your browser window. Click through the screens (full screen and **←** **→** work well for this). To collect comments, export an **SVG for Mural** and put it on a board, where everyone can add sticky notes next to the screens.

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
- Error screens are found by sending each form empty, with symbols and with too much text. Errors that need a specific wrong answer (for example a date in the past, or a wrong security code) only appear if one of those triggers them.
- Conditional reveals are found from the GOV.UK Frontend pattern (`data-aria-controls` pointing at a `govuk-radios__conditional` or `govuk-checkboxes__conditional` panel). Reveals built another way aren't found.
- Details components and accordions are photographed opened, so all their content can be reviewed. Tabs are photographed as the page opens them, and each other tab is a state of its own.
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
