import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { InspectionPromoteDialog } from '../components/inspection-promote-dialog';

// THE #15 CLIENT-SIDE FAIL-CLOSED GATE (T-I15).
//
// The server's inspectionPromotability() is the source of truth; this
// modal is the belt-and-suspenders. These tests assert:
//   - Status X (ABC_X) → no risk picker, blocked message visible.
//   - Status G (GAR)   → no risk picker, blocked message visible.
//   - Status A (ABC_X) → risk picker rendered + Promote CTA enabled.
//   - Status R (GAR)   → risk picker rendered + Promote CTA enabled.
//
// We render inside a MemoryRouter so any future Link inside the dialog
// (e.g. "view linked action item") has a router context.

function renderDialog(props: { statusVocab: 'ABC_X' | 'GAR'; statusValue: string }): void {
  render(
    <MemoryRouter>
      <InspectionPromoteDialog
        open
        findingId="finding-1"
        statusVocab={props.statusVocab}
        statusValue={props.statusValue}
        sectionLabel="Walk-through"
        itemLabel="Floor clear of trip hazards"
        onClose={vi.fn()}
        onPromoted={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('InspectionPromoteDialog — fail-closed (#15)', () => {
  it('refuses to render the form for ABC_X / X', () => {
    renderDialog({ statusVocab: 'ABC_X', statusValue: 'X' });
    // The blocked panel is visible.
    expect(screen.getByText(/Cannot promote this finding/)).toBeInTheDocument();
    // X is called out as not-promotable.
    expect(screen.getByText(/Status X findings cannot be promoted/)).toBeInTheDocument();
    // No Risk legend (the form is not rendered).
    expect(screen.queryByText(/^Risk$/i)).not.toBeInTheDocument();
    // No "Promote as" submit button.
    expect(screen.queryByRole('button', { name: /Promote as/i })).not.toBeInTheDocument();
  });

  it('refuses to render the form for GAR / G', () => {
    renderDialog({ statusVocab: 'GAR', statusValue: 'G' });
    expect(screen.getByText(/Cannot promote this finding/)).toBeInTheDocument();
    expect(screen.getByText(/Status G findings cannot be promoted/)).toBeInTheDocument();
    expect(screen.queryByText(/^Risk$/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Promote as/i })).not.toBeInTheDocument();
  });

  it('renders the form with a risk picker for ABC_X / A', () => {
    renderDialog({ statusVocab: 'ABC_X', statusValue: 'A' });
    // The form heading is present.
    expect(screen.getByText(/^Risk$/i)).toBeInTheDocument();
    // The four risk options are rendered as toggleable buttons.
    expect(screen.getByRole('button', { name: /^Low$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Medium$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^High$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Critical$/ })).toBeInTheDocument();
    // The Promote submit button is enabled by default.
    const submit = screen.getByRole('button', { name: /Promote as Medium/i });
    expect(submit).not.toBeDisabled();
  });

  it('renders the form with a risk picker for GAR / R', () => {
    renderDialog({ statusVocab: 'GAR', statusValue: 'R' });
    expect(screen.getByText(/^Risk$/i)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /Promote as Medium/i });
    expect(submit).not.toBeDisabled();
  });
});
