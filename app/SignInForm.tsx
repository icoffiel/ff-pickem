"use client";

import { FormEvent, useState } from "react";

import { useAuthActions } from "@convex-dev/auth/react";

// The signed-out view (#39): an email field that starts magic-link sign-in.
// Deliberately unstyled — the visual pass is M6 (#21). This only proves the
// flow is reachable and wired.
//
// `redirectTo` is where the magic link lands once the address is proven, so an
// invitee arriving at `/invite/<token>` signed out comes back to that same
// invite instead of the home page (#60).
export function SignInForm({ redirectTo }: { redirectTo?: string }) {
  const { signIn } = useAuthActions();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <p>
        Check your email for a sign-in link. In local development it is written
        to the <code>convex dev</code> log instead of sent.
      </p>
    );
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await signIn(
        "email",
        redirectTo === undefined ? { email } : { email, redirectTo },
      );
      setSent(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <label>
        Email
        <input
          type="email"
          name="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <button type="submit" disabled={submitting}>
        Sign in
      </button>
    </form>
  );
}
