#!/usr/bin/env node
// Markdown (.md) -> dist/ static site.
// Input is the markdown under the numbered folders; output is data/index.json,
// data/notes/<slug>.json, and a copy of site/.
//
// Extends the secbrain publishing pipeline for hands-on documentation.
// Added axes: stack (tools), env (verified environment), verified (last verification), duration, risk.
// For a procedure, "the day it last actually ran" matters more than "the day it was written",
// so `verified` is treated as a first-class field.

import { readFile, writeFile, mkdir, readdir, rm, cp, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";
import hljs from "highlight.js";
import hcl from "./hcl-language.mjs";

// highlight.js carries no HCL; this registers the hand-written grammar next to it so that
// ```hcl / ```tf / ```terraform blocks colour like every other language on the site.
hljs.registerLanguage("hcl", hcl);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const config = JSON.parse(await readFile(path.join(ROOT, "site.config.json"), "utf8"));
const VAULT_DIRS = Object.keys(config.folders);
const STALE_DAYS = config.staleDays || 120;
const VERIFIABILITY = ["lab", "partial", "field"];

/* ---------- frontmatter ---------- */

// Just enough YAML for our frontmatter: scalars, inline arrays, block arrays.
function parseFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };

  const data = {};
  const lines = m[1].split(/\r?\n/);
  let key = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && key) {
      if (!Array.isArray(data[key])) data[key] = [];
      data[key].push(unquote(listItem[1]));
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    const value = kv[2].trim();

    if (value === "") data[key] = "";
    else if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
    } else data[key] = unquote(value);
  }
  return { data, body: m[2] };
}

const unquote = (s) => s.replace(/^["'](.*)["']$/, "$1").trim();
const asList = (v) =>
  (Array.isArray(v) ? v : String(v || "").split(","))
    .map((s) => String(s).trim())
    .filter(Boolean);

/* ---------- extraction ---------- */

// Body with code blocks and inline code removed, so links and tags are not picked up from
// shell examples. Hands-on docs are mostly code blocks, which makes this filter load-bearing
// (#!/bin/bash, --tag=, and friends).
function stripCode(body) {
  return stripFences(body).replace(/`[^`\n]*`/g, "");
}

// Fenced blocks only. Task text loses its meaning without inline code (the `admin` account),
// so we stop here and strip the backticks just before display.
function stripFences(body) {
  return body.replace(/```[\s\S]*?```/g, "");
}

function extractWikilinks(body) {
  const out = new Set();
  for (const m of stripCode(body).matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    const target = m[1].trim();
    if (target) out.add(target);
  }
  return [...out];
}

function extractTags(body, fmTags) {
  const out = new Set(asList(fmTags).map((t) => t.replace(/^#/, "")).filter(Boolean));
  for (const m of stripCode(body).matchAll(/(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu)) out.add(m[1]);
  return [...out];
}

// Obsidian Tasks format: - [ ] text 📅 YYYY-MM-DD
//
// Hands-on docs mix two kinds of checkbox.
//  - Verification checklist: re-checked every time the procedure runs. Not a repo-level todo.
//  - Follow-up: real work left over after writing the doc.
// The nearest preceding heading separates them. Counted together, "open tasks" means nothing.
// The Korean form is kept so docs written before the site switched to English still classify.
const FOLLOWUP_HEADING = /follow[- ]?ups?|next steps|todo|후속\s*조치/i;

function extractTasks(body) {
  const tasks = [];
  let followup = false;
  for (const line of stripFences(body).split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      followup = FOLLOWUP_HEADING.test(heading[1]);
      continue;
    }
    const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (!m) continue;
    const text = m[2].trim();
    const due = text.match(/📅\s*(\d{4}-\d{2}-\d{2})/);
    tasks.push({
      done: m[1].toLowerCase() === "x",
      // Wikilink syntax is markup, not content — a follow-up quoted from another document
      // otherwise reaches the dashboard as a literal "[[k8s-node-drain-replace]]".
      text: text
        .replace(/📅\s*\d{4}-\d{2}-\d{2}/, "")
        .replace(/\[\[([^\]|#]+)(?:[#|]([^\]]*))?\]\]/g, (_a, target, alias) => (alias || target).trim())
        .replace(/`/g, "")
        .trim(),
      due: due ? due[1] : null,
      kind: followup ? "followup" : "checklist",
    });
  }
  return tasks;
}

