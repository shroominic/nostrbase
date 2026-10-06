import { defineConfig } from "astro/config";
import contentWatch from "./scripts/content-watch.mjs";

export default defineConfig({
  output: "static",
  site: "https://shroominic.github.io",
  base: process.env.BASE_PATH ?? "",
  devToolbar: { enabled: false },
  integrations: [contentWatch()],
  trailingSlash: "always",
  markdown: {
    shikiConfig: { themes: { light: "github-light", dark: "github-dark" }, defaultColor: false },
  },
  vite: { server: { fs: { allow: [".."] } } },
});
