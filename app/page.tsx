"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useQuery,
} from "convex/react";

import { api } from "../convex/_generated/api";
import { SignInForm } from "./SignInForm";

export default function Page() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>NFL Pick&apos;em</h1>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <SignInForm />
      </Unauthenticated>
      <Authenticated>
        <SignedIn />
      </Authenticated>
    </main>
  );
}

function SignedIn() {
  const me = useQuery(api.users.me);
  const { signOut } = useAuthActions();

  return (
    <div>
      <p>
        Signed in as <strong>{me?.email ?? "…"}</strong>
      </p>
      <button onClick={() => void signOut()}>Sign out</button>
    </div>
  );
}
