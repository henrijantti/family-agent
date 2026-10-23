import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, sep } from "node:path";
import { promisify } from "node:util";
import { localParts } from "../lib/time.js";
import { Tool, ToolError } from "./mcp.js";

// Tools over Henri's Brain vault (henrijantti/Brain, rules in its AGENTS.md).
// The vault's own rules are enforced here, in code, not in a prompt:
// - capture writes ONLY new files in inbox/ and pushes them to main
// - everything else the agent wants to file goes to an ingest/* branch that
//   Henri reviews and merges himself (AGENTS.md "Supervised writes")
// - raw/ is immutable, AGENTS.md/CLAUDE.md/templates are human-only
// - excluded folders (health/ by default) are neither read nor written
// git runs through execFile with fixed arguments: no shell, no agent-chosen flags.

const run = promisify(execFile);

export interface BrainDeps {
  /** Local clone of the vault, on main. */
  root: string;
  /** Top-level folders the agent may not read or write. */
  exclude: string[];
  /** https URL of the GitHub repo, for review links. */
  repoUrl: string;
  now(): Date;
  /** false = write and commit locally but never push (tests). */
  push: boolean;
}

export function brainDepsFromEnv(now: () => Date): BrainDeps {
  const root = process.env.BRAIN_DIR;
  if (!root) throw new Error("BRAIN_DIR is not set");
  return {
    root,
    exclude: (process.env.BRAIN_EXCLUDE ?? "health").split(",").map((s) => s.trim()).filter(Boolean),
    repoUrl: process.env.BRAIN_REPO_URL ?? "https://github.com/henrijantti/Brain",
    now,
    push: process.env.BRAIN_PUSH !== "0",
  };
}

const ALWAYS_HIDDEN = [".git", ".obsidian", ".trash"];
/** Paths an ingest proposal may create or change. */
const FILABLE = /^(wisdom\/(principles|letters|stories|people)|habits|ai\/(concepts|systems|sources))\/[a-z0-9-]+\.md$|^(index|log)\.md$|^ai\/(questions|glossary)\.md$/;
const RAW_NEW = /^raw\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.(md|txt|html)$/;

function git(d: BrainDeps, args: string[], cwd = d.root) {
  const name = process.env.BRAIN_GIT_NAME ?? "Family agent (OpenClaw)";
  const email = process.env.BRAIN_GIT_EMAIL ?? "family-agent@users.noreply.github.com";
  return run("git", ["-c", `user.name=${name}`, "-c", `user.email=${email}`, ...args], { cwd, timeout: 60_000 });
}

export function slugify(s: string): string {
  const map: Record<string, string> = { ä: "a", ö: "o", å: "a", ü: "u", é: "e" };
  return (
    s
      .toLowerCase()
      .replace(/[äöåüé]/g, (c) => map[c])
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/, "") || "capture"
  );
}

/** Resolves a vault-relative path, refusing escapes, hidden and excluded folders. */
export function safePath(d: BrainDeps, rel: string): string {
  const clean = normalize(rel).replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.startsWith("..") || clean.includes("/../")) throw new ToolError("path leaves the vault");
  const top = clean.split("/")[0];
  if (ALWAYS_HIDDEN.includes(top) || d.exclude.includes(top)) throw new ToolError(`${top}/ is off limits for the agent`);
  return join(d.root, clean);
}

function listMd(d: BrainDeps, dir = d.root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(d.root, full).split(sep).join("/");
    const top = rel.split("/")[0];
    if (ALWAYS_HIDDEN.includes(top) || d.exclude.includes(top)) continue;
    if (statSync(full).isDirectory()) out.push(...listMd(d, full));
    else if (name.endsWith(".md")) out.push(rel);
  }
  return out.sort();
}

function read(d: BrainDeps, rel: string): string {
  return readFileSync(safePath(d, rel), "utf8");
}

