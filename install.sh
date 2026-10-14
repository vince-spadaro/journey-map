#!/usr/bin/env bash
# Installs (or updates) journey-map so the `journey-map` command works in any
# terminal. No admin rights needed: if npm's shared folder isn't writable, npm
# is set up to install tools in ~/.npm-global instead.
#
# From a downloaded copy:   bash install.sh
# Without downloading:      curl -fsSL https://raw.githubusercontent.com/vince-spadaro/journey-map/main/install.sh | bash
#
# Running it again updates the tool.

set -u

REPO_URL="https://github.com/vince-spadaro/journey-map.git"
INSTALL_DIR="${JOURNEY_MAP_DIR:-$HOME/journey-map}"
USER_PREFIX="$HOME/.npm-global"
# Keep npm's own notices out of the installer's messages
export NPM_CONFIG_UPDATE_NOTIFIER=false

say () { printf '%s\n' "$*"; }
ok () { printf '  ✓ %s\n' "$*"; }
note () { printf '  ! %s\n' "$*"; }
fail () { printf '\n  ✗ %s\n\n' "$*" >&2; exit 1; }

say ''
say '  Installing journey-map'
say ''

# 1. Node.js 18.3 or later
command -v node > /dev/null 2>&1 ||
  fail "Node.js isn't installed. Install the LTS version from https://nodejs.org, then run this again."
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 18 || (a === 18 && b >= 3) ? 0 : 1)' ||
  fail "Node.js $(node -v) is too old. Install the LTS version from https://nodejs.org, then run this again."
ok "Node.js $(node -v)"

# 2. The tool's code: this folder if the script is in it, otherwise ~/journey-map
SCRIPT_DIR=''
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$SCRIPT_DIR" ] && grep -q '"name": "journey-map"' "$SCRIPT_DIR/package.json" 2> /dev/null; then
  DIR="$SCRIPT_DIR"
else
  DIR="$INSTALL_DIR"
fi

if [ -d "$DIR/.git" ]; then
  if command -v git > /dev/null 2>&1; then
    # Never ask for a password here: GitHub Desktop users update with Pull origin
    if GIT_TERMINAL_PROMPT=0 git -C "$DIR" pull --ff-only --quiet 2> /dev/null; then
      ok "Latest version from GitHub"
    else
      note "Couldn't check GitHub for a newer version, so installing the copy you have."
      note "To update, use Fetch origin and Pull origin in GitHub Desktop, then run this again."
    fi
  fi
elif [ -e "$DIR" ] && [ ! -f "$DIR/package.json" ]; then
  fail "$DIR already exists and isn't journey-map. Move it, or choose another folder with JOURNEY_MAP_DIR=<folder>."
elif [ ! -e "$DIR" ]; then
  command -v git > /dev/null 2>&1 ||
    fail "Git isn't installed. Download journey-map with GitHub Desktop instead, then run install.sh from its folder."
  GIT_TERMINAL_PROMPT=0 git clone --quiet "$REPO_URL" "$DIR" ||
    fail "Couldn't download journey-map from GitHub. If the repository is private, download it with GitHub Desktop, then run install.sh from its folder."
  ok "Downloaded to $DIR"
fi

# 3. The tool's packages
( cd "$DIR" && npm install --no-fund --no-audit --loglevel=error > /dev/null ) ||
  fail "npm install didn't work. On a work network you may need your organisation's npm registry or proxy settings: ask IT or a developer on your team."
ok "Packages installed"

# 4. Somewhere for npm to put the command that this user can write to
writable () { mkdir -p "$1" 2> /dev/null && [ -w "$1" ]; }
PREFIX="$(npm prefix -g)"
if ! writable "$PREFIX/bin" || ! writable "$PREFIX/lib/node_modules"; then
  PREFIX="$USER_PREFIX"
  mkdir -p "$PREFIX/bin" "$PREFIX/lib/node_modules"
  npm config set prefix "$PREFIX" ||
    fail "Couldn't change npm's settings. Run: npm config set prefix \"$PREFIX\""
  export NPM_CONFIG_PREFIX="$PREFIX"
  ok "npm will install command-line tools in $PREFIX (no admin rights needed)"
fi

# 5. The journey-map command
( cd "$DIR" && npm link --no-fund --no-audit --loglevel=error > /dev/null ) ||
  fail "npm link didn't work. Copy the message above and send it to the person who shared journey-map."
ok "journey-map command created"

# 6. Make sure terminals can find it, now and in future
NEW_TERMINAL=0
case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *)
    if [ "$PREFIX" = "$USER_PREFIX" ]; then
      LINE='export PATH="$HOME/.npm-global/bin:$PATH"'
    else
      LINE="export PATH=\"$PREFIX/bin:\$PATH\""
    fi
    case "$(basename "${SHELL:-zsh}")" in
      bash) if [ "$(uname)" = Darwin ]; then PROFILE="$HOME/.bash_profile"; else PROFILE="$HOME/.bashrc"; fi ;;
      zsh) PROFILE="$HOME/.zshrc" ;;
      *) PROFILE="$HOME/.profile" ;;
    esac
    if ! grep -qsF "$LINE" "$PROFILE"; then
      printf '\n# Added by the journey-map installer: command-line tools installed with npm\n%s\n' "$LINE" >> "$PROFILE"
      ok "Added npm's tools to your terminal's path in $PROFILE"
    fi
    NEW_TERMINAL=1
    ;;
esac

"$PREFIX/bin/journey-map" --version > /dev/null 2>&1 ||
  fail "The journey-map command was created but doesn't run. Copy the messages above and send them to the person who shared journey-map."

# 7. Chrome or Edge, for screenshots
BROWSER=''
for app in 'Google Chrome' 'Microsoft Edge' 'Chromium' 'Brave Browser'; do
  for base in /Applications "$HOME/Applications"; do
    [ -x "$base/$app.app/Contents/MacOS/$app" ] && BROWSER="$app" && break 2
  done
done
if [ -z "$BROWSER" ]; then
  for name in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge; do
    command -v "$name" > /dev/null 2>&1 && BROWSER="$name" && break
  done
fi
if [ -n "$BROWSER" ]; then
  ok "Screenshots will use $BROWSER"
else
  note "Couldn't find Chrome or Edge. Install one for screenshots, or give its location with --browser."
fi

say ''
say "  Done: journey-map $("$PREFIX/bin/journey-map" --version)"
say ''
if [ "$NEW_TERMINAL" = 1 ]; then
  say '  Close this terminal and open a new one, then map a journey:'
else
  say '  Map a journey:'
fi
say '    journey-map <journey folder in your prototype>'
say ''
say '  Tip: type "journey-map " and drag the journey folder into the terminal.'
say '  To update later, run this installer again.'
say ''
