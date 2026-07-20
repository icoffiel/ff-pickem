import { httpRouter } from "convex/server";
import { auth } from "./auth";

// Convex Auth's HTTP endpoints (token verification, session refresh). Required
// for sign-in from the browser; the convex-test suite drives the `signIn`
// action directly and does not exercise these routes.
const http = httpRouter();

auth.addHttpRoutes(http);

export default http;
