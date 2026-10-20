---
doc: spec
status: draft
---

# ScopeShield — Technical Spec

## How This Works, In Plain Language
A small Node.js app serves the freelancer workspace and client proposal pages. Its server sends the agreement and request to Groq, saves approved proposals in a local SQLite database, and handles PayPal sandbox checkout. API secrets stay on the server. A separate owner access key protects the freelancer workspace; a client only needs their proposal link.

This is a recommended implementation awaiting learner approval, not an already selected stack.

## The Core Journey Through the System
Implements `prd.md > The Core Journey`.
1. The owner enters their access key and pastes agreement/request text into the workspace.
2. The browser sends those texts to the protected analysis endpoint. The server requests a structured AI comparison and validates the result before displaying it.
3. The freelancer edits the scope, amount, and delivery change. Publication validates and stores fixed terms and a randomly generated client token.
4. The workspace displays the URL `/p/<token>`. The client page fetches only public proposal fields.
5. The client explicitly accepts the displayed terms. The server records acceptance and creates or reuses the proposal's PayPal order using its stored amount, then returns PayPal's approval URL.
6. PayPal redirects back to the client page. The browser requests server-side capture of the stored order; query parameters cannot choose another order or change the amount. The server confirms the capture status, reference, amount, and currency before recording payment.
7. Client and owner refresh proposal status to see the verified outcome. Pending or ambiguous outcomes stay unpaid until reconciled against PayPal.

