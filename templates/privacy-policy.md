# Privacy Policy — Template

> **NOT LEGAL ADVICE.** This is a starting structure. Have a privacy lawyer review
> the final version before publication. PIPEDA, Quebec Law 25, and other regimes
> have specific requirements that must be tailored to your actual practices.

---

# Privacy Policy

**Effective date:** [DATE]
**Last updated:** [DATE]

## 1. Who we are

[Organization name] (we / us / our) operates [service name] (the Service).
For privacy matters, contact our Privacy Officer at:

- Email: privacy@[domain].ca
- Mail: [Address]

## 2. What information we collect

We collect the following personal information:

### From you, directly:

- [Account information: name, email, etc.]
- [Profile information, if applicable]
- [Content you submit]

### Automatically, when you use the Service:

- [IP address, browser type, device]
- [Pages visited, features used (analytics)]
- [Cookies and similar technologies]

### From third parties:

- [List integrations that share data with you]

## 3. Why we collect it (purposes)

We collect personal information for these specific purposes:

- **Service provision**: to provide the features you use
- **Account management**: to authenticate you and protect your account
- **Communication**: to respond to inquiries and send service notices
- [Other specific, documented purposes — be precise; vague purposes don't meet PIPEDA]

We will not use your personal information for purposes other than those
listed here without obtaining your consent.

## 4. Legal basis (consent)

We rely on your consent to collect and use your personal information.
By using the Service, you consent to the collection and use described
in this policy. You may withdraw consent at any time by contacting our
Privacy Officer (this may affect our ability to provide the Service).

## 5. Who we share it with

We share personal information only as described here:

### Service providers (subprocessors):

- [List each: name, purpose, country of processing]
- Each provider is bound by a data processing agreement requiring
  PIPEDA-comparable protections.

### Legal disclosures:

- When required by law (court order, lawful warrant)
- To protect rights, safety, or property

We **do not** sell personal information.

## 6. Where it is stored

Personal information is stored in [country/region]. Where data leaves Canada,
we ensure comparable protection through contractual safeguards.
[For Quebec users: a Privacy Impact Assessment supports this transfer.]

## 7. How long we keep it

Retention by category:

- Account data: [duration, e.g., until account deletion + 30 days]
- Transaction records: [duration, with legal basis]
- Logs: [duration]
- Backups: [duration]

When retention expires, data is deleted or anonymized.

## 8. Your rights

Under PIPEDA, you have the right to:

- **Access** the personal information we hold about you
- **Correct** inaccurate information
- **Challenge** our handling of your information

To exercise these rights, contact our Privacy Officer. We will respond
within 30 days as required by PIPEDA.

[For Quebec users (Law 25), you additionally have:]

- **Portability** of personal information
- **Right to be informed** of automated decisions affecting you
- **Right to deindex** in some circumstances

## 9. How we protect your information

We use these safeguards:

- Encryption in transit (TLS 1.2+) and at rest (AES-256)
- Access controls (least privilege, MFA for admin)
- Audit logging
- Regular security reviews and dependency updates
- Incident response plan with breach notification procedures

No system is perfectly secure. If a breach involves your information and
creates a real risk of significant harm, we will notify you and the Office
of the Privacy Commissioner of Canada as required by PIPEDA s.10.1.

## 10. Cookies and similar technologies

We use:

- **Essential cookies**: required for the Service to function
- **Analytics cookies**: [details if used; opt-in if non-essential]
- [Other categories as applicable]

You can control cookies through your browser. Disabling essential cookies
may affect the Service.

## 11. Children

The Service is not directed at children under 13 (or [age threshold in
applicable jurisdiction]). We do not knowingly collect personal information
from children. If you believe we have, contact us for deletion.

## 12. Changes to this policy

We may update this policy. We will notify users of material changes via
[email/in-app notice/etc.] and update the "Last updated" date. Continued
use after notice constitutes acceptance.

## 13. Complaints

You may file a complaint with us at privacy@[domain].ca.

If unresolved, you may contact the **Office of the Privacy Commissioner
of Canada**:

- https://www.priv.gc.ca
- 1-800-282-1376

[For Quebec users:] You may contact the **Commission d'accès à
l'information du Québec**:

- https://www.cai.gouv.qc.ca

---

## Notes for the developer

This template is intentionally generic. Before publishing:

1. **Have a privacy lawyer review.** PIPEDA penalties for violations have
   teeth. Quebec Law 25 has higher penalties (up to 4% of global revenue
   or $25M CAD).
2. **Match it to your actual code.** Privacy-reviewer agent checks for
   drift between policy and behavior. Update both together.
3. **Translate to French** if any Quebec users (Law 25 requires it).
4. **Maintain a version history.** Old versions should remain accessible.
5. **Reference this from your app** at signup, in settings, and in your
   footer.
6. **Update the agents' `.context/decisions.md`** with the privacy
   commitments you've made — every agent should respect them.
