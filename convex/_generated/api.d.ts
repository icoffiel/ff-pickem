/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as config from "../config.js";
import type * as crons from "../crons.js";
import type * as emailTransport from "../emailTransport.js";
import type * as espn from "../espn.js";
import type * as games from "../games.js";
import type * as grading from "../grading.js";
import type * as http from "../http.js";
import type * as inviteEmail from "../inviteEmail.js";
import type * as invites from "../invites.js";
import type * as leagues from "../leagues.js";
import type * as nflverse from "../nflverse.js";
import type * as picks from "../picks.js";
import type * as sync from "../sync.js";
import type * as users from "../users.js";
import type * as week from "../week.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  config: typeof config;
  crons: typeof crons;
  emailTransport: typeof emailTransport;
  espn: typeof espn;
  games: typeof games;
  grading: typeof grading;
  http: typeof http;
  inviteEmail: typeof inviteEmail;
  invites: typeof invites;
  leagues: typeof leagues;
  nflverse: typeof nflverse;
  picks: typeof picks;
  sync: typeof sync;
  users: typeof users;
  week: typeof week;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
