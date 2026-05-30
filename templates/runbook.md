# Runbook Template

Copy this file to `playbooks/runbooks/[alert-name].md` for each alert defined
in your observability configuration. Without runbooks, alerts train your team
to ignore alerts.

---

# Runbook: [Alert Name]

## What this alert means

[Plain-language explanation of what condition triggered the alert. Not the
threshold expression — the actual problem condition.]

## Severity

[P0 / P1 / P2 / P3]

## Impact

- **Users affected:** [who, how many]
- **Functionality affected:** [what's broken]
- **Data risk:** [none / inconsistency / loss / exposure]
- **Regulatory:** [breach trigger? PIPEDA s.10.1 timer started?]

## Likely causes (ranked by historical frequency)

1. [Most common cause]
   - Indicator: [how to tell it's this cause]
   - Resolution: [steps]
2. [Second most common]
   - Indicator: ...
   - Resolution: ...
3. [Less common]
   - Indicator: ...
   - Resolution: ...

## Investigation steps

1. [First check — usually look at dashboards]
   - Dashboard link: ...
   - What to look for: ...

2. [Second check — usually logs]
   - Query: `[exact log query]`
   - What to look for: ...

3. [Third check — usually recent changes]
   - Recent deploys: [link to deploy history]
   - Recent feature flag changes: [link]
   - Recent config changes: [link]

## Resolution paths

### If cause #1:

1. [Step]
2. [Step]
3. Verify: [how to confirm fixed]

### If cause #2:

1. [Step]
2. ...

### If unknown:

1. [Stabilize first — flag off, rollback, scale up]
2. [Investigate after]
3. [Escalation contact]

## Escalation

- Primary owner: [name / role]
- Backup: [name / role]
- After hours: [process]

## Related runbooks

- [Link to related alert runbook]
- [Link to general incident response playbook]

## After resolution

- [ ] Confirm metrics returned to baseline for 30 minutes
- [ ] Update status page if posted
- [ ] Communication sent (if user-impacting)
- [ ] Incident logged for post-mortem if SEV-0 or SEV-1
- [ ] Add lesson to `.context/lessons.md` if novel cause

---

## Template maintenance

When you update this runbook based on a real incident, increment the version
and date below. Stale runbooks are worse than no runbooks.

**Last updated:** [DATE]
**Last incident this fired in:** [DATE / link to post-mortem]