// How many runnable commands a doc carries — the signal that separates something you read
// from something you follow.
function countCommands(body) {
  let n = 0;
  for (const block of body.matchAll(/```(\w*)[^\n]*\r?\n([\s\S]*?)```/g)) {
    const lang = (block[1] || "").toLowerCase();
    if (!["bash", "sh", "shell", "console", "zsh"].includes(lang)) continue;
    for (const line of block[2].split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#") || t.startsWith("//")) continue;
      n++;
    }
  }
  return n;
}

/* ---------- walk ---------- */

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const slugify = (relPath) => relPath.replace(/\.md$/, "").replace(/[/\\]/g, "~");

/* ---------- collect ---------- */

const notes = [];

for (const dir of VAULT_DIRS) {
  for (const file of await walk(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const raw = await readFile(file, "utf8");
    const { data, body } = parseFrontmatter(raw);

    // Skip files with no frontmatter — the convention in CLAUDE.md.
    if (!Object.keys(data).length) {
      console.warn(`  skip (no frontmatter): ${rel}`);
      continue;
    }

    const base = path.basename(rel, ".md");
    const mtime = (await stat(file)).mtime.toISOString().slice(0, 10);

    notes.push({
      slug: slugify(rel),
      base,
      path: rel,
      folder: dir,
      title: data.title || base,
      date: data.date || mtime,
      domain: data.domain || config.folders[dir].domain,
      tags: extractTags(body, data.tags),
      stack: asList(data.stack),
      summary: data.summary || "",
      source: data.source || "",
      env: data.env || "",
      verified: data.verified || "",
      // What stands between this document and a full verification.
      // lab (default) = a throwaway lab settles it; partial = it ran, but a named part could not be
      // exercised where it ran; field = no lab can settle it (real hardware, real time, a second
      // cluster, a real outage). The prose already said this; this makes the site able to read it.
      verifiability: VERIFIABILITY.includes((data.verifiability || "").toLowerCase())
        ? data.verifiability.toLowerCase()
        : "lab",
      verifiabilityNote: data["verifiability-note"] || "",
      duration: data.duration || "",
      risk: (data.risk || "").toLowerCase(),
      links: extractWikilinks(body),
      tasks: extractTasks(body),
      commands: countCommands(body),
      words: body.trim().split(/\s+/).filter(Boolean).length,
      body,
    });
  }
}

notes.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.title.localeCompare(b.title)));

/* ---------- resolve links ---------- */

// A wikilink points at a filename without its extension. Resolve base -> slug and leave
// anything unresolved as a "doc that does not exist yet" (i.e. the writing queue).
const byBase = new Map();
for (const n of notes) if (!byBase.has(n.base)) byBase.set(n.base, n.slug);
const bySlug = new Map(notes.map((n) => [n.slug, n]));

const backlinks = new Map(notes.map((n) => [n.slug, []]));
const edges = [];
const missing = new Set();

for (const n of notes) {
  n.resolved = [];
  for (const target of n.links) {
    const slug = byBase.get(target) ?? byBase.get(path.basename(target));
    if (!slug || slug === n.slug) {
      if (!slug) missing.add(target);
      continue;
    }
    n.resolved.push(slug);
    backlinks.get(slug).push(n.slug);
    edges.push({ from: n.slug, to: slug });
  }
}

/* ---------- render ---------- */

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Procedures cross-reference themselves in the body ("see section C").
// marked v15 no longer adds heading ids, so we generate them with GitHub-like rules.
const slugCounts = new Map();
const headingSlug = (text) => {
  const base =
    text
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const n = slugCounts.get(base) || 0;
  slugCounts.set(base, n + 1);
  return n ? `${base}-${n}` : base;
};

// A config file is easier to follow when the block says which file it is.
// ```yaml title="argocd-values.yaml" puts the name in a header bar instead of a comment
// on line one, which reads as part of the file and gets copied along with it.
const INFO = /^(\S+)?(?:\s+title="([^"]+)")?/;

// Languages highlight.js does not carry (hcl/terraform among them) fall through to plain
// text — the header bar and layout still apply, only the token colours are missing.
function highlight(code, lang) {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* fall through to escaped plain text */
    }
  }
  return escapeHtml(code);
}

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      return `<h${depth} id="${headingSlug(text)}">${text}</h${depth}>\n`;
    },
    code({ text, lang }) {
      const [, language = "", title = ""] = (lang || "").match(INFO) || [];
      const key = language.toLowerCase();
      const body = `<pre><code class="language-${escapeHtml(key || "text")}">${highlight(text, key)}</code></pre>`;
      if (!title) return body;
      return (
        `<figure class="codefile">` +
        `<figcaption><span class="fname">${escapeHtml(title)}</span>` +
        (key ? `<span class="flang">${escapeHtml(key)}</span>` : "") +
        `</figcaption>${body}</figure>\n`
      );
    },
  },
});

