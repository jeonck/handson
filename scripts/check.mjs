// Quality gate for the document set.
//
// CLAUDE.md states the rules; until now nothing enforced them, and the difference showed.
// A `verified` date was wrong by four days across six documents before a reader noticed,
// and the repository's own measurements say follow-ups are added about five times faster
// than they are closed. Prose does not run; this does.
//
// Two kinds of check:
//   errors  — conditions with zero violations today. Any new one fails the build.
//   ratchet — conditions with existing violations. The count may fall and must not rise.
//
// The ratchet baseline lives in scripts/quality-baseline.json and is the only file to edit
// when a number legitimately changes. Lowering it is the point; raising it needs a reason.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

const DRIFT_DAYS = 2;

// Every commit date that touched each path. `verified` has to line up with one of them:
// a date that matches no commit is a date nobody worked on.
export async function gitTouchDates(root) {
  const dates = new Map();
  try {
    const { stdout } = await exec(
      "git",
      ["log", "--format=%ad", "--date=short", "--name-only"],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 }
    );
    let current = null;
    for (const line of stdout.split("\n")) {
      if (/^\d{4}-\d\d-\d\d$/.test(line)) current = line;
      else if (line.trim() && current && /^0\d-[^/]+\/.+\.md$/.test(line)) {
        if (!dates.has(line)) dates.set(line, new Set());
        dates.get(line).add(current);
      }
    }
  } catch {
    return null; // shallow clone or no git — the drift check reports itself skipped
  }
  return dates.size ? dates : null;
}

const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
const hasHeading = (body, re) => new RegExp(`^#{2,}\\s.*${re}`, "im").test(body);

export function check(notes, { today, touchDates, baseline }) {
  const errors = [];
  const counts = { noCheck: 0, noRollback: 0, noBitUs: 0, openFollowups: 0, driftSkipped: 0 };

  for (const n of notes) {
    const at = `${n.path}`;

    if (n.verified && n.verified > today)
      errors.push(`${at}: verified ${n.verified} is in the future (today ${today})`);

    // build.mjs coerces an unknown value to "lab"; the raw field is what the author wrote.
    if (n.rawVerifiability && !["lab", "partial", "field"].includes(n.rawVerifiability.toLowerCase()))
      errors.push(`${at}: verifiability "${n.rawVerifiability}" is not lab | partial | field`);

    if (n.verifiability !== "lab" && !n.verifiabilityNote.trim())
      errors.push(`${at}: verifiability "${n.verifiability}" requires a verifiability-note`);

    if (n.verified && touchDates) {
      const seen = touchDates.get(n.path);
      if (!seen) counts.driftSkipped++;
      else if (![...seen].some((d) => days(d, n.verified) <= DRIFT_DAYS))
        errors.push(
          `${at}: verified ${n.verified} matches no commit that touched it ` +
            `(nearest: ${[...seen].sort((a, b) => days(a, n.verified) - days(b, n.verified))[0]})`
        );
    }

    if (n.domain === "install" || n.domain === "runbook") {
      if (!/^- \[x\]/m.test(n.body)) counts.noCheck++;
      if (!hasHeading(n.body, "rollback|abort")) counts.noRollback++;
      if (!hasHeading(n.body, "bit us|where this")) counts.noBitUs++;
    }

    counts.openFollowups += n.tasks.filter((t) => t.kind === "followup" && !t.done).length;
  }

  const ratchet = [];
  for (const [key, label] of [
    ["noCheck", "install/runbook docs with no verification checklist"],
    ["noRollback", "install/runbook docs with no rollback section"],
    ["noBitUs", "install/runbook docs with no 'where this bit us' section"],
    ["openFollowups", "open follow-ups"],
  ]) {
    const limit = baseline[key];
    if (limit === undefined) continue;
    if (counts[key] > limit)
      errors.push(`ratchet: ${label} rose to ${counts[key]} (baseline ${limit})`);
    else ratchet.push({ key, label, now: counts[key], limit });
  }

  return { errors, counts, ratchet };
}
