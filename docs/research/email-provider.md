# Transactional email provider for magic-link + invite emails (issue #3)

Research date: 2026-07-16

## Recommendation

**Use Resend**, integrated via Auth.js's first-class `Resend` provider (`next-auth/providers/resend`).

Reasons:
- Auth.js ships a dedicated Resend provider with an official step-by-step guide, so magic-link wiring is close to zero custom code (a `sendVerificationRequest` override is optional, not required). See [Auth.js — Configuring Resend for magic links](https://authjs.dev/guides/configuring-resend) and [Auth.js — Resend provider reference](https://authjs.dev/getting-started/providers/resend).
- No manual account-approval gate before you can send. Sign up, verify a domain, generate an API key with "Sending Access," and start sending — contrast with Postmark, which manually reviews every new account and blocks sends to unverified domains until approved ([Postmark — account approval process](https://postmarkapp.com/support/article/1084-how-does-the-account-approval-process-work)).
- No sandbox mode. Contrast with Amazon SES, where every new account starts in a sandbox capped at 200 messages/24h, 1 msg/sec, and sends only to pre-verified recipient addresses until a manual "production access" review is granted ([AWS — Request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)).
- The free tier (3,000 emails/month, 100/day, 1 verified domain — see below) comfortably covers a pick'em league's magic-link + invite volume, and the setup story (one domain, three DNS records) is the simplest of the API-based options.

The only caveat: Resend's free plan hard-caps at 100 emails/day with no overage — if the league grows large enough to blow past that in a single day (e.g., mass invite blast), either throttle invites or budget for the $20/mo Pro plan (50,000/mo) ([Resend pricing](https://resend.com/pricing)).

## Auth.js integration path

Auth.js's Email/passwordless authentication **requires a database adapter** — verification tokens must be persisted server-side, so it cannot run in a pure JWT/stateless session mode: *"a database is required for passwordless login to work as verification tokens need to be stored."* ([Auth.js — Email provider](https://authjs.dev/getting-started/authentication/email))

Auth.js ships first-class built-in email providers for: **Forward Email, Resend, SendGrid, Nodemailer (generic SMTP), Postmark, Loops, Mailgun** ([Auth.js — Email provider](https://authjs.dev/getting-started/authentication/email)). Each just needs an API key env var and a verified sending domain — no custom `sendVerificationRequest` is required unless you want to customize the email template. If you want a fully custom template/HTTP call (e.g., calling a provider without a built-in Auth.js integration), Auth.js documents a manual `sendVerificationRequest` pattern hitting the provider's HTTP API directly ([Auth.js — Configuring HTTP email](https://authjs.dev/guides/configuring-http-email)).

Minimal Resend setup with Auth.js:

```typescript
// auth.ts
import NextAuth from "next-auth"
import Resend from "next-auth/providers/resend"

export const { handlers, auth } = NextAuth({
  adapter, // any Auth.js DB adapter — required for email sign-in
  providers: [
    Resend({
      from: "auth@yourdomain.com", // must be on a Resend-verified domain
    }),
  ],
})
```

```
# .env.local
AUTH_SECRET="..."
AUTH_RESEND_KEY="re_..."   # API key with "Sending Access", from Resend dashboard
```

Steps ([Auth.js — Configuring Resend](https://authjs.dev/guides/configuring-resend)):
1. `npm install next-auth@beta` (or current major) and add the `Resend` provider to `auth.ts`.
2. Add the Auth.js catch-all route handler at `app/api/auth/[...nextauth]/route.ts`.
3. Sign up at Resend, create an API key with "Sending Access" under API Keys, put it in `AUTH_RESEND_KEY`.
4. Verify a sending domain in the Resend dashboard (see DNS section below), then set `from` to an address on that domain.
5. Wire a database adapter (Prisma/Drizzle/etc. — whatever this app already uses) so verification tokens can be stored.

The same `Resend` provider can send both the magic-link email and, with a second call to Resend's API from your own invite route/server action (not through Auth.js), league-invite emails — Resend's HTTP API is a plain `POST https://api.resend.com/emails` call re-usable for any transactional email, not just Auth.js's callback ([Auth.js — Resend HTTP email example](https://authjs.dev/guides/configuring-http-email)).

## Provider comparison

| Provider | Free tier | Overage / after free tier | Deliverability & DNS setup | Auth.js integration | Pre-send gate |
|---|---|---|---|---|---|
| **Resend** | 3,000 emails/mo, capped at 100/day, 1 verified domain ([pricing](https://resend.com/pricing)) | No overage on free plan — must upgrade to Pro ($20/mo, 50,000/mo, then $0.90/1,000 over) ([pricing](https://resend.com/pricing)) | Verify domain in dashboard → add SPF (TXT), DKIM (TXT), optional DMARC records shown under the domain's "Records" tab ([Resend — Domains](https://resend.com/docs/dashboard/domains/introduction)) | First-class `Resend` provider, official Auth.js guide ([guide](https://authjs.dev/guides/configuring-resend)) | None — just domain verification |
| **Amazon SES** | 3,000 message-charges free/mo for 12 months for new AWS accounts, plus (from July 15, 2025) up to $200 in AWS Free Tier credit for 6 months ([SES pricing](https://aws.amazon.com/ses/pricing/)) | Pay-per-message beyond free tier; also charged for attachment data ($0.12/GB) | Domain/DKIM verification via SES console; **sandbox mode** restricts all new accounts to 200 msgs/24h, 1 msg/sec, and recipients must be pre-verified until you request "production access" (manual AWS review, ~24h) ([AWS — sandbox/production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)) | No built-in Auth.js SES provider — would need Nodemailer (SMTP) or a custom `sendVerificationRequest` calling the SES SDK/API | Sandbox review required before sending to arbitrary recipients — a real blocker for pre-launch testing with real user emails |
| **Mailgun** | 100 emails/day (~3,000/mo), 1 sending domain, 2 API keys, SMTP + API access ([pricing](https://www.mailgun.com/pricing/)) | Paid plans start at $15/mo for 10,000/mo with no daily cap ([pricing](https://www.mailgun.com/pricing/)) | Domain verification + SPF/DKIM records via Mailgun dashboard (same general pattern as Resend) | First-class `Mailgun` provider, env var `AUTH_MAILGUN_KEY` ([Auth.js — Mailgun](https://authjs.dev/getting-started/providers/mailgun)) | None documented beyond domain verification |
| **Postmark** | 100 emails/month (developer/free plan), no expiration, "no overages allowed" ([pricing](https://postmarkapp.com/pricing)) | Must upgrade — no overage on free plan | Sender Signature or full domain (SPF/DKIM) verification required, matching the `from` address | First-class `Postmark` provider, env var `AUTH_POSTMARK_KEY`; must add domain to Postmark account matching the `from` address ([Auth.js — Postmark](https://authjs.dev/getting-started/providers/postmark)) | **Manual account approval required** — every new account is reviewed (usually <24h on weekdays); until approved you can only send to your own verified domains, and link tracking is disabled ([Postmark — approval process](https://postmarkapp.com/support/article/1084-how-does-the-account-approval-process-work)) |
| **Brevo (Sendinblue)** | 300 emails/day shared across marketing + transactional, up to 100,000 stored contacts ([Brevo Help Center — Free plan limits](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan)) | Must add prepaid email credits or upgrade plan once daily quota is hit; quota resets daily, unused sends don't roll over | Domain authentication (SPF/DKIM) via Brevo dashboard | No built-in Auth.js provider — would need Nodemailer (SMTP relay) or a custom HTTP `sendVerificationRequest` against Brevo's API | None beyond domain auth, but daily quota is shared with any marketing sends from the same account |

## Why not the alternatives

- **SES**: cheapest at real scale, but the sandbox-to-production manual review is unnecessary friction for a small league app, and there's no first-class Auth.js provider (SMTP/Nodemailer or custom code only).
- **Postmark**: excellent deliverability reputation, but the mandatory account-approval step is a real pre-launch blocker (can't email real testers' addresses until approved), and the free tier is smaller (100/mo vs. Resend's 3,000/mo).
- **Mailgun**: comparable free tier to Resend (100/day) and has a first-class Auth.js provider, viable second choice — but Resend's Auth.js docs/guide are more polished and Mailgun's historical deliverability reputation is more mixed than Resend/Postmark's.
- **Brevo**: free tier (300/day) is the most generous by volume, but it has no first-class Auth.js provider (extra integration work via Nodemailer/custom HTTP), and the daily quota is shared with any future marketing email use of the same account.

## Sources

- [Auth.js — Email provider (authentication)](https://authjs.dev/getting-started/authentication/email)
- [Auth.js — Configuring Resend for magic links](https://authjs.dev/guides/configuring-resend)
- [Auth.js — Resend provider reference](https://authjs.dev/getting-started/providers/resend)
- [Auth.js — Configuring HTTP email (custom sendVerificationRequest)](https://authjs.dev/guides/configuring-http-email)
- [Auth.js — Mailgun provider reference](https://authjs.dev/getting-started/providers/mailgun)
- [Auth.js — Postmark provider reference](https://authjs.dev/getting-started/providers/postmark)
- [Auth.js — Nodemailer provider reference](https://authjs.dev/getting-started/providers/nodemailer)
- [Resend — Pricing](https://resend.com/pricing)
- [Resend — Domains / DNS verification](https://resend.com/docs/dashboard/domains/introduction)
- [AWS — Amazon SES Pricing](https://aws.amazon.com/ses/pricing/)
- [AWS — Request production access (moving out of SES sandbox)](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- [Mailgun — Pricing](https://www.mailgun.com/pricing/)
- [Postmark — Pricing](https://postmarkapp.com/pricing)
- [Postmark — How does the account approval process work?](https://postmarkapp.com/support/article/1084-how-does-the-account-approval-process-work)
- [Brevo Help Center — What are the limits of the Free plan?](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan)
