import { expect, test } from "vitest";

import crons from "./crons";

// Registration is the whole content of `crons.ts`, and it is not something any
// other test would notice going missing: an unregistered sync simply never runs.

test("registers the nflverse schedule sync on a 6-hour interval", () => {
  const jobs = Object.values(crons.crons);

  expect(jobs).toHaveLength(1);
  expect(jobs[0].name).toBe("sync:scheduleSync");
  expect(jobs[0].schedule).toEqual({ type: "interval", hours: 6 });
});
