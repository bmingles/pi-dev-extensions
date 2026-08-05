# `cd`'s own stdout/stderr are silenced (not `pwd`'s, which follows outside the
# redirected command) because a shell-integrated nvm `chpwd` hook fires on this
# `cd` and prints "Now using node vX (npm vY)" to stdout when this repo's
# .nvmrc differs from the active version — left uncaptured, that text was
# leaking into $_PI_DEV_EXTENSIONS_DIR and corrupting every path built from it.
_PI_DEV_EXTENSIONS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd)"

# `pi` with the devcontainer and caffeinate extensions loaded, so its
# file/shell tools route into a devcontainer for the current directory (bare
# `!` stays on the host) and the host doesn't idle-sleep while it works.
# Launches in $PWD — the devcontainer extension resolves the container from
# pi's cwd — while `-e` points at each extension by absolute path so `pic`
# works from anywhere.
# One-time setup: `(cd "$_PI_DEV_EXTENSIONS_DIR" && npm install)`.
#
# This script knows nothing about where `devc` comes from — the devcontainer
# extension invokes plain `devc` on PATH by default, or $DEVC_BIN if set (see
# extensions/devcontainer/README.md). If you run devc from source instead of
# a compiled binary, source agent-tools' own bash_aliases_devc.sh in your
# .bashrc *before* this script — it exports $DEVC_BIN for you, so pic() picks
# it up with no further setup here.

function _pic_resolve_pi() {
  # Fast path: whatever node version is currently active in this shell.
  command -v pi 2>/dev/null && return
  # Fallback: scan all nvm-managed node installs for one with `pi` installed,
  # newest version first — works even if this shell's active version differs
  # from the one `pi` was npm-installed under.
  local candidate
  for candidate in $(ls -d "${NVM_DIR:-$HOME/.nvm}"/versions/node/*/bin/pi 2>/dev/null | sort -V -r); do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  return 1
}

function pic() {
  local pi_bin
  pi_bin="$(_pic_resolve_pi)" || {
    echo "pic: 'pi' not found on PATH or under \$NVM_DIR/versions/node/*/bin/pi" >&2
    return 1
  }
  "$pi_bin" \
    -e "$_PI_DEV_EXTENSIONS_DIR/extensions/caffeinate" \
    -e "$_PI_DEV_EXTENSIONS_DIR/extensions/devcontainer" \
    "$@"
}
