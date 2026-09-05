const OPENF1 = "https://api.openf1.org";
const FASTF1_SCHEDULE = "https://raw.githubusercontent.com/theOehrly/f1schedule/master";
const DATA_ENDPOINTS = [
  "drivers", "position", "intervals", "laps", "stints", "race_control", "weather",
  "pit", "overtakes", "session_result", "starting_grid", "team_radio",
  "championship_drivers", "championship_teams",
];
const PIT_LOSS_SECONDS = 22;
const ACTIVE_BEFORE_MS = 30 * 60 * 1000;
const ACTIVE_AFTER_MS = 5 * 60 * 1000;

let credentials = { token: "", expires: 0 };
let scheduleCache = { year: 0, expires: 0, sessions: [], meetings: [] };
let requestGate = Promise.resolve();
let nextRequest = 0;

function response(data, maxAge = 10, status = 200) {
  return Response.json(data, { status, headers: {
    "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 2}`,
    "X-Content-Type-Options": "nosniff",
  } });
}

class OpenF1Error extends Error {
  constructor(status) {
    super(`OpenF1 returned ${status}`);
    this.status = status;
  }
}

async function openF1(path, token = "") {
  const headers = { Accept: "application/json", "User-Agent": "F1-Pit-Wall/2.0" };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let release;
    const previous = requestGate;
    requestGate = new Promise((resolve) => { release = resolve; });
    await previous;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextRequest - Date.now())));
    nextRequest = Date.now() + 360;
    release();
    const result = await fetch(`${OPENF1}${path}`, { headers });
    if (result.ok) return result.json();
    if (result.status !== 429 || attempt === 1) throw new OpenF1Error(result.status);
    const retry = Math.min(3, Number(result.headers.get("Retry-After")) || 1);
    await new Promise((resolve) => setTimeout(resolve, retry * 1000));
  }
  throw new Error("OpenF1 request failed");
}

