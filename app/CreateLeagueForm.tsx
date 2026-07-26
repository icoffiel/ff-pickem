"use client";

import { FormEvent, useState } from "react";

import { useMutation } from "convex/react";

import { api } from "@/convex/_generated/api";

// The signed-in create-league form (M2a, #58): a league name + the creator's
// own team name. On submit the caller is born the league's commissioner.
// Deliberately unstyled — the visual pass is M6 (#21); this only proves the
// flow is reachable and wired.
export function CreateLeagueForm() {
  const createLeague = useMutation(api.leagues.createLeague);
  const [name, setName] = useState("");
  const [teamName, setTeamName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await createLeague({ name, teamName });
      setName("");
      setTeamName("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <h2>Create a league</h2>
      <label>
        League name
        <input
          name="name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        Your team name
        <input
          name="teamName"
          required
          value={teamName}
          onChange={(event) => setTeamName(event.target.value)}
        />
      </label>
      <button type="submit" disabled={submitting}>
        Create league
      </button>
    </form>
  );
}
