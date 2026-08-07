/* handson — static SPA. Reads only the data/*.json the build produced. No LLM is called at runtime. */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const TODAY = new Date().toISOString().slice(0, 10);
let DB = null;
const noteCache = new Map();

/* ---------- theme ---------- */

const applyTheme = (t) => {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
};
applyTheme(localStorage.getItem("handson-theme") || "auto");

$("#theme-toggle").addEventListener("click", () => {
  const cur = localStorage.getItem("handson-theme") || "auto";
  const next = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto";
  localStorage.setItem("handson-theme", next);
  applyTheme(next);
  if (location.hash.startsWith("#/graph")) render(); // canvas does not follow CSS variables, so redraw
});

/* ---------- helpers ---------- */

const domainClass = (d) => `d-${d}`;
const dayDiff = (d) => Math.round((new Date(d + "T00:00:00") - new Date(TODAY + "T00:00:00")) / 864e5);
const domainLabel = (d) => {
  const f = Object.values(DB.config.folders).find((f) => f.domain === d);
  return f ? f.label : d;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function dueClass(due) {
  if (!due) return "";
  const n = dayDiff(due);
  return n < 0 ? "overdue" : n <= 3 ? "soon" : "";
}
function dueLabel(due) {
  if (!due) return "";
  const n = dayDiff(due);
  if (n < 0) return `${due} · ${plural(-n, "day", "days")} overdue`;
  if (n === 0) return `${due} · today`;
  if (n <= 7) return `${due} · in ${plural(n, "day", "days")}`;
  return due;
}

// Shelf life of a procedure. A doc with no verification record is worse than an old one —
// at least the old one was true once.
function verifiedBadge(v) {
  const stale = DB.stats.staleDays;
  if (!v) return `<span class="verified none" title="Never recorded as verified">unverified</span>`;
  const age = -dayDiff(v);
  const cls = age > stale ? "stale" : "";
  const label = age <= 0 ? "verified today" : `verified ${plural(age, "day", "days")} ago`;
  return `<span class="verified ${cls}" title="Last verified ${v}">✓ ${label}</span>`;
}

const RISK_LABEL = { low: "low risk", medium: "medium risk", high: "high risk" };

const ghBase = () => `https://github.com/${DB.config.owner}/${DB.config.repo}`;
const issueUrl = (template, title) =>
  `${ghBase()}/issues/new?template=${encodeURIComponent(template)}&title=${encodeURIComponent(title)}`;

const PROCEDURAL = ["install", "runbook", "troubleshoot"];

function noteCard(n) {
  return `<a class="card" href="#/note/${encodeURIComponent(n.slug)}">
    <span class="card-top">
      <span class="domain ${domainClass(n.domain)}">${esc(domainLabel(n.domain))}</span>
      <span>${n.date}</span>
      ${n.risk ? `<span class="risk ${esc(n.risk)}">${RISK_LABEL[n.risk] || esc(n.risk)}</span>` : ""}
    </span>
    <h3>${esc(n.title)}</h3>
    ${n.summary ? `<p>${esc(n.summary)}</p>` : ""}
    <span class="card-foot">
      ${n.stack.slice(0, 4).map((t) => `<span class="pill stack">${esc(t)}</span>`).join("")}
      ${n.commands ? `<span class="pill">${n.commands} cmd</span>` : ""}
      ${PROCEDURAL.includes(n.domain) ? verifiedBadge(n.verified) : ""}
    </span>
  </a>`;
}

function taskRow(t) {
  return `<a class="task" href="#/note/${encodeURIComponent(t.note)}">
    <span class="box"></span>
    <span class="body">
      <span>${esc(t.text)}</span>
      <span class="meta">
        ${t.due ? `<span class="due ${dueClass(t.due)}">📅 ${dueLabel(t.due)}</span>` : `<span>no due date</span>`}
        <span>${esc(t.noteTitle)}</span>
      </span>
    </span>
  </a>`;
}

/* ---------- views ---------- */

function viewDashboard() {
  const s = DB.stats;
  const recent = DB.notes.slice(0, 6);
  const tasks = DB.tasks.slice(0, 5);
  const maxFolder = Math.max(1, ...Object.values(s.byFolder));
  const maxDay = Math.max(1, ...s.activity.map((a) => a.count));

  const folderBars = Object.entries(DB.config.folders)
    .map(([dir, meta]) => {
      const c = s.byFolder[dir] || 0;
      return `<a class="fold" href="#/notes?folder=${encodeURIComponent(dir)}">
        <span class="name"><i class="dot" style="background:var(--d-${meta.domain})"></i>${esc(meta.label)}</span>
        <span class="track"><span class="fill" style="width:${(c / maxFolder) * 100}%;background:var(--d-${meta.domain})"></span></span>
        <span class="cnt">${c}</span>
      </a>`;
    })
    .join("");

  const heat = s.activity
    .map((a) => {
      const lvl = a.count === 0 ? 0 : a.count >= maxDay * 0.66 ? 3 : a.count >= maxDay * 0.33 ? 2 : 1;
      return `<i data-c="${lvl}" title="${a.date} · ${plural(a.count, "doc", "docs")}"></i>`;
    })
    .join("");

  const staleRows = s.staleList
    .map(
      (f) => `<a class="fresh" href="#/note/${encodeURIComponent(f.slug)}">
        <span class="domain ${domainClass(f.domain)}">${esc(domainLabel(f.domain))}</span>
        <span class="t">${esc(f.title)}</span>
        <span class="age ${f.ageDays === null ? "verified none" : "verified stale"}">${
          f.ageDays === null ? "unverified" : `${f.ageDays}d ago`
        }</span>
      </a>`
    )
    .join("");

  const topStacks = DB.stacks.slice(0, 14);

  return `
  <div class="page-head">
    <h1>Dashboard</h1>
    <p>${esc(DB.config.tagline)}</p>
  </div>

  <div class="stats">
    <div class="stat accent"><div class="n">${s.notes}</div><div class="l">docs</div><div class="sub">${s.words.toLocaleString()} words</div></div>
    <div class="stat"><div class="n">${s.commands}</div><div class="l">commands recorded</div><div class="sub">lines you can actually run</div></div>
    <div class="stat ${s.stale ? "alert" : ""}"><div class="n">${s.stale}</div><div class="l">need re-verification</div><div class="sub">of ${s.procedural} procedures</div></div>
    <div class="stat"><div class="n">${s.tasksOpen}</div><div class="l">open follow-ups</div><div class="sub">${s.checklistItems} checklist items counted apart</div></div>
    <div class="stat"><div class="n">${s.stacks}</div><div class="l">stacks covered</div><div class="sub">${s.tags} tags</div></div>
  </div>

  <div class="two-col" style="margin-top:12px">
    <div class="panel">
      <div class="section-head" style="margin:0 0 12px"><h2>Procedures to re-verify</h2><span class="hint">older than ${s.staleDays} days</span></div>
      ${
        staleRows
          ? `<div class="freshlist">${staleRows}</div>
             <p class="capture-note">A procedure that is wrong is more dangerous than one that does not exist. Put the day you last ran it in <code>verified</code>.</p>`
          : `<p class="empty-state" style="padding:24px">Every procedure has been verified within the last ${s.staleDays} days.</p>`
      }
    </div>
    <div class="panel">
      <div class="section-head" style="margin:0 0 12px"><h2>Categories</h2></div>
      <div class="folders">${folderBars}</div>
      <div class="section-head" style="margin:20px 0 10px"><h2>Follow-ups</h2><span class="spacer"></span><a class="more" href="#/tasks">All</a></div>
      ${tasks.length ? `<div class="tasklist">${tasks.map(taskRow).join("")}</div>` : `<p class="empty" style="color:var(--ink-3);font-size:12.5px;margin:0">No open follow-ups.</p>`}
    </div>
  </div>

  <div class="section-head"><h2>Writing rhythm</h2><span class="hint">last 12 weeks</span></div>
  <div class="panel">
    <div class="heat">${heat}</div>
    <div class="heat-legend">less <i data-c="0"></i><i data-c="1"></i><i data-c="2"></i><i data-c="3"></i> more</div>
  </div>

  ${
    topStacks.length
      ? `<div class="section-head"><h2>Stacks</h2><span class="spacer"></span><a class="more" href="#/stacks">All ${DB.stacks.length}</a></div>
         <div class="tagcloud">${topStacks
           .map(
             (t) =>
               `<a href="#/notes?stack=${encodeURIComponent(t.name)}"><b class="mono">${esc(t.name)}</b><small>${t.count}</small></a>`
           )
           .join("")}</div>`
      : ""
  }

  <div class="section-head"><h2>Recent docs</h2><span class="spacer"></span><a class="more" href="#/notes">All ${s.notes}</a></div>
  ${recent.length ? `<div class="cards">${recent.map(noteCard).join("")}</div>` : emptyVault()}
  `;
}

function emptyVault() {
  return `<div class="empty-state">
    No docs yet. Hit <strong>Capture</strong> and throw in your first field note.
  </div>`;
}

function viewNotes(params) {
  const folder = params.get("folder");
  const tag = params.get("tag");
  const stack = params.get("stack");
  const q = (params.get("q") || "").toLowerCase();

  let list = DB.notes;
  if (folder) list = list.filter((n) => n.folder === folder);
  if (tag) list = list.filter((n) => n.tags.includes(tag));
  if (stack) list = list.filter((n) => n.stack.includes(stack));
  if (q) list = list.filter((n) => n.search.includes(q));

  const chips = Object.entries(DB.config.folders)
    .map(
      ([dir, meta]) =>
        `<button class="chip" data-folder="${esc(dir)}" aria-pressed="${folder === dir}">${esc(meta.label)} <span style="opacity:.6">${DB.stats.byFolder[dir] || 0}</span></button>`
    )
    .join("");

  const active = folder || tag || stack || q;

  return `
  <div class="page-head">
    <h1>Docs</h1>
    <p>Showing ${list.length} ${active ? `· <a href="#/notes" style="color:var(--accent)">clear filters</a>` : `of ${DB.notes.length}`}</p>
  </div>
  <div class="filters">
    <button class="chip" data-folder="" aria-pressed="${!folder}">All</button>
    ${chips}
    <input id="notes-q" type="search" placeholder="Search within this list…" value="${esc(params.get("q") || "")}">
  </div>
  ${stack ? `<div class="filters"><span class="pill stack">${esc(stack)}</span></div>` : ""}
  ${tag ? `<div class="filters"><span class="pill">#${esc(tag)}</span></div>` : ""}
  ${list.length ? `<div class="cards">${list.map(noteCard).join("")}</div>` : `<div class="empty-state">No docs match these filters.</div>`}
  `;
}

function viewTasks() {
  const open = DB.tasks;
  const overdue = open.filter((t) => t.due && dayDiff(t.due) < 0);
  const soon = open.filter((t) => t.due && dayDiff(t.due) >= 0 && dayDiff(t.due) <= 7);
  const later = open.filter((t) => t.due && dayDiff(t.due) > 7);
  const undated = open.filter((t) => !t.due);

  const group = (title, hint, items) =>
    items.length
      ? `<div class="section-head"><h2>${title}</h2><span class="hint">${items.length} ${hint}</span></div>
         <div class="tasklist">${items.map(taskRow).join("")}</div>`
      : "";

  return `
  <div class="page-head">
    <h1>Follow-ups</h1>
    <p>Collected from <code>- [ ] … 📅 YYYY-MM-DD</code> lines under a follow-up heading. Checking one off means editing the doc.</p>
  </div>
  ${open.length ? "" : `<div class="empty-state">No open follow-ups.</div>`}
  ${group("Overdue", "· look again", overdue)}
  ${group("Within 7 days", "", soon)}
  ${group("Later", "", later)}
  ${group("No due date", "· never got a date", undated)}
  `;
}

function viewStacks() {
  const maxS = Math.max(1, ...DB.stacks.map((t) => t.count));
  const maxT = Math.max(1, ...DB.tags.map((t) => t.count));
  return `
  <div class="page-head"><h1>Stacks</h1><p>${DB.stacks.length} tools this repository has actually touched. Click one to filter.</p></div>
  ${
    DB.stacks.length
      ? `<div class="tagcloud">
    ${DB.stacks
      .map(
        (t) =>
          `<a href="#/notes?stack=${encodeURIComponent(t.name)}" style="font-size:${13 + (t.count / maxS) * 5}px">
            <b class="mono">${esc(t.name)}</b><small>${t.count}</small></a>`
      )
      .join("")}
  </div>`
      : `<div class="empty-state">No doc declares a <code>stack:</code> yet.</div>`
  }

  <div class="section-head"><h2>Tags</h2><span class="hint">${DB.tags.length} · topic axis</span></div>
  <div class="tagcloud">
    ${DB.tags
      .map(
        (t) =>
          `<a href="#/notes?tag=${encodeURIComponent(t.name)}" style="font-size:${13 + (t.count / maxT) * 4}px">
            <b>#${esc(t.name)}</b><small>${t.count}</small></a>`
      )
      .join("")}
  </div>
  ${
    DB.stats.missingLinks.length
      ? `<div class="section-head"><h2>Docs that do not exist yet</h2><span class="hint">linked to, but no file — the writing queue</span></div>
         <div class="tagcloud">${DB.stats.missingLinks.map((m) => `<span class="pill">${esc(m)}</span>`).join("")}</div>`
      : ""
  }
  `;
}

function viewGraph() {
  return `
  <div class="page-head"><h1>Graph</h1><p>${DB.notes.length} docs · ${DB.edges.length} links. Drag to move, wheel to zoom, click a node to open.</p></div>
  <div class="graph-wrap">
    <canvas id="graph"></canvas>
    <div class="graph-hint">Unlinked docs are grey</div>
    <div class="graph-legend">
      ${Object.values(DB.config.folders)
        .map((m) => `<span><i style="background:var(--d-${m.domain})"></i>${esc(m.label)}</span>`)
        .join("")}
    </div>
  </div>`;
}

async function viewNote(slug) {
  let n = noteCache.get(slug);
  if (!n) {
    const res = await fetch(`data/notes/${encodeURIComponent(slug)}.json`, { cache: "no-cache" });
    if (!res.ok) return `<div class="empty-state">Doc not found: ${esc(slug)}</div>`;
    n = await res.json();
    noteCache.set(slug, n);
  }
  const editUrl = `${ghBase()}/edit/${DB.config.branch}/${n.path}`;
  const histUrl = `${ghBase()}/commits/${DB.config.branch}/${n.path}`;

  const linkList = (items, empty) =>
    items.length
      ? `<ul>${items.map((l) => `<li><a href="#/note/${encodeURIComponent(l.slug)}">${esc(l.title)}</a></li>`).join("")}</ul>`
      : `<p class="empty">${empty}</p>`;

  const envCells = [
    n.env && { k: "Verified on", v: n.env },
    n.verified && { k: "Last verified", v: n.verified },
    n.duration && { k: "Takes about", v: n.duration },
    n.risk && { k: "Risk", v: RISK_LABEL[n.risk] || n.risk },
  ].filter(Boolean);

  return `
  <a class="back-link" href="#/notes">← All docs</a>
  <div class="reader">
    <article>
      <header class="note-head">
        <span class="domain ${domainClass(n.domain)}">${esc(domainLabel(n.domain))}</span>
        <h1>${esc(n.title)}</h1>
        ${n.summary ? `<p class="note-sum">${esc(n.summary)}</p>` : ""}
        <div class="note-meta">
          <span class="pill">written ${n.date}</span>
          ${PROCEDURAL.includes(n.domain) ? verifiedBadge(n.verified) : ""}
          ${n.commands ? `<span class="pill">${plural(n.commands, "command", "commands")}</span>` : ""}
          ${n.stack.map((t) => `<a class="pill stack" href="#/notes?stack=${encodeURIComponent(t)}">${esc(t)}</a>`).join("")}
          ${n.tags.map((t) => `<a class="pill tag" href="#/notes?tag=${encodeURIComponent(t)}">#${esc(t)}</a>`).join("")}
        </div>
        ${
          envCells.length
            ? `<dl class="envbox">${envCells
                .map((c) => `<div><dt>${esc(c.k)}</dt><dd>${esc(c.v)}</dd></div>`)
                .join("")}</dl>`
            : ""
        }
      </header>
      <div class="prose">${n.html}</div>
    </article>
    <aside class="aside">
      <div id="toc-wrap" hidden>
        <h4>Contents</h4>
        <ul class="toc" id="toc"></ul>
      </div>
      <div>
        <h4>Backlinks ${n.backlinks.length}</h4>
        ${linkList(n.backlinks, "Nothing points here yet.")}
      </div>
      <div>
        <h4>Outgoing ${n.links.length}</h4>
        ${linkList(n.links, "This doc links nowhere.")}
      </div>
      <div>
        <h4>Source</h4>
        <ul>
          <li><a href="${esc(editUrl)}" target="_blank" rel="noopener">Edit on GitHub ↗</a></li>
          <li><a href="${esc(histUrl)}" target="_blank" rel="noopener">History ↗</a></li>
        </ul>
        <p class="empty" style="margin-top:8px"><code>${esc(n.path)}</code></p>
      </div>
    </aside>
  </div>`;
}

// Procedures get long, and a wall of steps without a map is unusable. Heading ids come from the build.
function buildToc() {
  const wrap = $("#toc-wrap");
  const toc = $("#toc");
  if (!wrap || !toc) return;
  const heads = $$(".prose h2, .prose h3").filter((h) => h.id);
  if (heads.length >= 3) {
    toc.innerHTML = heads
      .map((h) => `<li class="${h.tagName.toLowerCase()}"><a href="#${h.id}">${esc(h.textContent)}</a></li>`)
      .join("");
    wrap.hidden = false;
  }
}

const TOPBAR_OFFSET = 72;

// Keep the hash router from mistaking an in-document anchor (#c-exit-code-137) for a route.
// Route links (#/...) and external links pass through. Delegated, so it is attached once.
$("#main").addEventListener("click", (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || a.getAttribute("href").startsWith("#/")) return;
  const target = document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));
  if (!target) return;
  e.preventDefault();
  // Scroll explicitly rather than via scrollIntoView: smooth scrolling is a no-op in some
  // Chrome builds when triggered from a click handler, which left these links dead, and the
  // sticky topbar would hide the heading anyway. TOPBAR_OFFSET keeps the target visible.
  const top = window.scrollY + target.getBoundingClientRect().top - TOPBAR_OFFSET;
  window.scrollTo(0, Math.max(0, top));
});

/* ---------- router ---------- */

async function render() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [rawPath, rawQuery] = hash.split("?");
  const parts = rawPath.split("/").filter(Boolean);
  const params = new URLSearchParams(rawQuery || "");
  const main = $("#main");

  let view = "dashboard";
  let html;

  if (parts[0] === "note" && parts[1]) {
    view = "notes";
    html = await viewNote(decodeURIComponent(parts[1]));
  } else if (parts[0] === "notes") {
    view = "notes";
    html = viewNotes(params);
  } else if (parts[0] === "graph") {
    view = "graph";
    html = viewGraph();
  } else if (parts[0] === "tasks") {
    view = "tasks";
    html = viewTasks();
  } else if (parts[0] === "stacks" || parts[0] === "tags") {
    view = "stacks";
    html = viewStacks();
  } else {
    html = viewDashboard();
  }

  main.innerHTML = html;
  $$("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.view === view));
  window.scrollTo(0, 0);

  if (view === "graph") initGraph();
  if (parts[0] === "note") buildToc();

  $$(".chip[data-folder]").forEach((b) =>
    b.addEventListener("click", () => {
      location.hash = b.dataset.folder ? `#/notes?folder=${encodeURIComponent(b.dataset.folder)}` : "#/notes";
    })
  );
  const qi = $("#notes-q");
  if (qi) {
    let t;
    qi.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const p = new URLSearchParams(rawQuery || "");
        qi.value ? p.set("q", qi.value) : p.delete("q");
        const s = p.toString();
        history.replaceState(null, "", `#/notes${s ? "?" + s : ""}`);
        render().then(() => {
          const el = $("#notes-q");
          if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
        });
      }, 180);
    });
  }
}

