import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../app';

// Behavioral assertions only. No className, no JSX-structure checks,
// no internal-state probing.

describe('AppShell', () => {
  it('renders without crashing', () => {
    render(<App />);
    expect(document.body).toBeInTheDocument();
  });

  it('exposes all five primary tabs by accessible name', () => {
    render(<App />);
    for (const label of ['Minutes', 'Hazards', 'Inspections', 'Recommendations', 'More']) {
      // Each NavLink renders in both the sidebar and the bottom tab bar
      // (CSS handles visibility), so a label may yield more than one link.
      const links = screen.getAllByRole('link', { name: label });
      expect(links.length).toBeGreaterThan(0);
    }
  });

  it('redirects from / to /minutes on first render', () => {
    render(<App />);
    expect(window.location.pathname).toBe('/minutes');
  });

  it('has a skip-to-content link pointing at #main-content', () => {
    render(<App />);
    const skipLink = screen.getByRole('link', { name: /skip to main content/i });
    expect(skipLink).toHaveAttribute('href', '#main-content');
  });

  it('cycles the theme on toggle click (system → light → dark → system)', async () => {
    const user = userEvent.setup();
    render(<App />);

    const toggle = screen.getByRole('button', { name: /theme:/i });
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
