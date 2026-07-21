"use client";

import { ConvexAuthNextjsProvider } from "@convex-dev/auth/nextjs";
import { ConvexReactClient } from "convex/react";
import { ReactNode } from "react";

// The auth-aware Convex provider (#39). Replaces the plain `ConvexProvider`
// from M0 (#23) so `useAuthActions` and the `Authenticated`/`Unauthenticated`
// components have a session context to read. Pairs with the server provider in
// layout.tsx and the middleware, which keep the session in sync across reloads.
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

if (!convexUrl) {
  throw new Error(
    "Missing NEXT_PUBLIC_CONVEX_URL. Run `npx convex dev` and copy the deployment URL into .env.local (see .env.example).",
  );
}

const convex = new ConvexReactClient(convexUrl);

export function ConvexClientProvider({ children }: { children: ReactNode }) {
  return (
    <ConvexAuthNextjsProvider client={convex}>
      {children}
    </ConvexAuthNextjsProvider>
  );
}
