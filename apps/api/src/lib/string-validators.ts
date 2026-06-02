// Shared Zod string-validator helpers (1.9 S5 priv-F14 close-out).
//
// `noHtmlBounded` was originally inlined in
// `apps/api/src/routes/inspections/index.ts` for the 1.8 finding +
// template surfaces. The 1.9 recommendations surface needs the same
// refinement on `title`, `body`, `authorRole`, and response `body`
// fields. Rather than duplicate the helper, S5 extracts it here so
// both routes (and any future module) share one definition.
//
// The refinement rejects:
//   - `<` / `>` (HTML / markdown shorthand)
//   - C0 control characters (U+0000..U+001F) EXCEPT \t \n \r — printable
//     whitespace and newlines are allowed because body fields are
//     long-form prose.
//   - C1 control characters (U+0080..U+009F) — universally unprintable
//     legacy control-set characters.
//   - BiDi override characters (U+202A..U+202E + U+2066..U+2069) — these
//     can re-order rendered glyphs to weaponize a PDF (the rep sees
//     "approve this" while the printed bytes say "deny this"); priv-F14
//     close-out.
//
// The helper builds the .min/.max constraints FIRST then applies
// .refine LAST — `refine` returns `ZodEffects` which sheds the
// .min/.max API, so order matters.

import { z } from 'zod';

const HTML_OR_CONTROL_RE = /[<>]/;

/**
 * Returns true iff the string contains any forbidden control / BiDi
 * codepoint. Kept as a separate function so tests can target the
 * codepoint matrix directly.
 */
function hasForbiddenCodepoint(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // C0 controls except \t (0x09), \n (0x0A), \r (0x0D).
    if (c <= 0x1f) {
      if (c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
      continue;
    }
    // DEL (0x7F) + C1 controls (0x80..0x9F).
    if (c === 0x7f) return true;
    if (c >= 0x80 && c <= 0x9f) return true;
    // BiDi override characters (priv-F14 specific):
    //   U+202A LEFT-TO-RIGHT EMBEDDING
    //   U+202B RIGHT-TO-LEFT EMBEDDING
    //   U+202C POP DIRECTIONAL FORMATTING
    //   U+202D LEFT-TO-RIGHT OVERRIDE
    //   U+202E RIGHT-TO-LEFT OVERRIDE
    //   U+2066 LEFT-TO-RIGHT ISOLATE
    //   U+2067 RIGHT-TO-LEFT ISOLATE
    //   U+2068 FIRST STRONG ISOLATE
    //   U+2069 POP DIRECTIONAL ISOLATE
    if (c >= 0x202a && c <= 0x202e) return true;
    if (c >= 0x2066 && c <= 0x2069) return true;
  }
  return false;
}

/**
 * Build a Zod string schema with explicit `min`/`max` bounds and the
 * shared "no HTML, no control chars, no BiDi overrides" refinement.
 *
 * Used by:
 *   - `apps/api/src/routes/inspections/index.ts` (template label /
 *     helpText / displayName, observation, correctiveAction,
 *     responsibleParty.nameText, signature note)
 *   - `apps/api/src/routes/recommendations/index.ts` (title, body,
 *     response authorRole, response body) — priv-F14 close-out
 */
export function noHtmlBounded(opts: {
  min?: number;
  max: number;
}): z.ZodEffects<z.ZodString, string, string> {
  let s = z.string().max(opts.max);
  if (opts.min !== undefined) s = s.min(opts.min);
  return s.refine((v) => {
    if (HTML_OR_CONTROL_RE.test(v)) return false;
    if (hasForbiddenCodepoint(v)) return false;
    return true;
  }, 'must not contain `<`, `>`, control characters, or BiDi overrides');
}

/** Exposed for unit tests. */
export const _internal = { hasForbiddenCodepoint };
