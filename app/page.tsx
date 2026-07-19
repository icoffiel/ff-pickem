"use client";

import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

export default function Page() {
  const ping = useQuery(api.ping.get);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>NFL Pick&apos;em</h1>
      <p>
        Convex round-trip:{" "}
        <strong>{ping === undefined ? "loading…" : ping}</strong>
      </p>
    </main>
  );
}
