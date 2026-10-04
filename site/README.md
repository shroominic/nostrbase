# nostrbase documentation site

Static Astro site. Guide content comes from `../docs`; API signatures come from the built SDK declarations.

```sh
# From the SDK directory:
npm ci
npm ci --prefix site
npm run docs:dev
```

- Development: `http://127.0.0.1:4321`
- Production build: `npm run docs:build`
- Preview: `npm run docs:preview`
- Static output: `site/dist`

Edit `docs/` for prose, `site/src/catalog.json` for navigation, and `site/src/` for the interface. The dev server regenerates pages when Markdown sources, the catalog, or built SDK declarations change.

The build checks 58 guide snippets and typechecks four complete quickstarts. It also fails for missing exported declarations, invalid Astro types, broken local links, or search links with missing anchors. It emits plain Markdown, `llms.txt`, and `llms-full.txt`. Search runs in the browser against a local index. Fonts are served locally.
