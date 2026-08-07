# pi gondolin extension

Runs `pi`'s file and shell tools inside a local micro-VM instead of on your
host machine.

## What it does

- Overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` to run
  inside a gondolin VM.
- Mounts your project directory (the host cwd) read/write at `/workspace`
  inside the VM. Files the agent writes there show up on your host; anything
  else the VM does stays isolated.
- Starts the VM when a pi session starts, and stops it when the session
  ends.
- Adds `read_host`, a tool to read a file from your **host** machine (outside
  the VM), with a confirmation prompt. Adds `list_host_docs`, which lists
  pi's own docs directory on the host with no prompt.
- Prompts before starting if you launch pi from your home directory (that
  would mount your entire home directory into the VM).
- Routes `!` commands you type yourself into the VM too, matching the
  agent's own `bash` tool. Use `!!` to run on the host instead — pi's own
  "exclude this from the model's context" prefix doubles as the escape
  hatch here.

`grep` and `find` are implemented by walking the VM's filesystem directly,
not by shelling out to `rg` — a fresh VM image isn't guaranteed to have `rg`
installed.

## Requirements

- Node.js ≥ 23.6.0
- QEMU installed (`brew install qemu` on macOS, `apt install qemu-system-arm`
  on Debian/Ubuntu)

## Usage

```bash
cd /path/to/project
pi -e /path/to/pi-dev-extensions/extensions/gondolin
```

`pi -e <dir>` loads the extension for that one run. To have it load
automatically, copy or symlink the directory into `~/.pi/agent/extensions/`.

Once loaded, run `/gondolin` to see the VM's id, workspace paths, shell, and
image in use.

## Custom guest images

By default the VM boots gondolin's stock Alpine image, which only has a
basic shell — no compilers, no build tools. If your project needs something
like a JDK to run Gradle, point the extension at a custom image instead.

Build one with gondolin's own image tooling (`gondolin build --config
<file>`, listing whatever packages you need under `rootfsPackages`), then
tell this extension to use it:

```json
// .pi/gondolin.json (commit this to your project)
{
  "imagePath": "my-project-java:latest"
}
```

`imagePath` can be an image name/tag, a build id, a directory of guest
assets, or an explicit `{ "kernelPath", "initrdPath", "rootfsPath" }` object.

For one-off local testing without committing anything, set
`$PI_GONDOLIN_IMAGE` instead — it takes priority over `.pi/gondolin.json`.

If neither is set, the stock image is used. A `.pi/gondolin.json` that
exists but is invalid (bad JSON, wrong shape) fails the VM start with an
error rather than silently falling back.

## Host file access

`read_host` reads a file from your host machine, outside the VM's one mount.
It always asks for confirmation first, showing the exact path it resolved —
except `.md` files under pi's own docs directory, which it reads without
asking (static reference material, not your data). Any path already inside
the project workspace is refused — use `read` for those.

`list_host_docs` lists a directory under pi's docs directory on the host,
with no prompt. It only ever serves that one directory; use `read_host` for
anything else.

Both tools resolve symlinks safely: a path can't escape into or through the
VM's workspace mount via a symlink.

## Notes

- Only load one tool-routing extension at a time. If you also have another
  extension overriding the same tool names loaded, they'll silently
  overwrite each other's registrations — you'll get a warning at session
  start if that happens, but fix it by disabling one.
- The VM does not persist installed packages between sessions unless you use
  a custom image (see above) — a fresh session always starts from the
  configured image.

## Development

```bash
npm install
npm run typecheck
npm test
```

Tests use a fake in-memory VM, so they don't need a real micro-VM or QEMU.
