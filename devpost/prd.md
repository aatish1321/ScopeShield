---
doc: prd
status: approved
---

# ScopeShield — Product Requirements

Help freelancers turn extra client requests into approved, paid additions to an agreement.
Source: `scope.md > The Unique Kernel`, `The Core Loop`, and `The POC Boundary`.

## The Core Journey
1. The freelancer opens ScopeShield and enters the original agreement and new client request.
2. AI compares them, identifies possible extra work, and explains the comparison against the supplied agreement. Unclear scope is identified as uncertain rather than presented as fact.
3. The freelancer reviews the analysis and edits the added work, price, and delivery change. AI does not commit the freelancer to a price or deadline.
4. The freelancer explicitly approves and publishes a proposal, receiving a shareable client link.
5. The client opens that link, reviews the exact work, price, currency, and delivery change, and explicitly accepts before entering PayPal sandbox checkout.
6. After confirmed payment, the client sees a receipt/status and the freelancer can see that the proposal is paid.

## Screens and Layout
- **Freelancer workspace:** original agreement and request inputs, comparison results, editable proposal, publish action, client link, and proposal payment status. Use clear steps on a simple page.
- **Client proposal:** standalone shareable page displaying only the approved proposal, acceptance and PayPal payment actions, and payment status. It does not expose private input texts, internal AI reasoning, editing controls, or freelancer credentials.

## Look and Feel
The learner requested basic design and functional completeness first. Use readable text, labeled form fields, clear primary actions, responsive layout, accessible focus and status messages. Defer branding and visual polish.

## Features and Behavior

### Agreement Comparison
Source: `scope.md > The Core Loop`.
- Require both original agreement and new request before analysis.
- Show progress during AI analysis and preserve inputs on failure.
- Show identified additions and their explanation; identify ambiguous requests for freelancer review.
- If the request appears included in the original agreement, explain that outcome. Do not invent extra work or automatically prepare a charge.
- All AI output remains advisory and editable before publication.

### Proposal Review and Publication
Source: `scope.md > The Core Loop` and `Explicitly Cut`.
- The freelancer reviews the proposed work and supplies or approves the price and delivery change.
- Display a clearly identified currency; never infer or convert currencies silently.
- Validate required content and a valid positive payment amount before publication.
- Explicit publication creates a shareable client link to the approved terms.
- Published terms are fixed for this proof of concept, so the client cannot pay a proposal whose amount or work changes underneath them. Corrections require a new proposal.
- Preserve published proposals and payment records across application restarts.

### Client Review and Payment
Source: `scope.md > What "Working" Looks Like` and `The POC Boundary`.
- Anyone with the client link can view that proposal; use an unguessable link and clearly explain that possession grants access.
- Show the work, price, currency, and delivery change before acceptance.
- Require explicit client acceptance before starting PayPal sandbox payment.
- Cancellation or failed checkout does not display paid status. The client can return and retry when payment was not completed.
- Confirm payment using PayPal's returned transaction state and the proposal's expected amount and currency. A redirect alone is not proof of payment.
- A paid proposal shows payment confirmation and cannot be charged again through ScopeShield.
- Do not claim that payment is complete while the result is pending or unknown; reconcile status before retrying a potentially completed payment.

## States and Boundaries
- **First use:** empty labeled inputs explain what to provide.
- **Invalid input:** actionable field errors; preserve existing work.
- **Analysis unavailable:** clear retryable error; no fabricated AI result.
- **No extra work or unclear request:** explain the result and leave the freelancer in control.
- **Invalid or missing client link:** show a neutral unavailable message without leaking other proposals.
- **Published:** approved terms are read-only for the client.
- **Payment cancelled/failed/pending/paid:** distinguish outcomes, provide appropriate next steps, and preserve the approved proposal.
- **Access:** client links allow viewing and payment only. Freelancer creation, editing, and publishing require a separate protected access mechanism; its implementation belongs in the spec.
- **Persistence:** published terms and payment references survive restarts. No agreement text, API credentials, or internal AI context is included in client URLs.
- **Security requirement:** API secrets live only on the server in ignored environment configuration. Store published proposals and payment records in SQLite, never browser localStorage or sessionStorage. Authenticate the freelancer with a server-managed session in an HttpOnly cookie; keep credentials out of browser storage and client links. Serve only the explicit public asset directory, never environment files or the database.

## Product Decisions
- ScopeShield and its core freelancer-to-client workflow were explicitly accepted.
- The learner chose shareable client links rather than demonstrating both roles on one screen.
- The learner requested basic design, with functionality taking priority over visual polish.
- The learner selected Groq for testing and explicitly prioritized secure environment configuration and server-side persistence over browser storage.
- Proposed implementation boundaries for review: fixed published proposals, durable payment records, and separate protected freelancer access. These prevent ambiguous approval and payment states without adding full project management.

## What We're Building
One working agreement comparison → editable proposal → shareable client review → PayPal sandbox payment journey, with real AI, explicit human approval, persistent published terms and payment status, and documented setup.

## Deferred From the POC
- Full freelancer account registration, teams, and multi-tenant administration: unnecessary for a single-freelancer demonstration. Protect the freelancer workspace using the simpler mechanism chosen in the spec.
- Email delivery and reminders: the freelancer can copy and send the client link.
- Post-publication negotiation and proposal version histories: create a replacement proposal instead.
- Agreement uploads and document extraction: pasted text demonstrates the core comparison.
- Visual polish: explicitly deferred by the learner.

## Non-Goals
- Real-money payments, automatic client charges, and AI commitments without freelancer review: excluded by approved scope.
- Full project management, legal interpretation, and guaranteed AI correctness: outside the core demonstration.

## Acceptance Checks
- A three-page website agreement plus a ten-product store request yields an explained potential addition for review.
- A request already included in the agreement is not falsely presented as a certain paid addition.
- The freelancer can edit work, price, and delivery change before publishing.
- A separate browser can open the published client link and see the exact approved terms without accessing private freelancer content.
- Published terms and resulting payment state remain available after restarting the app.
- Successful PayPal sandbox payment produces confirmed paid status with a transaction reference; cancellation and failures do not.
- Repeated actions or reopening a paid link do not create a second charge.

## Open Questions
- Technical planning must choose the AI provider/model, PayPal API details, a supported initial currency, persistence, and the simplest protected freelancer access approach. Validate external API capabilities before implementation.
- Judge-run setup versus hosting remains for the technical plan; either is allowed by the supplied hackathon requirements.
