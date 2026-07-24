// Tells this Convex deployment how to validate the session JWTs Convex Auth
// issues (#16/#33). Without it the backend rejects the token the browser
// presents over the WebSocket, so the client stays `isAuthenticated: false`
// even after a successful sign-in. `domain` must match the token issuer
// (CONVEX_SITE_URL, the deployment's own `.convex.site` origin) and
// `applicationID` its audience ("convex").
const authConfig = {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};

export default authConfig;
