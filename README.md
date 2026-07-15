# Notes

Standalone Notes app for the AI App Host. It is an ordinary installable app,
not part of the trusted host or its bundled startup set.

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

The former bundled Notes workspace is deliberately not moved automatically.
Copy the contents of the old `notes-workspace` directory into this app's
managed data directory only while the app is stopped. This preserves the
original workspace if installation or import fails. If a custom workspace was
configured, its path remains in `apps.notes.settings` in the legacy
`host-config.json`.

Runtime requirements: Node.js 18 or newer. Installation from a public Git URL
also requires `git` on the machine running the host.
