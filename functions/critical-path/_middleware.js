const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

function credentials(request) {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    return separator < 0 ? null : [decoded.slice(0, separator), decoded.slice(separator + 1)];
  } catch {
    return null;
  }
}

async function sameSecret(left, right) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let difference = aa.length ^ bb.length;
  for (let index = 0; index < aa.length; index += 1) difference |= aa[index] ^ bb[index];
  return difference === 0;
}

function response(body, status, extraHeaders = {}) {
  return new Response(body, { status, headers: { ...PRIVATE_HEADERS, ...extraHeaders } });
}

export async function onRequest(context) {
  const expected = context.env.CRITICAL_PATH_PASSWORD;
  if (!expected) return response("Critical Path is temporarily unavailable.", 503);

  const supplied = credentials(context.request);
  const authorized = supplied?.[0] === "joseph" && await sameSecret(supplied[1], expected);
  if (!authorized) {
    return response("Authentication required.", 401, {
      "WWW-Authenticate": 'Basic realm="Critical Path", charset="UTF-8"',
    });
  }

  const asset = await context.next();
  const headers = new Headers(asset.headers);
  for (const [name, value] of Object.entries(PRIVATE_HEADERS)) headers.set(name, value);
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}