/* ---------- graph ---------- */

let graphRaf = null;

function initGraph() {
  const canvas = $("#graph");
  if (!canvas) return;
  cancelAnimationFrame(graphRaf);

  const css = getComputedStyle(document.documentElement);
  const colorOf = (d) => css.getPropertyValue(`--d-${d}`).trim() || css.getPropertyValue("--ink-3").trim();
  const lineColor = css.getPropertyValue("--line-strong").trim();
  const inkColor = css.getPropertyValue("--ink-2").trim();
  const orphanColor = css.getPropertyValue("--ink-3").trim();

  const degree = new Map(DB.notes.map((n) => [n.slug, 0]));
  for (const e of DB.edges) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }

  // Deterministic initial layout — index-based ring instead of random, so the graph
  // does not jump around on every refresh.
  const nodes = DB.notes.map((n, i) => {
    const a = (i / Math.max(1, DB.notes.length)) * Math.PI * 2;
    const r = 120 + ((i * 37) % 90);
    return {
      slug: n.slug, title: n.title, domain: n.domain,
      deg: degree.get(n.slug) || 0,
      x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0,
    };
  });
  const idx = new Map(nodes.map((n, i) => [n.slug, i]));
  const links = DB.edges
    .map((e) => ({ s: idx.get(e.from), t: idx.get(e.to) }))
    .filter((l) => l.s !== undefined && l.t !== undefined);

  let dpr, W, H;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  const view = { x: W / 2, y: H / 2, k: 1 };
  let hover = null, dragNode = null, panning = false, last = null, alpha = 1;

  const radius = (n) => 4.5 + Math.min(9, n.deg * 1.5);

  function step() {
    // Repulsion (O(n²) — fine at the size of one engineer's repository)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = (i - j) * 0.1 || 0.1; dy = 0.1; d2 = 1; }
        if (d2 > 90000) continue;
        const f = 900 / d2;
        const d = Math.sqrt(d2);
        a.vx -= (dx / d) * f; a.vy -= (dy / d) * f;
        b.vx += (dx / d) * f; b.vy += (dy / d) * f;
      }
    }
    // Link attraction
    for (const l of links) {
      const a = nodes[l.s], b = nodes[l.t];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - 90) * 0.012;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
    }
    // Pull to center + damping
    for (const n of nodes) {
      if (n === dragNode) { n.vx = n.vy = 0; continue; }
      n.vx -= n.x * 0.004; n.vy -= n.y * 0.004;
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += n.vx * alpha; n.y += n.vy * alpha;
    }
    alpha = Math.max(0.06, alpha * 0.994);
  }

  function draw() {
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);

    ctx.lineWidth = 1 / view.k;
    for (const l of links) {
      const a = nodes[l.s], b = nodes[l.t];
      const hot = hover && (hover === a || hover === b);
      ctx.strokeStyle = hot ? colorOf(hover.domain) : lineColor;
      ctx.globalAlpha = hot ? 0.9 : 0.42;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const n of nodes) {
      const r = radius(n);
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = n.deg === 0 ? orphanColor : colorOf(n.domain);
      ctx.globalAlpha = n.deg === 0 ? 0.45 : 1;
      ctx.fill();
      if (hover === n) {
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2 / view.k;
        ctx.strokeStyle = colorOf(n.domain);
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 4 / view.k, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      if (view.k > 0.75 && (n.deg >= 2 || hover === n)) {
        ctx.fillStyle = hover === n ? colorOf(n.domain) : inkColor;
        ctx.font = `${11 / view.k}px ${css.getPropertyValue("--font")}`;
        ctx.textAlign = "center";
        const label = n.title.length > 22 ? n.title.slice(0, 21) + "…" : n.title;
        ctx.fillText(label, n.x, n.y + r + 12 / view.k);
      }
    }
    ctx.restore();
  }

  const toWorld = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left - view.x) / view.k,
      y: (ev.clientY - rect.top - view.y) / view.k,
    };
  };
  const pick = (p) => nodes.find((n) => Math.hypot(n.x - p.x, n.y - p.y) < radius(n) + 6);

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = toWorld(e);
    dragNode = pick(p);
    panning = !dragNode;
    last = { x: e.clientX, y: e.clientY };
    alpha = Math.max(alpha, 0.7);
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = toWorld(e);
    if (dragNode) { dragNode.x = p.x; dragNode.y = p.y; alpha = Math.max(alpha, 0.5); }
    else if (panning && last) {
      view.x += e.clientX - last.x;
      view.y += e.clientY - last.y;
      last = { x: e.clientX, y: e.clientY };
    } else {
      const h = pick(p);
      if (h !== hover) { hover = h; canvas.style.cursor = h ? "pointer" : "grab"; }
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    if (dragNode && last && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 4) {
      location.hash = `#/note/${encodeURIComponent(dragNode.slug)}`;
    }
    dragNode = null; panning = false; last = null;
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const k = Math.min(3, Math.max(0.25, view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
      view.x = mx - ((mx - view.x) / view.k) * k;
      view.y = my - ((my - view.y) / view.k) * k;
      view.k = k;
    },
    { passive: false }
  );

  (function loop() {
    step();
    draw();
    graphRaf = requestAnimationFrame(loop);
  })();

  // Stop the simulation once the view is gone
  const stop = () => {
    if (!document.getElementById("graph")) {
      cancelAnimationFrame(graphRaf);
      ro.disconnect();
      window.removeEventListener("hashchange", stop);
    }
  };
  window.addEventListener("hashchange", stop);
}

