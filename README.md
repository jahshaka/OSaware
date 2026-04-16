# OSAWARE

OSAWARE is a fully browser-based operating system that gives
anyone with a web browser access to a threaded, memory-safe,
multi-process computing environment — no installation, no
configuration, no prior programming experience required.

Use its built-in BASIC compiler to write programs that execute
using their own isolated processes with access to 3D graphics,
audio synthesis, real-time networking, and direct AI integration —
all using a language as simple and readable as plain English.

## Quick Start

### Option 1 — Run locally, no server needed

The simplest way to try OSAWARE BASIC. Everything runs from a
single folder on your machine.

1. Download the latest release zip from the
   [Releases page](https://github.com/jahshaka/OSaware/releases)
   (or clone this repo).
2. Unzip it. You should see `index.html` at the top level alongside
   `core/`, `files/`, and `docs/`.
3. Open `index.html` in your browser.

That's it. Programs you save with `SAVE "PROGNAME"` will be kept in
your browser's local storage; they persist between sessions but only
on that browser/device.

If you cloned the repo and just want a zip, you can also download
the "Source code (zip)" button from any release, or run
`git archive --format=zip HEAD > osaware.zip`.

> **Heads-up:** some browsers block features like WebGL or
> AudioContext when pages are opened via `file://`. If a demo doesn't
> work, try the mini-server trick instead:
>
> ```bash
> # From inside the project directory
> python3 -m http.server 8080
> ```
>
> Then visit `http://localhost:8080/` in your browser.

### Option 2 — Host it on the web (free static hosting)

OSAWARE BASIC is a pure static site, so it'll run on any static
host with no backend needed. GitHub Pages, Netlify, Vercel, or any
plain HTTP server all work.

#### GitHub Pages (easiest)

1. Fork this repo to your GitHub account.
2. In your fork, go to **Settings → Pages**.
3. Under "Source", pick the **main** branch and the **/ (root)**
   folder.
4. Save. GitHub gives you a URL like
   `https://your-username.github.io/OSaware/` in about a minute.

#### Netlify

1. Log in at [netlify.com](https://www.netlify.com/) and pick
   "Add new site → Import an existing project".
2. Connect your GitHub fork.
3. Leave the build command blank. Set the publish directory to `.`
   (the repo root).
4. Deploy. Netlify gives you a live URL immediately.

#### Vercel

Same idea as Netlify — import the repo, leave framework preset as
"Other", publish directory `.`, hit deploy.

#### Any server you already have (Apache, nginx, etc.)

Just copy the repo contents into your web root (or a subdirectory)
and point a browser at it. No server-side code, no build step —
it's all HTML, CSS, and JavaScript.

### What's in the Box

- `index.html` — the entry point
- `core/` — the interpreter, compiler, graphics, and VFS
- `files/` — BASIC programs and assets shipped by default
- `docs/` — manual, architecture notes, and server setup guide

## Using OSAWARE BASIC

Once you've got it open in a browser, type `HELP` for a command
reference, or `DIR` to list available programs. To run one of the
bundled demos:

RUN PACMAN
RUN MAZE3D
RUN MANDEL
RUN TESTS

For a full language reference, check `docs/OSAWARE_BASIC_Manual.pdf`.

## Troubleshooting

**The page loads but graphics look broken or WebGL fails.**
Serve the files over HTTP rather than opening the file directly —
`file://` URLs restrict some web APIs. See the Python one-liner in
Option 1 above.

**Saved programs disappear between sessions.**
Local-storage saves are tied to the exact origin (domain + port)
and browser profile. If you switch browsers or open the site on a
different URL, those saves won't follow.

**Nothing happens when I press a key.**
Click the terminal once to give it keyboard focus. Some browsers
need an explicit click before capturing input.

## License

MIT License. See LICENSE file for details. Use it, fork it, ship it.
