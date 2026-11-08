// The request page, tonight's changes (Brian 2026-11-08 ~00:50, design/DECISIONS.md "Request page tonight";
// design/references/request-page-ux-rec.md T1–T5) and dropping Arrived:
//   T5  times on message runs: "Rae C. · Medical · 12:14 PM" over someone else's run, the time alone over mine, and the
//       time in each bubble's screen-reader label (the 5-minute run break is tests/unit/messaging.test.ts's)
//   Arrived is offered nowhere: not as a quick line on the request, not on the My requests card, where the card's
//       En route is followed by the request's Reunited; an old row's "Friend arrived" still shows.
// Server renders against the stub store (signed in as Dana Kim, front of house) with a stand-in messages engine.
// Synthetic data only.
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MineCard } from '@/components/list/cards';
import { RunLabel, bubbleSaid, timeOf } from '@/components/messages/MessagesSection';
import { ProfileView } from '@/components/profile/ProfileView';
import type { EnrouteSummary, RequestSummary } from '@/lib/api-types';
import type { MessagingApi } from '@/lib/client/messages-core';
import { StoreContext, type AppStore } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { stubId } from '@/lib/client/stub-data';
import { formatCreatedTime } from '@/lib/format';

const NOW = Date.now();
const TZ = 'America/New_York';
const IN_MEDICAL = stubId(1004);
const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();

/** The engine's two reads a server render makes; nothing else is called before effects run. */
const ENGINE = {
  getSnapshot: () => ({ threads: new Map(), jobs: [] }),
  subscribe: () => () => undefined,
} as unknown as MessagingApi;

function store(id: string, patch: (row: RequestSummary) => RequestSummary, team?: string): AppStore {
  const base = createStubStore({ eventTimezone: TZ, now: NOW });
  const state = base.getState();
  const confirmed = new Map(state.confirmed);
  confirmed.set(id, patch(confirmed.get(id)!));
  const session = team ? { ...state.session, team, staff: `Rae Chen · ${team}`, staffName: 'Rae Chen' } : state.session;
  const next = { ...state, confirmed, session };
  return { getState: () => next, subscribe: () => () => {}, actions: { ...base.actions, messages: ENGINE } };
}

const render = (s: AppStore, node: ReactNode) =>
  renderToString(
    <Theme>
      <StoreContext.Provider value={s}>{node}</StoreContext.Provider>
    </Theme>,
  );
const text = (html: string) => html.replace(/<!-- -->/g, '');

const MINE_ENROUTE: EnrouteSummary = { count: 1, earliestEta: iso(4), state: 'enroute', mine: { etaAt: iso(4), etaMinutes: 5, state: 'enroute' } };
const OTHERS_ENROUTE: EnrouteSummary = { count: 1, earliestEta: iso(4), state: 'enroute', mine: null };
const ARRIVED: EnrouteSummary = { count: 0, earliestEta: null, state: 'arrived', mine: { etaAt: null, state: 'arrived' } };
const withEnroute = (enroute: EnrouteSummary | null) => (r: RequestSummary): RequestSummary => ({ ...r, enroute });

describe('times on message runs (T5)', () => {
  it("someone else's run: name · team · time; my run: the time alone, at the right; both hidden from screen readers", () => {
    const theirs = text(renderToString(<RunLabel bubble={{ by: 'Rae C.', team: 'Medical', mine: false }} time="12:14 PM" />));
    expect(theirs).toMatch(/^<span class="[^"]+" aria-hidden="true" data-testid="run-label"><b>Rae C\.<\/b> · Medical · 12:14 PM<\/span>$/);
    const mine = text(renderToString(<RunLabel bubble={{ by: 'Dana K.', team: 'Dispatch', mine: true }} time="12:16 PM" />));
    expect(mine).toMatch(/^<span class="[^" ]+ [^"]+" aria-hidden="true" data-testid="run-label" data-mine="">12:16 PM<\/span>$/);
    // No team; no readable time: the name alone over theirs, nothing over mine.
    expect(text(renderToString(<RunLabel bubble={{ by: 'Sam L.', team: '', mine: false }} time="" />))).toMatch(/<b>Sam L\.<\/b><\/span>$/);
    expect(renderToString(<RunLabel bubble={{ by: 'Dana K.', team: 'Dispatch', mine: true }} time="" />)).toBe('');
  });

  it("each bubble's label says who, when and what (and Sending / Not delivered)", () => {
    const b = { by: 'Rae C.', team: 'Medical', mine: false, body: 'Any tattoos or marks?', pending: null };
    expect(bubbleSaid(b, '12:14 PM')).toBe('Rae C., Medical, 12:14 PM: Any tattoos or marks?.');
    expect(bubbleSaid({ ...b, mine: true, body: 'On my way', pending: 'sending' }, '12:16 PM')).toBe('You, 12:16 PM: On my way. Sending.');
    expect(bubbleSaid({ ...b, mine: true, body: 'On my way', pending: 'failed' }, '12:16 PM')).toBe('You, 12:16 PM: On my way. Not delivered.');
    expect(bubbleSaid(b, '')).toBe('Rae C., Medical: Any tattoos or marks?.');
  });

  it("the time is the log's: the clock today, the weekday for an earlier day; '' when unreadable", () => {
    const at = iso(-3);
    expect(timeOf(at, NOW, TZ)).toBe(formatCreatedTime(at, NOW, TZ));
    expect(timeOf(at, NOW, TZ)).toMatch(/^(\w{3} )?\d{1,2}:\d\d (AM|PM)$/);
    expect(timeOf(iso(-2 * 24 * 60), NOW, TZ)).toMatch(/^\w{3} \d{1,2}:\d\d (AM|PM)$/);
    expect(timeOf('not a time', NOW, TZ)).toBe('');
  });
});

