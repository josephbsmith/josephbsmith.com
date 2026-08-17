import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./functions/critical-path/_middleware.js", import.meta.url), "utf8");
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

function request(credentials) {
  const headers = credentials ? { Authorization: `Basic ${Buffer.from(credentials).toString("base64")}` } : {};
  return new Request("https://josephbsmith.com/critical-path/", { headers });
}

async function gate(credentials, secret = "correct-horse") {
  return onRequest({
    request: request(credentials),
    env: { CRITICAL_PATH_PASSWORD: secret },
    next: async () => new Response("tracker"),
  });
}

assert.equal((await gate()).status, 401);
assert.equal((await gate("joseph:wrong")).status, 401);
assert.equal((await gate("somebody:correct-horse")).status, 401);
const allowed = await gate("joseph:correct-horse");
assert.equal(allowed.status, 200);
assert.equal(await allowed.text(), "tracker");
assert.equal(allowed.headers.get("X-Robots-Tag"), "noindex, nofollow, noarchive");
assert.equal((await gate("joseph:correct-horse", "")).status, 503);

console.log("critical-path gate: ok");