function renderBody(note) {
  slugCounts.clear(); // fresh id namespace per document
  // Rewrite wikilinks into markdown links, then render the markdown.
  let src = note.body.replace(
    /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g,
    (_all, target, _anchor, alias) => {
      const name = target.trim();
      const label = (alias || name).trim();
      const slug = byBase.get(name) ?? byBase.get(path.basename(name));
      return slug
        ? `[${label}](#/note/${encodeURIComponent(slug)})`
        : `<span class="wikilink-missing" title="This doc does not exist yet">${escapeHtml(label)}</span>`;
    }
  );

  src = src.replace(/^(\s*[-*]\s+\[[ xX]\]\s+.*)$/gm, (line) =>
    line.replace(/📅\s*(\d{4}-\d{2}-\d{2})/, '<span class="due">📅 $1</span>')
  );

  return marked.parse(src);
}

/* ---------- stats ---------- */

const today = new Date();
const TODAY = today.toISOString().slice(0, 10);
const daysAgo = (n) => new Date(today.getTime() - n * 864e5).toISOString().slice(0, 10);
const dayGap = (d) => Math.round((new Date(TODAY + "T00:00:00") - new Date(d + "T00:00:00")) / 864e5);

const allTasks = notes.flatMap((n) =>
  n.tasks.map((t) => ({ ...t, note: n.slug, noteTitle: n.title, source: n.source }))
);

// A weekly review's follow-up list is other documents' follow-ups, copied across —
// its skill template spells the entry out as "<verbatim, with the document it came
// from>". Counting those as work of their own double-counts every item a review
// mentions, and the duplicate pair lands next to each other on the dashboard. The
// review still shows its own list on its own page; it just stops inflating the total.
const RESTATES_FOLLOWUPS = new Set(["weekly-review"]);

const followups = allTasks.filter((t) => t.kind === "followup" && !RESTATES_FOLLOWUPS.has(t.source));
const checklists = allTasks.filter((t) => t.kind === "checklist");

// Shelf life: last verified more than STALE_DAYS ago, or never verified at all.
// A procedure that is wrong is more dangerous than one that does not exist, so this is a
// first-class dashboard metric.
const PROCEDURAL = ["install", "runbook", "troubleshoot"];
const freshness = notes
  .filter((n) => PROCEDURAL.includes(n.domain))
  .map((n) => ({
    slug: n.slug,
    title: n.title,
    domain: n.domain,
    verified: n.verified || null,
    verifiability: n.verifiability,
    ageDays: n.verified ? dayGap(n.verified) : null,
  }))
  .sort((a, b) => (b.ageDays ?? 1e6) - (a.ageDays ?? 1e6));

const stale = freshness.filter((f) => f.ageDays === null || f.ageDays > STALE_DAYS);

// Documents whose verification is bounded by something other than effort. A `field` document is not
// cleared by re-running the lab, and a `partial` one is verified with a named hole in it — neither
// fact survives being collapsed into a date, which is why they get their own axis.
const gaps = notes
  .filter((n) => n.verifiability !== "lab")
  .map((n) => ({
    slug: n.slug,
    title: n.title,
    domain: n.domain,
    verifiability: n.verifiability,
    note: n.verifiabilityNote,
    verified: n.verified || null,
  }))
  .sort((a, b) => (a.verifiability === b.verifiability ? 0 : a.verifiability === "field" ? -1 : 1));