describe('Arrived is offered nowhere (2026-11-08)', () => {
  const card = (s: AppStore) => {
    const row = s.getState().confirmed.get(IN_MEDICAL)!;
    return render(s, <MineCard row={row} now={NOW} freshTone={null} timeZone={TZ} />);
  };

  it('My requests, front of house: En route first; once I am en route the card offers the request\'s Reunited (right of Message), never Arrived', () => {
    const before = card(store(IN_MEDICAL, withEnroute(null)));
    expect(before).toContain('data-testid="enroute-button"');
    expect(before).not.toContain('reunited-button');

    const enroute = card(store(IN_MEDICAL, withEnroute(MINE_ENROUTE)));
    expect(enroute).toContain('data-testid="enroute-row"');
    expect(enroute).not.toContain('enroute-button');
    expect(enroute).toMatch(/<button[^>]*data-testid="reunited-button"[^>]*aria-label="Reunited: [^"]+"[^>]*>[^]*?Reunited<\/button>/);
    expect(enroute).toContain('data-testid="message-button"');
    // Pending's Friend coming card's order, [Message | Reunited]: a tap meant for Message never closes the request.
    expect(enroute.indexOf('data-testid="message-button"')).toBeLessThan(enroute.indexOf('data-testid="reunited-button"'));
    expect(before.indexOf('data-testid="message-button"')).toBeGreaterThan(-1);
    expect(before.indexOf('data-testid="message-button"')).toBeLessThan(before.indexOf('data-testid="enroute-button"'));

    // Someone else en route: I can go too.
    const others = card(store(IN_MEDICAL, withEnroute(OTHERS_ENROUTE)));
    expect(others).toContain('data-testid="enroute-button"');
    expect(others).not.toContain('reunited-button');

    for (const html of [before, enroute, others]) {
      expect(html).not.toContain('arrived-button');
      expect(text(html)).not.toMatch(/>Arrived</);
      expect(html).not.toContain('Arrived with the friend');
    }
  });

  it('an old row whose friend arrived still shows "Friend arrived", and its card offers Reunited', () => {
    const html = card(store(IN_MEDICAL, withEnroute(ARRIVED)));
    expect(html).toContain('Friend arrived');
    expect(html).toContain('data-testid="reunited-button"');
    expect(html).not.toContain('enroute-button');
    expect(html).not.toContain('arrived-button');
  });

  it('medical sees neither En route nor Reunited on the card (as before Arrived went)', () => {
    const html = card(store(IN_MEDICAL, withEnroute(MINE_ENROUTE), 'Medical'));
    expect(html).not.toContain('enroute-button');
    expect(html).not.toContain('reunited-button');
  });

  it('the request page: no Arrived quick line or button while I am en route or after the friend arrived; En route before', () => {
    const quick = (html: string) => {
      const i = html.indexOf('data-testid="quick-lines"');
      return i < 0 ? '' : html.slice(i, html.indexOf('</div>', i));
    };
    const before = render(store(IN_MEDICAL, withEnroute(null)), <ProfileView id={IN_MEDICAL} />);
    expect(quick(before)).toContain('aria-label="En route: bringing the friend"');
    expect(quick(before)).toContain('Add to message: Friend left the area');

    for (const enroute of [MINE_ENROUTE, ARRIVED]) {
      const html = render(store(IN_MEDICAL, withEnroute(enroute)), <ProfileView id={IN_MEDICAL} />);
      const lines = quick(html);
      expect(lines, enroute.state).toContain('Add to message: Friend left the area');
      expect(lines).not.toContain('En route');
      expect(lines).not.toContain('data-kind="arrived"');
      expect(html).not.toContain('Arrived with the friend');
      expect(text(html)).not.toMatch(/>Arrived</);
    }
    // The old row's stage still reads "Friend arrived" in the status block.
    expect(render(store(IN_MEDICAL, withEnroute(ARRIVED)), <ProfileView id={IN_MEDICAL} />)).toContain('Friend arrived');
  });
});
