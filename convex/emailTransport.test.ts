import { describe, expect, test } from "vitest";

import {
  consoleTransport,
  resendTransport,
  resolveTransport,
  senderAddress,
} from "./emailTransport";

// The transport seam (#33). Development does not depend on inbox delivery, and
// the eventual domain migration (#22) is a config change, not a refactor.

describe("consoleTransport", () => {
  test("writes the magic link and its recipient to the log", async () => {
    const lines: string[] = [];

    await consoleTransport((line) => lines.push(line))({
      to: "alice@example.com",
      from: "onboarding@resend.dev",
      url: "https://example.com/verify?token=abc123",
    });

    const output = lines.join("\n");
    expect(output).toContain("https://example.com/verify?token=abc123");
    expect(output).toContain("alice@example.com");
  });
});

describe("resendTransport", () => {
  test("posts the message to Resend with the configured sender", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"id":"re_123"}', { status: 200 });
    };

    await resendTransport(
      "re_test_key",
      fakeFetch as never,
    )({
      to: "alice@example.com",
      from: "noreply@example.com",
      url: "https://example.com/verify?token=abc123",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("api.resend.com");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.from).toBe("noreply@example.com");
    expect(body.to).toBe("alice@example.com");
  });

  test("strips a trailing carriage return from the API key before signing the header", async () => {
    // `npx convex env set` keeps a trailing \r on values piped from a shell,
    // and `Bearer re_...\r` is an unparseable header value (#40).
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"id":"re_123"}', { status: 200 });
    };

    await resendTransport(
      "re_test_key\r",
      fakeFetch as never,
    )({
      to: "alice@example.com",
      from: "noreply@example.com",
      url: "https://example.com/verify?token=abc123",
    });

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
  });

  test("surfaces a failed send rather than silently succeeding", async () => {
    const fakeFetch = async () =>
      new Response('{"message":"Domain not verified"}', { status: 403 });

    await expect(
      resendTransport(
        "re_test_key",
        fakeFetch as never,
      )({
        to: "bob@example.com",
        from: "noreply@example.com",
        url: "https://example.com/verify?token=abc123",
      }),
    ).rejects.toThrow(/Domain not verified/);
  });
});

describe("resolveTransport", () => {
  test("selects the console transport by name", () => {
    expect(resolveTransport("console")).toBeTypeOf("function");
  });

  test("selects the Resend transport by name", () => {
    expect(resolveTransport("resend", "re_test_key")).toBeTypeOf("function");
  });

  test("rejects an unknown transport name rather than falling back", () => {
    expect(() => resolveTransport("carrier-pigeon")).toThrow(/carrier-pigeon/);
  });

  test("treats a whitespace-only Resend key as unset, naming the variable at fault", () => {
    // A \r-only or blank key must fail with an actionable, named error rather
    // than handing `fetch` a `Bearer \r` header it cannot parse (#40).
    expect(() => resolveTransport("resend", "  ")).toThrow(/RESEND_API_KEY/);
    expect(() => resolveTransport("resend", "\r")).toThrow(/RESEND_API_KEY/);
  });
});

describe("senderAddress", () => {
  test("reads the sender from the environment", () => {
    expect(senderAddress({ AUTH_EMAIL_FROM: "noreply@example.com" })).toBe(
      "noreply@example.com",
    );
  });

  test("trims surrounding whitespace so no carriage return reaches the JSON body", () => {
    expect(senderAddress({ AUTH_EMAIL_FROM: "noreply@example.com\r" })).toBe(
      "noreply@example.com",
    );
  });

  test("fails with a named error when the sender is not configured", () => {
    expect(() => senderAddress({})).toThrow(/AUTH_EMAIL_FROM/);
  });

  test("treats an all-whitespace sender the same as unset", () => {
    expect(() => senderAddress({ AUTH_EMAIL_FROM: "  \r" })).toThrow(
      /AUTH_EMAIL_FROM/,
    );
  });
});
