import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../app';

// Behavioral assertions only. No className, no JSX-structure checks,
// no internal-state probing.
//
// The AuthRouter (Milestone 1.2) fetches /first-run/status and /session
// before mounting the AppShell. The default test-setup fetch mock
// resolves both immediately as "completed + authenticated", but the
// state update still flushes via useEffect — so the chrome is
// available on the *next* microtask, not the first paint. The async
// helpers (findByRole, findAllByRole) wait through that one tick.

describe('AppShell', () => {
  it('renders without crashing', () => {
    render(<App />);
    expect(document.body).toBeInTheDocument();
  });

  it('exposes all five primary tabs by accessible name', async () => {
    render(<App />);
    for (const label of ['Minutes', 'Hazards', 'Inspections', 'Recommendations', 'More']) {
      const links = await screen.findAllByRole('link', { name: label });
      expect(links.length).toBeGreaterThan(0);
    }
  });

  it('redirects from / to /minutes on first render', async () => {
    render(<App />);
    // The chrome mounts as soon as auth resolves; the Navigate index
    // route then pushes the URL. waitFor covers both ticks.
    await waitFor(() => expect(window.location.pathname).toBe('/minutes'));
  });

  it('has a skip-to-content link pointing at #main-content', async () => {
    render(<App />);
    const skipLink = await screen.findByRole('link', { name: /skip to main content/i });
    expect(skipLink).toHaveAttribute('href', '#main-content');
  });

  it('cycles the theme on toggle click (system → light → dark → system)', async () => {
    const user = userEvent.setup();
    render(<App />);

    const toggle = await screen.findByRole('button', { name: /theme:/i });
    const currentLabel = (): string => toggle.getAttribute('aria-label') ?? '';

    // Initial state — no localStorage entry yet, defaults to 'system'.
    expect(currentLabel()).toMatch(/^Theme: system\./);

    await user.click(toggle);
    expect(currentLabel()).toMatch(/^Theme: light\./);

    await user.click(toggle);
    expect(currentLabel()).toMatch(/^Theme: dark\./);

    await user.click(toggle);
    expect(currentLabel()).toMatch(/^Theme: system\./);
  });
});
