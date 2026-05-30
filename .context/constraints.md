# Constraints — Canadian/Ontario Privacy & Security

**These are hard requirements, not preferences. Every agent reads this before
any task touching user data, auth, storage, telemetry, or external services.**

This is not legal advice. For commercial launch, get a privacy lawyer to
review the actual compliance posture.

---

## Jurisdiction

- **Primary:** Canada (federal) + Ontario (provincial)
- **PIPEDA** applies to all commercial activity involving personal information
- **Ontario regimes** layer on for specific data types (see below)
- **Quebec Law 25:** out of scope — no Quebec users. Revisit before serving
  any Quebec resident; the regime is stricter than PIPEDA.
- **Other provinces** (BC PIPA, Alberta PIPA, Nova Scotia PIIDPA): out of scope.
  Revisit if audience expands outside Ontario.

---

## PIPEDA — The Federal Baseline

Every feature touching personal information must satisfy the ten fair-information principles:

1. **Accountability** — designated privacy contact, published policy, accountable for transfers to third parties
2. **Identifying purposes** — purpose stated at or before collection
3. **Consent** — meaningful, informed, and appropriate to sensitivity. Opt-in for anything beyond what's reasonably expected.
4. **Limiting collection** — only what's necessary for the stated purpose
5. **Limiting use, disclosure, retention** — only for stated purpose; retention schedule defined and enforced
6. **Accuracy** — users can correct their data
7. **Safeguards** — appropriate to sensitivity (see Technical Security below)
8. **Openness** — privacy practices readily available
9. **Individual access** — users can access their personal information on request
10. **Challenging compliance** — process for handling complaints

### Breach notification (PIPEDA s.10.1)

- Notify **Office of the Privacy Commissioner** AND affected individuals **as soon as feasible** when a breach creates **real risk of significant harm**
- Keep **breach records for 24 months** regardless of severity
- Bake the incident response plan into the app from day one — don't wait for an incident to find out you can't reconstruct what happened

---

## Ontario Layers (apply when relevant)

### PHIPA (Personal Health Information Protection Act)

**Trigger:** any health information about an identifiable individual.

- Health information custodian rules apply
- Lockbox provisions — users can restrict access to their record
- **Breach notification within 60 days** to affected individuals; report to IPC for significant breaches
- Strict consent rules; implied consent narrowly defined to the "circle of care"

### FIPPA / MFIPPA

**Trigger:** working with provincial or municipal government data.

- Requires authorization to collect
- Stricter retention and access rules
- Generally requires data to stay in Canada unless specific exceptions apply

### AODA — Accessibility for Ontarians with Disabilities Act

**Trigger:** any public-facing service.

- WCAG 2.0 Level AA minimum
- Accessibility statement published
- Feedback mechanism for accessibility issues

---

## Financial / Payment Data

**Trigger:** any storage, processing, or transmission of payment card data
(PAN, expiry, CVV) or bank account information.

- **PCI DSS** compliance required. Prefer a hosted payment provider
  (Stripe, Moneris, Square) that keeps card data off our servers — this
  scopes us to SAQ-A rather than full PCI DSS.
- **Never log card numbers**, even in encrypted form. Never log full bank
  account numbers.
- **Tokenize at the boundary**; persist only the provider's token, not the PAN.
- Heightened PIPEDA sensitivity expectations apply to financial information.
- A breach involving financial data almost always meets the "real risk of
  significant harm" threshold — assume notification is required.
- Reconciliation, refunds, and chargebacks need an audit trail separate
  from application logs.

---

## Technical Security Baseline

Non-negotiable for any app handling personal information:

### Encryption

- **TLS 1.2 minimum** (prefer 1.3) in transit — no exceptions
- **AES-256 at rest** for personal information
- Encrypted backups; key management documented

### Access control

- **MFA required** for all admin accounts and production access
- **Least privilege** — no shared admin accounts; role-based access
- Audit logs retained for at least 1 year (longer if regulated)
- Access reviewed quarterly

### Logging hygiene

- **No PII in application logs** unless absolutely necessary and documented
- No PII in error messages returned to clients
- No PII in URL query strings (they end up in proxy logs, browser history, referrer headers)
- Structured logs only; redact sensitive fields at the logging layer

