# ScopeShield

ScopeShield helps freelancers compare an existing agreement with a new client request and draft a proposal for additional work.

Currently implemented: protected freelancer login, Groq-powered comparison with quoted evidence, editable draft terms, immutable published proposals saved in SQLite, and shareable client review pages. PayPal sandbox checkout is not implemented yet. This is not yet a complete hackathon submission.

## Run locally

Requires Node.js 24.13+ (tested with Node 26) and npm.

1. Run `npm ci`.
2. If you do not already have `.env`, copy `.env.example` to `.env`. Never overwrite an existing configuration.
3. Set `GROQ_API_KEY` using your Groq account. The default model is `openai/gpt-oss-20b`, served by Groq, with strict structured outputs. No OpenAI API key is needed.
4. Generate a login secret with `openssl rand -hex 32` and place it in `OWNER_ACCESS_KEY`. Keep it private; this is the freelancer login credential.
5. Restrict the local file with `chmod 600 .env`.
6. Run `npm start` and open `http://localhost:3000`. Enter the owner access key to log in.

Use **Load website example**, then **Analyze request**, to try the synthetic demo. Review the classification, quoted evidence, and explanations. Edit the proposed work, price in USD, and delivery change. Check the review confirmation and choose **Approve and publish proposal** to save fixed terms and get a client link. Open it in a separate browser to review the approved terms. No payment can be taken yet.

`APP_URL` must match the origin in your browser exactly. The server binds to `127.0.0.1`, does not trust proxy headers, and accepts HTTP only on loopback for development. Hosting needs HTTPS, an appropriate reverse proxy, and further deployment configuration; this release is intended for local testing.

PayPal configuration entries are placeholders for the upcoming sandbox integration. Leave them blank for this first step. To obtain them, open the PayPal Developer Dashboard, select **Apps & Credentials → Sandbox**, and create an app attached to a sandbox business account. Use a separate sandbox personal account for eventual buyer checkout. Never use live payment credentials for this demo.

## Security and data

- API credentials stay in server-side `.env`; missing Groq or owner credentials prevent startup. Only `.env.example` with blank secrets belongs in Git.
- Login uses a random, expiring server-managed session. Its cookie is HttpOnly, SameSite=Strict, and Secure when configured with HTTPS. The server stores only the session token hash. Logout/restart invalidates sessions.
- The app does not use localStorage or sessionStorage. Unpublished inputs, analysis, and draft edits stay only in page memory and are cleared on reload/logout. Published proposals live in `data/scopeshield.sqlite` with owner-only permissions and survive restarts. Back up this directory if you need to preserve records. Client links grant view access to anyone who possesses them; keep them private. Localhost links work only on the computer running the app.
- Agreement and request text is sent to Groq for analysis. Use synthetic data during testing and check your provider's data policies before submitting confidential client content.
- AI results are advisory. Quotes are checked against the submitted text, allowing whitespace differences only. Invalid evidence triggers one corrective Groq attempt; repeated invalid evidence is rejected. That retry can consume an additional API call. Interpretation can still be wrong, so a freelancer must review the result; checkout remains unavailable in this version.
- State-changing requests require matching Origin and JSON content type. Owner APIs require a valid session. Login and analysis are throttled. Throttling is per connection IP and per server process, with proxy trust disabled; this local prototype is not a multi-instance public service.
- Only `public/` is web-served. Environment files, source, local plans, and future databases are excluded. Responses use no-store/no-referrer and restrictive content/security headers. User and AI strings render as text rather than HTML.
- Keep local plans, tooling, credentials, runtime databases, private keys, and dependencies out of commits. Ignore rules do not remove files already committed to history.

## Verify

Run `npm test`. Tests use synthetic text and mocked Groq responses; they do not consume real API credits and do not prove live provider access. To verify your actual key/model, start the app and run the example. Missing keys, provider errors, and malformed output are shown as errors; the app never substitutes fake analysis.

## Files

- `src/server.js`: routes, authentication, sessions, security boundaries, and startup.
- `src/analysis.js`: Groq request, schema, prompt, and result/evidence validation.
- `src/validation.js`: bounded text, exact USD money parsing, and environment configuration checks.
- `src/store.js`: private SQLite records, fixed published terms, and allowlisted public views.
- `public/`: basic freelancer UI and browser behavior.
- `test/`: configuration, AI, API, and security checks.

## License

MIT. See [LICENSE](LICENSE).
