import { convexAuthNextjsMiddleware } from "@convex-dev/auth/nextjs/server";

// Refreshes the auth session on navigations so it survives page loads (#39),
// and is the seam M2's protected routes (e.g. `/invite/<token>`) plug their
// signed-in checks into. No custom handler yet — M1b only needs the refresh.
// Next 16 renamed the middleware convention to `proxy` and requires the
// handler to be exported as `proxy` (a default export alone is not picked up).
export const proxy = convexAuthNextjsMiddleware();

export const config = {
  // Everything except Next internals and files with an extension (static
  // assets), plus the API routes. The Convex Auth recommended matcher.
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
