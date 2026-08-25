#!/usr/bin/env node
/* i18n integrity check:
 *  1. fr ⇄ en key parity (every key in one exists in the other).
 *  2. Every static t("key") used in src exists in both dictionaries.
 *  3. Dynamic families (run.stage_*, citations.kind_*, publisher.tab_*,
 *     subscribers.plan_*) are covered explicitly.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const src = new URL("..", import.meta.url).pathname + "/src";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|ts)$/.test(name)) out.push(p);
  }
  return out;
}

function keysOf(dictPath) {
  const text = readFileSync(dictPath, "utf8");
  const keys = new Set();
  for (const m of text.matchAll(/^\s*"([a-zA-Z0-9_.-]+)":/gm)) keys.add(m[1]);
  return keys;
}

const fr = keysOf(join(src, "i18n/fr.ts"));
const en = keysOf(join(src, "i18n/en.ts"));

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error("  ✗ " + msg);
};

for (const k of fr) if (!en.has(k)) fail(`fr key missing in en: ${k}`);
for (const k of en) if (!fr.has(k)) fail(`en key missing in fr: ${k}`);

const used = new Set();
for (const file of walk(src)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/\bt\("([a-zA-Z0-9_.]+)"/g)) used.add(m[1]);
}

const dynamicFamilies = [
  ["run.stage_understanding", "run.stage_evidence", "run.stage_preparing", "run.stage_writing", "run.stage_finishing"],
  ["citations.kind_document", "citations.kind_web", "citations.kind_memory", "citations.kind_chat"],
  ["publisher.tab_sources", "publisher.tab_publications", "publisher.tab_documents", "publisher.tab_subscribers"],
  ["subscribers.plan_lettre", "subscribers.plan_portefeuille", "subscribers.plan_sur-mesure"],
];
for (const family of dynamicFamilies) for (const k of family) used.add(k);

for (const k of used) {
  if (!fr.has(k)) fail(`used key missing in fr: ${k}`);
  if (!en.has(k)) fail(`used key missing in en: ${k}`);
}

const orphanFr = [...fr].filter((k) => !used.has(k));
console.log(`fr keys: ${fr.size}, en keys: ${en.size}, used (static+dynamic): ${used.size}`);
if (orphanFr.length) console.log(`unused fr keys (informational): ${orphanFr.join(", ")}`);

if (failures > 0) {
  console.error(`${failures} i18n failure(s)`);
  process.exit(1);
}
console.log("i18n OK — fr/en parity holds, every used key resolves");
