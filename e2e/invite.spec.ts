import { expect, Page, test } from "@playwright/test";

import { waitForInviteLink, waitForMagicLink } from "./magic-link";

// M2c (#60): the invite→membership loop end to end in a real browser against
// the Convex dev deployment. One commissioner, one invitee, two sign-ins — the
// milestone destination from #17 ("a second email receives an invite, redeems
// it, and shows up as an active member with a team name").

/** Fresh addresses per run: captured links are unambiguous and the run does not
 * depend on state left in the dev deployment by a previous run. */
function uniqueEmail(role: string) {
  return `e2e-${role}-${Date.now()}@example.com`;
}

/**
 * Sign in by email from whatever page is showing the sign-in form, then open
 * the emailed link as the user would from their inbox. Where that link lands
 * depends on the form's `redirectTo`, so callers assert the destination.
 */
async function signIn(page: Page, email: string) {
  await page.getByLabel(/email/i).fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.goto(await waitForMagicLink(email));
}

test("a commissioner invites a second person, who redeems and joins the league", async ({
  page,
}) => {
  const commissioner = uniqueEmail("commish");
  const invitee = uniqueEmail("invitee");
  const leagueName = `E2E League ${Date.now()}`;

  // The commissioner signs in and creates a league.
  await page.goto("/");
  await signIn(page, commissioner);
  await expect(page.getByText(commissioner)).toBeVisible();
  await page.getByLabel(/league name/i).fill(leagueName);
  await page.getByLabel(/team name/i).fill("Thunder Llamas");
  await page.getByRole("button", { name: /create league/i }).click();

  // …then invites the second address from the league's roster page.
  await page.getByRole("link", { name: new RegExp(leagueName) }).click();
  await expect(page.getByText("Thunder Llamas")).toBeVisible();
  await page.getByLabel(/email/i).fill(invitee);
  await page.getByRole("button", { name: /send invite/i }).click();
  // The pending-invite list entry, not the form's "Invited …" confirmation.
  await expect(page.getByText(invitee, { exact: true })).toBeVisible();

  const inviteLink = await waitForInviteLink(invitee);

  // Hand the browser over to the invitee. The invite link is a plain
  // deep-link, so opening it signed out asks them to prove the invited address.
  await page.goto("/");
  await page.getByRole("button", { name: /sign out/i }).click();
  await page.goto(inviteLink);
  await signIn(page, invitee);

  // Signing in lands them back on the invite (`redirectTo`), where they choose
  // the team name they will play under.
  await expect(page.getByText(leagueName)).toBeVisible();
  await page.getByLabel(/team name/i).fill("Gridiron Geese");
  await page.getByRole("button", { name: /join league/i }).click();

  // They are now an active member on that league's roster, alongside the
  // commissioner.
  await expect(page.getByText("Gridiron Geese")).toBeVisible();
  await expect(page.getByText("Thunder Llamas")).toBeVisible();

  // And the spent invite no longer haunts their home screen.
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: new RegExp(leagueName) }),
  ).toBeVisible();
  await expect(page.getByText(/you're invited to/i)).toHaveCount(0);
});
