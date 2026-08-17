const COOKIE = "smith_os";
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function sameSecret(left, right) {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function sign(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

function cookieValue(request) {
  const cookies = request.headers.get("Cookie") || "";
  const row = cookies.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
  return row ? row.slice(COOKIE.length + 1) : null;
}

async function authorized(request, secret) {
  const token = cookieValue(request);
  if (!token) return false;
  const separator = token.indexOf(".");
  if (separator < 1) return false;
  const expires = Number(token.slice(0, separator));
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(Date.now() / 1000)) return false;
  return sameSecret(token.slice(separator + 1), await sign(secret, String(expires)));
}

function secured(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function loginPage(error = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><title>Smith OS · Sign in</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;background:#101411;color:#f3f5f1;font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:24px}.box{width:min(100%,390px);padding:30px;border:1px solid #344039;border-radius:18px;background:#171d19;box-shadow:0 30px 80px #0008}.mark{color:#dff26b;font-size:12px;font-weight:800;letter-spacing:.14em}.box h1{font:750 34px/1.05 ui-sans-serif,-apple-system,sans-serif;letter-spacing:-.04em;margin:14px 0 8px}.box p{color:#97a39b;margin:0 0 26px}label{display:block;color:#cbd2cc;font-size:12px;margin-bottom:7px}input{width:100%;font:inherit;font-size:16px;padding:14px;border:1px solid #4b5b51;border-radius:10px;background:#0d100e;color:#fff}button{width:100%;margin-top:12px;padding:14px;border:0;border-radius:10px;background:#dff26b;color:#111;font:800 15px ui-sans-serif,-apple-system,sans-serif}.error{color:#ff9a83!important;margin:0 0 14px!important}</style></head><body><main class="box"><div class="mark">PRIVATE / SMITH OS</div><h1>Open the books.</h1><p>One clock. One close. One source of truth.</p>${error ? `<p class="error">${error}</p>` : ""}<form method="post" action="/os/login"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" autofocus required><button type="submit">Sign in</button></form></main></body></html>`;
}

function html(body, status = 200, extra = {}) {
  return secured(new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...extra } }));
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get("Sec-Fetch-Site") !== "cross-site";
}

async function attemptKey(request, secret) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return sign(secret, `login:${ip}`);
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const secret = env.CRITICAL_PATH_PASSWORD;
  if (!secret || !env.DB) return html("<h1>Smith OS is temporarily unavailable.</h1>", 503);

  if (url.pathname === "/os/login") {
    if (request.method === "GET") {
      if (await authorized(request, secret)) return Response.redirect(`${url.origin}/os/`, 303);
      return html(loginPage());
    }
    if (request.method !== "POST" || !sameOrigin(request)) return html(loginPage("Request rejected."), 403);
    const now = Math.floor(Date.now() / 1000);
    const key = await attemptKey(request, secret);
    const attempt = await env.DB.prepare("SELECT failures,blocked_until,updated_at FROM auth_attempts WHERE key=?")
      .bind(key).first();
    if (attempt?.blocked_until > now) return html(loginPage("Too many attempts. Try again in 15 minutes."), 429);
    const form = await request.formData();
    const supplied = String(form.get("password") || "");
    if (!await sameSecret(supplied, secret)) {
      const failures = attempt && now - attempt.updated_at < 900 ? attempt.failures + 1 : 1;
      const blocked = failures >= 5 ? now + 900 : 0;
      await env.DB.prepare("INSERT INTO auth_attempts(key,failures,blocked_until,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,blocked_until=excluded.blocked_until,updated_at=excluded.updated_at")
        .bind(key, failures, blocked, now).run();
      return html(loginPage("That password did not work."), 401);
    }
    await env.DB.prepare("DELETE FROM auth_attempts WHERE key=?").bind(key).run();
    const expires = now + SESSION_SECONDS;
    const token = `${expires}.${await sign(secret, String(expires))}`;
    return secured(new Response(null, { status: 303, headers: {
      Location: "/os/",
      "Set-Cookie": `${COOKIE}=${token}; Path=/os; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`,
    } }));
  }

  if (url.pathname === "/os/logout") {
    if (request.method !== "POST" || !sameOrigin(request)) return new Response("Forbidden", { status: 403 });
    return secured(new Response(null, { status: 303, headers: {
      Location: "/os/login",
      "Set-Cookie": `${COOKIE}=; Path=/os; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    } }));
  }

  if (!await authorized(request, secret)) {
    if (url.pathname.startsWith("/os/api/")) return secured(Response.json({ error: "Authentication required." }, { status: 401 }));
    return secured(new Response(null, { status: 303, headers: { Location: "/os/login" } }));
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !sameOrigin(request)) {
    return secured(Response.json({ error: "Cross-site request rejected." }, { status: 403 }));
  }
  return secured(await context.next());
}