const stats = {
  notes: notes.length,
  words: notes.reduce((a, n) => a + n.words, 0),
  commands: notes.reduce((a, n) => a + n.commands, 0),
  links: edges.length,
  tags: new Set(notes.flatMap((n) => n.tags)).size,
  stacks: new Set(notes.flatMap((n) => n.stack)).size,
  procedural: freshness.length,
  stale: stale.length,
  gaps: gaps.length,
  gapList: gaps,
  tasksOpen: followups.filter((t) => !t.done).length,
  tasksDone: followups.filter((t) => t.done).length,
  checklistItems: checklists.length,
  last7: notes.filter((n) => n.date >= daysAgo(7)).length,
  last30: notes.filter((n) => n.date >= daysAgo(30)).length,
  orphans: notes.filter((n) => !n.resolved.length && !backlinks.get(n.slug).length).length,
  missingLinks: [...missing].sort(),
  staleDays: STALE_DAYS,
  staleList: stale.slice(0, 8),
  byFolder: Object.fromEntries(VAULT_DIRS.map((d) => [d, notes.filter((n) => n.folder === d).length])),
  // Daily buckets for the 12-week writing heatmap
  activity: Array.from({ length: 84 }, (_, i) => {
    const day = daysAgo(83 - i);
    return { date: day, count: notes.filter((n) => n.date === day).length };
  }),
};

const count = (key) => {
  const acc = {};
  for (const n of notes) for (const v of n[key]) acc[v] = (acc[v] || 0) + 1;
  return Object.entries(acc)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, c]) => ({ name, count: c }));
};

/* ---------- write ---------- */

if (existsSync(DIST)) await rm(DIST, { recursive: true });
await mkdir(path.join(DIST, "data", "notes"), { recursive: true });
await cp(path.join(ROOT, "site"), DIST, { recursive: true });

// Image assets live in <folder>/img/ next to the documents that use them. The
// walker above only collects .md, so without this they never reach dist/ and
// every screenshot 404s on the published site.
for (const folder of VAULT_DIRS) {
  const src = path.join(ROOT, folder, "img");
  if (existsSync(src)) await cp(src, path.join(DIST, folder, "img"), { recursive: true });
}

const index = {
  generatedAt: new Date().toISOString(),
  config: {
    title: config.title,
    tagline: config.tagline,
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    site: config.site,
    folders: config.folders,
  },
  stats,
  tags: count("tags"),
  stacks: count("stack"),
  edges,
  tasks: followups
    .filter((t) => !t.done)
    .sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999")),
  notes: notes.map((n) => ({
    slug: n.slug,
    title: n.title,
    date: n.date,
    domain: n.domain,
    folder: n.folder,
    tags: n.tags,
    stack: n.stack,
    summary: n.summary,
    words: n.words,
    commands: n.commands,
    verified: n.verified,
    verifiability: n.verifiability,
    duration: n.duration,
    risk: n.risk,
    tasksOpen: n.tasks.filter((t) => !t.done && t.kind === "followup").length,
    linkCount: n.resolved.length + backlinks.get(n.slug).length,
    // Plain text for search — lowercased body with code blocks and markdown syntax stripped.
    // People often search for the tool rather than the prose, so stack/env are appended.
    search: (
      n.title + " " + n.summary + " " + n.tags.join(" ") + " " + n.stack.join(" ") + " " + n.env + " " + stripCode(n.body)
    )
      .replace(/[#*_>`\[\]()|-]/g, " ")
      .replace(/\s+/g, " ")
      .toLowerCase()
      .slice(0, 4000),
  })),
};

await writeFile(path.join(DIST, "data", "index.json"), JSON.stringify(index));

for (const n of notes) {
  await writeFile(
    path.join(DIST, "data", "notes", `${n.slug}.json`),
    JSON.stringify({
      slug: n.slug,
      title: n.title,
      date: n.date,
      domain: n.domain,
      folder: n.folder,
      path: n.path,
      tags: n.tags,
      stack: n.stack,
      summary: n.summary,
      source: n.source,
      env: n.env,
      verified: n.verified,
      verifiability: n.verifiability,
      verifiabilityNote: n.verifiabilityNote,
      duration: n.duration,
      risk: n.risk,
      words: n.words,
      commands: n.commands,
      html: renderBody(n),
      tasks: n.tasks,
      links: n.resolved.map((s) => ({ slug: s, title: bySlug.get(s).title })),
      backlinks: backlinks.get(n.slug).map((s) => ({ slug: s, title: bySlug.get(s).title })),
    })
  );
}

// 404 fallback for deep links (hash routing rarely needs it, but a bad path lands in the app)
await cp(path.join(DIST, "index.html"), path.join(DIST, "404.html"));
await writeFile(path.join(DIST, ".nojekyll"), "");

console.log(
  `built ${notes.length} docs · ${stats.commands} commands · ${edges.length} links · ${stats.stale} stale · ${stats.gaps} with verification gaps · ${index.stacks.length} stacks`
);
if (missing.size) console.log(`  unresolved wikilinks: ${[...missing].join(", ")}`);
