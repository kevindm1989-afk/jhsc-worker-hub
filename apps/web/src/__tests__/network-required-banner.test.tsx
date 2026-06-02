// Unit tests for the NetworkRequiredBanner + its NetworkRequiredError
// integration on the existing view surfaces (Milestone 1.10 S3).

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NetworkRequiredBanner } from '../sync/components/network-required-banner';

describe('NetworkRequiredBanner', () => {
  it('renders the default copy', () => {
    render(<NetworkRequiredBanner />);
    expect(screen.getByText(/This action needs network/)).toBeInTheDocument();
    expect(screen.getByText(/Try again when you're back online/)).toBeInTheDocument();
  });

  it('renders the action verb when provided', () => {
    render(<NetworkRequiredBanner action="Reveal" />);
    expect(screen.getByText(/Reveal needs network/)).toBeInTheDocument();
  });

  it('renders as a polite status (not alert) so screen readers do not interrupt', () => {
    const { container } = render(<NetworkRequiredBanner action="Export" />);
    const root = container.firstElementChild;
    expect(root?.getAttribute('role')).toBe('status');
    expect(root?.getAttribute('aria-live')).toBe('polite');
  });

  it('exposes a Dismiss button when onDismiss is provided', async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<NetworkRequiredBanner action="Reveal" onDismiss={onDismiss} />);
    const dismiss = screen.getByRole('button', { name: /Dismiss/ });
    await user.click(dismiss);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('hides the Dismiss button when onDismiss is omitted', () => {
    render(<NetworkRequiredBanner action="Reveal" />);
    expect(screen.queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument();
  });

  it('pairs the WifiOff icon with the textual label per CLAUDE.md never-color-alone', () => {
    const { container } = render(<NetworkRequiredBanner action="Download" />);
    // The icon's lucide class names are present in the rendered SVG.
    const wifiOff = container.querySelector('.lucide-wifi-off');
    expect(wifiOff).not.toBeNull();
    // The textual label is also present (color + icon + label).
    expect(screen.getByText(/Download needs network/)).toBeInTheDocument();
  });
});
