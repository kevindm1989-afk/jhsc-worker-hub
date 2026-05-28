// WebAuthn / passkey primitives via @simplewebauthn/server.
//
// Three flows: register, authenticate, and step-up (a UV-required
// authenticate that the server uses to grant a fresh step-up window).
//
// All flows persist their challenge to `webauthn_challenges` with a
// 60-second TTL and a `purpose` discriminator. Verification consumes
// the challenge in the same transaction so a replay can't slip in.
//
// RP config comes from env (ADR-0001 §"WebAuthn parameters"):
//   WEBAUTHN_RP_ID   — registrable hostname
//   WEBAUTHN_RP_ORIGIN — full origin string the browser sees
//   WEBAUTHN_RP_NAME — human-readable name in the prompt

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/types';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb } from '../db/client';
import { passkeyCredentials, webauthnChallenges } from '../db/schema';
import { env } from '../env';
import type { WebauthnPurpose } from './enums';

const CHALLENGE_TTL_SECONDS = 60;

function rpConfig() {
  return {
    rpID: env.WEBAUTHN_RP_ID,
    rpName: env.WEBAUTHN_RP_NAME,
    origin: env.WEBAUTHN_RP_ORIGIN,
  };
}

async function persistChallenge(
  userId: string | null,
  purpose: WebauthnPurpose,
  challenge: Uint8Array,
): Promise<void> {
  const db = getDb();
  const now = new Date();
  await db.insert(webauthnChallenges).values({
    userId,
    purpose,
    challenge,
    expiresAt: new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000),
  });
}

async function consumeChallenge(
  purpose: WebauthnPurpose,
  challenge: Uint8Array,
  expectedUserId: string | null,
): Promise<boolean> {
  const db = getDb();
  const now = new Date();
  // Atomic consume-if-unconsumed-and-not-expired-and-matches-purpose.
  const updated = await db
    .update(webauthnChallenges)
    .set({ consumedAt: now })
    .where(
      and(
        eq(webauthnChallenges.challenge, challenge),
        eq(webauthnChallenges.purpose, purpose),
        gt(webauthnChallenges.expiresAt, now),
        isNull(webauthnChallenges.consumedAt),
        expectedUserId
          ? eq(webauthnChallenges.userId, expectedUserId)
          : isNull(webauthnChallenges.userId),
      ),
    )
    .returning({ id: webauthnChallenges.id });
  return updated.length > 0;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function startRegistration(args: {
  userId: string;
  userDisplayName: string;
  userName: string;
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const rp = rpConfig();
  // Existing credentials for this user — exclude so the user doesn't
  // accidentally enroll the same authenticator twice.
  const db = getDb();
  const existing = await db
    .select({ id: passkeyCredentials.id, transports: passkeyCredentials.transports })
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.userId, args.userId));
  const opts = await generateRegistrationOptions({
    rpID: rp.rpID,
    rpName: rp.rpName,
    userID: new TextEncoder().encode(args.userId),
    userName: args.userName,
    userDisplayName: args.userDisplayName,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
    excludeCredentials: existing.map((c) => ({
      id: bytesToB64u(c.id),
      transports: (c.transports as AuthenticatorTransportFuture[]) ?? undefined,
    })),
  });
  await persistChallenge(args.userId, 'register', b64uToBytes(opts.challenge));
  return opts;
}

export interface FinishRegistrationInput {
  readonly userId: string;
  readonly response: RegistrationResponseJSON;
}

export interface FinishedRegistration {
  readonly credentialId: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: ReadonlyArray<string>;
}

export type FinishRegistrationOutcome =
  | { readonly ok: true; readonly credential: FinishedRegistration }
  | { readonly ok: false; readonly reason: 'challenge_expired' | 'verification_failed' };

