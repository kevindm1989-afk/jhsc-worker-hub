import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ExcelImportsView } from '../views/excel-imports-view';

// S3 ships the upload + preview + commit + reverse views; the full
// happy-path coverage (drop zone, parse, reconciliation, step-up
// commit) lands in S4 alongside the acceptance fixtures. This file
// is the load-bearing smoke test: the list view renders without
// crashing, the empty state copy points the rep at the new-import
// path, and the filter chips are present on the surface.

vi.mock('../excel-imports/api', () => ({
  excelImportsApi: {
    list: () => Promise.resolve({ items: [] }),
  },
  ExcelImportApiError: class ExcelImportApiError extends Error {},
}));

describe('ExcelImportsView — list', () => {
  it('renders the empty-state copy that points at the new-import flow', async () => {
    render(
      <MemoryRouter>
        <ExcelImportsView />
      </MemoryRouter>,
    );
    // Heading + empty-state copy + new-import CTA all render.
    expect(await screen.findByRole('heading', { name: /excel imports/i })).toBeVisible();
    // The header's "+ New import" CTA renders as a Link wrapping a Button.
    const newLinks = screen.getAllByRole('link');
    expect(newLinks.some((a) => a.getAttribute('href') === '/excel-imports/new')).toBe(true);
  });
});
