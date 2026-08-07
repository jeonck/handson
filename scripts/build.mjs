#!/usr/bin/env node
// vault(.md) -> dist/ 정적 사이트.
// 입력은 숫자 폴더의 마크다운, 출력은 data/index.json + data/notes/<slug>.json + 복사된 site/.
//
// secbrain의 발행 파이프라인을 핸즈온 문서용으로 확장했습니다.
// 추가된 축: stack(도구), env(검증 환경), verified(마지막 검증일), duration, risk.
// 핸즈온 문서는 "쓴 날"보다 "마지막으로 실제로 돌려 본 날"이 중요하므로 verified를 1급 필드로 다룹니다.

import { readFile, writeFile, mkdir, readdir, rm, cp, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const config = JSON.parse(await readFile(path.join(ROOT, "site.config.json"), "utf8"));
const VAULT_DIRS = Object.keys(config.folders);
const STALE_DAYS = config.staleDays || 120;

/* ---------- frontmatter ---------- */

// 노트 프론트매터에 필요한 만큼의 YAML 부분집합: 스칼라, 인라인 배열, 블록 배열.
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

// 코드 블록/인라인 코드를 제외한 본문. 링크·태그가 셸 예시에서 잡히는 것을 막는다.
// 핸즈온 문서는 코드 블록 비중이 크므로 이 필터가 특히 중요하다 (#!/bin/bash, --tag= 등).
function stripCode(body) {
  return stripFences(body).replace(/`[^`\n]*`/g, "");
}

// 펜스 블록만 제거. 태스크 텍스트는 인라인 코드(`admin` 계정)를 잃으면 뜻이 달라지므로
// 여기까지만 걷어 내고 백틱은 표시 직전에 없앱니다.
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

// Obsidian Tasks 형식: - [ ] 내용 📅 YYYY-MM-DD
//
// 핸즈온 문서에는 체크박스가 두 종류 섞여 있습니다.
//  - 검증 체크리스트: 절차를 실행할 때마다 새로 확인하는 것. 저장소 차원의 할 일이 아님.
//  - 후속 조치: 이 문서를 쓴 뒤에 남은 진짜 할 일.
// 직전 헤딩으로 둘을 가릅니다. 섞어서 세면 "열린 태스크" 숫자가 의미를 잃습니다.
const FOLLOWUP_HEADING = /후속\s*조치|follow[- ]?up|todo/i;

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
      text: text.replace(/📅\s*\d{4}-\d{2}-\d{2}/, "").replace(/`/g, "").trim(),
      due: due ? due[1] : null,
      kind: followup ? "followup" : "checklist",
    });
  }
  return tasks;
}

// 절차서에서 실행 가능한 명령이 몇 개인지. "읽는 문서"와 "따라 하는 문서"를 구분하는 신호.
function countCommands(body) {
  let n = 0;
  for (const block of body.matchAll(/```(\w*)\r?\n([\s\S]*?)```/g)) {
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

    // 프론트매터 없는 파일은 건너뛴다 — CLAUDE.md의 규약.
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

// wikilink는 확장자 없는 파일명(base)을 가리킨다. base -> slug 로 해석하고,
// 해석되지 않는 링크는 "아직 없는 문서"로 남겨 둔다 (다음에 쓸 거리).
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

// 절차 문서는 본문 안에서 "→ C절 참조" 식으로 서로를 가리킵니다.
// marked v15는 헤딩 id를 자동으로 붙이지 않으므로 GitHub와 같은 규칙으로 직접 만듭니다.
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

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens);
      return `<h${depth} id="${headingSlug(text)}">${text}</h${depth}>\n`;
    },
  },
});

function renderBody(note) {
  slugCounts.clear(); // 문서마다 id 네임스페이스를 새로 시작한다
  // wikilink를 마크다운 링크로 치환한 뒤 마크다운을 렌더한다.
  let src = note.body.replace(
    /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g,
    (_all, target, _anchor, alias) => {
      const name = target.trim();
      const label = (alias || name).trim();
      const slug = byBase.get(name) ?? byBase.get(path.basename(name));
      return slug
        ? `[${label}](#/note/${encodeURIComponent(slug)})`
        : `<span class="wikilink-missing" title="아직 없는 문서">${escapeHtml(label)}</span>`;
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

const allTasks = notes.flatMap((n) => n.tasks.map((t) => ({ ...t, note: n.slug, noteTitle: n.title })));
const followups = allTasks.filter((t) => t.kind === "followup");
const checklists = allTasks.filter((t) => t.kind === "checklist");

// 핸즈온 문서의 수명: 마지막 검증일이 STALE_DAYS를 넘겼거나 아예 없는 것.
// 절차서는 틀린 채로 남아 있는 것이 없는 것보다 위험하므로 대시보드 1급 지표로 올린다.
const PROCEDURAL = ["install", "runbook", "troubleshoot"];
const freshness = notes
  .filter((n) => PROCEDURAL.includes(n.domain))
  .map((n) => ({
    slug: n.slug,
    title: n.title,
    domain: n.domain,
    verified: n.verified || null,
    ageDays: n.verified ? dayGap(n.verified) : null,
  }))
  .sort((a, b) => (b.ageDays ?? 1e6) - (a.ageDays ?? 1e6));

const stale = freshness.filter((f) => f.ageDays === null || f.ageDays > STALE_DAYS);

const stats = {
  notes: notes.length,
  words: notes.reduce((a, n) => a + n.words, 0),
  commands: notes.reduce((a, n) => a + n.commands, 0),
  links: edges.length,
  tags: new Set(notes.flatMap((n) => n.tags)).size,
  stacks: new Set(notes.flatMap((n) => n.stack)).size,
  procedural: freshness.length,
  stale: stale.length,
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
  // 최근 12주 작성 히트맵용 일간 버킷
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
    duration: n.duration,
    risk: n.risk,
    tasksOpen: n.tasks.filter((t) => !t.done && t.kind === "followup").length,
    linkCount: n.resolved.length + backlinks.get(n.slug).length,
    // 검색용 평문 — 코드 블록과 마크다운 기호를 걷어낸 소문자 본문.
    // 명령 자체를 검색하고 싶은 경우가 많아 stack/env는 따로 이어 붙인다.
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

// SPA 딥링크 404 폴백 (해시 라우팅이라 보통 필요 없지만, 잘못된 경로도 앱으로 흡수)
await cp(path.join(DIST, "index.html"), path.join(DIST, "404.html"));
await writeFile(path.join(DIST, ".nojekyll"), "");

console.log(
  `built ${notes.length} docs · ${stats.commands} commands · ${edges.length} links · ${stats.stale} stale · ${index.stacks.length} stacks`
);
if (missing.size) console.log(`  unresolved wikilinks: ${[...missing].join(", ")}`);