async function fastF1Schedule(year) {
  const result = await fetch(`${FASTF1_SCHEDULE}/schedule_${year}.json`, {
    headers: { Accept: "application/json", "User-Agent": "F1-Pit-Wall/2.0" },
    signal: AbortSignal.timeout(5000),
  });
  if (!result.ok) throw new Error(`FastF1 schedule returned ${result.status}`);
  return result.json();
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

function sessionDetails(session, meetings) {
  const meeting = meetings.find((item) => item.meeting_key === session.meeting_key) || {};
  return {
    session_key: session.session_key,
    meeting_key: session.meeting_key,
    session_name: session.session_name,
    session_type: session.session_type,
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

function meetingsFromSessions(sessions) {
  return [...new Map(sessions.map((session) => [session.meeting_key, {
    meeting_key: session.meeting_key,
    meeting_name: `${session.country_name} Grand Prix`,
    location: session.location,
    country_name: session.country_name,
    country_code: session.country_code,
    circuit_short_name: session.circuit_short_name,
    date_start: session.date_start,
  }])).values()];
}

function utcDate(value, offset = "00:00:00") {
  if (!value) return null;
  const sign = offset.startsWith("-") ? "-" : "+";
  return new Date(`${value}${sign}${offset.replace(/^[-+]/, "").slice(0, 5)}`).toISOString();
}

export function normalizeCalendar(index) {
  const rows = Object.keys(index.event_name || {});
  const meetings = rows.map((row) => ({
    meeting_key: 800000 + Number(row),
    meeting_name: index.event_name[row],
    meeting_official_name: index.official_event_name[row],
    location: index.location[row],
    country_name: index.country[row],
    circuit_short_name: index.location[row],
  }));
  const sessions = rows.flatMap((row) => [1, 2, 3, 4, 5].flatMap((number) => {
    const name = index[`session${number}`]?.[row];
    const localStart = index[`session${number}_date`]?.[row];
    if (!name || !localStart) return [];
    const dateStart = utcDate(localStart, index.gmt_offset[row]);
    const duration = name === "Race" ? 120 : name === "Sprint" ? 60 : name.includes("Sprint Qualifying") ? 44 : 60;
    return [{
      session_key: Math.floor(Date.parse(dateStart) / 1000),
      meeting_key: 800000 + Number(row),
      session_name: name,
      session_type: ["Race", "Sprint"].includes(name) ? "Race" : name.includes("Qualifying") ? "Qualifying" : "Practice",
      location: index.location[row],
      country_name: index.country[row],
      circuit_short_name: index.location[row],
      date_start: dateStart,
      date_end: new Date(Date.parse(dateStart) + duration * 60000).toISOString(),
    }];
  }));
  return { meetings, sessions };
}

function isActive(session, now = Date.now()) {
  return Date.parse(session.date_start) - ACTIVE_BEFORE_MS <= now
    && now <= Date.parse(session.date_end) + ACTIVE_AFTER_MS;
}

export function selectSession(sessions, meetings, now = Date.now()) {
  const ordered = sessions
    .filter((session) => session.date_start && !session.is_cancelled)
    .sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start));
  const active = ordered.find((session) => isActive(session, now));
  const completed = ordered.filter((session) => Date.parse(session.date_start) <= now).at(-1);
  const next = ordered.find((session) => Date.parse(session.date_start) > now);
  return {
    active: active ? sessionDetails(active, meetings) : null,
    latest: completed ? sessionDetails(completed, meetings) : null,
    next: next ? sessionDetails(next, meetings) : null,
  };
}

function latest(records, field, order = "date") {
  const rows = new Map();
  for (const record of records || []) {
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

function best(values) {
  const numbers = values.map(number).filter((value) => value !== null);
  return numbers.length ? Math.min(...numbers) : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sparkline(values, width = 96, height = 28) {
  if (!values.length) return "";
  const low = Math.min(...values);
  const span = Math.max(...values) - low;
  return values.map((value, index) => {
    const x = Math.round(index * width / Math.max(values.length - 1, 1) * 10) / 10;
    const y = Math.round((span ? height - (value - low) / span * height : height / 2) * 10) / 10;
    return `${index ? "L" : "M"}${x},${y}`;
  }).join(" ");
}

function group(records, field) {
  const rows = new Map();
  for (const record of records || []) {
    const key = record[field];
    if (key === null || key === undefined) continue;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(record);
  }
  return rows;
}

function pointScale(locationGroups) {
  const all = [...locationGroups.values()].flat();
  const xs = all.map((row) => number(row.x)).filter((value) => value !== null);
  const ys = all.map((row) => number(row.y)).filter((value) => value !== null);
  const minX = xs.length ? Math.min(...xs) : 0;
  const maxX = xs.length ? Math.max(...xs) : 1;
  const minY = ys.length ? Math.min(...ys) : 0;
  const maxY = ys.length ? Math.max(...ys) : 1;
  return (row) => ({
    x: Math.round((5 + 90 * (row.x - minX) / Math.max(1, maxX - minX)) * 100) / 100,
    y: Math.round((95 - 90 * (row.y - minY) / Math.max(1, maxY - minY)) * 100) / 100,
  });
}

export function buildState(input, pitLoss = PIT_LOSS_SECONDS) {
  const data = Object.fromEntries([
    "session", "sessions", "meeting", ...DATA_ENDPOINTS, "location", "car_data",
  ].map((key) => [key, input[key] || []]));
  const session = data.session.at(-1) || {};
  const meeting = data.meeting.at(-1) || {};
  const sessionType = String(session.session_type || "Race");
  const race = ["Race", "Sprint"].includes(sessionType);
  const drivers = new Map(data.drivers.map((driver) => [driver.driver_number, driver]));
  const positions = latest(data.position, "driver_number");
  const intervals = latest(data.intervals, "driver_number");
  const currentStints = latest(data.stints, "driver_number", "stint_number");
  const results = new Map(data.session_result.map((row) => [row.driver_number, row]));
  const grid = new Map(data.starting_grid.map((row) => [row.driver_number, row]));
  const telemetry = latest(data.car_data, "driver_number");
  const locations = latest(data.location, "driver_number");
  const championship = new Map(data.championship_drivers.map((row) => [row.driver_number, row]));
  const laps = group(data.laps, "driver_number");
  const stints = group(data.stints, "driver_number");
  const pits = group(data.pit, "driver_number");
  const gaps = new Map([...new Set([...drivers.keys(), ...positions.keys()])]
    .map((driver) => [driver, number(intervals.get(driver)?.gap_to_leader)]));
  const leader = [...positions.values()]
    .filter((row) => row.position)
    .sort((a, b) => a.position - b.position)[0];
  if (leader) gaps.set(leader.driver_number, 0);

  const driverNumbers = new Set([...drivers.keys(), ...positions.keys(), ...laps.keys(), ...results.keys()]);
  const bestByDriver = new Map();
  for (const driver of driverNumbers) {
    const lapBest = best((laps.get(driver) || [])
      .filter((lap) => !lap.is_pit_out_lap)
      .map((lap) => lap.lap_duration));
    const duration = results.get(driver)?.duration;
    const resultBest = Array.isArray(duration) ? best(duration) : number(duration);
    bestByDriver.set(driver, lapBest ?? (!race ? resultBest : null));
  }
  const fieldBest = best([...bestByDriver.values()]);
  const ranked = [...driverNumbers].sort((a, b) => (bestByDriver.get(a) ?? Infinity) - (bestByDriver.get(b) ?? Infinity) || a - b);
  const practiceRank = new Map(ranked.map((driver, index) => [driver, index + 1]));

  const board = [...driverNumbers].map((driverNumber) => {
    const driverLaps = [...(laps.get(driverNumber) || [])].sort((a, b) => (a.lap_number || 0) - (b.lap_number || 0));
    const validLaps = driverLaps.filter((lap) => number(lap.lap_duration) !== null && !lap.is_pit_out_lap);
    const times = validLaps.map((lap) => number(lap.lap_duration));
    const bestLap = [...validLaps].sort((a, b) => a.lap_duration - b.lap_duration)[0] || {};
    const lastLap = validLaps.at(-1) || {};
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
    const result = results.get(driverNumber) || {};
    const resultPosition = result.position;
    const classification = race
      ? (positions.get(driverNumber)?.position || resultPosition || 999)
      : (resultPosition || practiceRank.get(driverNumber) || 999);
    const driverPits = [...(pits.get(driverNumber) || [])].sort((a, b) => (a.lap_number || 0) - (b.lap_number || 0));
    const car = telemetry.get(driverNumber) || {};
    const location = locations.get(driverNumber) || {};
    const qualifying = Array.isArray(result.duration) ? result.duration : [];
    const gridPosition = grid.get(driverNumber)?.position;
    const speeds = driverLaps.flatMap((lap) => [lap.i1_speed, lap.i2_speed, lap.st_speed]).map(number).filter((value) => value !== null);
    return {
      position: classification,
      track_position: positions.get(driverNumber)?.position,
      driver_number: driverNumber,
      name: profile.name_acronym || profile.full_name || String(driverNumber),
      full_name: profile.full_name || profile.broadcast_name || String(driverNumber),
      team: profile.team_name,
      team_colour: profile.team_colour,
      gap_to_leader: intervals.get(driverNumber)?.gap_to_leader ?? (leader?.driver_number === driverNumber ? 0 : null),
      interval: intervals.get(driverNumber)?.interval ?? null,
      compound: stint.compound,
      tyre_age_laps: tyreAge,
      recent_pace_seconds: median(times.slice(-3)),
      best_lap_seconds: bestByDriver.get(driverNumber),
      last_lap_seconds: number(lastLap.lap_duration),
      gap_to_best_seconds: bestByDriver.get(driverNumber) !== null && fieldBest !== null
        ? bestByDriver.get(driverNumber) - fieldBest : null,
      best_sectors: [1, 2, 3].map((index) => bestLap[`duration_sector_${index}`] ?? null),
      last_sectors: [1, 2, 3].map((index) => lastLap[`duration_sector_${index}`] ?? null),
      mini_sectors: [1, 2, 3].flatMap((index) => lastLap[`segments_sector_${index}`] || []),
      speed_trap: speeds.length ? Math.max(...speeds) : null,
      laps_completed: driverLaps.length,
      q1: qualifying[0] ?? null,
      q2: qualifying[1] ?? null,
      q3: qualifying[2] ?? null,
      grid_position: gridPosition,
      position_change: Number.isInteger(gridPosition) && Number.isInteger(classification) ? gridPosition - classification : null,
      pit_stops: driverPits.length,
      last_stop_seconds: number(driverPits.at(-1)?.stop_duration),
      lane_time_seconds: number(driverPits.at(-1)?.lane_duration ?? driverPits.at(-1)?.pit_duration),
      status: result.dsq ? "DSQ" : result.dns ? "DNS" : result.dnf ? "DNF" : null,
      telemetry: Object.fromEntries(["speed", "rpm", "n_gear", "throttle", "brake", "drs"].map((key) => [key, car[key]])),
      location: Object.fromEntries(["x", "y", "z"].map((key) => [key, location[key]])),
      championship: championship.get(driverNumber) || {},
      estimated_rejoin_position: projected,
      pace_sparkline_path: sparkline(times.slice(-8)),
      stint_history: [...(stints.get(driverNumber) || [])]
        .sort((a, b) => (a.stint_number || 0) - (b.stint_number || 0))
        .map((row) => ({
          compound: row.compound,
          laps: Math.max(1, Number(row.lap_end || currentLap || row.lap_start || 1) - Number(row.lap_start || 1) + 1),
        })),
    };
  }).sort((a, b) => (a.position ?? 999) - (b.position ?? 999));

  const weather = [...data.weather].sort((a, b) => String(a.date).localeCompare(String(b.date))).at(-1) || {};
  const messages = [...data.race_control].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-40);
  const names = new Map([...drivers].map(([driver, profile]) => [driver, profile.name_acronym || String(driver)]));
  const events = [
    ...data.race_control.map((row) => ({ date: row.date, kind: "CONTROL", label: row.flag || row.category, message: row.message, lap: row.lap_number, phase: row.qualifying_phase })),
    ...data.pit.map((row) => ({ date: row.date, kind: "PIT", label: names.get(row.driver_number), message: `Pit lane · ${row.lane_duration || row.pit_duration || "—"}s / stop ${row.stop_duration || "—"}s`, lap: row.lap_number })),
    ...data.overtakes.map((row) => ({ date: row.date, kind: "PASS", label: names.get(row.overtaking_driver_number), message: `Passed ${names.get(row.overtaken_driver_number) || row.overtaken_driver_number} for P${row.position}`, lap: null })),
    ...data.team_radio.map((row) => ({ date: row.date, kind: "RADIO", label: names.get(row.driver_number), message: "Team radio", url: row.recording_url, lap: null })),
  ].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));

  const locationGroups = group(data.location.filter((row) => number(row.x) !== null && number(row.y) !== null && (row.x || row.y)), "driver_number");
  const scale = pointScale(locationGroups);
  const outlineRows = [...locationGroups.values()].sort((a, b) => b.length - a.length)[0] || [];
  const step = Math.max(1, Math.floor(outlineRows.length / 120));
  const outline = outlineRows.filter((_, index) => index % step === 0).slice(-120).map(scale);
  const cars = [...locationGroups].map(([driver, rows]) => ({
    driver_number: driver,
    name: names.get(driver) || String(driver),
    team_colour: drivers.get(driver)?.team_colour,
    ...scale(rows.at(-1)),
  }));
  const phase = [...messages].reverse().find((row) => row.qualifying_phase)?.qualifying_phase;

  return {
    generated_utc: new Date().toISOString(),
    session,
    meeting,
    sessions: [...data.sessions].sort((a, b) => String(a.date_start).localeCompare(String(b.date_start))),
    session_type: sessionType,
    phase: phase ? `Q${phase}` : null,
    lap_number: Math.max(0, ...data.laps.map((lap) => Number(lap.lap_number) || 0)),
    pit_loss_seconds: pitLoss,
    board,
    weather,
    race_control: messages,
    events,
    track: { outline, cars },
    championship_drivers: [...data.championship_drivers].sort((a, b) => (a.position_current || 999) - (b.position_current || 999)),
    championship_teams: [...data.championship_teams].sort((a, b) => (a.position_current || 999) - (b.position_current || 999)),
  };
}

function query(params) {
  return new URLSearchParams(Object.entries(params).filter(([, value]) => value !== null && value !== undefined)).toString();
}

async function optional(endpoint, params, token) {
  try {
    return await openF1(`/v1/${endpoint}?${query(params)}`, token);
  } catch (error) {
    if (![401, 403].includes(error.status)) {
      console.warn(`Pit Wall skipped ${endpoint}: ${error.message}`);
      return [];
    }
    throw error;
  }
}

function recordDate(record) {
  const raw = record.date || record.date_start;
  return raw ? new Date(raw) : null;
}

async function fetchBundle(sessionKey, token = "", context = null, active = false) {
  const sessionRows = context ? [context.session] : await openF1(`/v1/sessions?${query({ session_key: sessionKey })}`, token);
  const session = sessionRows.at(-1) || { session_key: sessionKey };
  const meetingKey = session.meeting_key;
  const surroundings = context ? [context.sessions, [context.meeting]] : await Promise.all([
    meetingKey ? openF1(`/v1/sessions?${query({ meeting_key: meetingKey })}`, token) : Promise.resolve(sessionRows),
    meetingKey ? openF1(`/v1/meetings?${query({ meeting_key: meetingKey })}`, token) : Promise.resolve([]),
  ]);
  const data = {
    session: sessionRows,
    sessions: surroundings[0],
    meeting: surroundings[1],
    ...Object.fromEntries(DATA_ENDPOINTS.map((endpoint) => [endpoint, []])),
  };
  const raceOnly = new Set(["intervals", "overtakes", "championship_drivers", "championship_teams"]);
  const race = ["Race", "Sprint"].includes(session.session_type);
  const liveEndpoints = new Set([
    "drivers", "position", "laps", "stints", "race_control", "weather", "pit", "team_radio",
    ...(race ? ["intervals", "overtakes", "starting_grid"] : []),
  ]);
  const archiveEndpoints = new Set(race ? DATA_ENDPOINTS : [
    "drivers", "laps", "stints", "race_control", "weather", "session_result", "team_radio",
  ]);
  const endpoints = DATA_ENDPOINTS.filter((endpoint) => (active ? liveEndpoints : archiveEndpoints).has(endpoint)
    && (!raceOnly.has(endpoint) || race));
  const records = [];
  for (let index = 0; index < endpoints.length; index += 3) {
    records.push(...await Promise.all(endpoints.slice(index, index + 3)
      .map((endpoint) => optional(endpoint, { session_key: sessionKey }, token))));
  }
  endpoints.forEach((endpoint, index) => { data[endpoint] = records[index]; });

  const dates = ["position", "laps"].flatMap((endpoint) => data[endpoint].map(recordDate).filter(Boolean));
  data.location = [];
  data.car_data = [];
  if (dates.length && (active || race)) {
    const anchor = new Date(Math.max(...dates.map(Number)));
    const lapCounts = new Map();
    for (const lap of data.laps) lapCounts.set(lap.driver_number, (lapCounts.get(lap.driver_number) || 0) + 1);
    const reference = [...lapCounts].sort((a, b) => b[1] - a[1])[0]?.[0];
    const streamRequests = [
      ["location", { session_key: sessionKey, driver_number: reference, "date>": new Date(anchor - 150000).toISOString() }],
      ["location", { session_key: sessionKey, "date>": new Date(anchor - 5000).toISOString() }],
      ["car_data", { session_key: sessionKey, "date>": new Date(anchor - 12000).toISOString() }],
    ];
    const streams = await Promise.all(streamRequests.map(([endpoint, params]) => optional(endpoint, params, token)));
    data.location = [...streams[0], ...streams[1]];
    data.car_data = streams[2];
  }
  return data;
}

async function calendar(token = "") {
  const year = new Date().getUTCFullYear();
  if (scheduleCache.year === year && Date.now() < scheduleCache.expires && (!token || !scheduleCache.synthetic)) return scheduleCache;
  const edge = globalThis.caches?.default;
  const cacheKey = new Request(`https://josephbsmith.com/api/pit-wall-calendar?year=${year}`);
  const cached = edge ? await edge.match(cacheKey) : null;
  if (cached) {
    scheduleCache = await cached.json();
    return scheduleCache;
  }
  let results;
  let synthetic = false;
  try {
    const sessions = await openF1(`/v1/sessions?year=${year}`, token);
    const meetings = await optional("meetings", { year }, token);
    results = { sessions, meetings: meetings.length ? meetings : meetingsFromSessions(sessions) };
  } catch (error) {
    results = normalizeCalendar(await fastF1Schedule(year));
    synthetic = true;
  }
  scheduleCache = {
    year,
    expires: Date.now() + (synthetic ? 5 * 60 * 1000 : 6 * 60 * 60 * 1000),
    sessions: results.sessions,
    meetings: results.meetings,
    synthetic,
  };
  if (edge && !synthetic) {
    await edge.put(cacheKey, Response.json(scheduleCache, {
      headers: { "Cache-Control": "public, max-age=21600" },
    }));
  }
  return scheduleCache;
}

function unavailable(target, schedule, selection, message) {
  const session = sessionDetails(target, schedule.meetings);
  return {
    data: {
      status: "setup_required",
      message,
      session,
      sessions: schedule.sessions
        .filter((item) => item.meeting_key === target.meeting_key)
        .map((item) => sessionDetails(item, schedule.meetings)),
      next_session: selection.next,
    },
    maxAge: 30,
  };
}

async function livePayload(env, requestedSession, pitLoss) {
  const configured = Boolean(env.OPENF1_USERNAME && env.OPENF1_PASSWORD);
  let token = configured ? await accessToken(env) : "";
  const schedule = await calendar(token);
  const selection = selectSession(schedule.sessions, schedule.meetings);
  let target = requestedSession
    ? schedule.sessions.find((session) => String(session.session_key) === String(requestedSession))
    : selection.active || selection.latest;
  if (!target && requestedSession) {
    target = (await openF1(`/v1/sessions?${query({ session_key: requestedSession })}`, token)).at(-1);
  }
  if (!target) return { data: { status: "waiting", next_session: selection.next }, maxAge: 300 };
  const active = isActive(target);
  if (active && !configured) {
    return unavailable(target, schedule, selection, "Live timing requires an OpenF1 subscription.");
  }
  if (active && !token) token = await accessToken(env);
  let bundle;
  try {
    const meeting = schedule.meetings.find((item) => item.meeting_key === target.meeting_key);
    const context = meeting ? {
      session: target,
      meeting,
      sessions: schedule.sessions.filter((item) => item.meeting_key === target.meeting_key),
    } : null;
    bundle = await fetchBundle(target.session_key, token, context, active);
  } catch (error) {
    if (error.status === 401 && !configured) {
      return unavailable(target, schedule, selection, "OpenF1 requires authentication while a live session is in progress.");
    }
    throw error;
  }
  const state = buildState(bundle, pitLoss);
  state.follow_latest = !requestedSession;
  return {
    data: {
      status: active ? "live" : "session",
      session: sessionDetails(target, schedule.meetings),
      next_session: selection.next,
      state,
    },
    maxAge: active || !state.board.length ? 30 : 3600,
  };
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const requestedSession = url.searchParams.get("session_key") || "";
  if (requestedSession && !/^\d+$/.test(requestedSession)) return response({ status: "error", message: "Invalid session key." }, 60, 400);
  const rawPitLoss = Number(url.searchParams.get("pit_loss") || PIT_LOSS_SECONDS);
  const pitLoss = Math.min(45, Math.max(10, Number.isFinite(rawPitLoss) ? rawPitLoss : PIT_LOSS_SECONDS));
  const cache = globalThis.caches?.default;
  const cached = cache ? await cache.match(context.request) : null;
  if (cached) return cached;
  let result;
  try {
    const payload = await livePayload(context.env, requestedSession, pitLoss);
    result = response(payload.data, payload.maxAge);
  } catch (error) {
    console.error("Pit Wall feed:", error);
    result = response({ status: "error", message: "Timing is temporarily unavailable." }, 10, 502);
  }
  if (cache && result.ok) context.waitUntil(cache.put(context.request, result.clone()));
  return result;
}
