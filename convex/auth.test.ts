/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// End-to-end auth through the convex-test seam (#16 stories 4-5, #33 AC 3-4).
// The transport is the console one, so no network and no inbox: any address
// can sign in, which is what makes M2's multi-member flows developable.
const modules = import.meta.glob("./**/*.ts");

/** Convex Auth signs session tokens with an RS256 key from JWT_PRIVATE_KEY.
 * Generated per run rather than committed, so nothing key-shaped lives in the
 * repo and the tests need no provisioned secret. */
async function generateSigningKey() {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", privateKey),
  );
  const base64 = btoa(String.fromCharCode(...pkcs8));
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----`,
    jwks: JSON.stringify({
      keys: [
        { use: "sig", ...(await crypto.subtle.exportKey("jwk", publicKey)) },
      ],
    }),
  };
}

let signingKey: Awaited<ReturnType<typeof generateSigningKey>>;

beforeAll(async () => {
  signingKey = await generateSigningKey();
});

beforeEach(() => {
  vi.stubEnv("AUTH_EMAIL_TRANSPORT", "console");
  vi.stubEnv("AUTH_EMAIL_FROM", "onboarding@resend.dev");
  // Where the magic link points; the verification `code` is appended to it.
  vi.stubEnv("SITE_URL", "http://localhost:3000");
  // The Convex deployment's own HTTP origin (issuer of the session tokens).
  vi.stubEnv("CONVEX_SITE_URL", "http://localhost:3210");
  vi.stubEnv("JWT_PRIVATE_KEY", signingKey.pem);
  vi.stubEnv("JWKS", signingKey.jwks);
});

/** Drives a full magic-link sign-in the way a developer does locally:
 * start sign-in, read the link out of the server log, open it. */
async function signInViaMagicLink(
  t: ReturnType<typeof convexTest>,
  email: string,
) {
  const logged: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line) => {
    logged.push(String(line));
  });
  try {
    await t.action(api.auth.signIn, {
      provider: "email",
      params: { email },
    });
  } finally {
    spy.mockRestore();
  }

  const link = logged.find((line) => line.includes("http"));
  expect(link, "no magic link was written to the log").toBeDefined();
  const code = new URL(link!.slice(link!.indexOf("http"))).searchParams.get(
    "code",
  );
  expect(code, "magic link carried no code").toBeTruthy();

  await t.action(api.auth.signIn, { provider: "email", params: { code } });
}

test("signing in with an arbitrary address creates exactly one user", async () => {
  const t = convexTest(schema, modules);

  await signInViaMagicLink(t, "alice@example.com");

  const users = await t.run((ctx) => ctx.db.query("users").collect());
  expect(users.map((u) => u.email)).toEqual(["alice@example.com"]);
});

test("signing in again with the same address resolves to the same user", async () => {
  const t = convexTest(schema, modules);

  await signInViaMagicLink(t, "alice@example.com");
  const first = await t.run((ctx) => ctx.db.query("users").collect());
  await signInViaMagicLink(t, "alice@example.com");
  const second = await t.run((ctx) => ctx.db.query("users").collect());

  expect(second).toHaveLength(1);
  expect(second[0]._id).toBe(first[0]._id);
});

test("two different addresses produce two distinct users", async () => {
  const t = convexTest(schema, modules);

  await signInViaMagicLink(t, "alice@example.com");
  await signInViaMagicLink(t, "bob@example.com");

  const users = await t.run((ctx) => ctx.db.query("users").collect());
  expect(users.map((u) => u.email).sort()).toEqual([
    "alice@example.com",
    "bob@example.com",
  ]);
});
