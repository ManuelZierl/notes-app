# Notes

Standalone Notes app for Kestral (the AI App Host). It is an ordinary
installable app, not part of the trusted host or its bundled startup set.

## Build

```sh
npm install
npm run build
```

Commit `dist/` in the Notes repository. The App Host's public-Git installer
does not run package builds and expects `app.json` or `dist/app.json` at the
repository root.

## Data

The backend stores Markdown files and `.meta.json` sidecars below the managed
`APP_HOST_DATA_DIR` supplied by the host. Missing `tags` in older sidecars are
treated as an empty list and written in the current format on the next save.

Comments attach to a selected passage of a note. Commented passages are
marked in the editor and clicking a mark opens its comment in the collapsible
comments section. Each comment stores the quoted text, its offsets, and 180
characters of surrounding context, so it re-anchors after edits; an ambiguous
anchor (repeated quote, stale context) shows the original quote instead of
guessing. Writing comments requires `expected_version`, and sidecar comment
entries that predate this format are preserved on disk but not shown. The
note list can additionally be narrowed by tag chips (all selected tags must
match).

The former bundled Notes workspace is deliberately not moved automatically.
Copy the contents of the old `notes-workspace` directory into this app's
managed data directory only while the app is stopped. This preserves the
original workspace if installation or import fails. If a custom workspace was
configured, its path remains in `apps.notes.settings` in the legacy
`host-config.json`.

Runtime requirements: Node.js 18 or newer. Installation from a public Git URL
also requires `git` on the machine running the host.
