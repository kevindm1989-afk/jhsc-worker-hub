# Before shipping

Run this checklist before any production deploy that touches personal information,
auth, billing, or external services. Don't skip it because the change feels small.

---

## PIPEDA / privacy

- [ ] Any new personal information collected? Purpose documented in `decisions.md`?
- [ ] Consent flow updated if collection scope changed?
- [ ] Retention schedule defined and enforced (automated deletion or expiry)?
- [ ] Privacy policy still accurate?
- [ ] User access / export / deletion flows still working?

## Quebec Law 25 (if applicable)

- [ ] PIA done if this is a new tech project involving personal info?
- [ ] Cross-border transfer documented if data leaves Canada?
- [ ] Automated decision-making disclosed if applicable?

## Ontario-specific (if applicable)

- [ ] PHIPA: lockbox preferences respected? Breach response ready?
- [ ] FIPPA/MFIPPA: government data handling rules satisfied?
- [ ] AODA: WCAG 2.0 AA compliance verified for new UI?

## Technical security

- [ ] TLS 1.2+ enforced; HSTS header set?
- [ ] No PII in logs, error messages, URL params, referrer headers?
- [ ] All new endpoints have authn/authz?
- [ ] CSRF protection on state-changing endpoints?
- [ ] Rate limiting on auth and abuse-prone endpoints?
- [ ] Input validated at every trust boundary?
- [ ] Dependency audit clean (no high-severity CVEs)?
- [ ] Static analysis clean?
- [ ] Security headers set (CSP, HSTS, X-Frame-Options)?

## Third parties

- [ ] Any new subprocessor introduced? DPA in place? Storage region acceptable?
- [ ] Vendor risk assessment done if first integration?
- [ ] PIPEDA-comparable safeguards verified for non-Canadian processors?

## Operational

- [ ] Rollback plan documented (feature flag, migration reversal, etc.)?
- [ ] Observability in place (logs, metrics, error tracking)?
- [ ] Incident response contacts current?
- [ ] Backup verified recently?

## Human approval

- [ ] All items above either checked or explicitly waived with documented reason
- [ ] Changes to auth, billing, or personal data handling approved by a human
- [ ] Production deploy approved (or pre-approved via feature flag)

---

If anything is unchecked and unwaived, **the deploy doesn't go**. The system can
do everything else autonomously, but this gate stays human.
