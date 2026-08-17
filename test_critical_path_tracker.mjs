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
assert.match(html, /id="actionButton"/);
assert.match(html, /id="activityDays"/);
assert.match(html, /id="weekProgress"/);
assert.match(html, /id="receiptButton"/);
assert.match(html, /const DAY_FOCUS =/);
assert.match(html, /duration: renderedAction\.kind === "metric"/);
assert.doesNotMatch(html, /type="date"|id="schedule"|id="viewDate"/);
assert.doesNotMatch(html.split("<script>")[0], /data-infinite-scroll|<video[^>]+autoplay/);

console.log("critical-path weekly tracker: ok");
