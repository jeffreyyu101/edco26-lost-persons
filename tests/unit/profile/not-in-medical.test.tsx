// Not in medical on the profile (v2.2, Jeffrey 2026-11-06): it counts as closed and is grey everywhere, like
// Reunited / Discharged / Cancelled, but it keeps exactly the actions it had before (Change answer, nothing
// else: no Reopen, no Mark discharged, no Cancel request). Change answer opens its menu (In medical, Back to
// Waiting for check) since the v2.2 "Change answer and Undo" decision. Server renders against the stub store, plus the
// domain helpers the profile takes its actions from. Synthetic data only.
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuditTrail } from '@/components/profile/AuditTrail';
import { ProfileView } from '@/components/profile/ProfileView';
import { buildAuditTrail } from '@/components/profile/audit-trail';
import type { AuditEvent, RequestSummary } from '@/lib/api-types';
import { StoreContext, type AppStore } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { STUB_SESSION, stubRows } from '@/lib/client/stub-data';
import { STATUS, canCancel, menuActions, primaryActions, sameStaff, statusMeta } from '@/lib/domain';

const NOW = Date.now();
const rows = stubRows(NOW);
const byCase = (n: number) => rows.find((r) => r.caseNumber === n) as RequestSummary;

function store(): AppStore {
  const base = createStubStore({ eventTimezone: 'America/New_York', now: NOW });
  const state = base.getState();
  return { getState: () => state, subscribe: () => () => {}, actions: base.actions };
}

const render = (node: ReactNode) =>
  renderToString(
    <Theme>
      <StoreContext.Provider value={store()}>{node}</StoreContext.Provider>
    </Theme>,
  );

/** The status block's opening tag through its label. */
function statusBlock(html: string): string {
  const i = html.indexOf('data-testid="status-block"');
  expect(i).toBeGreaterThan(0);
  return html.slice(html.lastIndexOf('<div', i), i + 1200);
}

const footer = (html: string): string => {
  const i = html.indexOf('data-testid="profile-actions"');
  return i < 0 ? '' : html.slice(html.lastIndexOf('<div', i), html.indexOf('</div>', i));
};

describe('Not in medical on the profile', () => {
  // 1009 A.N. is Not in medical, logged by Dana Kim (the stub session, so the creator); 1003 C.H. is Reunited.
  const notIn = byCase(1009);
  const reunited = byCase(1003);

  it('the fixture is what the tests assume', () => {
    expect(notIn.status).toBe(STATUS.notInMedical);
    expect(reunited.status).toBe(STATUS.reunited);
    expect(sameStaff(notIn.createdBy, STUB_SESSION.staff)).toBe(true);
  });

  it('the status block is grey like the other closed states: grey tint, grey label, grey × glyph', () => {
    const html = render(<ProfileView id={notIn.id} />);
    const block = statusBlock(html);
    expect(block).toContain('data-tone="gray"');
    expect(block).toMatch(/data-glyph="notInMedical"[^>]*><circle[^>]*fill="var\(--gray-9\)"/);
    expect(block).not.toMatch(/amber/);
    // The label: Radix gray text, not the high-contrast step-12 used on coloured tints.
    expect(block).toMatch(/<span[^>]*data-accent-color="gray"[^>]*>Not in medical<\/span>/);
    expect(block).not.toMatch(/rt-high-contrast[^>]*>Not in medical</);

    // Same treatment as Reunited.
    const closed = statusBlock(render(<ProfileView id={reunited.id} />));
    expect(closed).toContain('data-tone="gray"');
    expect(closed).toMatch(/data-glyph="closed"[^>]*><circle[^>]*fill="var\(--gray-9\)"/);
    expect(closed).toMatch(/<span[^>]*data-accent-color="gray"[^>]*>Reunited<\/span>/);
  });

  it('keeps exactly its actions: Change answer (its menu: In medical, Back to Waiting for check) and nothing else', () => {
    const html = render(<ProfileView id={notIn.id} />);
    const bar = footer(html);
    expect(bar).toContain('data-layout="one"');
    expect(bar.match(/<button/g)).toHaveLength(1);
    // v2.2 (Brian + Jeffrey, 2026-11-06): Change answer opens a menu (tests/unit/profile/change-answer.test.tsx).
    expect(bar).toMatch(/<button[^>]*data-testid="change-answer"[^>]*aria-haspopup="menu"/);
    expect(bar).toContain('Change answer');
    for (const other of ['>Reunited<', '>In medical<', '>Not in medical<', 'Reopen', 'Mark discharged']) expect(bar).not.toContain(other);
    // Even for the person who logged it: Cancel request is only for Waiting.
    expect(html).not.toContain('Cancel request');
    // A closed status has no action bar at all; Not in medical still has its own.
    expect(footer(render(<ProfileView id={reunited.id} />))).toBe('');
  });

  it('domain: the profile’s buttons and ⋯ menu for Not in medical are unchanged by the closed bucket', () => {
    expect(statusMeta(STATUS.notInMedical)).toMatchObject({ bucket: 'closed', tone: 'gray', glyph: 'notInMedical' });
    expect(primaryActions(STATUS.notInMedical)).toEqual([
      { id: 'changeToInMedical', label: 'Change answer', to: STATUS.inMedical, kind: 'change', undoable: true, creatorOnly: false },
    ]);
    // No Reopen (that is only for Reunited / Discharged / Cancelled), no Mark discharged.
    expect(menuActions(STATUS.notInMedical, true)).toEqual([]);
    expect(menuActions(STATUS.notInMedical, false)).toEqual([]);
    expect(menuActions(STATUS.reunited, false).map((a) => a.id)).toEqual(['reopen']);
    expect(canCancel(STATUS.notInMedical, notIn.createdBy, STUB_SESSION.staff)).toBe(false);
  });

  it('the audit trail draws Not in medical grey, like Reunited', () => {
    const ev = (id: string, minute: string, to: string, from: string): AuditEvent => ({
      id,
      action: 'status',
      at: `2026-11-07T04:${minute}:00.000000+00:00`,
      staff: 'Rae Chen · Medical',
      notes: null,
      previous: { status: from },
      next: { status: to, kind: 'answer' },
    });
    const items = buildAuditTrail([ev('a', '10', STATUS.notInMedical, STATUS.waiting), ev('b', '20', STATUS.reunited, STATUS.inMedical)], 'America/New_York');
    const html = renderToString(
      <Theme>
        <AuditTrail items={items} />
      </Theme>,
    );
    const item = (label: string) => {
      const end = html.indexOf(`>${label}</span>`);
      expect(end).toBeGreaterThan(0);
      return html.slice(html.lastIndexOf('<li', end), end + label.length + 8);
    };
    const notInItem = item('Not in medical');
    // The timeline marker and the inline "to" glyph are both the grey ×; the label is grey text.
    expect(notInItem.match(/data-glyph="notInMedical"[^>]*><circle[^>]*fill="var\(--gray-9\)"/g)).toHaveLength(2);
    expect(notInItem).toMatch(/data-accent-color="gray"[^>]*>Not in medical<\/span>$/);
    expect(notInItem).not.toContain('amber');
    const reunitedItem = item('Reunited');
    expect(reunitedItem).toMatch(/data-accent-color="gray"[^>]*>Reunited<\/span>$/);
    // The "from" side keeps its own colour: In medical is still green.
    expect(reunitedItem).toContain('var(--green-9)');
  });
});
