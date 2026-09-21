#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const statsDir = join(root, "stats");
const codeExtensions = new Set([".ts", ".svelte", ".sql", ".js", ".mjs"]);
const ignored = new Set(["node_modules", ".git", ".wrangler", "dist", "coverage", "stats"]);

async function files(directory) {
  const output = [];
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) output.push(...await files(path));
      else if (codeExtensions.has(extname(entry.name))) output.push(path);
    }
  } catch { /* Optional source directory. */ }
  return output;
}
async function count(directory) {
  const paths = await files(join(root, directory));
  let lines = 0;
  for (const path of paths) lines += (await readFile(path, "utf8")).split("\n").length;
  return { files: paths.length, lines };
}
function commit() {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}
function date() { return new Date().toISOString().slice(0, 10); }
function escape(value) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;"); }
function chart(entries) {
  const w = 640, h = 250, l = 56, r = 38, t = 38, b = 42;
  const total = (entry) => entry.worker + entry.web + entry.tests;
  const max = Math.max(...entries.map(total), 1);
  const yMax = Math.ceil(max * 1.2 / 100) * 100;
  const x = (i) => entries.length === 1 ? w / 2 : l + i * ((w - l - r) / (entries.length - 1));
  const y = (v) => t + (h - t - b) * (1 - v / yMax);
  const line = (key, color) => `<polyline fill="none" stroke="${color}" stroke-width="2" points="${entries.map((entry, i) => `${x(i)},${y(entry[key])}`).join(" ")}"/>`;
  const grid = [0, .25, .5, .75, 1].map((n) => { const v = Math.round(yMax * n); return `<line x1="${l}" y1="${y(v)}" x2="${w-r}" y2="${y(v)}" stroke="#dbe4ed"/><text x="${l-7}" y="${y(v)+4}" text-anchor="end" font-size="10" fill="#64748b">${v}</text>`; }).join("");
  const dates = entries.map((entry, i) => `<text x="${x(i)}" y="${h-16}" text-anchor="middle" font-size="10" fill="#64748b">${escape(entry.date.slice(5))}</text>`).join("");
  const last = entries.at(-1);
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="system-ui, sans-serif" aria-label="Codebase size"><rect width="100%" height="100%" fill="#f8fafc"/><text x="${l}" y="22" font-size="13" font-weight="700" fill="#0f172a">Codebase size (lines)</text>${grid}<line x1="${l}" y1="${t}" x2="${l}" y2="${h-b}" stroke="#94a3b8"/><line x1="${l}" y1="${h-b}" x2="${w-r}" y2="${h-b}" stroke="#94a3b8"/>${line("worker", "#2563eb")}${line("web", "#7c3aed")}${line("tests", "#059669")}${dates}<text x="${w-r}" y="22" text-anchor="end" font-size="10" fill="#2563eb">Worker ${last.worker}</text><text x="${w-r}" y="35" text-anchor="end" font-size="10" fill="#7c3aed">UI ${last.web}</text><text x="${w-r}" y="48" text-anchor="end" font-size="10" fill="#059669">Tests ${last.tests}</text></svg>`;
}

const worker = await count("src");
const web = await count("web/src");
const tests = await count("test");
const snapshot = { generatedAt: new Date().toISOString(), commit: commit(), worker, web, tests };
await mkdir(statsDir, { recursive: true });
let history = [];
try { history = JSON.parse(await readFile(join(statsDir, "growth-data.json"), "utf8")); } catch { /* First snapshot. */ }
const entry = { date: date(), commit: snapshot.commit, worker: worker.lines, web: web.lines, tests: tests.lines };
history = history.filter((item) => item.date !== entry.date);
history.push(entry);
history.sort((a, b) => a.date.localeCompare(b.date));
await writeFile(join(statsDir, "stats.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
await writeFile(join(statsDir, "growth-data.json"), `${JSON.stringify(history, null, 2)}\n`);
await writeFile(join(statsDir, "codebase-growth.svg"), `${chart(history)}\n`);
await writeFile(join(statsDir, "stats.md"), `# tsudoi codebase snapshot\n\nCommit \`${snapshot.commit}\` · ${date()}\n\n| Area | Files | Lines |\n| --- | ---: | ---: |\n| Worker \`src/\` | ${worker.files} | ${worker.lines} |\n| UI \`web/src/\` | ${web.files} | ${web.lines} |\n| Tests \`test/\` | ${tests.files} | ${tests.lines} |\n`);
if (!process.argv.includes("--save")) process.stdout.write(`${JSON.stringify(snapshot)}\n`);
