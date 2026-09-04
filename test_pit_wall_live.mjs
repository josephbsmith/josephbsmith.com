import assert from "node:assert/strict";

const { buildState, selectRace } = await import("./functions/api/pit-wall.js");

const sessions = [
  { session_key: 2, meeting_key: 20, session_name: "Race", country_name: "Italy", date_start: "2026-09-06T13:00:00Z", date_end: "2026-09-06T15:00:00Z" },
  { session_key: 3, meeting_key: 30, session_name: "Race", country_name: "Spain", date_start: "2026-09-13T13:00:00Z", date_end: "2026-09-13T15:00:00Z" },
];
const meetings = [
  { meeting_key: 20, meeting_name: "Italian Grand Prix" },
  { meeting_key: 30, meeting_name: "Spanish Grand Prix" },
];

const before = selectRace(sessions, meetings, Date.parse("2026-09-04T12:00:00Z"));
assert.equal(before.active, null);
assert.equal(before.next.meeting_name, "Italian Grand Prix");
const live = selectRace(sessions, meetings, Date.parse("2026-09-06T14:00:00Z"));
assert.equal(live.active.session_key, 2);
assert.equal(live.next.session_key, 3);

const state = buildState({
  drivers: [
    { driver_number: 1, name_acronym: "AAA", team_name: "Alpha", team_colour: "ff0000" },
    { driver_number: 2, name_acronym: "BBB", team_name: "Beta", team_colour: "00ff00" },
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
    { driver_number: 1, lap_number: 10, lap_duration: 90 },
    { driver_number: 1, lap_number: 11, lap_duration: 91 },
    { driver_number: 1, lap_number: 12, lap_duration: 92 },
    { driver_number: 2, lap_number: 12, lap_duration: 93 },
  ],
  stints: [
    { driver_number: 1, stint_number: 1, lap_start: 1, lap_end: 12, compound: "MEDIUM", tyre_age_at_start: 0 },
    { driver_number: 2, stint_number: 1, lap_start: 1, lap_end: 12, compound: "HARD", tyre_age_at_start: 0 },
  ],
  race_control: [{ lap_number: 12, date: "2026-09-06T14:00:00Z", message: "DRS ENABLED" }],
  weather: [{ date: "2026-09-06T14:00:00Z", air_temperature: 26 }],
});

assert.equal(state.lap_number, 12);
assert.equal(state.board[0].name, "AAA");
assert.equal(state.board[0].recent_pace_seconds, 91);
assert.equal(state.board[1].estimated_rejoin_position, 2);
assert.equal(state.weather.air_temperature, 26);
assert.match(state.board[0].pace_sparkline_path, /^M/);

console.log("pit wall live state: ok");