/* ---------- search palette ---------- */

const palette = $("#palette");
const pInput = $("#palette-input");
const pResults = $("#palette-results");
let pSel = 0, pHits = [];

function openPalette() {
  palette.hidden = false;
  pInput.value = "";
  runSearch("");
  pInput.focus();
}
const closePalette = () => (palette.hidden = true);

function highlight(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
}

function runSearch(raw) {
  const q = raw.trim().toLowerCase();
  if (!q) {
    pHits = DB.notes.slice(0, 8);
  } else {
    pHits = DB.notes
      .map((n) => {
        const title = n.title.toLowerCase();
        let score = 0;
        if (title === q) score = 100;
        else if (title.startsWith(q)) score = 60;
        else if (title.includes(q)) score = 40;
        else if (n.stack.some((t) => t.toLowerCase() === q)) score = 38;
        else if (n.stack.some((t) => t.toLowerCase().includes(q))) score = 32;
        else if (n.tags.some((t) => t.toLowerCase().includes(q))) score = 30;
        else if (n.summary.toLowerCase().includes(q)) score = 20;
        else if (n.search.includes(q)) score = 10;
        return { n, score };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || (a.n.date < b.n.date ? 1 : -1))
      .slice(0, 12)
      .map((h) => h.n);
  }
  pSel = 0;
  pResults.innerHTML = pHits.length
    ? pHits
        .map(
          (n, i) => `<li class="${i === 0 ? "sel" : ""}"><a href="#/note/${encodeURIComponent(n.slug)}">
        <span class="t"><span class="domain ${domainClass(n.domain)}">${esc(domainLabel(n.domain))}</span>${highlight(n.title, q)}</span>
        ${n.summary ? `<span class="s">${highlight(n.summary, q)}</span>` : ""}
      </a></li>`
        )
        .join("")
    : `<li class="palette-empty">Nothing matches "${esc(raw)}".</li>`;
}

function moveSel(d) {
  const items = $$("#palette-results li");
  if (!pHits.length) return;
  items[pSel]?.classList.remove("sel");
  pSel = (pSel + d + pHits.length) % pHits.length;
  items[pSel]?.classList.add("sel");
  items[pSel]?.scrollIntoView({ block: "nearest" });
}

pInput.addEventListener("input", () => runSearch(pInput.value));
pInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); moveSel(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveSel(-1); }
  else if (e.key === "Enter" && pHits[pSel]) {
    e.preventDefault();
    location.hash = `#/note/${encodeURIComponent(pHits[pSel].slug)}`;
    closePalette();
  }
});
pResults.addEventListener("click", (e) => { if (e.target.closest("a")) closePalette(); });