### Application security

- Input validation at every trust boundary
- Output encoding to prevent injection
- Parameterized queries — no string concatenation for SQL
- CSRF protection on state-changing endpoints
- Rate limiting and abuse controls on auth endpoints
- Security headers (CSP, HSTS, X-Frame-Options, etc.)

### Vulnerability management

- **Dependency audit on every CI build** — block merge on high-severity CVEs
- Static analysis (semgrep or equivalent) on every PR
- Regular penetration test before launch and annually after
- Documented patching cadence

### Data lifecycle

- **Retention schedule defined per data type** and enforced (automated deletion)
- Deletion is real deletion (or documented anonymization), not just soft-delete
- Data export available for user access requests (PIPEDA s.8 / Law 25)
- Right-to-deletion workflow tested

### Third parties

- Vendor risk assessment before integrating any subprocessor
- Data processing agreements in place
- Cross-border transfers documented; PIPEDA-comparable safeguards verified

### Incident response

- Written incident response plan with named contacts and escalation path
- Tabletop exercise annually
- Communication templates for breach notification ready in advance

---

## Secrets handling — applies to all agents

Files and inline values that look like credentials, API keys, private
keys, passwords, or session tokens must never be summarized, quoted, or
echoed by any agent. If an agent reads such content (intentionally or
incidentally), it must:

- **Refuse to include the secret value** in any output — briefing,
  review comment, generated code, commit message, PR description, log
  line, or downstream-agent context.
- **Surface only the FACT** that a secret was encountered: file path,
  rough category (e.g. "AWS access key", "private key", "generic API
  token"), and a recommendation to rotate-and-remove.
- **Never propagate the value** to a downstream agent's context. The
  librarian and memory-curator are the most likely chokepoints — they
  must redact at the boundary.

Patterns that count as secret-bearing:

- Files: `.env`, `.env.*` (not `.env.example`); `*.pem`, `*.key`,
  `*.p12`, `*.pfx`, `*.jks` (not `*.example.*`); files with names
  containing `secret`, `credential`, `token`, `password`, `apikey` /
  `api_key` / `api-key`; cloud credential paths
  (`~/.aws/credentials`, `~/.config/gcloud/`, `~/.kube/config`,
  `~/.netrc`).
- Inline values: AWS keys (`AKIA[0-9A-Z]{16}`), GitHub tokens (`ghp_*`,
  `gho_*`, `ghu_*`, `ghs_*`, `github_pat_*`), Stripe live keys
  (`sk_live_*`, `pk_live_*`, `rk_live_*`), Google API keys
  (`AIza[0-9A-Za-z-_]{35}`), Slack tokens (`xox[abprs]-*`), private-key
  headers (`-----BEGIN ... PRIVATE KEY-----`), JWTs hard-coded as
  literals in source.

If a secret appears inside any `.context/` file, treat that as a
finding in itself: those files were meant to capture institutional
knowledge, not credentials. Recommend immediate rotation **and** removal
from git history (the value is already exposed to anyone who can clone
the repo).

---

## Hard Rules for Agents

Every agent working on this project must:

1. **Never log, return, or display personal information** beyond what the immediate function requires.
2. **Never disable security controls** "temporarily" or "for debugging" without an explicit human approval comment in the code.
3. **Never introduce a third-party service that processes personal data** without flagging it for human review — does it have a DPA, where is data stored, is it PIPEDA-compatible?
4. **Always assume cross-border data transfer is a flagged decision**, even to common services (Vercel, AWS US, etc.). Default to Canadian regions where available; document where it's not.
5. **Treat authentication, authorization, and session management as security-critical** — these get extra review, not autonomous merge.
6. **For any new data field collected from users**, require a documented purpose in `.context/decisions.md` before implementation.

---

## Human Gates (Non-Negotiable)

These never get automated, regardless of how much the system has learned:

- Approving the privacy policy and terms of service
- Approving the data retention schedule
- Approving any cross-border data transfer
- Approving access by a new subprocessor or third party
- Responding to a regulator (OPC federal, IPC Ontario)
- Breach notification decisions
- Production deploys of changes touching auth, billing, or personal data
