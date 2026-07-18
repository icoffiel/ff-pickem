# NFL Pick'em

A private NFL pick'em league app: members of a single league predict the winners of each week's games, picks lock and grade against real results, and weekly + season standings follow. This file is the glossary — the shared language for the domain, free of implementation detail.

## Language

### People & membership

**User**:
A person with one login (one email/auth identity), who may belong to many leagues. Carries no display name — the name a person shows is per-league.
_Avoid_: Account, member (a User is not a Membership)

**League**:
One private competition for a **single season**. Owns its rule settings and its members.
_Avoid_: Group, pool, competition

**Membership**:
The link between a User and a League — the "user-in-a-league." Carries the person's per-league identity: team name, role, join date, and (by derivation) standing. All per-league data hangs off the Membership, never the User.
_Avoid_: Player, participant, member record

**Commissioner**:
The Membership that created the League. Exactly one per League. A role on the Membership, not a pointer on the League. The Commissioner holds the League's admin powers: [result overrides](#play--scoring), removing a member, revoking a pending Invite, and editing the League name.
_Avoid_: Admin, owner, organizer

**Removed member**:
A Membership the Commissioner has taken out of the League. Removal is **go-forward** and reversible: the member keeps every week that had already locked when they were removed — completed weeks, and who won them, are never rewritten — and stops competing thereafter. On the season Standings they stay visible, marked **"left,"** with a frozen total, ineligible for the title. Nothing is deleted; un-removing restores them fully.
_Avoid_: Deleted member, banned, kicked

**Team name**:
The display name a person chooses for themselves within one League, captured when they join. Lives only on the Membership; there is no global user name.
_Avoid_: Username, handle, nickname

**Invite**:
An app-level grant that lets a specific email join a specific League. Has its own token and 14-day expiry, independent of auth. At most one live (pending) invite per (email, league); re-inviting supersedes the previous one. The Commissioner may **revoke** a still-pending Invite, cancelling it (a terminal state, distinct from time-based expiry and re-invite supersession). An invite grants membership, not a role — every invited person joins as an ordinary member.
_Avoid_: Magic link (that is the auth mechanism, not the grant)

### Play & scoring

**Game**:
A single NFL game — the global, league-agnostic fact: teams, week, season, kickoff, scores, and outcome. Shared by every League; no League owns a Game.
_Avoid_: Match, fixture, matchup

**Outcome**:
The result of a Game: the home team won, the away team won, or a **tie**. A property of the Game alone — it knows nothing about picks or scoring.

**Result override**:
A Commissioner's per-League correction to a Game's result. Because a Game is global (shared by every League), the correction is scoped to one League and never touches the shared Game — it may set the result to home, away, tie, or **void** (a cancelled / no-contest Game, which becomes a push for everyone).
_Avoid_: Manual result (that lives on the Game — it does not)

**Effective outcome**:
The Outcome a League actually scores against for a Game: the League's Result override if one exists, else the Game's Outcome. All grading and Standings read the effective outcome, never the raw Game Outcome.

**Tie**:
A Game that finished level. A fact about the Game. Distinct from a **push**, which is what a tie does to a Pick.
_Avoid_: Draw

**Pick**:
A Membership's prediction of the winner of one Game (home or away). Once graded against the Game's outcome it is correct, incorrect, or a push.
_Avoid_: Bet, guess (a "guess" is the tiebreaker number), selection

**Push**:
The scoring consequence for a Pick whose Game was a **tie**: excluded from scoring — no one gains or loses. A property of the Pick, not the Game.
_Avoid_: Void, no-contest

**RuleSet**:
The League's settings that govern how the game is played and scored — lock rule, slate, season scope, scoring, weekly and season tiebreakers, pick visibility, and absent-pick scoring. First-class and per-league; the first loop ships one default rule-set.
_Avoid_: Config, options, preferences

**Slate**:
The set of a week's Games that count toward picks, per the RuleSet. The default slate is **Saturday + Sunday + Monday** games; Thursday and Friday Games (including the Week 13 Black Friday game) are excluded and do not exist for scoring — they are not shown and generate no Picks.
_Avoid_: Card, schedule (the schedule is all Games; the slate is the counted subset)

**Active week**:
The week a League is currently picking — **derived**, never stored: the earliest week whose Lock is still in the future. When a week Locks, the next becomes active automatically. The make-picks screen defaults to it, but members may pick ahead into any not-yet-Locked week.
_Avoid_: Current week (as a stored field), this week

**Lock**:
The moment a week's Picks (and Tiebreaker guesses) can no longer be made or changed. Under the default rule-set, the week locks at the first counted Game's kickoff. A derived point in time, not a stored flag.
_Avoid_: Deadline, cutoff, close

**Tiebreaker guess**:
A Membership's predicted combined point total for a week, used to break weekly standings ties. Bound to a week, not to a specific Game — which Game it is measured against is decided by the tiebreaker policy at standings time.
_Avoid_: Prediction, over/under

**Standings**:
The weekly and season rankings of a League's Memberships, derived from graded Picks (and Tiebreaker guesses for ties). Computed on read; never stored. Weekly points = correct Picks (push excluded, absent = 0); season points = the sum of weekly correct Picks. The weekly Tiebreaker guess settles the **weekly winner only** — it orders the weekly leaderboard but never changes point totals and never feeds the season. Season ties yield **co-champions**.
_Avoid_: Leaderboard, rankings, scores
