// Drizzle schema root. Empty in milestone 1.1 — tables land starting in
// 1.3 (audit log) and 1.5 (hazards). drizzle-kit reads this file to
// generate migrations into the root `migrations/` directory.

export const schema = {} as const;
export type Schema = typeof schema;
