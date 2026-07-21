/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// The `me` query is the seam the signed-in browser view reads its identity
// from (#39): `useConvexAuth` only exposes whether a session exists, not who it
// belongs to. Sign a user in through the real magic-link path, then act as that
// user's session to prove `me` returns their email — and nothing when nobody is
// signed in.
const modules = import.meta.glob("./**/*.ts");

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
  vi.stubEnv("SITE_URL", "http://localhost:3000");
  vi.stubEnv("CONVEX_SITE_URL", "http://localhost:3210");
  vi.stubEnv("JWT_PRIVATE_KEY", signingKey.pem);
  vi.stubEnv("JWKS", signingKey.jwks);
});

/** Completes a full magic-link sign-in so a `users` row exists to resolve. */
async function signInViaMagicLink(
  t: ReturnType<typeof convexTest>,
  email: string,
) {
  const logged: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line) => {
    logged.push(String(line));
  });
  try {
    await t.action(api.auth.signIn, { provider: "email", params: { email } });
  } finally {
    spy.mockRestore();
  }
  const link = logged.find((line) => line.includes("http"));
  const code = new URL(link!.slice(link!.indexOf("http"))).searchParams.get(
    "code",
  );
  await t.action(api.auth.signIn, { provider: "email", params: { code } });
}

test("me returns null for an unauthenticated caller", async () => {
  const t = convexTest(schema, modules);

  expect(await t.query(api.users.me, {})).toBeNull();
});

test("me returns the signed-in user's email", async () => {
  const t = convexTest(schema, modules);
  await signInViaMagicLink(t, "alice@example.com");

  const user = await t.run((ctx) => ctx.db.query("users").first());
  // Convex Auth encodes the session identity as `<userId>|<sessionId>`;
  // `getAuthUserId` reads the userId before the divider. Reproduce that so the
  // query resolves the same user a real session would.
  const asAlice = t.withIdentity({ subject: `${user!._id}|session` });

  expect(await asAlice.query(api.users.me, {})).toEqual({
    email: "alice@example.com",
  });
});
