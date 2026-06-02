// Unit tests for the PWA install prompt (Milestone 1.10 S3, ADR §3.10,
// SECURITY.md T-S37).

import 'fake-indexeddb/auto';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PwaInstallPrompt,
  bumpSessionCount,
  _internal as pwaInternal,
} from '../sync/components/pwa-install-prompt';
import { db } from '../sync/db';

let originalUA: string;

beforeEach(async () => {
  await db.open();
  await db.evidence_files.clear();
  originalUA = navigator.userAgent;
});

afterEach(async () => {
  await db.evidence_files.clear();
  window.localStorage.clear();
  Object.defineProperty(navigator, 'userAgent', {
    value: originalUA,
    configurable: true,
  });
});

/** Force the userAgent to a specific platform. */
function spoofUserAgent(ua: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    value: ua,
    configurable: true,
  });
}

describe('PwaInstallPrompt — gating', () => {
  it('does not render in auto mode without engagement signals', () => {
    spoofUserAgent('Mozilla/5.0 (Linux; Android 12) Chrome/120.0');
    render(<PwaInstallPrompt mode="auto" />);
    expect(screen.queryByText(/Install JHSC Worker Hub/)).not.toBeInTheDocument();
  });

  it('renders in auto mode when session count >= 3', async () => {
    spoofUserAgent('Mozilla/5.0 (Linux; Android 12) Chrome/120.0');
    bumpSessionCount();
    bumpSessionCount();
    bumpSessionCount();
    render(<PwaInstallPrompt mode="auto" />);
    expect(await screen.findByText(/Install JHSC Worker Hub/)).toBeInTheDocument();
  });

  it('renders in auto mode when evidence count >= 1', async () => {
    spoofUserAgent('Mozilla/5.0 (Linux; Android 12) Chrome/120.0');
    await db.evidence_files.add({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      linkedType: 'hazard',
      linkedId: 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz',
      mimeType: 'image/png',
      byteSize: 12345,
      plaintextSha256: 'x'.repeat(64),
      uploadedAt: new Date().toISOString(),
      uploadedByUserId: 'user-1',
      _sync_state: 'clean',
      _local_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      _server_version: 1,
      _base_state_json: '',
      _updated_at_client: new Date().toISOString(),
      _synced_at: new Date().toISOString(),
    });
    render(<PwaInstallPrompt mode="auto" />);
    expect(await screen.findByText(/Install JHSC Worker Hub/)).toBeInTheDocument();
  });

  it('does not render in auto mode when dismissed-hard is set', () => {
    spoofUserAgent('Mozilla/5.0 (Linux; Android 12) Chrome/120.0');
    bumpSessionCount();
    bumpSessionCount();
    bumpSessionCount();
    window.localStorage.setItem(pwaInternal.DISMISSED_KEY, 'true');
    render(<PwaInstallPrompt mode="auto" />);
    expect(screen.queryByText(/Install JHSC Worker Hub/)).not.toBeInTheDocument();
  });

  it('always renders in inline mode (unless hard-dismissed) so the rep can opt in', async () => {
    spoofUserAgent('Mozilla/5.0 (Linux; Android 12) Chrome/120.0');
    render(<PwaInstallPrompt mode="inline" />);
    expect(await screen.findByText(/Install JHSC Worker Hub/)).toBeInTheDocument();
  });
});

describe('PwaInstallPrompt — platform branches', () => {
  it('Android: fires the deferred beforeinstallprompt event on Install', async () => {
    spoofUserAgent('Mozilla/5.0 (Linux; Android 12) Chrome/120.0');
    bumpSessionCount();
    bumpSessionCount();
    bumpSessionCount();
    const promptFn = vi.fn().mockResolvedValue(undefined);
    const fakeEvent = new Event('beforeinstallprompt') as Event & {
      prompt: typeof promptFn;
      userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
    };
    fakeEvent.prompt = promptFn;
    fakeEvent.userChoice = Promise.resolve({ outcome: 'accepted' as const });
    render(<PwaInstallPrompt mode="auto" />);
    // Fire the event so the prompt caches the handle.
    await act(async () => {
      window.dispatchEvent(fakeEvent);
    });
    const installBtn = await screen.findByRole('button', { name: /^Install$/ });
    const user = userEvent.setup();
    await user.click(installBtn);
    expect(promptFn).toHaveBeenCalledOnce();
  });

  it('iOS: opens the modal with the Add-to-Home-Screen instructions', async () => {
    spoofUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    );
    bumpSessionCount();
    bumpSessionCount();
    bumpSessionCount();
    const user = userEvent.setup();
    render(<PwaInstallPrompt mode="auto" />);
    const cta = await screen.findByRole('button', { name: /How to install on iOS/ });
    await user.click(cta);
    expect(await screen.findByRole('dialog', { name: /Install on iOS/ })).toBeInTheDocument();
    // The instructions include the Share-sheet hint and Add to Home Screen.
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
  });
});

describe('PwaInstallPrompt — dismiss flow', () => {
  it("Don't-ask-again writes localStorage.jhsc.pwaInstallDismissed", async () => {
    spoofUserAgent('Mozilla/5.0 (Linux; Android 12) Chrome/120.0');
    bumpSessionCount();
    bumpSessionCount();
    bumpSessionCount();
    const user = userEvent.setup();
    render(<PwaInstallPrompt mode="auto" />);
    await screen.findByText(/Install JHSC Worker Hub/);
    const noAgain = await screen.findByRole('button', { name: /Don't ask again/ });
    await user.click(noAgain);
    expect(window.localStorage.getItem(pwaInternal.DISMISSED_KEY)).toBe('true');
    expect(screen.queryByText(/Install JHSC Worker Hub/)).not.toBeInTheDocument();
  });
});
