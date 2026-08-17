import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("./critical-path/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script);
new Function(script);

const contractSource = script.match(/const WEEK_CONTRACTS = \[([\s\S]*?)\n    \];/)?.[1];
assert.ok(contractSource);
const contracts = Function("return [" + contractSource + "];")();
assert.equal(contracts.length, 38);
assert.match(html, /id="weekSelect"/);
assert.match(html, />Weekly targets</);
assert.match(html, />Weekly outputs</);
assert.doesNotMatch(html, /type="date"|id="schedule"|id="viewDate"/);

console.log("critical-path weekly tracker: ok");
