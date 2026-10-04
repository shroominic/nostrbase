# Documentation

## Read the site

From the SDK directory:

```sh
npm ci
npm ci --prefix site
npm run docs:dev
```

Open `http://127.0.0.1:4321`. Build static HTML with `npm run docs:build`; preview with `npm run docs:preview`. Upload `site/dist` to any static host.

## Find a guide

- [Quickstart](guides/quickstart.md)
- [How it works](guides/architecture.md)
- [From Supabase](guides/supabase.md)
- [Read and write](guides/crud.md), [filters](guides/filters.md), [API setup](api.md)
- [Realtime](realtime.md), [private data and files](private-storage.md), [offline and sync](offline-sync.md)
- [Search and tools](tooling.md), [errors](guides/errors.md), [troubleshooting](guides/troubleshooting.md)
- [Wire protocol](protocol.md), [verification](verification.md)
- [Engineering baseline](engineering.md), [release policy](releasing.md), [ownership](../MAINTAINERS.md), [security](../SECURITY.md)

## Edit documentation

Edit guide Markdown in `docs/`; the site copies it during preparation. `site/src/catalog.json` controls navigation and section extraction. API pages are generated from `dist/index.d.ts` and source module ownership during the site build. Rebuild the SDK before generating a reference. The dev server watches Markdown, navigation, and built declarations.

`npm run docs:build` checks examples and Astro/TypeScript, verifies every local link and fragment, and emits searchable HTML, per-page Markdown, `llms.txt`, and `llms-full.txt`. Code examples use placeholder relay/server URLs; replace them before running.
