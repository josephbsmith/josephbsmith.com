import assert from "node:assert/strict";

const { onRequest } = await import("./functions/os/_middleware.js");

class FakeDB {
  prepare(sql) {
    return {
      bind() { return this; },
      async first() { return null; },
      async run() { return { success: true }; },
    };
  }
}

const env = { CRITICAL_PATH_PASSWORD: "correct-horse", DB: new FakeDB() };
const next = async () => new Response("private books");

const anonymous = await onRequest({
  request: new Request("https://josephbsmith.com/os/"), env, next,
});
assert.equal(anonymous.status, 303);
assert.equal(anonymous.headers.get("Location"), "/os/login");

const login = await onRequest({
  request: new Request("https://josephbsmith.com/os/login", {
    method: "POST",
    headers: { Origin: "https://josephbsmith.com", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "correct-horse" }),
  }), env, next,
});
assert.equal(login.status, 303);
const cookie = login.headers.get("Set-Cookie").split(";", 1)[0];
assert.match(login.headers.get("Set-Cookie"), /HttpOnly; Secure; SameSite=Strict/);

const allowed = await onRequest({
  request: new Request("https://josephbsmith.com/os/", { headers: { Cookie: cookie } }), env, next,
});
assert.equal(allowed.status, 200);
assert.equal(await allowed.text(), "private books");
assert.equal(allowed.headers.get("X-Robots-Tag"), "noindex, nofollow, noarchive");
assert.match(allowed.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);

const originlessLogin = await onRequest({
  request: new Request("https://josephbsmith.com/os/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams({ password: "correct-horse" }),
  }), env, next,
});
assert.equal(originlessLogin.status, 303);

const crossSite = await onRequest({
  request: new Request("https://josephbsmith.com/os/api/clock-in", {
    method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example" }, body: "{}",
  }), env, next,
});
assert.equal(crossSite.status, 403);

const crossSiteWithoutOrigin = await onRequest({
  request: new Request("https://josephbsmith.com/os/api/clock-in", {
    method: "POST", headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" }, body: "{}",
  }), env, next,
});
assert.equal(crossSiteWithoutOrigin.status, 403);

console.log("smith os gate: ok");
