import { describe, expect, it } from "vitest";

import { readEnvVar, upsertEnvVar } from "./env-file.mjs";

describe("readEnvVar", () => {
  it("reads a bare assignment", () => {
    expect(readEnvVar("PORT=3001\n", "PORT")).toBe("3001");
  });

  it("returns null when the name is absent", () => {
    expect(readEnvVar("PORT=3001\n", "SITE_URL")).toBe(null);
  });

  it("ignores blank lines and comments", () => {
    const text = "# a comment\n\n#PORT=9999\nPORT=3001\n";
    expect(readEnvVar(text, "PORT")).toBe("3001");
  });

  it("strips the inline comment Convex writes after CONVEX_DEPLOYMENT", () => {
    const text =
      "CONVEX_DEPLOYMENT=local:local-team-proj # team: team, project: proj\n";
    expect(readEnvVar(text, "CONVEX_DEPLOYMENT")).toBe("local:local-team-proj");
  });

  it("keeps a # that is inside a quoted value", () => {
    expect(readEnvVar('SECRET="a#b" # trailing\n', "SECRET")).toBe("a#b");
  });

  it("does not match a name that is only a suffix of another", () => {
    expect(readEnvVar("NEXT_PUBLIC_CONVEX_URL=x\n", "CONVEX_URL")).toBe(null);
  });
});

describe("upsertEnvVar", () => {
  it("appends to an empty file", () => {
    expect(upsertEnvVar("", "PORT", "3001")).toBe("PORT=3001\n");
  });

  it("appends after existing content, leaving it untouched", () => {
    const text = "# Deployment used by `npx convex dev`\nCONVEX_DEPLOYMENT=x\n";
    expect(upsertEnvVar(text, "PORT", "3001")).toBe(
      "# Deployment used by `npx convex dev`\nCONVEX_DEPLOYMENT=x\n\nPORT=3001\n",
    );
  });

  it("replaces the value in place, keeping surrounding lines and order", () => {
    const text = "A=1\nPORT=3000\nB=2\n";
    expect(upsertEnvVar(text, "PORT", "3001")).toBe("A=1\nPORT=3001\nB=2\n");
  });

  it("adds a trailing newline when the file lacks one", () => {
    expect(upsertEnvVar("A=1", "PORT", "3001")).toBe("A=1\n\nPORT=3001\n");
  });

  it("accepts an optional comment line above a newly added entry", () => {
    expect(upsertEnvVar("", "PORT", "3001", "# why")).toBe(
      "# why\nPORT=3001\n",
    );
  });

  it("does not re-add the comment when replacing an existing entry", () => {
    expect(upsertEnvVar("PORT=3000\n", "PORT", "3001", "# why")).toBe(
      "PORT=3001\n",
    );
  });
});
