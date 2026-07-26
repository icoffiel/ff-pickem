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

import { SignInForm } from "@/app/SignInForm";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

// The league roster page (M2b, #59): every member sees who is playing; the
// commissioner also sees the invite-by-email form and the outstanding pending
// invites. Deliberately unstyled — the visual pass is M6 (#21); this only
// proves the flow is reachable and wired to `leagueRoster` / `createInvite`.
export default function LeaguePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const leagueId = id as Id<"leagues">;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <p>
        <Link href="/">← Back</Link>
      </p>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <SignInForm />
      </Unauthenticated>
      <Authenticated>
        <Roster leagueId={leagueId} />
      </Authenticated>
    </main>
  );
}

function Roster({ leagueId }: { leagueId: Id<"leagues"> }) {
  const roster = useQuery(api.invites.leagueRoster, { leagueId });

  if (roster === undefined) {
    return <p>Loading roster…</p>;
  }

  const isCommissioner = roster.pendingInvites !== undefined;

  return (
    <div>
      <section>
        <h2>Members</h2>
        <ul>
          {roster.members.map((member, index) => (
            <li key={index}>
              {member.teamName}
              {member.role === "commissioner" ? " (commissioner)" : ""}
            </li>
          ))}
        </ul>
      </section>

      {isCommissioner && (
        <>
          <InviteMemberForm leagueId={leagueId} />
          <section>
            <h2>Pending invites</h2>
            {roster.pendingInvites!.length === 0 ? (
              <p>No pending invites.</p>
            ) : (
              <ul>
                {roster.pendingInvites!.map((invite) => (
                  <li key={invite.targetEmail}>{invite.targetEmail}</li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function InviteMemberForm({ leagueId }: { leagueId: Id<"leagues"> }) {
  const createInvite = useMutation(api.invites.createInvite);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await createInvite({ leagueId, email });
      setMessage(
        result.status === "alreadyMember"
          ? `${email} is already a member.`
          : `Invited ${email}.`,
      );
      setEmail("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)}>
      <h2>Invite a member</h2>
      <label>
        Email
        <input
          name="email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <button type="submit" disabled={submitting}>
        Send invite
      </button>
      {message && <p>{message}</p>}
    </form>
  );
}
