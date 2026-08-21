/**
 * Literal rows from the nflverse `games` dataset (https://nflgamedata.com/games.csv),
 * captured 2026-08-21. Nothing here is edited except where a constant says otherwise.
 *
 * Pinned outside `convex/` on purpose: files under `convex/` are bundled into the
 * deployment, and fixtures have no business shipping to production.
 *
 * No test fetches the live dataset. It is an unofficial community file with no
 * stability guarantee, and a suite that depends on it fails for reasons that have
 * nothing to do with our code.
 */

/** The real header, verbatim — 46 columns. `parseSchedule` resolves by name. */
export const NFLVERSE_HEADER =
  "game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location,result,total,overtime,old_game_id,gsis,nfl_detail_id,pfr,pff,espn,ftn,away_rest,home_rest,away_moneyline,home_moneyline,spread_line,away_spread_odds,home_spread_odds,total_line,under_odds,over_odds,div_game,roof,surface,temp,wind,away_qb_id,home_qb_id,away_qb_name,home_qb_name,away_coach,home_coach,referee,stadium_id,stadium";

/** 2026 week 1 opener. 20:20 ET on a Wednesday — EDT, and it rolls into the next UTC day. */
export const WEEK_1_OPENER =
  "2026_01_NE_SEA,2026,REG,1,2026-09-09,Wednesday,20:20,NE,,SEA,,Home,,,,2026090900,,,202609090sea,,401872656,,7,7,160,-192,3.5,-110,-110,44.5,-110,-110,0,outdoors,fieldturf,,,,,,,Mike Vrabel,Mike Macdonald,,SEA00,Lumen Field";

/** A neutral-site game (Melbourne). Still an ordinary home/away row to us. */
export const WEEK_1_NEUTRAL_SITE =
  "2026_01_SF_LA,2026,REG,1,2026-09-10,Thursday,20:35,SF,,LA,,Neutral,,,,2026091000,,,202609100ram,,401872657,,7,7,154,-185,3.5,-110,-110,48.5,-112,-108,1,dome,matrixturf,,,,,,,Kyle Shanahan,Sean McVay,,LAX01,Melbourne Cricket Ground";

/** An ordinary Sunday-afternoon row, unquoted throughout. */
export const WEEK_1_SUNDAY =
  "2026_01_CHI_CAR,2026,REG,1,2026-09-13,Sunday,13:00,CHI,,CAR,,Home,,,,2026091300,,,202609130car,,401872661,,7,7,-148,124,-2.5,-118,-102,47.5,-105,-115,0,outdoors,grass,,,,,,,Ben Johnson,Dave Canales,,CAR00,Bank of America Stadium";

/**
 * A row whose `roof` column is the quoted empty string `""` — 43 of the 272 2026 rows
 * look like this. A naive unquote leaves the two quote characters in the value.
 */
export const WEEK_1_QUOTED_EMPTY_FIELD =
  '2026_01_BUF_HOU,2026,REG,1,2026-09-13,Sunday,13:00,BUF,,HOU,,Home,,,,2026091303,,,202609130htx,,401872660,,7,7,-118,-102,-1.5,-105,-115,44.5,-110,-110,0,"",astroturf,,,,,,,Sean McDermott,DeMeco Ryans,,HOU00,Reliant Stadium';

/** 2026-11-01 is the day EDT ends, and a 13:00 ET kickoff on it is EST. */
export const WEEK_8_DST_END_DAY =
  "2026_08_BAL_BUF,2026,REG,8,2026-11-01,Sunday,13:00,BAL,,BUF,,Home,,,,2026110100,,,202611010buf,,401873026,,7,14,,,,,,,,,0,outdoors,a_turf,,,,,,,Jesse Minter,Sean McDermott,,BUF00,Highmark Stadium";

/** A played game, scores populated. Belongs to 2025, so a 2026 parse must drop it. */
export const PLAYED_2025_REGULAR_SEASON =
  "2025_01_DAL_PHI,2025,REG,1,2025-09-04,Thursday,20:20,DAL,20,PHI,24,Home,4,44,0,2025090400,59843,,202509040phi,28418,401772510,6734,7,7,330,-425,8.5,-110,-110,47.5,-110,-110,1,outdoors,grass,75,11,00-0033077,00-0036389,Dak Prescott,Jalen Hurts,Brian Schottenheimer,Nick Sirianni,Shawn Smith,PHI00,Lincoln Financial Field";

/** A postseason row. Same season as a 2025 parse would ask for, but not `REG`. */
export const PLAYED_2025_WILD_CARD =
  "2025_19_LA_CAR,2025,WC,19,2026-01-10,Saturday,16:30,LA,34,CAR,31,Home,-3,65,0,2026011000,60164,,202601100car,,401772979,7006,6,7,-550,410,-10,-108,-112,44.5,-108,-112,0,outdoors,grass,72,16,00-0026498,00-0039150,Matthew Stafford,Bryce Young,Sean McVay,Dave Canales,Clete Blakeman,CAR00,Bank of America Stadium";

/**
 * NOT a real row — `WEEK_1_SUNDAY` with a comma spliced into the quoted stadium name.
 *
 * The 2026-08-21 snapshot happens to contain no comma inside a quoted field, so this
 * case cannot be covered by a literal copy. It is still the case worth defending
 * against: a stadium rename is upstream's to make, and a plain `split(",")` would
 * shift every column after it, landing the wrong values in every later read.
 */
export const SYNTHETIC_COMMA_INSIDE_QUOTED_FIELD =
  '2026_01_CHI_CAR,2026,REG,1,2026-09-13,Sunday,13:00,CHI,,CAR,,Home,,,,2026091300,,,202609130car,,401872661,,7,7,-148,124,-2.5,-118,-102,47.5,-105,-115,0,outdoors,grass,,,,,,,Ben Johnson,Dave Canales,,CAR00,"Bank of America Stadium, Charlotte"';

/** A whole CSV document from a header and some rows, as the fetch would return it. */
export function csvOf(...rows: string[]): string {
  return [NFLVERSE_HEADER, ...rows, ""].join("\n");
}
