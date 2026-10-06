import { getCollection, render } from "astro:content";
import type { APIRoute } from "astro";

const base = import.meta.env.BASE_URL.replace(/\/$/, "");
const plain = (value: string) =>
  value
    .replace(/<\/?(?:figure|svg|title|defs|marker|path|g|text|rect)(?:\s[^>]*)?>/g, " ")
    .replace(/```[\w-]*\n?/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#*`>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export const GET: APIRoute = async () => {
  const entries = await getCollection("docs");
  const index = [];
  for (const entry of entries) {
    const { headings } = await render(entry);
    const sections = (entry.body ?? "").split(/(?=^#{2,3} )/m);
    let headingIndex = 0;
    for (const section of sections) {
      const hasHeading = /^#{2,3} /.test(section);
      const heading = hasHeading ? headings[headingIndex++] : undefined;
      index.push({
        title: entry.data.title,
        group: entry.data.group,
        heading: heading?.text ?? "",
        url: `${base}/docs/${entry.id}/${heading ? `#${heading.slug}` : ""}`,
        text: plain(section),
      });
    }
  }
  return new Response(JSON.stringify(index), { headers: { "Content-Type": "application/json" } });
};
