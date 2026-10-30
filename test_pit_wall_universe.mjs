import assert from "node:assert/strict";
import { buildSeasonAnalytics, mergeRaceCollection, normalizeCatalog } from "./functions/api/pit-wall-universe.js";

const driver = (id, code, givenName, familyName) => ({ driverId: id, code, givenName, familyName, nationality: "Test" });
const constructor = (id, name) => ({ constructorId: id, name });
const result = (id, code, givenName, familyName, teamId, team, position, grid, points, status = "Finished") => ({
  number: String(position), position: String(position), positionText: String(position), grid: String(grid), points: String(points), laps: "50", status,
  Driver: driver(id, code, givenName, familyName), Constructor: constructor(teamId, team),
  FastestLap: { rank: position === 1 ? "1" : "2", lap: "40", Time: { time: position === 1 ? "1:20.000" : "1:21.000" } },
});

const splitPages = [
  { MRData: { RaceTable: { Races: [{ season: "2025", round: "1", raceName: "Alpha Grand Prix", Results: [{ position: "1" }] }] } } },
  { MRData: { RaceTable: { Races: [{ season: "2025", round: "1", raceName: "Alpha Grand Prix", Results: [{ position: "2" }] }, { season: "2025", round: "2", raceName: "Beta Grand Prix", Results: [{ position: "1" }] }] } } },
];
const merged = mergeRaceCollection(splitPages, "Results");
assert.equal(merged.length, 2);
assert.equal(merged[0].Results.length, 2);

const catalog = normalizeCatalog(2025, [{
  season: "2025", round: "1", raceName: "Alpha Grand Prix", date: "2025-03-01", time: "12:00:00Z",
  Circuit: { circuitId: "alpha", circuitName: "Alpha Ring", Location: { locality: "Alpha", country: "Test", lat: "1", long: "2" } },
}], [{ session_key: 9001, meeting_key: 8001, session_name: "Race", session_type: "Race", date_start: "2025-03-01T12:00:00Z", date_end: "2025-03-01T14:00:00Z" }], [{ meeting_key: 8001, circuit_type: "Permanent", circuit_image: "track.png" }], Date.parse("2025-03-02"));
assert.equal(catalog[0].session_key, 9001);
assert.equal(catalog[0].detailed, true);
assert.equal(catalog[0].status, "complete");

const raceRows = [
  { season: "2025", round: "1", raceName: "Alpha Grand Prix", date: "2025-03-01", Circuit: { circuitId: "alpha", circuitName: "Alpha", Location: { locality: "A", country: "Test" } }, Results: [
    result("ada", "ADA", "Ada", "Apex", "red", "Red", 1, 2, 25),
    result("bob", "BOB", "Bob", "Brake", "blue", "Blue", 2, 1, 18),
  ] },
  { season: "2025", round: "2", raceName: "Beta Grand Prix", date: "2025-03-08", Circuit: { circuitId: "beta", circuitName: "Beta", Location: { locality: "B", country: "Test" } }, Results: [
    result("bob", "BOB", "Bob", "Brake", "blue", "Blue", 1, 1, 25),
    result("ada", "ADA", "Ada", "Apex", "red", "Red", 2, 2, 18, "Retired"),
  ] },
];
const sprintRows = [{ season: "2025", round: "2", SprintResults: [{ Driver: driver("ada", "ADA", "Ada", "Apex"), Constructor: constructor("red", "Red"), points: "8", position: "1" }] }];
const analytics = buildSeasonAnalytics({
  year: 2025, raceRows, sprintRows,
  driverStandings: [{ id: "ada", position: 1, points: 51, wins: 1 }, { id: "bob", position: 2, points: 43, wins: 1 }],
  constructorStandings: [{ id: "red", position: 1, points: 51, wins: 1 }, { id: "blue", position: 2, points: 43, wins: 1 }],
});
assert.equal(analytics.summary.races, 2);
assert.equal(analytics.summary.winners, 2);
assert.equal(analytics.drivers[0].name, "Ada Apex");
assert.equal(analytics.drivers[0].points, 51);
assert.equal(analytics.drivers[0].sprint_points, 8);
assert.equal(analytics.drivers[0].dnfs, 1);
assert.deepEqual(analytics.progression.drivers.find((row) => row.id === "ada").values, [25, 51]);
assert.equal(analytics.teams[0].name, "Red");

console.log("pit wall universe analytics: ok");
