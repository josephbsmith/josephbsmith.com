const OPENF1 = "https://api.openf1.org";
const DATA_ENDPOINTS = ["drivers", "position", "intervals", "laps", "stints", "race_control", "weather"];
const PIT_LOSS_SECONDS = 22;

let credentials = { token: "", expires: 0 };

function response(data, maxAge = 10, status = 200) {
  return Response.json(data, { status, headers: {
    "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 2}`,
    "X-Content-Type-Options": "nosniff",
  } });
}

async function openF1(path, token = "") {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await fetch(`${OPENF1}${path}`, { headers });
    if (result.ok) return result.json();
    if (result.status !== 429 || attempt === 2) throw new Error(`OpenF1 returned ${result.status}`);
    const retry = Number(result.headers.get("Retry-After")) || 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, retry * 1000));
  }
  throw new Error("OpenF1 request failed");
}

async function accessToken(env) {
  if (credentials.token && Date.now() < credentials.expires) return credentials.token;
  if (!env.OPENF1_USERNAME || !env.OPENF1_PASSWORD) return "";
  const body = new URLSearchParams({ username: env.OPENF1_USERNAME, password: env.OPENF1_PASSWORD });
  const result = await fetch(`${OPENF1}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!result.ok) throw new Error("OpenF1 sign-in failed");
  const data = await result.json();
  credentials = {
    token: data.access_token,
    expires: Date.now() + Math.max(60, Number(data.expires_in) - 60) * 1000,
  };
  return credentials.token;
}

function raceDetails(session, meetings) {
  const meeting = meetings.find((item) => item.meeting_key === session.meeting_key) || {};
  return {
    session_key: session.session_key,
    meeting_name: meeting.meeting_name || `${session.country_name} Grand Prix`,
    official_name: meeting.meeting_official_name || null,
    location: session.location,
    country_name: session.country_name,
    country_code: session.country_code,
    circuit_short_name: session.circuit_short_name,
    date_start: session.date_start,
    date_end: session.date_end,
  };
}

export function selectRace(sessions, meetings, now = Date.now()) {
  const races = sessions
    .filter((session) => session.session_name === "Race" && !session.is_cancelled)
    .sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start));
  const active = races.find((session) => {
    const start = Date.parse(session.date_start) - 60 * 60 * 1000;
    const end = Date.parse(session.date_end) + 2 * 60 * 60 * 1000;
    return start <= now && now <= end;
  });
  const next = races.find((session) => Date.parse(session.date_start) > now);
  return {
    active: active ? raceDetails(active, meetings) : null,
    next: next ? raceDetails(next, meetings) : null,
  };
}

function latest(records, field, order = "date") {
  const rows = new Map();
  for (const record of records) {
    const key = record[field];
    if (key === null || key === undefined) continue;
    const before = rows.get(key);
    if (!before || String(record[order] ?? "") >= String(before[order] ?? "")) rows.set(key, record);
  }
  return rows;
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sparkline(values, width = 60, height = 20) {
  if (!values.length) return "";
  const low = Math.min(...values);
  const span = Math.max(...values) - low;
  const points = values.map((value, index) => {
    const x = Math.round(index * width / Math.max(values.length - 1, 1) * 10) / 10;
    const y = Math.round((span ? height - (value - low) / span * height : height / 2) * 10) / 10;
    return [x, y];
  });
  return points.map(([x, y], index) => `${index ? "L" : "M"}${x},${y}`).join(" ");
}

function group(records, field) {
  const rows = new Map();
  for (const record of records) {
    const key = record[field];
    if (key === null || key === undefined) continue;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(record);
  }
  return rows;
}

export function buildState(data, pitLoss = PIT_LOSS_SECONDS) {
  const drivers = new Map(data.drivers.map((driver) => [driver.driver_number, driver]));
  const positions = latest(data.position, "driver_number");
  const intervals = latest(data.intervals, "driver_number");
  const currentStints = latest(data.stints, "driver_number", "stint_number");
  const laps = group(data.laps, "driver_number");
  const stints = group(data.stints, "driver_number");
  const gaps = new Map([...new Set([...drivers.keys(), ...positions.keys()])]
    .map((driver) => [driver, number(intervals.get(driver)?.gap_to_leader)]));
  const leader = [...positions.values()]
    .filter((row) => row.position)
    .sort((a, b) => a.position - b.position)[0];
  if (leader) gaps.set(leader.driver_number, 0);

  const board = [...positions.entries()].map(([driverNumber, position]) => {
    const driverLaps = (laps.get(driverNumber) || []).sort((a, b) => (a.lap_number || 0) - (b.lap_number || 0));
    const times = driverLaps.map((lap) => number(lap.lap_duration)).filter((lap) => lap !== null);
    const currentLap = Math.max(0, ...driverLaps.map((lap) => Number(lap.lap_number) || 0));
    const stint = currentStints.get(driverNumber) || {};
    const tyreAge = currentLap && Object.keys(stint).length
      ? Math.max(0, currentLap - Number(stint.lap_start || currentLap) + Number(stint.tyre_age_at_start || 0))
      : null;
    const driverGap = gaps.get(driverNumber);
    const projected = driverGap === null || driverGap === undefined ? null : Math.min(
      1 + [...gaps.values()].filter((gap) => gap !== null && gap < driverGap + pitLoss).length,
      positions.size,
    );
    const profile = drivers.get(driverNumber) || {};
    return {
      position: position.position,
      driver_number: driverNumber,
      name: profile.name_acronym || profile.full_name || String(driverNumber),
      team: profile.team_name,
      team_colour: profile.team_colour,
      gap_to_leader: intervals.get(driverNumber)?.gap_to_leader ?? (leader?.driver_number === driverNumber ? 0 : null),
      interval: intervals.get(driverNumber)?.interval ?? null,
      compound: stint.compound,
      tyre_age_laps: tyreAge,
      recent_pace_seconds: median(times.slice(-3)),
      estimated_rejoin_position: projected,
      pace_sparkline_path: sparkline(times.slice(-5)),
      stint_history: (stints.get(driverNumber) || [])
        .sort((a, b) => (a.stint_number || 0) - (b.stint_number || 0))
        .map((row) => ({
          compound: row.compound,
          laps: Math.max(1, Number(row.lap_end || currentLap || row.lap_start || 1) - Number(row.lap_start || 1) + 1),
        })),
    };
  }).sort((a, b) => (a.position ?? 999) - (b.position ?? 999));

  return {
    generated_utc: new Date().toISOString(),
    lap_number: Math.max(0, ...data.laps.map((lap) => Number(lap.lap_number) || 0)),
    pit_loss_seconds: pitLoss,
    board,
    weather: [...data.weather].sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1) || {},
    race_control: [...data.race_control].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-8),
  };
}

async function calendar(token = "") {
  const year = new Date().getUTCFullYear();
  const results = await Promise.all([
    openF1(`/v1/sessions?year=${year}&session_name=Race`, token),
    openF1(`/v1/meetings?year=${year}`, token),
  ]);
  return {
    sessions: results[0],
    meetings: results[1],
  };
}

async function livePayload(env) {
  const configured = env.OPENF1_USERNAME && env.OPENF1_PASSWORD;
  const token = configured ? await accessToken(env) : "";
  const schedule = await calendar(token);
  const race = selectRace(schedule.sessions, schedule.meetings);
  if (!race.active) return { data: { status: "waiting", next_session: race.next }, maxAge: 300 };
  if (!configured) {
    return { data: { status: "setup_required", session: race.active, next_session: race.next }, maxAge: 60 };
  }
  const records = await Promise.all(DATA_ENDPOINTS.map((endpoint) =>
    openF1(`/v1/${endpoint}?session_key=${race.active.session_key}`, token)));
  const data = Object.fromEntries(DATA_ENDPOINTS.map((endpoint, index) => [endpoint, records[index]]));
  return { data: { status: "live", session: race.active, next_session: race.next, state: buildState(data) }, maxAge: 10 };
}

export async function onRequestGet(context) {
  const cache = globalThis.caches?.default;
  const cached = cache ? await cache.match(context.request) : null;
  if (cached) return cached;
  let result;
  try {
    const payload = await livePayload(context.env);
    result = response(payload.data, payload.maxAge);
  } catch (error) {
    console.error("Pit Wall live feed:", error);
    result = response({ status: "error", message: "Live timing is temporarily unavailable." }, 10, 502);
  }
  if (cache && result.ok) context.waitUntil(cache.put(context.request, result.clone()));
  return result;
}
