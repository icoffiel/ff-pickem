import { describe, expect, test } from "vitest";

import { effectiveOutcome, gradePick } from "./grading";

describe("gradePick", () => {
  test("is correct when the picked team won", () => {
    expect(gradePick("home", "home")).toBe("correct");
    expect(gradePick("away", "away")).toBe("correct");
  });

  test("is incorrect when the other team won", () => {
    expect(gradePick("home", "away")).toBe("incorrect");
    expect(gradePick("away", "home")).toBe("incorrect");
  });

  test("is a push on a tie, whichever team was picked", () => {
    expect(gradePick("home", "tie")).toBe("push");
    expect(gradePick("away", "tie")).toBe("push");
  });

  test("is a push on a voided game", () => {
    expect(gradePick("home", "void")).toBe("push");
    expect(gradePick("away", "void")).toBe("push");
  });

  test("is pending while the game has no outcome yet", () => {
    expect(gradePick("home", undefined)).toBe("pending");
  });

  test("is absent when no pick was made", () => {
    expect(gradePick(undefined, "home")).toBe("absent");
  });

  test("is absent — not pending — for an unpicked game with no outcome", () => {
    expect(gradePick(undefined, undefined)).toBe("absent");
  });
});

describe("effectiveOutcome", () => {
  test("is the game's own outcome when the league has no override", () => {
    expect(effectiveOutcome({ outcome: "home" }, undefined)).toBe("home");
  });

  test("is undefined while an un-overridden game is unfinished", () => {
    expect(effectiveOutcome({}, undefined)).toBeUndefined();
  });

  test("is the override when the commissioner has corrected the game", () => {
    expect(effectiveOutcome({ outcome: "home" }, { outcome: "away" })).toBe(
      "away",
    );
  });

  test("is the override even before the game has an outcome of its own", () => {
    expect(effectiveOutcome({}, { outcome: "void" })).toBe("void");
  });

  test("grades a pick against the correction, not the raw result", () => {
    const game = { outcome: "home" } as const;

    expect(gradePick("away", effectiveOutcome(game, undefined))).toBe(
      "incorrect",
    );
    expect(gradePick("away", effectiveOutcome(game, { outcome: "away" }))).toBe(
      "correct",
    );
    expect(gradePick("away", effectiveOutcome(game, { outcome: "void" }))).toBe(
      "push",
    );
  });
});
