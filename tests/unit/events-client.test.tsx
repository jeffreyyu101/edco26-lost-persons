// (Events, phase 2) The client's event pieces: the stage chips (and which headers show them), the Ended screen, the
// event logo's single-colour test, the config helpers (dates, posts, teams, the medical team and its old labels) and
// the sign-in answer for an archived event. (The form's posts and chips from a 1-post and a 6-post event: tests/e2e.)
import { Theme } from '@radix-ui/themes';
import type { ReactNode } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EndedScreen, ENDED_LINE } from '@/components/signin/Ended';
import { interpretSignInResponse } from '@/components/signin/logic';
import { WhoStep } from '@/components/signin/WhoStep';
import { classifyLogo } from '@/components/ui/EventLogo';
import { EventStageChip, PRACTICE } from '@/components/ui/EventStageChip';
import { StageChip } from '@/components/ui/StageChip';
import type { EventConfig } from '@/lib/api-types';
import { eventDates, eventZone, isEventPost, mainMedicalLabel, medicalLabel, teamOf, teamShortOf } from '@/lib/client/event-config';
import { StoreContext, type AppStore, type StoreState } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { STUB_EVENT } from '@/lib/client/stub-data';

function storeWith(patch: (s: StoreState) => StoreState = (s) => s): AppStore {
  const base = createStubStore({ eventTimezone: 'America/New_York', now: Date.now() });
  const state = patch(base.getState());
  return { getState: () => state, subscribe: () => () => {}, actions: base.actions };
}
const render = (store: AppStore, node: ReactNode) =>
  renderToString(
    <Theme>
      <StoreContext.Provider value={store}>{node}</StoreContext.Provider>
    </Theme>,
  );
const withEvent = (event: Partial<EventConfig> | null) => storeWith((s) => ({ ...s, event: event === null ? null : { ...STUB_EVENT, ...event } }));

const SIX_POSTS: Partial<EventConfig> = {
  posts: ['North', 'South', 'East', 'West', 'Main Stage', 'VIP'].map((label, i) => ({ id: `p${i}`, label: `${label} Gate`, short: label })),
  lastSeen: ['Ferris wheel', 'Main stage'],
};

describe('stage chips', () => {
  it('Practice: amber half ring; Live: green dot; Archived: grey archive box; each says its stage in words', () => {
    const practice = renderToStaticMarkup(<StageChip stage="practice" />);
    expect(practice).toContain('data-stage="practice"');
    expect(practice).toContain('aria-label="Practice event"');
    expect(practice).toMatch(/<path d="M7 3\.75A3\.25 3\.25 0 0 1 7 10\.25Z"/); // the half ring's fill
    const live = renderToStaticMarkup(<StageChip stage="live" />);
    expect(live).toMatch(/<circle cx="7" cy="7" r="4" fill="currentColor"/);
    expect(live).toContain('aria-label="Live event"');
    const archived = renderToStaticMarkup(<StageChip stage="archived" />);
    expect(archived).toMatch(/<rect width="20" height="5"/);
    expect(archived).toMatch(/>Archived</);
    // Labels and values only: the word, nothing else.
    for (const html of [practice, live, archived]) expect(html.replace(/<[^>]+>/g, '')).toMatch(/^(Practice|Live|Archived)$/);
  });

  it('a header shows practice on every screen; a practice-only header shows nothing when live', () => {
    expect(render(withEvent({ stage: 'practice' }), <EventStageChip only={PRACTICE} />)).toContain('data-stage="practice"');
    expect(render(withEvent({ stage: 'live' }), <EventStageChip only={PRACTICE} />)).not.toContain('stage-chip');
    expect(render(withEvent({ stage: 'live' }), <EventStageChip />)).toContain('data-stage="live"');
    expect(render(withEvent(null), <EventStageChip />)).not.toContain('stage-chip');
  });
});

describe('the Ended screen', () => {
  it('Ground Control, the event logo, the name, Archived, one line; nothing else', () => {
    const html = renderToStaticMarkup(
      <Theme>
        <EndedScreen event={{ name: 'Warped Tour Orlando', logoUrl: '/api/events/logo/warped?v=1', stage: 'archived' }} />
      </Theme>,
    );
    expect(html).toContain('src="/logos/ground-control.png"');
    expect(html).toContain('src="/api/events/logo/warped?v=1"');
    expect(html).toMatch(/<h1[^>]*>Warped Tour Orlando<\/h1>/);
    expect(html).toContain('data-stage="archived"');
    expect(html).toContain(ENDED_LINE);
    expect(ENDED_LINE).toBe('This event is now closed. Thank you for your work.');
    // No password field, no stats, no other event, no button.
    expect(html).not.toMatch(/<input|<button|<form/);
    const words = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    expect(words).toBe(`Warped Tour Orlando Archived ${ENDED_LINE}`);
  });

  it('without the event (a new tab): Ground Control alone, the chip and the line', () => {
    const html = renderToStaticMarkup(
      <Theme>
        <EndedScreen event={null} />
      </Theme>,
    );
    expect(html).not.toContain('/api/events/logo');
    expect(html).toContain('aria-label="Ground Control"');
    expect(html).toContain(ENDED_LINE);
  });
});