## Stack
- **Node.js 24.13+ or 26**, JavaScript modules: built-in `fetch`, environment-file support, crypto, test runner, and SQLite. Node 26.10.0 is installed here; an in-memory SQLite query succeeded during planning. [Node docs](https://nodejs.org/api/), [SQLite](https://nodejs.org/api/sqlite.html).
- **Express 5:** routing, static pages, JSON request parsing, and error handling. Pin the resolved version in the package lock during installation. [Express docs](https://expressjs.com/en/5x/api/).
- **Plain HTML/CSS/browser JavaScript:** two small surfaces without a frontend framework or separate compilation step.
- **Groq Chat Completions API**, initial model `openai/gpt-oss-20b`, configurable through `GROQ_MODEL`; strict structured results through JSON Schema. Groq is the learner-selected provider for testing; no OpenAI account or API key is needed. [Structured outputs](https://console.groq.com/docs/structured-outputs), [API reference](https://console.groq.com/docs/api-reference).
- **PayPal Orders v2**, server-side sandbox integration with browser redirect checkout. No stored cards or automatic billing. [Orders documentation](https://developer.paypal.com/api/orders/v2).

## Where It Runs and How Someone Tries It
Recommended first target: one local Node process at `http://localhost:3000`, with SQLite on disk. Same-machine separate-browser testing demonstrates the client link. An external client needs the app hosted at an HTTPS URL; localhost links are not publicly reachable.

Planned setup: `npm ci`, copy `.env.example` to `.env`, fill local configuration, then `npm start`. Open `/` for the owner workspace; use the generated `/p/<token>` URL in another browser for the client journey. Tests run with `npm test`.

Required environment: `GROQ_API_KEY`, `GROQ_MODEL`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `OWNER_ACCESS_KEY` (a long random secret), `APP_URL`, and optional `PORT`. `APP_URL` is trusted configuration for return URLs, not derived from incoming headers. Sandbox endpoint is fixed in code. Never request or store credentials in chat or version control.

Judges can use complete setup/run instructions rather than a hosted URL, per the supplied challenge. A public source repository with a top-level license and a public YouTube functioning demo under three minutes remain required. Deployment and recording are subsequent work; this plan does not publish anything.

## Look and Feel
Implements `prd.md > Look and Feel`: system fonts, neutral background, readable panels, labeled textareas and money fields, one clear primary action per step, visible keyboard focus, responsive widths, and status/error announcements. No visual design system or custom artwork.

## Components

### Freelancer Workspace
Implements `prd.md > Agreement Comparison` and `Proposal Review and Publication`.
Serve the static owner page with a login form. Submit the owner key once to a rate-limited, same-origin login endpoint. Compare it server-side against the environment secret; clear the password input after submission and never save it in localStorage/sessionStorage. Issue a cryptographically random session ID as an HttpOnly, SameSite=Strict cookie, with Secure required over hosted HTTPS. Store only a hash of the session token in server memory, expire sessions after eight hours, and invalidate them on logout. Restarting requires logging in again. Protect every private API using the server-managed session, not merely hidden UI controls. Analysis and draft edits stay in browser memory until publication. Show a protected list of published proposals, their client links, and payment state. Warn that unsaved drafts are lost on reload.

### Comparison Service
Implements `prd.md > Agreement Comparison`.
Validate nonempty agreement/request strings with finite length limits and a bounded JSON body. Treat both documents as untrusted data, not instructions. Use a fixed prompt that requests classification (`additional`, `included`, `unclear`), a summary, and items with request excerpt, agreement evidence, explanation, and suggested work. Evidence is labeled unavailable when no supporting excerpt exists. Do not ask AI to set binding prices or deadlines.

Use strict JSON Schema and local response checks. Handle refusal, truncated output, malformed data, provider errors, and timeouts with an actionable error while preserving input. Render all text with `textContent`; never render provider/user text as HTML. Require explicit human publication for all classifications; an included/unclear result cannot silently become a paid addition.

### Proposal Store
Implements `prd.md > Proposal Review and Publication` and `States and Boundaries`.
SQLite database under ignored `data/`. Parameterized queries. Generate client tokens with 32 random bytes. Public reads return an allowlist of approved terms and payment status only. Require positive USD amounts with at most two decimal places; parse decimal strings into integer cents without floating-point money arithmetic. Initial currency is USD only, visibly labeled, with no conversion.

Validate work/title/delivery strings and enforce limits. Store publication time and immutable public terms. Do not store the original agreement, request, or AI analysis server-side after publication; they are unnecessary to the client payment journey. No editing/deletion endpoint for published proposals.

### PayPal Payment Service
Implements `prd.md > Client Review and Payment`.
Use the fixed sandbox host `https://api-m.sandbox.paypal.com`. Build amounts from the database, and verify order identity, proposal reference, capture identity, capture status, amount, currency, and expected merchant context from the authenticated order. Store only transaction metadata needed for status, not the full payer response.

Record explicit proposal acceptance before order creation. Persist separate create and capture request IDs before external calls. Reuse the same order for refresh, cancellation and retried requests. Serialize payment operations per proposal in the single app process, with durable states guarding restart recovery. Never create a fresh order while an existing creation/capture result is unknown. Check known order state before capture retries and reuse its capture request ID. After a timeout, reconcile the existing order rather than assume failure.

Only a matching completed capture marks a proposal paid. A `PENDING` capture stays pending and cannot start another payment. Read-only remote status reconciliation updates durable state without assuming that the return redirect means success. If PayPal's idempotency recovery window has elapsed and an unknown order cannot be recovered, block automated retries and explain that manual reconciliation is needed. An expired/voided or irrecoverably failed order is not silently replaced in the POC; show a clear support/replacement instruction.

### HTTP Boundaries
Implements `prd.md > States and Boundaries`.
Login requires constant-time secret comparison; protected owner APIs require a valid, unexpired server-side session. Missing or weak required secrets fail startup closed. Session cookies are inaccessible to JavaScript; they grant no access to client-only links. Check trusted Origin on every state-changing browser request, including login and logout, to prevent CSRF. Use JSON-only same-origin POST requests with origin validation, body size limits, and simple request throttling for paid AI and payment endpoints. No permissive CORS. Set no-store and no-referrer on sensitive pages/API responses, prevent framing, and apply a CSP permitting only own scripts/styles plus necessary PayPal navigation. Never log tokens, credentials, raw agreement texts, or upstream payloads. Hosted use requires HTTPS and a persistent database volume. Express serves only `public/`, with dotfiles denied; `.env`, source, SQLite, dependency files, and plans must not be web-accessible. Bind to loopback by default for local development. Apply restrictive local permissions (0600 for `.env` and database files, 0700 for the data directory, with umask 077 before database creation). Validate proxy configuration explicitly rather than trusting arbitrary forwarded headers.

## Data Model
- **Unpublished input and AI result:** browser memory only; lost on refresh. No localStorage or sessionStorage. The owner credential is transient during login; the browser receives only an HttpOnly session cookie. Hashed session records live in server memory until expiry/logout/restart.
- **proposals:** internal ID, unique random client token, title, approved work description, delivery change, `amount_cents`, currency fixed to USD, publication and acceptance times, payment state, PayPal order ID/approval URL, durable create/capture request IDs and timestamps, capture ID and paid time. Terms never change after insertion. Save transaction state before and after external operations.
- **Secrets and OAuth access token:** environment configuration and server memory only. Cache PayPal OAuth token until shortly before expiry; never expose it to the browser.
- **Database:** `data/scopeshield.sqlite`, including associated WAL/SHM files. Survives process restart; excluded from source control.

## File Structure
```text
project/
├── src/
│   ├── server.js       # configuration, Express routes, auth and startup
│   ├── store.js        # SQLite schema and parameterized operations
│   ├── analysis.js     # schema, prompt and Groq request/validation
│   ├── paypal.js       # OAuth, Orders calls and payment reconciliation
│   └── validation.js   # input and exact USD amount checks
├── public/
│   ├── index.html      # freelancer workspace
│   ├── owner.js        # analysis, editing, publication and owner status
│   ├── proposal.html   # client review and payment
│   ├── proposal.js     # acceptance, redirect/return and status
│   └── styles.css      # basic accessible layout
├── test/
│   ├── validation.test.js
│   ├── analysis.test.js
│   └── app.test.js     # API flow, access, persistence and payment failures
├── data/               # ignored runtime database
├── devpost/            # plans and build progress
├── .env.example        # placeholders only
├── .gitignore
├── package.json
├── package-lock.json
├── LICENSE             # proposed MIT license
└── README.md           # setup, architecture, limits and demo path
```

## External Services and Dependencies

### Groq Contract
Server `POST https://api.groq.com/openai/v1/chat/completions`, bearer `GROQ_API_KEY`. Body: configured `model`, fixed system and untrusted user `messages`, bounded `max_completion_tokens`, `stream:false`, and `response_format:{type:'json_schema',json_schema:{name:'scope_comparison',strict:true,schema:...}}`. Extract `choices[0].message.content`, check completion/refusal state, then parse and validate locally. Use built-in fetch; no provider SDK is needed. Default to `openai/gpt-oss-20b`, which Groq documents as supporting strict schema mode. If the configured model lacks support, return a configuration error rather than silently weakening validation.

Groq receives the submitted agreement/request for processing; server-side secrets and a gitignore do not make that content local-only. Use synthetic text for testing. Review [Groq data handling](https://console.groq.com/docs/your-data) before submitting confidential client material. Account access, limits and billing are not verified; see [rate limits](https://console.groq.com/docs/rate-limits). Missing configuration yields a real error, not fake analysis.

### PayPal Contract
- `POST /v1/oauth2/token`: Basic auth with sandbox client ID/secret, form `grant_type=client_credentials`; returns `access_token` and `expires_in`. [Authentication](https://developer.paypal.com/api/rest/authentication/).
- `POST /v2/checkout/orders`: bearer OAuth, durable `PayPal-Request-Id`, `intent:CAPTURE`, one purchase unit with internal proposal reference and exact USD value. `payment_source.paypal.experience_context` carries configured return/cancel URLs, `NO_SHIPPING` and payment intent. Read `id`, `status`, and `links` for the `payer-action`/approval redirect; permit only expected sandbox PayPal HTTPS destinations. [Create order](https://developer.paypal.com/api/orders/v2/orders-create).
- `POST /v2/checkout/orders/{storedId}/capture`: bearer OAuth and stored capture request ID; receive capture status, ID and amount in `purchase_units[].payments.captures[]`. [Capture order](https://developer.paypal.com/api/orders/v2/orders-capture).
- `GET /v2/checkout/orders/{storedId}`: reconcile known orders after interruptions and when refreshing status. [Orders API](https://developer.paypal.com/api/orders/v2).

Sandbox buyer and seller accounts are separate. No real funds move. API availability, account eligibility and actual sandbox checkout remain to be tested; documentation compatibility is not evidence of a completed transaction. PayPal request IDs have bounded retention; retain local state and stop unsafe retries outside recovery limits. [Request ID guidance](https://developer.paypal.com/api/rest/integration/orders-api/api-use-cases/advanced/).

## Important Failure Modes
- **Missing credentials or provider error:** actionable server error without revealing secrets; preserve draft inputs and never fabricate analysis/payment.
- **Network interruption during payment:** keep pending/unknown state, reconcile the stored order, block a new order until safe. Cancelled approval is not a paid status.
- **Bad amount or forged client request:** reject invalid input, ignore browser-supplied payment amounts/order IDs, and verify remote capture against immutable stored terms.
- **Database unavailable:** fail the affected action; never continue charging when durable payment state cannot be recorded.

## Verification
Use `node --test` with temporary SQLite databases and mocked fetch responses for deterministic boundary tests: amount parsing, login throttling, session expiry/logout, cookie flags, CSRF/origin rejection, anonymous access denial, blocked `.env`/database/source paths, absence of browser storage and frontend secrets, auth/public field isolation, analysis failures, immutable terms, persistence across reopen, acceptance requirement, concurrent/repeated checkout, capture timeout/reconciliation, mismatched amounts/currencies/references, pending and completed captures, and blocking repeat charges. Verify ignore rules for environment variants, database/WAL files, private keys and dependencies while allowing the secret-free `.env.example`. Audit tracked/staged files for secrets before commits and publication; ignore rules never remove already tracked files. Run real AI examples and a real PayPal sandbox transaction separately when credentials are configured. Mocked tests do not count as live integration verification. Verify both browser surfaces, keyboard interaction and the complete return/cancel flow manually or through available browser automation.

## What Was Simplified and Why
- One protected freelancer workspace rather than account registration/teams.
- One server, local SQLite, plain browser UI, and one Express dependency rather than separate frontend/database infrastructure.
- USD only and fixed published terms rather than currency conversion or negotiation/version history.
- Status refresh/reconciliation rather than background workers or webhooks. POC does not track later refunds/disputes.
- Local runnable demo first; hosting requires a reachable HTTPS address and persistent disk.

## Decisions and Open Issues
- Groq for testing and strong environment/security handling are explicit learner choices. The revised cookie-session approach follows that requirement. Stack, initial currency, license and local run target remain recommendations awaiting review.
- No new learner uncertainty was identified; they explicitly requested implementation without lessons. Genuine build investigation: prove PayPal approval/capture and timeout recovery with deterministic tests plus a configured sandbox transaction.
- Live keys, account access, model availability, and buyer/seller setup are not verified. No credentials have been requested in chat. Blank local environment configuration is not working integration setup. Security controls above are implementation requirements, not controls already proven in a running app.
- Git initialized on `main` at the learner's explicit request. No files are tracked or staged, no commits exist, and no remote is configured. Verified that `.env` and the learner profile are ignored; the learner will supply the GitHub URL later.
- This is a single-process POC. Multiple replicas, public production use, automated unknown-order recovery beyond PayPal retention, and later dispute/refund handling require additional design.
