import assert from "node:assert/strict";

const { buildState, normalizeCalendar, selectSession } = await import("./functions/api/pit-wall.js");

const calendar = normalizeCalendar({ Meetings: [{
  Key: 20, Name: "Italian Grand Prix", OfficialName: "FORMULA 1 ITALIAN GRAND PRIX 2026",
  Location: "Monza", Country: { Code: "ITA", Name: "Italy" }, Circuit: { ShortName: "Monza" },
  Sessions: [{ Key: 1, Type: "Practice", Name: "Practice 1", StartDate: "2026-09-04T12:30:00", EndDate: "2026-09-04T13:30:00", GmtOffset: "02:00:00" }],
}] });
assert.equal(calendar.sessions[0].date_start, "2026-09-04T10:30:00.000Z");
assert.equal(calendar.sessions[0].meeting_key, 20);
assert.equal(calendar.meetings[0].circuit_short_name, "Monza");

const sessions = [
  { session_key: 1, meeting_key: 20, session_name: "Practice 1", session_type: "Practice", country_name: "Italy", date_start: "2026-09-04T10:00:00Z", date_end: "2026-09-04T11:00:00Z" },
  { session_key: 2, meeting_key: 20, session_name: "Practice 2", session_type: "Practice", country_name: "Italy", date_start: "2026-09-04T14:00:00Z", date_end: "2026-09-04T15:00:00Z" },
  { session_key: 3, meeting_key: 20, session_name: "Qualifying", session_type: "Qualifying", country_name: "Italy", date_start: "2026-09-05T14:00:00Z", date_end: "2026-09-05T15:00:00Z" },
  { session_key: 4, meeting_key: 20, session_name: "Race", session_type: "Race", country_name: "Italy", date_start: "2026-09-06T13:00:00Z", date_end: "2026-09-06T15:00:00Z" },
];
const meetings = [{ meeting_key: 20, meeting_name: "Italian Grand Prix" }];

const between = selectSession(sessions, meetings, Date.parse("2026-09-04T12:00:00Z"));
assert.equal(between.active, null);
assert.equal(between.latest.session_name, "Practice 1");
assert.equal(between.next.session_name, "Practice 2");
const live = selectSession(sessions, meetings, Date.parse("2026-09-04T14:30:00Z"));
assert.equal(live.active.session_key, 2);
assert.equal(live.next.session_key, 3);

const state = buildState({
  session: [sessions[3]],
  sessions,
  meeting: meetings,
  drivers: [
    { driver_number: 1, name_acronym: "AAA", full_name: "Alice Apex", team_name: "Alpha", team_colour: "ff0000" },
    { driver_number: 2, name_acronym: "BBB", full_name: "Bob Brake", team_name: "Beta", team_colour: "00ff00" },
  ],
  position: [
    { driver_number: 1, position: 1, date: "2026-09-06T14:00:00Z" },
    { driver_number: 2, position: 2, date: "2026-09-06T14:00:00Z" },
  ],
  intervals: [
    { driver_number: 1, gap_to_leader: 0, interval: 0, date: "2026-09-06T14:00:00Z" },
    { driver_number: 2, gap_to_leader: 4.5, interval: 4.5, date: "2026-09-06T14:00:00Z" },
  ],
  laps: [
    { driver_number: 1, lap_number: 10, lap_duration: 90, duration_sector_1: 30, duration_sector_2: 30, duration_sector_3: 30, st_speed: 320 },
    { driver_number: 1, lap_number: 11, lap_duration: 91, duration_sector_1: 30, duration_sector_2: 30, duration_sector_3: 31 },
    { driver_number: 1, lap_number: 12, lap_duration: 92, duration_sector_1: 30, duration_sector_2: 31, duration_sector_3: 31 },
    { driver_number: 2, lap_number: 12, lap_duration: 93 },
  ],
  stints: [
    { driver_number: 1, stint_number: 1, lap_start: 1, lap_end: 12, compound: "MEDIUM", tyre_age_at_start: 0 },
    { driver_number: 2, stint_number: 1, lap_start: 1, lap_end: 12, compound: "HARD", tyre_age_at_start: 0 },
  ],
  race_control: [{ lap_number: 12, date: "2026-09-06T14:00:00Z", message: "DRS ENABLED", category: "Other" }],
  weather: [{ date: "2026-09-06T14:00:00Z", air_temperature: 26 }],
  pit: [{ driver_number: 1, lap_number: 8, date: "2026-09-06T13:50:00Z", stop_duration: 2.4, lane_duration: 20.1 }],
  overtakes: [{ overtaking_driver_number: 1, overtaken_driver_number: 2, position: 1, date: "2026-09-06T13:55:00Z" }],
  session_result: [{ driver_number: 1, position: 1 }, { driver_number: 2, position: 2 }],
  starting_grid: [{ driver_number: 1, position: 2 }, { driver_number: 2, position: 1 }],
  team_radio: [{ driver_number: 1, date: "2026-09-06T14:01:00Z", recording_url: "https://example.com/radio.mp3" }],
  championship_drivers: [{ driver_number: 1, position_current: 1, points_current: 100 }],
  championship_teams: [{ team_name: "Alpha", position_current: 1, points_current: 150 }],
  car_data: [{ driver_number: 1, date: "2026-09-06T14:01:00Z", speed: 315, throttle: 100, n_gear: 8, rpm: 11000, brake: 0, drs: 12 }],
  location: [
    { driver_number: 1, date: "2026-09-06T14:00:58Z", x: 100, y: 100, z: 0 },
    { driver_number: 1, date: "2026-09-06T14:00:59Z", x: 200, y: 150, z: 0 },
    { driver_number: 2, date: "2026-09-06T14:00:59Z", x: 150, y: 125, z: 0 },
  ],
});

assert.equal(state.session.session_name, "Race");
assert.equal(state.sessions.length, 4);
assert.equal(state.lap_number, 12);
assert.equal(state.board[0].name, "AAA");
assert.equal(state.board[0].recent_pace_seconds, 91);
assert.equal(state.board[0].speed_trap, 320);
assert.equal(state.board[0].pit_stops, 1);
assert.equal(state.board[0].telemetry.speed, 315);
assert.equal(state.board[1].estimated_rejoin_position, 2);
assert.equal(state.weather.air_temperature, 26);
assert.equal(state.events.length, 4);
assert.equal(state.track.cars.length, 2);
assert.match(state.board[0].pace_sparkline_path, /^M/);

console.log("pit wall session state: ok");