describe('sign-in to an archived event', () => {
  it('410 event_ended reads as the Ended screen with the event the server sent', () => {
    const body = { error: { code: 'event_ended', message: 'x', event: { id: 'e1', name: 'EDC Orlando', logoUrl: null, stage: 'archived' } } };
    expect(interpretSignInResponse(410, body, null, 0)).toEqual({ kind: 'ended', event: { name: 'EDC Orlando', logoUrl: null, stage: 'archived' } });
    expect(interpretSignInResponse(410, { error: { code: 'event_ended', message: 'x' } }, null, 0)).toEqual({ kind: 'ended', event: null });
    // Another 410 is not the Ended screen.
    expect(interpretSignInResponse(410, null, null, 0)).toEqual({ kind: 'server' });
  });

  it('the sign-in cards are the running events\' teams; without any, the team field alone', () => {
    const teams = [{ label: 'First Aid', short: 'Aid', medical: true }, { label: 'Gate Crew', short: 'Gate', medical: false }];
    const html = renderToStaticMarkup(
      <Theme>
        <WhoStep teams={teams} draft={{ name: '', team: null, otherTeam: '' }} onDraft={() => {}} onContinue={() => {}} autoFocus={false} />
      </Theme>,
    );
    expect(html).toContain('>Aid<');
    expect(html).toContain('>Gate<');
    expect(html).not.toContain('Dispatch');
    expect(html).toContain('placeholder="Other team"');
    // Ground Control only: a password sign-in does not know the event yet.
    expect(html).not.toContain('/api/events/logo');
    const none = renderToStaticMarkup(
      <Theme>
        <WhoStep teams={[]} draft={{ name: '', team: null, otherTeam: '' }} onDraft={() => {}} onContinue={() => {}} autoFocus={false} />
      </Theme>,
    );
    expect(none).not.toContain('Your team</');
    expect(none).toContain('placeholder="Your team"');
    // A join link names its event: its logo beside Ground Control's.
    const link = renderToStaticMarkup(
      <Theme>
        <WhoStep teams={teams} eventLogo="/api/events/logo/warped" draft={{ name: '', team: null, otherTeam: '' }} onDraft={() => {}} onContinue={() => {}} autoFocus={false} />
      </Theme>,
    );
    expect(link.indexOf('/api/events/logo/warped')).toBeLessThan(link.indexOf('/logos/ground-control.png'));
  });
});

describe('the event logo', () => {
  const px = (pixels: Array<[number, number, number, number]>) => new Uint8ClampedArray(pixels.flat());
  it('single colour on transparency → mono (tinted); a photo, an opaque square or two colours → shown as uploaded', () => {
    const mono = px([...Array(50).fill([0, 0, 0, 255]), ...Array(50).fill([0, 0, 0, 0])]);
    expect(classifyLogo(mono)).toBe('mono');
    const antialiased = px([...Array(50).fill([10, 10, 10, 255]), [60, 60, 60, 255], ...Array(49).fill([0, 0, 0, 0])]);
    expect(classifyLogo(antialiased)).toBe('mono');
    const opaque = px(Array(100).fill([20, 20, 20, 255]));
    expect(classifyLogo(opaque)).toBe('full');
    const twoColours = px([...Array(25).fill([255, 0, 0, 255]), ...Array(25).fill([0, 0, 255, 255]), ...Array(50).fill([0, 0, 0, 0])]);
    expect(classifyLogo(twoColours)).toBe('full');
    expect(classifyLogo(new Uint8ClampedArray())).toBe('full');
  });
});

describe('config helpers', () => {
  it('dates in words, short and long, across a month and a year', () => {
    expect(eventDates({ startsOn: '2026-11-14', endsOn: '2026-11-15' }, 'short')).toBe('Nov 14–15');
    expect(eventDates({ startsOn: '2026-11-14', endsOn: '2026-11-15' }, 'long')).toBe('November 14–15, 2026');
    expect(eventDates({ startsOn: '2026-11-30', endsOn: '2026-12-01' }, 'short')).toBe('Nov 30–Dec 1');
    expect(eventDates({ startsOn: '2026-12-31', endsOn: '2027-01-01' }, 'long')).toBe('December 31–January 1, 2027');
    expect(eventDates({ startsOn: '2026-11-14', endsOn: '2026-11-14' }, 'short')).toBe('Nov 14');
    expect(eventDates(null, 'short')).toBe('');
  });

  it('posts, teams, the medical team (and the labels it had before a rename), main medical, the zone', () => {
    const event = { ...STUB_EVENT, ...SIX_POSTS, teams: [{ id: 'aid', label: 'First Aid', short: 'Aid', medical: true, aliases: ['Medical'] }, { id: 'gate', label: 'Gate Crew', short: 'Gate', medical: false }], mainMedical: 'Aid Tent', timezone: 'America/Denver' };
    expect(isEventPost(event, 'VIP Gate')).toBe(true);
    expect(isEventPost(event, 'FA 3 – Kinetic')).toBe(false);
    expect(isEventPost(event, 'Other')).toBe(false);
    expect(medicalLabel(event)).toEqual(['First Aid', 'Medical']);
    expect(teamOf(event, 'medical')?.id).toBe('aid');
    expect(teamShortOf(event, 'gate crew')).toBe('Gate');
    expect(teamShortOf(event, 'Volunteers')).toBe('Volunteers');
    expect(mainMedicalLabel(event)).toBe('Aid Tent');
    expect(eventZone(event)).toBe('America/Denver');
    expect(medicalLabel({ teams: [{ id: 'x', label: 'X', short: 'X', medical: false }] })).toEqual([]);
  });
});