/** Finds a page by wikilink name ("finish-things") or by path. */
export function findPage(d: BrainDeps, page: string): string {
  if (page.includes("/") || page.endsWith(".md")) {
    const rel = page.endsWith(".md") ? page : `${page}.md`;
    if (!existsSync(safePath(d, rel))) throw new ToolError(`no page ${rel}`);
    return rel;
  }
  const hits = listMd(d).filter((p) => p.split("/").pop() === `${page}.md`);
  if (!hits.length) throw new ToolError(`no page named ${page}`);
  if (hits.length > 1) throw new ToolError(`several pages named ${page}: ${hits.join(", ")}`);
  return hits[0];
}

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  return Object.fromEntries(
    m[1]
      .split("\n")
      .map((l) => l.match(/^([a-z_]+):\s*(.*?)\s*(#.*)?$/))
      .filter((x): x is RegExpMatchArray => !!x)
      .map((x) => [x[1], x[2]]),
  );
}

const links = (text: string) => [...text.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim());

async function syncMain(d: BrainDeps) {
  if (!d.push) return;
  await git(d, ["pull", "--rebase", "--quiet", "origin", "main"]);
}

async function pushMain(d: BrainDeps) {
  if (!d.push) return;
  try {
    await git(d, ["push", "--quiet", "origin", "HEAD:main"]);
  } catch {
    // Someone (Henri's PC) pushed in between: replay our capture on top once.
    await git(d, ["pull", "--rebase", "--quiet", "origin", "main"]);
    await git(d, ["push", "--quiet", "origin", "HEAD:main"]);
  }
}

/** Vault health in numbers, per the monthly lint in AGENTS.md. Pure reads. */
export function lint(d: BrainDeps) {
  const today = localParts(d.now()).date;
  const pages = listMd(d).filter((p) => !/^(raw|templates|inbox)\//.test(p) && !["AGENTS.md", "CLAUDE.md", "README.md"].includes(p));
  const names = new Map(pages.map((p) => [p.split("/").pop()!.replace(/\.md$/, ""), p]));
  const index = existsSync(join(d.root, "index.md")) ? read(d, "index.md") : "";
  const inIndex = new Set(links(index));
  const linkedFrom = new Map<string, number>();
  for (const p of pages) for (const l of links(read(d, p))) if (p !== "index.md") linkedFrom.set(l, (linkedFrom.get(l) ?? 0) + 1);
  const content = pages.filter((p) => !["index.md", "log.md"].includes(p));
  const overdue = content
    .map((p) => ({ page: p, review_by: frontmatter(read(d, p)).review_by }))
    .filter((x) => x.review_by && x.review_by < today);
  const principlesWithoutEvidence = content
    .filter((p) => p.startsWith("wisdom/principles/"))
    .filter((p) => {
      const body = read(d, p).split(/^## Evidence from my own life\s*$/m)[1]?.split(/^## /m)[0] ?? "";
      return !body.trim() || /none written yet/i.test(body);
    });
  const inboxDir = join(d.root, "inbox");
  const inbox = existsSync(inboxDir) ? readdirSync(inboxDir).filter((f) => !f.startsWith(".") && f !== "README.md") : [];
  const questions = existsSync(join(d.root, "ai/questions.md")) ? read(d, "ai/questions.md") : "";
  const firstQuestion = questions.split(/^\d+\.\s+/m)[1]?.replace(/\s+/g, " ").trim();
  return {
    pages: content.length,
    inbox: inbox.length,
    notInIndex: [...names.keys()].filter((n) => !inIndex.has(n) && !["index", "log"].includes(n)),
    indexLinksWithoutPage: [...inIndex].filter((n) => !names.has(n)),
    orphans: [...names.keys()].filter((n) => !linkedFrom.has(n) && !["index", "log", "questions", "glossary"].includes(n)),
    overdueReview: overdue,
    principlesWithoutEvidence: principlesWithoutEvidence.map((p) => p.split("/").pop()!.replace(/\.md$/, "")),
    nextQuizQuestion: firstQuestion,
  };
}

export function brainTools(d: BrainDeps): Tool[] {
  return [
    {
      name: "brain_capture",
      description:
        "Save something Henri sends (thought, link, quote, voice-note transcript) as a new note in the vault inbox, as-is. No filing decisions: ingest decides later.",
      input: {
        properties: {
          title: { type: "string", maxLength: 80, description: "short single-line title" },
          text: { type: "string", maxLength: 20000, description: "the capture, verbatim; for a link, one line on why it matters" },
          url: { type: "string", maxLength: 2000, pattern: "^https?://\\S+$" },
        },
        required: ["title", "text"],
      },
      async run(a) {
        await syncMain(d);
        const now = d.now();
        const p = localParts(now);
        const base = `inbox/${p.date}-${slugify(a.title as string)}`;
        let rel = `${base}.md`;
        for (let i = 2; existsSync(join(d.root, rel)); i++) rel = `${base}-${i}.md`;
        const title = (a.title as string).replace(/\s+/g, " ").trim();
        const body = [`# ${title}`, "", a.url ? `${a.url}\n` : "", a.text as string, "", `_Captured from Telegram ${p.date} ${p.time}_`, ""].join("\n");
        mkdirSync(dirname(join(d.root, rel)), { recursive: true });
        writeFileSync(join(d.root, rel), body.replace(/\n{3,}/g, "\n\n"), { flag: "wx" });
        await git(d, ["add", "--", rel]);
        await git(d, ["commit", "--quiet", "-m", `capture: ${title}`, "--", rel]);
        await pushMain(d);
        return { saved: rel, pushed: d.push };
      },
    },
    {
      name: "brain_index",
      description: "The vault's index.md: one line per page. Start every query here.",
      input: { properties: {} },
      async run() {
        await syncMain(d).catch(() => {});
        return read(d, "index.md");
      },
    },
    {
      name: "brain_read",
      description: "Read one vault page by wikilink name (finish-things) or path (wisdom/principles/finish-things.md). Also reads AGENTS.md, inbox and raw files.",
      input: { properties: { page: { type: "string", maxLength: 200 } }, required: ["page"] },
      async run(a) {
        const rel = findPage(d, a.page as string);
        return `${rel}\n\n${read(d, rel)}`;
      },
    },
    {
      name: "brain_search",
      description: "Case-insensitive text search across vault pages. Returns up to 40 matching lines with their page.",
      input: { properties: { query: { type: "string", maxLength: 100 } }, required: ["query"] },
      async run(a) {
        const q = (a.query as string).toLowerCase();
        const hits: { page: string; line: number; text: string }[] = [];
        for (const p of listMd(d)) {
          read(d, p)
            .split("\n")
            .forEach((l, i) => {
              if (hits.length < 40 && l.toLowerCase().includes(q)) hits.push({ page: p, line: i + 1, text: l.trim().slice(0, 240) });
            });
        }
        return hits;
      },
    },
    {
      name: "brain_inbox",
      description: "Unprocessed captures in inbox/, oldest first, with their text (each cut at 3000 characters).",
      input: { properties: {} },
      async run() {
        await syncMain(d).catch(() => {});
        const dir = join(d.root, "inbox");
        if (!existsSync(dir)) return [];
        return readdirSync(dir)
          .filter((f) => !f.startsWith(".") && f !== "README.md")
          .sort()
          .map((f) => ({ path: `inbox/${f}`, text: f.endsWith(".md") ? read(d, `inbox/${f}`).slice(0, 3000) : "(not a markdown file)" }));
      },
    },
    {
      name: "brain_lint",
      description:
        "Vault health check from AGENTS.md: inbox backlog, pages missing from index, broken index links, orphans, overdue review_by, principles without lived evidence, next quiz question.",
      input: { properties: {} },
      async run() {
        await syncMain(d).catch(() => {});
        return lint(d);
      },
    },
    {
      name: "brain_propose",
      description:
        "Propose an ingest as a branch for Henri to review and merge on GitHub; nothing lands on main. Give full new file contents. Include the index.md and log.md updates AGENTS.md requires, and list the inbox items this clears. Returns the review link to send Henri.",
      input: {
        properties: {
          title: { type: "string", maxLength: 80, description: "what this ingest does, e.g. 'finish-things evidence from hockey weekend'" },
          summary: { type: "string", maxLength: 3000, description: "the diff in words: new pages, updates, contradictions found" },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string", maxLength: 200 }, content: { type: "string", maxLength: 60000 } },
              required: ["path", "content"],
            },
          },
          clearInbox: { type: "array", items: { type: "string", maxLength: 200, pattern: "^inbox/[^/]+$" } },
        },
        required: ["title", "summary", "files"],
      },
      async run(a) {
        const files = a.files as { path: string; content: string }[];
        const clear = (a.clearInbox as string[] | undefined) ?? [];
        if (!files.length && !clear.length) throw new ToolError("nothing to propose");
        for (const f of files) {
          safePath(d, f.path);
          if (RAW_NEW.test(f.path)) {
            if (existsSync(join(d.root, f.path))) throw new ToolError(`${f.path}: raw/ is immutable, existing files are never changed`);
          } else if (!FILABLE.test(f.path)) {
            throw new ToolError(`${f.path}: not a path an ingest may write (pages in wisdom/, habits/, ai/, index.md, log.md, or a new dated raw/ file)`);
          }
        }
        for (const p of clear) if (!existsSync(safePath(d, p))) throw new ToolError(`${p} is not in the inbox`);
        await syncMain(d);
        const branch = `ingest/${localParts(d.now()).date}-${slugify(a.title as string)}`;
        const wt = mkdtempSync(join(tmpdir(), "brain-ingest-"));
        try {
          await git(d, ["worktree", "add", "--quiet", "-b", branch, wt, "HEAD"]);
          for (const f of files) {
            mkdirSync(dirname(join(wt, f.path)), { recursive: true });
            writeFileSync(join(wt, f.path), f.content.endsWith("\n") ? f.content : `${f.content}\n`);
          }
          for (const p of clear) rmSync(join(wt, p));
          await git(d, ["add", "-A", "--", ...files.map((f) => f.path), ...clear], wt);
          await git(d, ["commit", "--quiet", "-m", `ingest: ${a.title}\n\n${a.summary}`], wt);
          if (d.push) await git(d, ["push", "--quiet", "-u", "origin", branch], wt);
        } finally {
          await git(d, ["worktree", "remove", "--force", wt]).catch(() => rmSync(wt, { recursive: true, force: true }));
        }
        return {
          branch,
          review: `${d.repoUrl}/compare/main...${encodeURIComponent(branch)}?expand=1`,
          note: "Henri opens the link, creates the pull request and merges it. Nothing is filed until he does.",
          pushed: d.push,
        };
      },
    },
  ];
}