$("#search-open").addEventListener("click", openPalette);

/* ---------- capture sheet ---------- */

const capture = $("#capture");

const REQUESTS = [
  { ico: "🛠", t: "Capture field notes", d: "Throw in the install, task, or incident you just finished — it gets sorted into the right category.", tpl: "handson.yml", title: "Field notes" },
  { ico: "📅", t: "Topic of the day", d: "The same job that runs on days with no notes — picks one current DevOps topic and builds a hands-on lab.", tpl: "daily-topic.yml", title: "Topic of the day" },
  { ico: "🔁", t: "Weekly review", d: "Reads the last 7 days across docs and names the repeats and the missing procedures.", tpl: "weekly-review.yml", title: "Weekly review" },
  { ico: "📐", t: "Standardize", d: "When the same work is scattered across docs, promotes it into one standard runbook.", tpl: "standardize.yml", title: "Standardize a procedure" },
];

function openCapture() {
  $("#capture-grid").innerHTML = REQUESTS.map(
    (r) => `<a href="${issueUrl(r.tpl, r.title)}" target="_blank" rel="noopener">
      <span class="ico">${r.ico}</span>
      <span><b>${r.t}</b><small>${r.d}</small></span>
    </a>`
  ).join("");
  capture.hidden = false;
}

$("#capture-btn").addEventListener("click", openCapture);

$$("[data-close]").forEach((el) =>
  el.addEventListener("click", () => { closePalette(); capture.hidden = true; })
);

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
  else if (e.key === "/" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { e.preventDefault(); openPalette(); }
  else if (e.key === "Escape") { closePalette(); capture.hidden = true; }
});

/* ---------- boot ---------- */

(async function boot() {
  try {
    // no-cache = conditional GET. Keeps a doc the agent just committed from staying invisible
    // for minutes behind the Pages cache (304 when unchanged, so it costs almost nothing).
    DB = await (await fetch("data/index.json", { cache: "no-cache" })).json();
  } catch {
    $("#main").innerHTML = `<div class="empty-state">
      Could not load the data. Run <code>node scripts/build.mjs</code> to produce <code>dist/</code> and serve that folder.
    </div>`;
    return;
  }

  document.title = DB.config.title;
  $("#brand-title").textContent = DB.config.title;
  $("#brand-tagline").textContent = DB.config.tagline;
  $("#repo-link").href = ghBase();
  $("#build-stamp").textContent = `built ${DB.generatedAt.slice(0, 16).replace("T", " ")} UTC`;

  window.addEventListener("hashchange", render);
  await render();
})();
