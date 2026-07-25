import { ReactNode } from "react";
import type { Metadata } from "next";

import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";

import { ConvexClientProvider } from "./ConvexClientProvider";

export const metadata: Metadata = {
  title: "NFL Pick'em",
  description: "A private NFL pick'em league.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // The server provider reads the auth cookie during SSR so the first paint
  // already knows whether the visitor is signed in; the client provider inside
  // it drives reactivity. Both are needed for the session to survive a reload.
  return (
    <ConvexAuthNextjsServerProvider>
      <html lang="en">
        <body>
          <ConvexClientProvider>{children}</ConvexClientProvider>
        </body>
      </html>
    </ConvexAuthNextjsServerProvider>
  );
}
