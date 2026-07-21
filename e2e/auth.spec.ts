import { expect, test } from "@playwright/test";
import { waitForMagicLink } from "./magic-link";

// M1b (#39): auth reachable from a browser. Drives the whole loop a person
// takes — sign in by email, follow the magic link, stay signed in across a
// reload, sign out — against the real app + Convex dev deployment.

/** A fresh address per run: the captured link is unambiguous and the run does
 * not depend on state left in the dev deployment by a previous run. */
function uniqueEmail() {
  return `e2e-${Date.now()}@example.com`;
}

test("sign in by email, stay signed in across a reload, then sign out", async ({
  page,
}) => {
  const email = uniqueEmail();

  await page.goto("/");

  // Signed out: a way to sign in by email is offered.
  const emailField = page.getByLabel(/email/i);
  await expect(emailField).toBeVisible();

  await emailField.fill(email);
  await page.getByRole("button", { name: /sign in/i }).click();

  // The console transport prints the link to the server log; open it as the
  // user would from their inbox.
  const link = await waitForMagicLink(email);
  await page.goto(link);

  // Signed in: the page shows the user's email and a way to sign out.
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByRole("button", { name: /sign out/i })).toBeVisible();

  // The session survives a full page reload (M1 story 7).
  await page.reload();
  await expect(page.getByText(email)).toBeVisible();

  // Signing out returns to the signed-out state.
  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page.getByLabel(/email/i)).toBeVisible();
});
