import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("./", import.meta.url);
const studio = await readFile(new URL("pit-wall-studio.html", root), "utf8");
const builder = await readFile(new URL("pit-wall-builder.html", root), "utf8");
const pitWall = await readFile(new URL("pit-wall.html", root), "utf8");
const codeIndex = await readFile(new URL("code/index.html", root), "utf8");
const sitemap = await readFile(new URL("sitemap.xml", root), "utf8");

assert.match(studio, /<title>Pit Wall Intelligence — Formula 1 Analytics<\/title>/);
assert.match(studio, /Every championship race/);
assert.match(studio, /\/api\/pit-wall-universe\?view=catalog&year=/);
assert.match(studio, /\/api\/pit-wall-universe\?view=season&year=/);
assert.match(studio, /\/api\/pit-wall-universe\?view=race&year=/);
assert.match(studio, /\/api\/pit-wall\?v=6&pit_loss=22&session_key=/);
for (const view of ["overview", "season", "race", "drivers", "teams", "compare", "circuits"]) {
  assert.match(studio, new RegExp(`data-view="${view}"`), `missing ${view} intelligence view`);
}

assert.match(builder, /<title>Pit Wall Report Builder — Formula 1 Analytics<\/title>/);
assert.match(builder, /href="\/pit-wall-builder" aria-current="page"/);
assert.match(builder, /const STORAGE_KEY='pit-wall-studio-v1'/);
assert.match(builder, /\/api\/pit-wall\?v=5&pit_loss=22&session_key=/);
assert.match(builder, /function applyCrossFilter/);
assert.match(builder, /function shareView/);
assert.match(builder, /function exportCsv/);
assert.match(builder, /function importReport/);

for (const template of ["overview", "pace", "strategy", "performance", "blank"]) {
  assert.match(builder, new RegExp(`id:'${template}'`), `missing ${template} report template`);
}
for (const visual of ["kpi", "bar", "line", "scatter", "table"]) {
  assert.match(builder, new RegExp(`${visual}:'`), `missing ${visual} visual type`);
}
for (const field of ["driver", "team", "compound", "lap", "stint"]) {
  assert.match(builder, new RegExp(`${field}:\\{label:`), `missing ${field} dimension`);
}
for (const measure of ["best_lap", "median_pace", "compound_count", "top_speed", "degradation", "consistency"]) {
  assert.match(builder, new RegExp(`${measure}:\\{label:`), `missing ${measure} measure`);
}

const ids = [...studio.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "static element IDs must be unique");

const script = studio.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "studio script should exist");
assert.doesNotThrow(() => new Function(script), "studio JavaScript should parse");
const builderScript = builder.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(builderScript, "builder script should exist");
assert.doesNotThrow(() => new Function(builderScript), "builder JavaScript should parse");

assert.match(pitWall, /href="\/pit-wall-studio"/);
assert.match(codeIndex, /Pit Wall Intelligence/);
assert.match(sitemap, /https:\/\/josephbsmith\.com\/pit-wall-studio/);
assert.match(sitemap, /https:\/\/josephbsmith\.com\/pit-wall-builder/);

console.log("pit wall studio contract: ok");
