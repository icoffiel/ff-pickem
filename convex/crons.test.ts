import { expect, test } from "vitest";

import crons from "./crons";

// Registration is the whole content of `crons.ts`, and it is not something any
// other test would notice going missing: an unregistered sync simply never runs.

const jobNamed = (name: string) =>
  Object.values(crons.crons).find((job) => job.name === name);

test("registers the nflverse schedule sync on a 6-hour interval", () => {
  expect(jobNamed("sync:scheduleSync")?.schedule).toEqual({
    type: "interval",
    hours: 6,
  });
});

test("registers the ESPN live sync every 15 minutes, year-round", () => {
  // Year-round on purpose: `liveSync` gates itself against the database before
  // spending a fetch, so an out-of-season run is a no-op. No in-season cron
  // expression is needed — see the action.
  expect(jobNamed("sync:liveSync")?.schedule).toEqual({
    type: "interval",
    minutes: 15,
  });
});

test("registers nothing else", () => {
  expect(
    Object.values(crons.crons)
      .map((job) => job.name)
      .sort(),
  ).toEqual(["sync:liveSync", "sync:scheduleSync"]);
});
