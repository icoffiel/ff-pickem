"use client";

import { FormEvent, use, useState } from "react";
import Link from "next/link";

import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useMutation,
  useQuery,
} from "convex/react";
import { ConvexError } from "convex/values";

import { currentMinute } from "@/app/currentMinute";
import { SignInForm } from "@/app/SignInForm";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

// The make-picks screen (M4, #19): the week's slate, the deadline, the caller's
// own picks and their tiebreaker guess. Deliberately unstyled — the visual pass
// is M6 (#21); this proves the flow is reachable and wired to `pickSheet`,
// `makePick` and `setTiebreakerGuess`.

export default function PicksPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const leagueId = id as Id<"leagues">;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <p>
        <Link href={`/leagues/${id}`}>← Back to league</Link>
      </p>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <SignInForm />
      </Unauthenticated>
      <Authenticated>
        <PickSheet leagueId={leagueId} />
      </Authenticated>
    </main>
  );
}

/** A refusal from the backend, in the member's terms. */
function refusalMessage(error: unknown): string {
  const code =
    error instanceof ConvexError
      ? (error.data as { code?: string }).code
      : undefined;
  switch (code) {
    case "WeekLocked":
      return "This week has locked — picks can no longer be changed.";
    case "NotOnSlate":
      return "That game isn't part of this week's slate.";
    case "NotMember":
      return "You're not an active member of this league.";
    case "NotSignedIn":
      return "Your session has ended. Sign in again to make picks.";
    case "InvalidGuess":
      return "A tiebreaker guess must be a whole number of points.";
    case "NoSlate":
      return "This week has no games to pick.";
    default:
      return "Something went wrong. Please try again.";
  }
}

/** How a graded pick reads on screen. `pending` and `absent` say nothing yet. */
const RESULT_LABEL: Record<string, string> = {
  correct: "✓ correct",
  incorrect: "✗ incorrect",
  push: "— push",
};

function PickSheet({ leagueId }: { leagueId: Id<"leagues"> }) {
  // `undefined` means "whichever week is active" — the screen opens on it, and
  // choosing a week from the picker is what pins it (pick-ahead).
  const [week, setWeek] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const sheet = useQuery(api.picks.pickSheet, {
    leagueId,
    week,
    now: currentMinute(),
  });
  const makePick = useMutation(api.picks.makePick);

  if (sheet === undefined) {
    return <p>Loading this week…</p>;
  }

  async function pick(gameId: Id<"games">, selection: "home" | "away") {
    setError(null);
    try {
      await makePick({ leagueId, gameId, selection });
    } catch (caught) {
      setError(refusalMessage(caught));
    }
  }

  return (
    <div>
      <h1>Week {sheet.week}</h1>

      <label>
        Week
        <select
          value={sheet.week}
          onChange={(event) => setWeek(Number(event.target.value))}
        >
          {sheet.weeks.map((option) => (
            <option key={option} value={option}>
              Week {option}
              {option === sheet.activeWeek ? " (this week)" : ""}
            </option>
          ))}
        </select>
      </label>

      <p>
        {sheet.lockAt === null
          ? "No games count this week."
          : sheet.locked
            ? `Locked at ${new Date(sheet.lockAt).toLocaleString()}.`
            : `Picks lock at ${new Date(sheet.lockAt).toLocaleString()}.`}
      </p>
      {error && <p role="alert">{error}</p>}

      <ul>
        {sheet.games.map((game) => (
          <li key={game.gameId}>
            {game.awayTeam} @ {game.homeTeam} —{" "}
            {new Date(game.kickoffAt).toLocaleString()}
            {["away", "home"].map((side) => (
              <button
                key={side}
                type="button"
                disabled={sheet.locked}
                aria-pressed={game.selection === side}
                onClick={() => void pick(game.gameId, side as "home" | "away")}
              >
                {game.selection === side ? "▸ " : ""}
                {side === "away" ? game.awayTeam : game.homeTeam}
              </button>
            ))}
            {game.homeScore !== null && game.awayScore !== null && (
              <span>
                {" "}
                ({game.awayScore}–{game.homeScore})
              </span>
            )}
            {RESULT_LABEL[game.result] && (
              <span> {RESULT_LABEL[game.result]}</span>
            )}
            {game.gameId === sheet.tiebreakerGameId && (
              <span> ★ tiebreaker game</span>
            )}
          </li>
        ))}
      </ul>

      <TiebreakerGuessForm
        leagueId={leagueId}
        week={sheet.week}
        locked={sheet.locked}
        current={sheet.tiebreakerGuess}
        onError={setError}
      />
    </div>
  );
}

/**
 * The week's combined-points guess. Optional by design — submitting picks
 * without one is allowed, and costs only the weekly tiebreaker.
 */
function TiebreakerGuessForm({
  leagueId,
  week,
  locked,
  current,
  onError,
}: {
  leagueId: Id<"leagues">;
  week: number;
  locked: boolean;
  current: number | null;
  onError: (message: string | null) => void;
}) {
  const setTiebreakerGuess = useMutation(api.picks.setTiebreakerGuess);
  const [points, setPoints] = useState("");
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    onError(null);
    try {
      await setTiebreakerGuess({ leagueId, week, points: Number(points) });
      setPoints("");
    } catch (caught) {
      onError(refusalMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <h2>Tiebreaker</h2>
      <p>
        Combined points in the ★ game.{" "}
        {current === null ? "No guess yet." : `Your guess: ${current}.`}
      </p>
      <label>
        Points
        <input
          name="points"
          type="number"
          min={0}
          step={1}
          required
          disabled={locked}
          value={points}
          onChange={(event) => setPoints(event.target.value)}
        />
      </label>
      <button type="submit" disabled={locked || saving}>
        Save guess
      </button>
    </form>
  );
}
