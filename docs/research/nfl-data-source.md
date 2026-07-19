# NFL Schedule & Results Data Source (Issue #2)

Research date: 2026-07-16. All requests below were made live against the source in question unless marked "via search" (meaning the provider blocked direct fetch and the fact is corroborated by a secondary citation of the provider's own page).

## Recommendation

**Primary: `nflverse/nfldata` (the `games` dataset — consume via `nflreadr`/`nflreadpy`, or fetch the published CSV/Parquet directly).**
**Fallback / live-status cross-check: ESPN's unofficial site API (`site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`).**

**Per-game kickoff times: YES — available from both sources.** ESPN exposes a full ISO-8601 UTC kickoff timestamp per game (`date`); nflverse exposes an ET `gameday` (date) + `gametime` (24h ET) pair per game. Either is sufficient to drive a per-game pick-lock rule.

Why nflverse as primary:
- No API key, no published rate limit — it's a static CSV/Parquet file served over plain HTTPS, so there is no quota to run out of and no auth flow to build ([`games.csv`](https://nflgamedata.com/games.csv), fetched live 2026-07-16).
- No third-party ToS exposure. It's a community-published dataset, not a scrape of a vendor's private JSON API — lower legal/breakage risk than depending directly on ESPN's undocumented endpoints for the number that actually grades users' picks.
- It already has the entire 2026 season schedule loaded (confirmed live, see below) and nflreadr states the games/schedule data "updates every 5 minutes during the season" (<https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html>), which is more than fast enough for grading picks (nobody needs second-by-second latency for a pick'em result).
- Weakness: there is no explicit boolean "is final" column — see the Data Available section below for how to derive one, and why ESPN is kept as a fallback specifically to plug that gap.

Why ESPN as fallback rather than primary:
- It has the single best "is final" signal of any candidate evaluated — an explicit `status.type.completed` boolean plus `status.type.state` (`"pre" | "in" | "post"`) — and it updates live, within seconds of a play (it's the feed ESPN's own live scoreboard UI runs on). That makes it the right tool for (a) double-checking a final score the moment it happens and (b) showing live in-progress scores in the UI, which nflverse's 5-minute-cadence file isn't built for.
- It is unofficial/undocumented: no published rate limit, no ToS covering this use, and a documented history of being "a free ride" that could end at any time (community note, see citation below). That risk profile makes it a poor sole source of record for grading picks, but a fine low-cost fallback/cross-check given it needs zero auth and is trivial to call opportunistically.

## Candidates evaluated

| Source | Auth/key | Free-tier limit | Official? | Kickoff datetime? | Final-score signal | Live latency |
|---|---|---|---|---|---|---|
| **nflverse/nfldata** (`games` dataset) | None | None (static file) | Unofficial community project | Yes (`gameday` + `gametime`, ET) | Inferred: `home_score`/`away_score` populated | ~5 min refresh during season |
| **ESPN site API** (unofficial) | None | Undocumented/none published | Unofficial (reverse-engineered) | Yes (`date`, ISO-8601 UTC) | Explicit: `status.type.completed` + `state` | Seconds (live scoreboard feed) |
| **TheSportsDB** (free tier) | Shared test key `123` | 30 req/min | Official product, free tier is real but limited | Yes (`strTimestamp`/`strTime`/`strTimeLocal`) | Explicit: `strStatus` = `"FT"` for finished | Not live on free tier — live-score endpoint is Premium-only |
| **api-sports.io / API-American-Football** | Required (`x-apisports-key` header) | 100 requests/day | Official commercial product | Yes | Explicit status codes (`NS`, `Q1`–`Q4`, `HT`, `FT`, etc.) | Not verified directly (site blocked automated fetch) |
| **SportsDataIO** (free trial) | Required (API key) | 1,000 calls/month, trial | Official commercial product | Yes | Explicit `Status` field (per docs) | **Free-trial data is scrambled — not usable for real grading** |

---

## nflverse/nfldata — primary recommendation

**What it is:** a community-maintained, long-running NFL data project (maintained by Lee Sharpe and the nflverse organization; builds on `nflfastR`/`nflscrapR`). Repo: <https://github.com/nflverse/nfldata>.

**Cost / rate limits:** none. The `games` dataset is published as a flat CSV (and Parquet via the `nflverse-data` releases) at a stable URL and via the `nflreadr`/`nflreadpy` packages. No API key, no request quota — it's a plain HTTPS GET. Verified live:

```
$ curl -s https://nflgamedata.com/games.csv | tail -5
2026_18_CHI_MIN,2026,REG,18,2027-01-10,Sunday,13:00,CHI,,MIN,,Home,...
2026_18_MIA_NE,2026,REG,18,2027-01-10,Sunday,13:00,MIA,,NE,,Home,...
...
```
(fetched 2026-07-16 — the file already contains the full 2026 regular-season schedule, months before kickoff.)

**Reliability & terms:** Actively maintained (55k+ commits, 340 stars, 81 forks; last push at fetch time was same-day) — <https://github.com/nflverse/nfldata>. **No LICENSE file is present** — `gh api repos/nflverse/nfldata --jq .license` returns `null`. This is a real caveat: there is no explicit open-data license (CC0/MIT/etc.) granting reuse rights. In practice this dataset is the backbone of the entire nflverse/nflfastR ecosystem and is used by thousands of public projects, but the app should note this as an unresolved legal-risk item rather than treat it as formally licensed.

**Data available (schedule):** the `games` dataset column header, fetched live from <https://nflgamedata.com/games.csv>:

```
game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location,result,total,overtime,old_game_id,gsis,nfl_detail_id,pfr,pff,espn,ftn,away_rest,home_rest,away_moneyline,home_moneyline,spread_line,away_spread_odds,home_spread_odds,total_line,under_odds,over_odds,div_game,roof,surface,temp,wind,away_qb_id,home_qb_id,away_qb_name,home_qb_name,away_coach,home_coach,referee,stadium_id,stadium
```

Relevant columns per `DATASETS.md` (<https://github.com/nflverse/nfldata/blob/master/DATASETS.md>):
- `gameday` — "the date on which the game occurred"
- `gametime` — "the kickoff time of the game... represented in 24-hour time and the Eastern time zone"
- `home_team` / `away_team`, `week`, `game_type` (`REG`/`WC`/`DIV`/`CON`/`SB`)
- `home_score` / `away_score`, `result` (home score − away score), `total`

**Example row — an unplayed, already-scheduled 2026 game** (confirms schedule is published ahead of the season, and confirms the completion-inference mechanism: scores are blank until the game is played):
```
2026_18_DAL_WAS,2026,REG,18,2027-01-10,Sunday,13:00,DAL,,WAS,,Home,,,,...
```

**Example row — a completed game (Super Bowl LX, 2026-02-08), scores populated:**
```
2025_22_SEA_NE,2025,SB,22,2026-02-08,Sunday,18:30,SEA,29,NE,13,Neutral,-16,42,0,...
```
(Seattle 29, New England 13 — cross-checked independently against TheSportsDB's record of the same game below; scores match.)

**Final-score / "is final" signal:** there is **no explicit boolean column**. The de facto convention (used throughout the nflverse ecosystem) is: a game is final once `home_score`/`away_score` are non-null/non-blank. Since `gameday`/`gametime` are known in advance, the app can also gate "check for a result" on `now > gameday+gametime`, but the authoritative signal is the presence of scores.

**Freshness:** nflreadr's own docs state schedule/game data "updates every 5 minutes during the season" (<https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html>). That is same-game-day, not live-play-by-play, but far faster than needed to grade a pick'em.

---

## ESPN unofficial site API — fallback recommendation

**What it is:** ESPN's public-facing (but undocumented/unofficial) JSON endpoints that power ESPN.com's own scoreboards. No official ESPN developer documentation exists; the closest things to primary sources are the live endpoints themselves plus community reverse-engineering docs: <https://github.com/pseudo-r/Public-ESPN-API>, <https://gist.github.com/akeaswaran/b48b02f1c94f873c6655e7129910fc3b>.

**Cost / rate limits / auth:** no API key required, publicly accessible via plain GET. No official rate limit is published anywhere; community documentation explicitly flags this as a risk ("I guess less users the better, because you never know when the ESPN API free ride will end" — community comment on the akeaswaran gist).

**Reliability & terms:** **Unofficial.** Not covered by any published developer ToS; ESPN can change or remove these endpoints without notice, and heavy automated use risks being blocked. No SLA, no guaranteed stability (<https://github.com/pseudo-r/Public-ESPN-API>).

**Data available / shape — request:**
```
GET https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=1&seasontype=2&year=2025
```

**Trimmed example response** (live fetch, 2026-07-16; top level has `leagues`, `season`, `week`, `events`):
```json
{
  "season": { "year": 2025, "type": 2, "slug": "regular-season" },
  "week": { "number": 1 },
  "events": [
    {
      "id": "401772510",
      "date": "2025-09-05T00:20Z",
      "name": "Dallas Cowboys at Philadelphia Eagles",
      "shortName": "DAL @ PHI",
      "competitions": [
        {
          "date": "2025-09-05T00:20Z",
          "competitors": [
            { "team": { "abbreviation": "PHI", "displayName": "Philadelphia Eagles" }, "score": "24", "winner": true },
            { "team": { "abbreviation": "DAL", "displayName": "Dallas Cowboys" }, "score": "20", "winner": false }
          ],
          "status": {
            "type": { "id": "3", "name": "STATUS_FINAL", "state": "post", "completed": true }
          }
        }
      ]
    }
  ]
}
```

**Final-score / "is final" signal:** explicit — `status.type.completed: true` and `status.type.state: "post"` (observed directly, live). For not-yet-played games, community documentation reports `state: "pre"`/`completed: false`, and `"in"` while a game is in progress (not independently re-verified live in this pass since no in-progress game was available at research time, but this is the same convention documented across every community write-up of this endpoint, e.g. <https://github.com/pseudo-r/Public-ESPN-API>).

**Kickoff datetime:** `date` field, ISO-8601 UTC (e.g. `"2025-09-05T00:20Z"`) — directly usable for a per-game lock rule.

**Freshness:** this is the live feed ESPN.com's own scoreboard runs on, so in-progress/final transitions are effectively real-time (seconds), not batch-refreshed.

---

## TheSportsDB — evaluated, not recommended as primary

**What it is:** a community sports database with a genuinely free tier (distinct from a time-limited trial). Docs: <https://www.thesportsdb.com/documentation>. NFL league id `4391` (<https://www.thesportsdb.com/league/4391-NFL>).

**Cost / auth:** free tier uses a shared public test key, `123`, in the URL path. Rate limit: **30 requests/minute** on the free tier; exceeding it returns HTTP 429 (<https://www.thesportsdb.com/documentation>).

**Reliability & terms:** official product with an explicit free/premium split. The **live-score endpoint is Premium-only** ("$9/month" — <https://www.thesportsdb.com/documentation>); the free tier only exposes results after the fact via the season/event-history endpoints.

**Data available — request:**
```
GET https://www.thesportsdb.com/api/v1/json/123/eventspastleague.php?id=4391
```

**Trimmed example response** (live fetch, 2026-07-16 — most recent past NFL event, Super Bowl LX):
```json
{
  "idEvent": "2423873",
  "strEvent": "New England Patriots vs Seattle Seahawks",
  "strHomeTeam": "New England Patriots",
  "strAwayTeam": "Seattle Seahawks",
  "intHomeScore": "13",
  "intAwayScore": "29",
  "dateEvent": "2026-02-08",
  "strTimestamp": "2026-02-08T23:30:00",
  "strTime": "23:30:00",
  "strTimeLocal": "15:40:00",
  "strStatus": "FT",
  "strVenue": "Levi's Stadium"
}
```
Scores (Seattle 29, New England 13) match the nflverse record of the same game independently.

**Final-score signal:** explicit, `strStatus: "FT"`.

**Kickoff datetime:** present (`strTimestamp`, `strTime`, `strTimeLocal`).

**Why not primary:** free-tier season/schedule lookups were inconsistent in testing — `eventsseason.php?id=4391&s=2024-2025` returned a null `events` array, while `eventspastleague.php?id=4391` worked. The 30 req/min ceiling on a *shared* free key (`123`, used by every free-tier consumer globally) is also a real operational risk for a multi-user app polling weekly schedules. Usable as a secondary cross-check source, not as primary.

---

## api-sports.io / API-American-Football — evaluated, not recommended

**What it is:** the American Football product in the api-sports.io family (sibling to api-football.com), covering NFL and NCAA. Product page: <https://api-sports.io/sports/nfl>; docs: <https://api-sports.io/documentation/nfl/v1>.

Direct automated fetches of api-sports.io and api-football.com were blocked (HTTP 403) during this research, consistent with bot/anti-scraping protection on their docs site — noted here as itself a data point about programmatic friction with this provider. Facts below are corroborated via search-indexed copies of the provider's own pages.

**Cost / rate limits:** free plan = **100 requests/day**, resetting at 00:00 UTC; unused requests are not banked. All endpoints (including games/scores) are available on every plan, including free — paid tiers only raise the request ceiling (Pro $19/mo, Ultra $29/mo, Mega $39/mo) (<https://api-sports.io/sports/nfl>).

**Auth:** requires an API key (`x-apisports-key` header or RapidAPI equivalent).

**Data available:** endpoints for Leagues, Teams, Standings, Games, Odds. Game status uses short codes: `NS` (Not Started), `Q1`–`Q4`/`OT`/`HT` (in progress), `FT`/`AOT` (finished), `CANC`/`PST` (cancelled/postponed) — consistent with the wider api-sports.io product family's convention (<https://api-sports.io/documentation/nfl/v1>, via search-indexed copy).

**Why not recommended:** 100 requests/day is workable for a single-league weekly-schedule + once-per-game-final poll pattern, but it's a hard commercial-product quota (requires signup + key) for data that nflverse gives away with zero registration and zero quota. Given the app only needs one authoritative primary + one fallback, this is redundant with better-documented free options.

---

## SportsDataIO — evaluated, disqualified for the free tier

**What it is:** a commercial sports-data vendor with real-time feeds trusted by sportsbooks/media (<https://sportsdata.io/nfl-api>).

**Free trial:** 1,000 API calls/month, no credit card required to start (per search-indexed trial page, <https://sportsdata.io/cart/free-trial/nfl>). **Disqualifying fact, confirmed directly from SportsDataIO's own page:**

> "Data in the free trial is scrambled for demonstration purposes." — <https://sportsdata.io/developers/apis>

This means player names, scores, and stats in the free tier are **not real** — structurally correct but fabricated, meant only for integration testing. A pick'em app that needs to grade real picks against real results cannot use this tier at all; going beyond evaluation would require a paid production plan. Disqualified for this use case.

---

## Summary answer to the issue's core question

- **Per-game kickoff times available? Yes**, from both the primary (nflverse `gameday`+`gametime`) and fallback (ESPN `date`, ISO-8601 UTC) sources — the per-game pick-lock rule is buildable on either.
- **Recommended primary:** `nflverse/nfldata` `games` dataset (via `nflreadr`/`nflreadpy` or the raw CSV/Parquet) — no auth, no rate limit, actively maintained, 5-minute refresh cadence during the season. Caveat: no explicit license file (treat as an open item), and "final" must be inferred from populated score columns rather than an explicit flag.
- **Recommended fallback:** ESPN's unofficial scoreboard API (`site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard`) — use for a fast, explicit `completed`/`state` cross-check and for live in-progress display; do not rely on it as the sole source of truth given its unofficial status and undocumented rate limits.
- Both TheSportsDB (free-tier request ceiling + shared key + inconsistent season endpoint) and api-sports.io (paid-signup quota) are viable secondary options but offer no advantage over the recommended pair. SportsDataIO's free tier is disqualified outright (scrambled data).
