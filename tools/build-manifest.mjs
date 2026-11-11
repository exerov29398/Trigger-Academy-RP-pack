// MOVEXTSync manifest builder - runs inside GitHub Actions (Node 20, no dependencies).
// Rebuilds the "mods" list of manifest.json from every .jar in this repo's published Releases,
// keeps your own settings (bans, removeUnlisted, files...), and points selfUpdate at the newest
// movextsync-*.jar. Made by MOVEXT.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

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

function jsonLine(o) {
  return "{" + Object.entries(o).map(([k, v]) => JSON.stringify(k) + ": " + JSON.stringify(v)).join(", ") + "}";
}

/**
 * @param current  parsed current manifest.json (or {})
 * @param extra    array of extra mod entries hosted elsewhere (e.g. Modrinth)
 * @param names    { "<name on GitHub>": "<file name to use on players' PCs>" }
 * @param releases GitHub API releases array
 * @param now      Date, used for packVersion when the mod list changes
 */
function buildManifest(current, extra, names, releases, now) {
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
  const selfEntry = self ? self.e : current.selfUpdate;
  if (selfEntry) lines.push(`  "selfUpdate": ${jsonLine(selfEntry)},`);
  lines.push(`  "removeUnlisted": ${JSON.stringify(current.removeUnlisted ?? true)},`);
  lines.push(`  "allowedExtras": ${JSON.stringify(current.allowedExtras || [])},`);
  lines.push(`  "bannedModIds": ${JSON.stringify(current.bannedModIds || [])},`);
  lines.push(`  "bannedFiles": ${JSON.stringify(current.bannedFiles || [])},`);
  lines.push(`  "mods": [`);
  outMods.forEach((m, i) => lines.push("    " + jsonLine(m) + (i + 1 < outMods.length ? "," : "")));
  lines.push(`  ],`);
  const files = current.files || [];
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

  const r = buildManifest(current, extra, names, releases, new Date());
  for (const p of r.problems) console.log(`::warning::${p}`);
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
