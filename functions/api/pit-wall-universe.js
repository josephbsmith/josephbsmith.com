const OPENF1 = "https://api.openf1.org/v1";
const JOLPICA = "https://api.jolpi.ca/ergast/f1";
const PAGE_SIZE = 100;
const FIRST_DETAILED_YEAR = 2023;
let jolpicaGate = Promise.resolve();
let nextJolpicaRequest = 0;

function json(data, maxAge = 3600, status = 200) {
  return Response.json(data, { status, headers: {
    "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 4}`,
    "X-Content-Type-Options": "nosniff",
  } });
}

async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "F1-Pit-Wall/3.1" },
      signal: AbortSignal.timeout(20000),
    });
    if (response.ok) return response.json();
    if (response.status !== 429 || attempt === 2) throw new Error(`${new URL(url).hostname} returned ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, (Number(response.headers.get("Retry-After")) || attempt + 1) * 1000)));
  }
  throw new Error("Analytics data source did not respond");
}

function params(values) {
  return new URLSearchParams(Object.entries(values)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")).toString();
}

async function openF1(endpoint, values) {
  return fetchJson(`${OPENF1}/${endpoint}?${params(values)}`);
}

async function jolpica(path, values = {}) {
  let release;
  const previous = jolpicaGate;
  jolpicaGate = new Promise((resolve) => { release = resolve; });
  await previous;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextJolpicaRequest - Date.now())));
  try {
    return await fetchJson(`${JOLPICA}/${path}${path.endsWith(".json") ? "" : ".json"}?${params(values)}`);
  } finally {
    nextJolpicaRequest = Date.now() + 280;
    release();
  }
}

async function jolpicaPages(path, maxPages = 30) {
  const first = await jolpica(path, { limit: PAGE_SIZE, offset: 0 });
  const total = Number(first?.MRData?.total || 0);
  const pageCount = Math.min(maxPages, Math.ceil(total / PAGE_SIZE));
  const pages = [first];
  for (let page = 1; page < pageCount; page += 3) {
    const batch = [];
    for (let index = page; index < Math.min(page + 3, pageCount); index += 1) {
      batch.push(jolpica(path, { limit: PAGE_SIZE, offset: index * PAGE_SIZE }));
    }
    pages.push(...await Promise.all(batch));
  }
  return pages;
}

export function mergeRaceCollection(pages, collection) {
  const merged = new Map();
  for (const page of pages) {
    for (const race of page?.MRData?.RaceTable?.Races || []) {
      const id = `${race.season}-${race.round}`;
      const existing = merged.get(id) || { ...race, [collection]: [] };
      existing[collection].push(...(race[collection] || []));
      merged.set(id, existing);
    }
  }
  return [...merged.values()].sort((a, b) => Number(a.round) - Number(b.round));
}

function seconds(value) {
  if (!value) return null;
  const parts = String(value).replace(/^\+/, "").split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function normalizeResult(result) {
  const grid = number(result.grid);
  const position = number(result.position);
  return {
    driver_id: result.Driver?.driverId || result.number,
    driver_number: result.number || null,
    code: result.Driver?.code || result.Driver?.familyName?.slice(0, 3).toUpperCase() || result.number,
    name: [result.Driver?.givenName, result.Driver?.familyName].filter(Boolean).join(" "),
    nationality: result.Driver?.nationality || null,
    team_id: result.Constructor?.constructorId || null,
    team: result.Constructor?.name || "Unknown",
    position,
    position_text: result.positionText || null,
    grid,
    positions_gained: grid > 0 && position ? grid - position : null,
    points: number(result.points) || 0,
    laps: number(result.laps),
    status: result.status || null,
    classified: Boolean(result.status && (/Finished|Lapped|Lap/.test(result.status))),
    race_time_ms: number(result.Time?.millis),
    gap: result.Time?.time || null,
    fastest_lap: seconds(result.FastestLap?.Time?.time),
    fastest_lap_rank: number(result.FastestLap?.rank),
    fastest_lap_number: number(result.FastestLap?.lap),
    average_speed: number(result.FastestLap?.AverageSpeed?.speed),
  };
}

function normalizeSprint(result) {
  return {
    driver_id: result.Driver?.driverId || result.number,
    team_id: result.Constructor?.constructorId || null,
    points: number(result.points) || 0,
    position: number(result.position),
  };
}

function standingsRows(payload, type) {
  const lists = payload?.MRData?.StandingsTable?.StandingsLists || [];
  const key = type === "drivers" ? "DriverStandings" : "ConstructorStandings";
  return (lists.at(-1)?.[key] || []).map((row) => ({
    id: type === "drivers" ? row.Driver?.driverId : row.Constructor?.constructorId,
    position: number(row.position),
    points: number(row.points) || 0,
    wins: number(row.wins) || 0,
    name: type === "drivers"
      ? [row.Driver?.givenName, row.Driver?.familyName].filter(Boolean).join(" ")
      : row.Constructor?.name,
    code: type === "drivers" ? row.Driver?.code : null,
    team: type === "drivers" ? row.Constructors?.at(-1)?.name : null,
  }));
}

function leaderChanges(series) {
  let previous = null;
  let changes = 0;
  for (let index = 0; index < (series[0]?.values.length || 0); index += 1) {
    const leader = [...series].sort((a, b) => b.values[index] - a.values[index])[0]?.id;
    if (previous && leader && leader !== previous) changes += 1;
    if (leader) previous = leader;
  }
  return changes;
}

export function buildSeasonAnalytics({ year, raceRows, sprintRows = [], driverStandings = [], constructorStandings = [] }) {
  const sprintByRound = new Map(sprintRows.map((race) => [String(race.round),
    (race.SprintResults || []).map(normalizeSprint)]));
  const races = raceRows.map((race) => ({
    year: Number(race.season || year),
    round: Number(race.round),
    name: race.raceName,
    date: race.date,
    circuit: {
      id: race.Circuit?.circuitId,
      name: race.Circuit?.circuitName,
      locality: race.Circuit?.Location?.locality,
      country: race.Circuit?.Location?.country,
      lat: number(race.Circuit?.Location?.lat),
      long: number(race.Circuit?.Location?.long),
    },
    results: (race.Results || []).map(normalizeResult),
    sprint: sprintByRound.get(String(race.round)) || [],
  }));

  const drivers = new Map();
  const teams = new Map();
  const ensureDriver = (result) => {
    if (!drivers.has(result.driver_id)) drivers.set(result.driver_id, {
      id: result.driver_id, code: result.code, name: result.name, nationality: result.nationality,
      team: result.team, starts: 0, wins: 0, podiums: 0, poles: 0, points: 0, sprint_points: 0,
      finishes: [], grid: [], gains: [], fastest_laps: 0, classified: 0, dnfs: 0, results: [],
    });
    return drivers.get(result.driver_id);
  };
  const ensureTeam = (result) => {
    if (!teams.has(result.team_id)) teams.set(result.team_id, {
      id: result.team_id, name: result.team, starts: 0, wins: 0, podiums: 0, poles: 0,
      points: 0, sprint_points: 0, finishes: [], gains: [], classified: 0, results: [],
    });
    return teams.get(result.team_id);
  };

  for (const race of races) {
    const sprintPoints = new Map(race.sprint.map((row) => [row.driver_id, row.points]));
    for (const result of race.results) {
      const driver = ensureDriver(result);
      const team = ensureTeam(result);
      const sprintPoint = sprintPoints.get(result.driver_id) || 0;
      Object.assign(driver, { code: result.code, name: result.name, team: result.team });
      driver.starts += 1; team.starts += 1;
      driver.points += result.points + sprintPoint; team.points += result.points + sprintPoint;
      driver.sprint_points += sprintPoint; team.sprint_points += sprintPoint;
      if (result.position === 1) { driver.wins += 1; team.wins += 1; }
      if (result.position && result.position <= 3) { driver.podiums += 1; team.podiums += 1; }
      if (result.grid === 1) { driver.poles += 1; team.poles += 1; }
      if (result.fastest_lap_rank === 1) driver.fastest_laps += 1;
      if (result.classified) { driver.classified += 1; team.classified += 1; } else driver.dnfs += 1;
      if (result.position) { driver.finishes.push(result.position); team.finishes.push(result.position); }
      if (result.grid > 0) driver.grid.push(result.grid);
      if (result.positions_gained !== null) { driver.gains.push(result.positions_gained); team.gains.push(result.positions_gained); }
      const compact = { round: race.round, race: race.name, position: result.position, grid: result.grid,
        points: result.points + sprintPoint, gain: result.positions_gained, status: result.status,
        fastest_lap: result.fastest_lap, team: result.team };
      driver.results.push(compact); team.results.push({ ...compact, driver: result.code });
    }
  }

  const driverStandingMap = new Map(driverStandings.map((row) => [row.id, row]));
  const teamStandingMap = new Map(constructorStandings.map((row) => [row.id, row]));
  const driverList = [...drivers.values()].map((driver) => {
    const official = driverStandingMap.get(driver.id);
    return { ...driver, points: official?.points ?? driver.points, championship_position: official?.position ?? null,
      wins: official?.wins ?? driver.wins, average_finish: mean(driver.finishes), average_grid: mean(driver.grid),
      average_gain: mean(driver.gains), reliability: driver.starts ? driver.classified / driver.starts : null };
  }).sort((a, b) => (a.championship_position || 999) - (b.championship_position || 999) || b.points - a.points);
  const teamList = [...teams.values()].map((team) => {
    const official = teamStandingMap.get(team.id);
    return { ...team, points: official?.points ?? team.points, championship_position: official?.position ?? null,
      wins: official?.wins ?? team.wins, average_finish: mean(team.finishes), average_gain: mean(team.gains),
      reliability: team.starts ? team.classified / team.starts : null };
  }).sort((a, b) => (a.championship_position || 999) - (b.championship_position || 999) || b.points - a.points);

  const cumulativeDrivers = new Map(driverList.map((driver) => [driver.id, 0]));
  const cumulativeTeams = new Map(teamList.map((team) => [team.id, 0]));
  const driverProgress = new Map(driverList.map((driver) => [driver.id, []]));
  const teamProgress = new Map(teamList.map((team) => [team.id, []]));
  for (const race of races) {
    const sprintMap = new Map(race.sprint.map((row) => [row.driver_id, row.points]));
    for (const result of race.results) {
      cumulativeDrivers.set(result.driver_id, (cumulativeDrivers.get(result.driver_id) || 0) + result.points + (sprintMap.get(result.driver_id) || 0));
      cumulativeTeams.set(result.team_id, (cumulativeTeams.get(result.team_id) || 0) + result.points + (sprintMap.get(result.driver_id) || 0));
    }
    driverList.forEach((driver) => driverProgress.get(driver.id).push(cumulativeDrivers.get(driver.id) || 0));
    teamList.forEach((team) => teamProgress.get(team.id).push(cumulativeTeams.get(team.id) || 0));
  }
  const driverSeries = driverList.map((driver) => ({ id: driver.id, code: driver.code, name: driver.name, team: driver.team, values: driverProgress.get(driver.id) }));
  const teamSeries = teamList.map((team) => ({ id: team.id, name: team.name, values: teamProgress.get(team.id) }));
  const positiveGains = races.flatMap((race) => race.results.map((result) => result.positions_gained)).filter((gain) => gain > 0);
  const winnerCounts = new Map();
  races.forEach((race) => { const winner = race.results.find((result) => result.position === 1); if (winner) winnerCounts.set(winner.driver_id, (winnerCounts.get(winner.driver_id) || 0) + 1); });
  return {
    year: Number(year), races, drivers: driverList, teams: teamList,
    progression: { rounds: races.map((race) => ({ round: race.round, label: race.name.replace(/ Grand Prix$/i, "") })), drivers: driverSeries, teams: teamSeries },
    summary: {
      races: races.length, drivers: driverList.length, teams: teamList.length,
      winners: winnerCounts.size, championship_lead_changes: leaderChanges(driverSeries),
      reliability: driverList.length ? mean(driverList.map((driver) => driver.reliability)) : null,
      average_positions_gained: mean(positiveGains),
      dominance: races.length ? Math.max(0, ...winnerCounts.values()) / races.length : null,
    },
  };
}

function normalizeSession(session) {
  return {
    session_key: session.session_key, meeting_key: session.meeting_key,
    name: session.session_name, type: session.session_type,
    date_start: session.date_start, date_end: session.date_end,
  };
}

export function normalizeCatalog(year, scheduleRows, sessions = [], meetings = [], now = Date.now()) {
  const racesByDate = new Map(sessions.filter((session) => session.session_name === "Race")
    .map((session) => [String(session.date_start).slice(0, 10), session]));
  const sessionsByMeeting = new Map();
  for (const session of sessions) {
    if (!sessionsByMeeting.has(session.meeting_key)) sessionsByMeeting.set(session.meeting_key, []);
    sessionsByMeeting.get(session.meeting_key).push(normalizeSession(session));
  }
  const meetingMap = new Map(meetings.map((meeting) => [meeting.meeting_key, meeting]));
  return scheduleRows.map((race) => {
    const session = racesByDate.get(race.date);
    const meeting = meetingMap.get(session?.meeting_key) || {};
    const start = Date.parse(`${race.date}T${race.time || "12:00:00Z"}`);
    return {
      year: Number(year), round: Number(race.round), name: race.raceName, date: race.date,
      time: race.time || null,
      circuit: { id: race.Circuit?.circuitId, name: race.Circuit?.circuitName,
        locality: race.Circuit?.Location?.locality, country: race.Circuit?.Location?.country,
        lat: number(race.Circuit?.Location?.lat), long: number(race.Circuit?.Location?.long) },
      status: start > now ? "upcoming" : now - start < 3 * 60 * 60 * 1000 ? "live" : "complete",
      detailed: Boolean(session), session_key: session?.session_key || null,
      meeting_key: session?.meeting_key || null,
      circuit_image: meeting.circuit_image || null, country_flag: meeting.country_flag || null,
      circuit_type: meeting.circuit_type || null,
      sessions: [...(sessionsByMeeting.get(session?.meeting_key) || [])]
        .sort((a, b) => String(a.date_start).localeCompare(String(b.date_start))),
    };
  });
}

async function catalog(year) {
  const schedule = await jolpica(`${year}.json`, { limit: 100 });
  const scheduleRows = schedule?.MRData?.RaceTable?.Races || [];
  let sessions = [];
  let meetings = [];
  if (year >= FIRST_DETAILED_YEAR) {
    [sessions, meetings] = await Promise.all([
      openF1("sessions", { year }).catch(() => []),
      openF1("meetings", { year }).catch(() => []),
    ]);
  }
  return {
    year, races: normalizeCatalog(year, scheduleRows, sessions, meetings),
    coverage: { historical_from: 1950, detailed_from: FIRST_DETAILED_YEAR },
  };
}

async function season(year) {
  const [resultPages, sprintPages, driverPayload, constructorPayload] = await Promise.all([
    jolpicaPages(`${year}/results.json`, 8),
    jolpicaPages(`${year}/sprint.json`, 4),
    jolpica(`${year}/driverstandings.json`, { limit: 100 }),
    jolpica(`${year}/constructorstandings.json`, { limit: 100 }),
  ]);
  return buildSeasonAnalytics({
    year,
    raceRows: mergeRaceCollection(resultPages, "Results"),
    sprintRows: mergeRaceCollection(sprintPages, "SprintResults"),
    driverStandings: standingsRows(driverPayload, "drivers"),
    constructorStandings: standingsRows(constructorPayload, "teams"),
  });
}

function mergeSingleRace(pages, collection) {
  return mergeRaceCollection(pages, collection)[0] || null;
}

async function race(year, round, includeLaps) {
  const requests = [
    jolpicaPages(`${year}/${round}/results.json`, 2),
    jolpicaPages(`${year}/${round}/qualifying.json`, 2),
    jolpicaPages(`${year}/${round}/pitstops.json`, 5),
  ];
  if (includeLaps) requests.push(jolpicaPages(`${year}/${round}/laps.json`, 30));
  const [resultPages, qualifyingPages, pitPages, lapPages = []] = await Promise.all(requests);
  const resultRace = mergeSingleRace(resultPages, "Results");
  if (!resultRace) return { year, round, available: false };
  const qualifyingRace = mergeSingleRace(qualifyingPages, "QualifyingResults");
  const pitRace = mergeSingleRace(pitPages, "PitStops");
  const lapRace = includeLaps ? mergeSingleRace(lapPages, "Laps") : null;
  return {
    year, round, available: true, name: resultRace.raceName, date: resultRace.date,
    circuit: resultRace.Circuit, results: resultRace.Results.map(normalizeResult),
    qualifying: (qualifyingRace?.QualifyingResults || []).map((row) => ({
      driver_id: row.Driver?.driverId, code: row.Driver?.code, name: [row.Driver?.givenName, row.Driver?.familyName].filter(Boolean).join(" "),
      team: row.Constructor?.name, position: number(row.position), q1: seconds(row.Q1), q2: seconds(row.Q2), q3: seconds(row.Q3),
    })),
    pits: (pitRace?.PitStops || []).map((row) => ({ driver_id: row.driverId, lap: number(row.lap), stop: number(row.stop), duration: seconds(row.duration), time: row.time })),
    laps: (lapRace?.Laps || []).map((lap) => ({ lap: number(lap.number), timings: (lap.Timings || []).map((timing) => ({ driver_id: timing.driverId, position: number(timing.position), time: seconds(timing.time) })) })),
    lap_data_available: Boolean(lapRace?.Laps?.length),
  };
}

function allowedYear(value) {
  const year = Number(value);
  const maximum = new Date().getUTCFullYear() + 1;
  return Number.isInteger(year) && year >= 1950 && year <= maximum ? year : null;
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const view = url.searchParams.get("view") || "catalog";
  const year = allowedYear(url.searchParams.get("year") || new Date().getUTCFullYear());
  const round = Number(url.searchParams.get("round"));
  if (!year) return json({ status: "error", message: "Year must be between 1950 and next season." }, 60, 400);
  if (!new Set(["catalog", "season", "race"]).has(view)) return json({ status: "error", message: "Unknown analytics view." }, 60, 400);
  if (view === "race" && (!Number.isInteger(round) || round < 1 || round > 30)) return json({ status: "error", message: "Round must be between 1 and 30." }, 60, 400);
  const cache = globalThis.caches?.default;
  const cached = cache ? await cache.match(context.request) : null;
  if (cached) return cached;
  try {
    const data = view === "catalog" ? await catalog(year)
      : view === "season" ? await season(year)
        : await race(year, round, url.searchParams.get("laps") !== "0");
    const current = year >= new Date().getUTCFullYear();
    const maxAge = current ? (view === "catalog" ? 21600 : 1800) : view === "race" ? 604800 : 86400;
    const result = json({ status: "ok", view, data }, maxAge);
    if (cache) context.waitUntil(cache.put(context.request, result.clone()));
    return result;
  } catch (error) {
    console.error("Pit Wall universe:", error);
    return json({ status: "error", message: "Historical analytics are temporarily unavailable." }, 30, 502);
  }
}
