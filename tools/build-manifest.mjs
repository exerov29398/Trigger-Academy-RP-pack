// MOVEXTSync manifest builder - runs inside GitHub Actions (Node 20, no dependencies).
// Rebuilds the "mods" list of manifest.json from every .jar in this repo's published Releases,
// keeps your own settings (bans, removeUnlisted, files...), and points selfUpdate at the newest
// movextsync-*.jar. Made by MOVEXT.
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

// ===== core (pure, no I/O) =====
const ALT_SELF = /^movextsync-(\d+(?:\.\d+)*)\.jar$/i;

/**
 * Forge 1.20.1 reads a version from the file name: the text after the first match of /-([.\d]+)/
 * must start with a digit, otherwise the game crashes on start (e.g. "cluttered-.Forge.-3.0.3").
 * Names Forge can read are returned unchanged; broken ones get "-." / ".-" cleaned up.
 */
function forgeUnsafe(base) {
  const m = /-([.\d]+)/.exec(base);
  return !!m && !/^\d/.test(base.slice(m.index + 1));
}

function forgeSafeName(name) {
  const ext = /\.jar$/i.test(name) ? name.slice(-4) : "";
  let base = name.slice(0, name.length - ext.length);
  if (!forgeUnsafe(base)) return name;
  // After this no "-" is followed by ".", so the first /-([.\d]+)/ match always starts with a digit.
  base = base.replace(/-\.+/g, "-").replace(/\.+-/g, "-");
  return base + ext;
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Turns files found in the repo's pack/ and pack-once/ folders into manifest "files" entries.
 * @param found   [{ folder: "pack"|"pack-once", rel: "config/x.toml", sha256, size }]
 * @param current parsed current manifest (its file URLs are reused while the content is unchanged,
 *                so the manifest does not change on every run)
 * @param ownRaw  "https://raw.githubusercontent.com/<owner>/<repo>/" - entries pointing elsewhere are kept as-is
 * @param rawBase ownRaw + "<commit sha>/" - new files are linked at this exact commit (never stale)
 */
function buildFileEntries(found, current, ownRaw, rawBase, problems) {
  const prev = new Map((current.files || []).map(f => [f.path, f]));
  const byPath = new Map();
  for (const f of found) {
    if (/^mods\/[^/]*\.jar$/i.test(f.rel)) { problems.push(`${f.folder}/${f.rel}: put mods into the Release, not here (skipped)`); continue; }
    if (byPath.has(f.rel)) { problems.push(`${f.rel} is in both pack/ and pack-once/ - using pack/`); if (f.folder !== "pack") continue; }
    const old = prev.get(f.rel);
    const url = old && old.sha256 === f.sha256 && old.url.startsWith(ownRaw)
      ? old.url
      : rawBase + (f.folder + "/" + f.rel).split("/").map(encodeURIComponent).join("/");
    byPath.set(f.rel, { path: f.rel, url, sha256: f.sha256, size: f.size, replace: f.folder === "pack" });
  }
  const generated = [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manual = (current.files || []).filter(f => !String(f.url).startsWith(ownRaw));
  return [...generated, ...manual];
}

function jsonLine(o) {
  return "{" + Object.entries(o).map(([k, v]) => JSON.stringify(k) + ": " + JSON.stringify(v)).join(", ") + "}";
}

/**
 * @param current  parsed current manifest.json (or {})
 * @param extra    array of extra mod entries hosted elsewhere (e.g. Modrinth)
 * @param names    { "<name on GitHub>": "<file name to use on players' PCs>" }
 * @param releases GitHub API releases array
 * @param now      Date, used for packVersion when the mod list changes
 * @param changelogLines lines from changelog.txt, or null to keep the manifest's current changelog
 * @param fileEntries    "files" entries (see buildFileEntries), or null to keep the manifest's current files
 */
function buildManifest(current, extra, names, releases, now, changelogLines = null, fileEntries = null) {
  const problems = [];
  const mods = [];
  let self = null;

  for (const rel of releases) {
    if (rel.draft) continue;
    for (const a of rel.assets || []) {
      if (!/\.jar$/i.test(a.name)) continue;
      const sha = (a.digest || "").startsWith("sha256:") ? a.digest.slice(7).toLowerCase() : null;
      if (!sha) { problems.push(`no SHA-256 from GitHub for ${a.name} (re-upload it)`); continue; }
      const sv = ALT_SELF.exec(a.name);
      if (sv) {
        if (!self || compareVersions(sv[1], self.v) > 0) {
          self = { v: sv[1], e: { fileName: a.name, url: a.browser_download_url, sha256: sha, size: a.size } };
        }
        continue;
      }
      const fileName = names[a.name] || forgeSafeName(a.name);
      mods.push({ fileName, url: a.browser_download_url, sha256: sha, size: a.size, _sort: a.name.toLowerCase() });
    }
  }
  for (const e of extra) mods.push({ ...e, _sort: e.fileName.toLowerCase() });

  // one entry per file content and per file name
  const bySha = new Map(), byName = new Map();
  const unique = [];
  for (const m of mods) {
    if (bySha.has(m.sha256)) { problems.push(`same file uploaded twice: ${m.fileName} = ${bySha.get(m.sha256)} (kept one)`); continue; }
    const key = m.fileName.toLowerCase();
    if (byName.has(key)) { problems.push(`two different files named ${m.fileName} - delete one of them`); continue; }
    bySha.set(m.sha256, m.fileName); byName.set(key, true);
    unique.push(m);
  }
  unique.sort((x, y) => (x._sort < y._sort ? -1 : x._sort > y._sort ? 1 : 0));
  const outMods = unique.map(({ _sort, ...m }) => m);

  const oldKey = JSON.stringify((current.mods || []).map(m => m.sha256 + m.fileName).sort());
  const newKey = JSON.stringify(outMods.map(m => m.sha256 + m.fileName).sort());
  const changed = oldKey !== newKey;
  const p = n => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}.${p(now.getUTCMonth() + 1)}.${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;

  const head = {
    packName: current.packName || "Modpack",
    packVersion: changed ? stamp : (current.packVersion || stamp),
  };
  const lines = ["{"];
  lines.push(`  "packName": ${JSON.stringify(head.packName)},`);
  lines.push(`  "packVersion": ${JSON.stringify(head.packVersion)},`);
  const changelog = changelogLines ?? current.changelog ?? [];
  if (changelog.length) lines.push(`  "changelog": ${JSON.stringify(changelog)},`);
  const selfEntry = self ? self.e : current.selfUpdate;
  if (selfEntry) lines.push(`  "selfUpdate": ${jsonLine(selfEntry)},`);
  lines.push(`  "removeUnlisted": ${JSON.stringify(current.removeUnlisted ?? true)},`);
  lines.push(`  "allowedExtras": ${JSON.stringify(current.allowedExtras || [])},`);
  lines.push(`  "bannedModIds": ${JSON.stringify(current.bannedModIds || [])},`);
  lines.push(`  "bannedFiles": ${JSON.stringify(current.bannedFiles || [])},`);
  lines.push(`  "mods": [`);
  outMods.forEach((m, i) => lines.push("    " + jsonLine(m) + (i + 1 < outMods.length ? "," : "")));
  lines.push(`  ],`);
  const files = fileEntries ?? current.files ?? [];
  if (files.length === 0) lines.push(`  "files": []`);
  else {
    lines.push(`  "files": [`);
    files.forEach((f, i) => lines.push("    " + jsonLine(f) + (i + 1 < files.length ? "," : "")));
    lines.push(`  ]`);
  }
  lines.push("}");
  const text = lines.join("\n") + "\n";
  JSON.parse(text); // never write broken JSON
  return { text, problems, changed, count: outMods.length, self: selfEntry && selfEntry.fileName };
}
// ===== end core =====

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const headers = { "User-Agent": "MOVEXTSync-manifest", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const releases = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    for (const r of batch) {
      // a release lists at most 100 assets inline; fetch the rest
      const assets = [];
      for (let ap = 1; ; ap++) {
        const ar = await fetch(`https://api.github.com/repos/${repo}/releases/${r.id}/assets?per_page=100&page=${ap}`, { headers });
        if (!ar.ok) throw new Error(`GitHub API ${ar.status} (assets)`);
        const ab = await ar.json();
        assets.push(...ab);
        if (ab.length < 100) break;
      }
      releases.push({ ...r, assets });
    }
    if (batch.length < 100) break;
  }

  const read = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
  const current = read("manifest.json", {});
  const extra = read("extra-mods.json", []);
  const names = read("original-names.json", {});
  // changelog.txt: one "what's new" line per row; empty rows and rows starting with # are ignored
  const changelog = existsSync("changelog.txt")
    ? readFileSync("changelog.txt", "utf8").split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"))
    : null;

  // pack/      -> always kept up to date on players' PCs (e.g. config files the server needs)
  // pack-once/ -> only given when the player does not have the file yet (e.g. options.txt, keybinds)
  const walk = (dir, base = dir) => readdirSync(dir).flatMap(name => {
    const p = `${dir}/${name}`;
    return statSync(p).isDirectory() ? walk(p, base) : [p.slice(base.length + 1)];
  });
  const found = [];
  for (const folder of ["pack", "pack-once"]) {
    if (!existsSync(folder)) continue;
    for (const rel of walk(folder)) {
      if (/(^|\/)\.gitkeep$/.test(rel)) continue;
      const buf = readFileSync(`${folder}/${rel}`);
      found.push({ folder, rel, sha256: createHash("sha256").update(buf).digest("hex"), size: buf.length });
    }
  }
  const ownRaw = `https://raw.githubusercontent.com/${repo}/`;
  const fileProblems = [];
  const files = buildFileEntries(found, current, ownRaw, ownRaw + process.env.GITHUB_SHA + "/", fileProblems);

  const r = buildManifest(current, extra, names, releases, new Date(), changelog, files);
  for (const p of [...fileProblems, ...r.problems]) console.log(`::warning::${p}`);
  const old = existsSync("manifest.json") ? readFileSync("manifest.json", "utf8") : "";
  if (old === r.text) {
    console.log(`manifest.json unchanged (${r.count} mods, selfUpdate ${r.self})`);
    return;
  }
  writeFileSync("manifest.json", r.text);
  console.log(`manifest.json updated: ${r.count} mods, selfUpdate ${r.self}, mod list ${r.changed ? "changed" : "unchanged"}`);
}

if (typeof process !== "undefined" && process.argv && process.argv[1] && process.argv[1].endsWith("build-manifest.mjs")) {
  main().catch(e => { console.error(e); process.exit(1); });
}
