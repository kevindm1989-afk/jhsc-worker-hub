# Deployment

Production deployment notes live in [`../SECURITY.md`](../SECURITY.md) §8
(pre-launch checklist) and [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §12.

This file is a placeholder. It will be expanded as deploy procedures
solidify across Milestones 1.1 → 1.12. Topics expected:

- Fly.io provisioning (region `yyz`)
- Neon Postgres setup (region `ca-central-1`)
- Tigris bucket provisioning
- Fly Secrets management — master key, VAPID, Tigris creds
- GitHub Actions → `fly deploy` pipeline
- DNS, HSTS preload, CSP verification
- Backup & restore drill procedure
