import { query } from "./_generated/server";

// Throwaway proof-of-wiring query (build-spec M0 / issue #23).
// Returns a constant so the landing page and the convex-test seam can both
// assert a full client<->backend round-trip. Replaced once M1 lands real queries.
export const get = query({
  args: {},
  handler: async () => {
    return "pong";
  },
});
