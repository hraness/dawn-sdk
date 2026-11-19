// SPDX-License-Identifier: MIT
/**
 * One static page for a built catalog, in the DAWN instrument language: one
 * paper and one ink, structure from alignment and space, quiet labels and
 * mono readings. No script, no remote font, no hue: a listing has nothing
 * live, so it has no signal color.
 */
import type { Collection, CollectionEntry } from "../../core/collection.ts";

/** The instrument tokens (`assets/design/instrument-tokens.json`, v2) a page uses. */
export const PAGE_TOKENS = Object.freeze({
  light: {
    ground: "#f4f4f1",
    sunk: "#eaeae6",
    ink: "#131313",
    ink2: "#5a5a56",
    ink3: "#9c9c97",
    rule: "#d6d6d1",
  },
  dark: {
    ground: "#0f0f0f",
    sunk: "#1a1a1a",
    ink: "#ececea",
    ink2: "#9c9c98",
    ink3: "#5e5e5c",
    rule: "#2b2b2b",
  },
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
});

const escape = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const scheme = (t: Record<string, string>) =>
  Object.entries(t)
    .map(([k, v]) => `--${k}:${v};`)
    .join("");

function sourceLink(entry: CollectionEntry): { href?: string; text: string } {
  const s = entry.source;
  if (s.type === "github")
    return {
      href: `https://github.com/${s.owner}/${s.repo}/blob/${s.ref.split("/").map(encodeURIComponent).join("/")}/${s.path.split("/").map(encodeURIComponent).join("/")}`,
      text: `${s.owner}/${s.repo} · ${s.ref} · ${s.path}`,
    };
  if (s.type === "https") return { href: s.url, text: s.url };
  return {
    href: s.path.split("/").map(encodeURIComponent).join("/"),
    text: s.path,
  };
}
const LICENSE_NAMES = {
  content: "Content",
  software: "Software",
  samples: "Samples",
  trace: "Trace",
} as const;
function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024,
    i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function entryItem(entry: CollectionEntry, url: string | undefined): string {
  const link = sourceLink(entry);
  const size =
    entry.files?.reduce((n, f) => n + f.bytes, 0) ?? entry.source.bytes;
  const facts: [string, string][] = [
    ["Credits", entry.credits.map(escape).join(", ")],
    ...Object.entries(entry.licenses).map(([k, v]): [string, string] => [
      `${LICENSE_NAMES[k as keyof typeof LICENSE_NAMES]} license`,
      escape(v),
    ]),
    [
      "Source",
      link.href
        ? `<a href="${escape(link.href)}">${escape(link.text)}</a>`
        : escape(link.text),
    ],
  ];
  if (entry.files)
    facts.push(["Files", `<span class="value">${entry.files.length}</span>`]);
  if (size !== undefined)
    facts.push(["Size", `<span class="value">${bytes(size)}</span>`]);
  if (entry.source.sha256)
    facts.push([
      "SHA-256",
      `<span class="value digest">${entry.source.sha256}</span>`,
    ]);
  const install =
    entry.kind === "collection"
      ? ""
      : `<pre><code>dawn-collection install ${escape(url ?? "<catalog URL>")} ${escape(entry.id)}</code></pre>`;
  return `<li id="${escape(entry.id)}">
<h3>${escape(entry.title)}</h3>
<p class="label">${escape(entry.kind)} · <span class="id">${escape(entry.id)}</span></p>
${entry.description ? `<p>${escape(entry.description)}</p>\n` : ""}<dl>
${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("\n")}
</dl>
${install}</li>`;
}

export function catalogPage(catalog: Collection, url?: string): string {
  const t = PAGE_TOKENS;
  const css = `:root{color-scheme:light dark;${scheme(t.light)}}
@media (prefers-color-scheme:dark){:root{${scheme(t.dark)}}}
*{box-sizing:border-box}
html{background:var(--ground);color:var(--ink)}
body{margin:0;font:400 14px/20px ${t.sans};-webkit-text-size-adjust:100%}
main{max-width:44rem;margin:0 auto;padding:48px 16px 64px}
h1{font-size:28px;line-height:32px;font-weight:600;letter-spacing:-0.025em;margin:0 0 12px}
@media (min-width:48rem){h1{font-size:40px;line-height:44px;letter-spacing:-0.03em}}
h2{font-size:16px;line-height:24px;font-weight:600;margin:48px 0 16px}
h3{font-size:16px;line-height:24px;font-weight:600;margin:0}
p{margin:0 0 8px}
.lead{font-size:16px;line-height:24px;color:var(--ink2);max-width:36rem}
.label,dt{font-size:10px;line-height:16px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink2)}
.label .id{text-transform:none;letter-spacing:0;font-family:${t.mono}}
.value,code{font-family:${t.mono};font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
.digest{overflow-wrap:anywhere}
dl{margin:12px 0 0;display:grid;gap:4px 16px;grid-template-columns:minmax(6rem,max-content) 1fr}
dl div{display:contents}
dd{margin:0;overflow-wrap:anywhere}
dt{padding-top:2px}
.facts{margin-top:24px}
ul{list-style:none;margin:0;padding:0}
li{margin:0 0 32px}
pre{background:var(--sunk);border-radius:2px;padding:8px 12px;margin:12px 0 0;overflow-x:auto}
a{color:var(--ink);text-decoration:underline;text-decoration-color:var(--ink3);text-decoration-thickness:1px;text-underline-offset:2px}
a:hover{text-decoration-color:var(--ink)}
a:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:2px}
footer{margin-top:64px;color:var(--ink2);font-size:12px;line-height:16px}`;
  const description =
    catalog.description ??
    `${catalog.entries.length} entries curated by ${catalog.curator}.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape(catalog.title)}</title>
<meta name="description" content="${escape(description.slice(0, 300))}">
<meta name="generator" content="DAWN collection build">
<style>
${css}
</style>
</head>
<body>
<main>
<header>
<p class="label">Collection</p>
<h1>${escape(catalog.title)}</h1>
${catalog.description ? `<p class="lead">${escape(catalog.description)}</p>\n` : ""}<dl class="facts">
<div><dt>Curator</dt><dd>${escape(catalog.curator)}</dd></div>
<div><dt>Version</dt><dd class="value">${escape(catalog.version)}</dd></div>
<div><dt>Entries</dt><dd class="value">${catalog.entries.length}</dd></div>
<div><dt>Catalog</dt><dd><a href="dawn.collection.json">dawn.collection.json</a> · <a href="dawn.inventory.json">inventory</a></dd></div>
</dl>
</header>
<section aria-labelledby="entries">
<h2 id="entries">Entries</h2>
${catalog.entries.length ? `<ul>\n${catalog.entries.map((e) => entryItem(e, url)).join("\n")}\n</ul>` : "<p>This collection has no entries yet.</p>"}
</section>
<footer>
<p>Credits are the curator's and contributors' claims, and digests identify bytes, not authors. A listing grants no license beyond the labels shown. Installing copies the declared files and runs nothing.</p>
</footer>
</main>
</body>
</html>
`;
}