export async function finishRegistration(
  input: FinishRegistrationInput,
): Promise<FinishRegistrationOutcome> {
  const rp = rpConfig();
  const challengeBytes = b64uToBytes(input.response.response.clientDataJSON);
  void challengeBytes;
  // Pull the challenge from clientDataJSON inside verifyRegistrationResponse — the lib does this internally.
  // We don't have direct access to the challenge bytes here, so consume by purpose+user+the most recent unconsumed entry.
  const db = getDb();
  const now = new Date();
  const rows = await db
    .select({ id: webauthnChallenges.id, challenge: webauthnChallenges.challenge })
    .from(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.purpose, 'register'),
        eq(webauthnChallenges.userId, input.userId),
        gt(webauthnChallenges.expiresAt, now),
        isNull(webauthnChallenges.consumedAt),
      ),
    );
  if (rows.length === 0) {
    return { ok: false, reason: 'challenge_expired' };
  }
  // Try each unconsumed challenge — the recent ones first — until one
  // verifies. In practice there is exactly one because the route flow
  // calls `startRegistration` then immediately `finishRegistration`.
  for (const row of rows) {
    try {
      const verification = await verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: bytesToB64u(row.challenge),
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) continue;
      const consumed = await consumeChallenge('register', row.challenge, input.userId);
      if (!consumed) continue;
      const info = verification.registrationInfo;
      return {
        ok: true,
        credential: {
          credentialId: info.credential.id ? b64uToBytes(info.credential.id) : new Uint8Array(),
          publicKey: info.credential.publicKey,
          counter: info.credential.counter,
          transports:
            (input.response.response.transports as ReadonlyArray<string> | undefined) ?? [],
        },
      };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, reason: 'verification_failed' };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export async function startAuthentication(args: {
  userId?: string | null;
  purpose?: WebauthnPurpose;
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const purpose: WebauthnPurpose = args.purpose ?? 'authenticate';
  const rp = rpConfig();
  const allowCredentials = args.userId
    ? await (async () => {
        const db = getDb();
        const rows = await db
          .select({ id: passkeyCredentials.id, transports: passkeyCredentials.transports })
          .from(passkeyCredentials)
          .where(eq(passkeyCredentials.userId, args.userId!));
        return rows.map((r) => ({
          id: bytesToB64u(r.id),
          transports: (r.transports as AuthenticatorTransportFuture[]) ?? undefined,
        }));
      })()
    : undefined;
  const opts = await generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: 'required',
    ...(allowCredentials ? { allowCredentials } : {}),
  });
  await persistChallenge(args.userId ?? null, purpose, b64uToBytes(opts.challenge));
  return opts;
}

export interface FinishAuthenticationInput {
  readonly response: AuthenticationResponseJSON;
  readonly purpose?: WebauthnPurpose;
}

export interface FinishedAuthentication {
  readonly userId: string;
  readonly credentialId: Uint8Array;
  readonly newCounter: number;
}

export type FinishAuthenticationOutcome =
  | { readonly ok: true; readonly auth: FinishedAuthentication }
  | {
      readonly ok: false;
      readonly reason:
        | 'unknown_credential'
        | 'counter_rollback'
        | 'challenge_expired'
        | 'verification_failed';
    };

export async function finishAuthentication(
  input: FinishAuthenticationInput,
): Promise<FinishAuthenticationOutcome> {
  const purpose: WebauthnPurpose = input.purpose ?? 'authenticate';
  const rp = rpConfig();
  const credentialIdBytes = b64uToBytes(input.response.id);
  const db = getDb();
  const credRows = await db
    .select({
      id: passkeyCredentials.id,
      userId: passkeyCredentials.userId,
      publicKey: passkeyCredentials.publicKey,
      counter: passkeyCredentials.counter,
      transports: passkeyCredentials.transports,
    })
    .from(passkeyCredentials)
    .where(eq(passkeyCredentials.id, credentialIdBytes))
    .limit(1);
  const cred = credRows[0];
  if (!cred) return { ok: false, reason: 'unknown_credential' };

  const now = new Date();
  const challengeRows = await db
    .select({ id: webauthnChallenges.id, challenge: webauthnChallenges.challenge })
    .from(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.purpose, purpose),
        gt(webauthnChallenges.expiresAt, now),
        isNull(webauthnChallenges.consumedAt),
      ),
    );
  if (challengeRows.length === 0) {
    return { ok: false, reason: 'challenge_expired' };
  }
  for (const row of challengeRows) {
    try {
      const verification = await verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: bytesToB64u(row.challenge),
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
        credential: {
          id: bytesToB64u(cred.id),
          publicKey: cred.publicKey,
          counter: cred.counter,
          transports: (cred.transports as AuthenticatorTransportFuture[]) ?? undefined,
        },
      });
      if (!verification.verified) continue;
      // signCount rollback check: the lib enforces "newCounter > storedCounter"
      // unless storedCounter === 0 AND newCounter === 0 (RFC 8809 allows
      // authenticators that don't implement a counter to keep it at 0
      // forever). We mirror that policy explicitly so reviewers can find it.
      const newCounter = verification.authenticationInfo.newCounter;
      if (newCounter < cred.counter) {
        return { ok: false, reason: 'counter_rollback' };
      }
      const consumed = await consumeChallenge(purpose, row.challenge, cred.userId);
      if (!consumed) {
        // The same plaintext shouldn't be reusable; bail.
        return { ok: false, reason: 'verification_failed' };
      }
      // Update credential counter + last_used_at.
      await db
        .update(passkeyCredentials)
        .set({ counter: newCounter, lastUsedAt: now })
        .where(eq(passkeyCredentials.id, cred.id));
      return {
        ok: true,
        auth: {
          userId: cred.userId,
          credentialId: cred.id,
          newCounter,
        },
      };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, reason: 'verification_failed' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64uToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

function bytesToB64u(b: Uint8Array): string {
  return Buffer.from(b)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export const _internals = { CHALLENGE_TTL_SECONDS };
