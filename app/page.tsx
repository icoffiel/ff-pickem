"use client";

import Link from "next/link";

import { useAuthActions } from "@convex-dev/auth/react";
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useQuery,
} from "convex/react";

import { api } from "../convex/_generated/api";
import { CreateLeagueForm } from "./CreateLeagueForm";
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
      <MyLeagues />
      <CreateLeagueForm />
    </div>
  );
}

function MyLeagues() {
  const leagues = useQuery(api.leagues.myLeagues);

  if (leagues === undefined) {
    return <p>Loading your leagues…</p>;
  }

  return (
    <section>
      <h2>My leagues</h2>
      {leagues.length === 0 ? (
        <p>You&apos;re not in any leagues yet. Create one below.</p>
      ) : (
        <ul>
          {leagues.map((league) => (
            <li key={league._id}>
              <Link href={`/leagues/${league._id}`}>
                {league.name} ({league.season})
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
