import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("./", import.meta.url);
const studio = await readFile(new URL("pit-wall-studio.html", root), "utf8");
const pitWall = await readFile(new URL("pit-wall.html", root), "utf8");
const codeIndex = await readFile(new URL("code/index.html", root), "utf8");
const sitemap = await readFile(new URL("sitemap.xml", root), "utf8");

assert.match(studio, /<title>Pit Wall Studio — Formula 1 Analytics<\/title>/);
assert.match(studio, /href="\/pit-wall-studio" aria-current="page"/);
assert.match(studio, /const STORAGE_KEY='pit-wall-studio-v1'/);
assert.match(studio, /\/api\/pit-wall\?v=5&pit_loss=22&session_key=/);
assert.match(studio, /function applyCrossFilter/);
assert.match(studio, /function shareView/);
assert.match(studio, /function exportCsv/);
assert.match(studio, /function importReport/);

for (const template of ["overview", "pace", "strategy", "performance", "blank"]) {
  assert.match(studio, new RegExp(`id:'${template}'`), `missing ${template} report template`);
}
for (const visual of ["kpi", "bar", "line", "scatter", "table"]) {
  assert.match(studio, new RegExp(`${visual}:'`), `missing ${visual} visual type`);
}
for (const field of ["driver", "team", "compound", "lap", "stint"]) {
  assert.match(studio, new RegExp(`${field}:\\{label:`), `missing ${field} dimension`);
}
for (const measure of ["best_lap", "median_pace", "compound_count", "top_speed", "degradation", "consistency"]) {
  assert.match(studio, new RegExp(`${measure}:\\{label:`), `missing ${measure} measure`);
}

const ids = [...studio.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "static element IDs must be unique");

const script = studio.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "studio script should exist");
assert.doesNotThrow(() => new Function(script), "studio JavaScript should parse");

assert.match(pitWall, /href="\/pit-wall-studio"/);
assert.match(codeIndex, /project-based analytics studio/);
assert.match(sitemap, /https:\/\/josephbsmith\.com\/pit-wall-studio/);

console.log("pit wall studio contract: ok");
