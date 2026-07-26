"use client";

import { FormEvent, use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useMutation,
  useQuery,
} from "convex/react";
import { ConvexError } from "convex/values";

import { SignInForm } from "@/app/SignInForm";
import { api } from "@/convex/_generated/api";

// The invite accept screen (M2c, #60). The token in the URL is only a
// deep-link; what makes the invite yours is the email you signed in with, so
// this page reads `myPendingInvites` — scoped to the caller's own address — and
// finds the token in it. A token that isn't in that list gets one honest
// refusal, whether it is expired, spent, or addressed to someone else.
// Deliberately unstyled — the visual pass is M6 (#21).
export default function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>You&apos;re invited</h1>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <p>
          Sign in with the email address this invite was sent to, and the link
          will bring you back here.
        </p>
        <SignInForm redirectTo={`/invite/${token}`} />
      </Unauthenticated>
      <Authenticated>
        <AcceptInvite token={token} />
      </Authenticated>
    </main>
  );
}

function AcceptInvite({ token }: { token: string }) {
  const invites = useQuery(api.invites.myPendingInvites);

  if (invites === undefined) {
    return <p>Checking your invite…</p>;
  }

  const invite = invites.find((i) => i.token === token);
  if (invite === undefined) {
    return (
      <div>
        <p>
          This invite isn&apos;t available for the email you&apos;re signed in
          with. It may have expired, already been used, or been sent to a
          different address.
        </p>
        <p>
          Ask your commissioner for a fresh invite, or{" "}
          <Link href="/">go back home</Link>.
        </p>
      </div>
    );
  }

  return <JoinLeagueForm token={invite.token} leagueName={invite.leagueName} />;
}

/** The refusals `redeem` can raise, in the invitee's language. */
const REFUSAL_MESSAGES: Record<string, string> = {
  EmailMismatch:
    "This invite was sent to a different email address. Sign in as that address to join.",
  InviteExpired:
    "This invite is no longer valid. Ask your commissioner for a fresh one.",
  InviteNotFound:
    "We couldn't find this invite. Ask your commissioner for a fresh link.",
  EmptyField: "Please choose a team name.",
};

function refusalMessage(error: unknown): string {
  const data = error instanceof ConvexError ? error.data : undefined;
  const code =
    typeof data === "object" && data !== null && "code" in data
      ? String((data as { code: unknown }).code)
      : undefined;
  return (
    (code === undefined ? undefined : REFUSAL_MESSAGES[code]) ??
    "Something went wrong joining the league. Please try again."
  );
}

function JoinLeagueForm({
  token,
  leagueName,
}: {
  token: string;
  leagueName: string;
}) {
  const redeem = useMutation(api.invites.redeem);
  const router = useRouter();
  const [teamName, setTeamName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const leagueId = await redeem({ token, teamName });
      router.push(`/leagues/${leagueId}`);
    } catch (caught) {
      setError(refusalMessage(caught));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <p>
        Join <strong>{leagueName}</strong>. Pick the team name you want to play
        under — it&apos;s how you&apos;ll appear on the board.
      </p>
      <label>
        Team name
        <input
          name="teamName"
          required
          value={teamName}
          onChange={(event) => setTeamName(event.target.value)}
        />
      </label>
      <button type="submit" disabled={submitting}>
        Join league
      </button>
      {error && <p>{error}</p>}
    </form>
  );
}
