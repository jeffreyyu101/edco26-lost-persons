// (Events, lead screens) Event setup's form logic: components/events/setup-model.ts.
import { describe, expect, it } from 'vitest';
import type { EventAdmin } from '@/lib/api-types';
import {
  addItem,
  canGoLive,
  changedPayload,
  emptyForm,
  fieldKeyOf,
  flagFromServer,
  formFromEvent,
  isDirty,
  itemError,
  itemFlags,
  itemProblem,
  shortOf,
  lpNumber,
  moveItem,
  payloadFromForm,
  removeItem,
  setMedical,
  suggestSlug,
  updateItem,
  validateForm,
  type ListItem,
  type SetupForm,
} from '@/components/events/setup-model';

function event(over: Partial<EventAdmin> = {}): EventAdmin {
  return {
    id: '10ca1000-0000-4000-8000-0000000000aa',
    slug: 'warped-orlando',
    name: 'Warped Tour Orlando',
    startsOn: '2026-11-14',
    endsOn: '2026-11-15',
    timezone: 'America/New_York',
    dayStartHour: 6,
    stage: 'practice',
    logoUrl: null,
    posts: [
      { id: 'fa1', label: 'FA 1', short: 'FA 1' },
      { id: 'cmd', label: 'Command post', short: 'Cmd' },
    ],
    mainMedical: 'Main Med',
    teams: [
      { id: 'disp', label: 'Dispatch', short: 'Dispatch', medical: false },
      { id: 'med', label: 'Medical', short: 'Med', medical: true },
    ],
    lastSeen: ['Main stage', 'Ferris wheel'],
    wentLiveAt: null,
    endedAt: null,
    updatedAt: '2026-11-10T10:00:00Z',
    hasStaffPassword: false,
    joinLinkExpiresAt: null,
    holdUntil: null,
    caseSeq: 0,
    recordsDeleteAt: null,
    recordsDeletedAt: null,
    department: 'Ground Control',
    staffing: [{ role: 'Lead', name: 'Dana Kim' }],
    preparedBy: null,
    createdAt: '2026-11-10T09:00:00Z',
    ...over,
  };
}

const labels = (list: ListItem[]) => list.map((i) => i.label);

describe('suggestSlug', () => {
  it('makes a link name from the event name', () => {
    expect(suggestSlug('Warped Tour Orlando')).toBe('warped-tour-orlando');
    expect(suggestSlug('  Café  Señor 2026! ')).toBe('cafe-senor-2026');
    expect(suggestSlug('EDC – Orlando')).toBe('edc-orlando');
  });
  it('gives nothing a link could not be', () => {
    expect(suggestSlug('')).toBe('');
    expect(suggestSlug('!!')).toBe('');
    expect(suggestSlug('A')).toBe('');
  });
  it('stays within 40 characters and never ends on a dash', () => {
    const slug = suggestSlug('a very long festival name that goes on and on past the limit');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('formFromEvent / payloadFromForm', () => {
  it('round-trips an event, keeping ids (a rename stays a rename)', () => {
    const form = formFromEvent(event());
    const p = payloadFromForm(form);
    expect(p).toMatchObject({
      name: 'Warped Tour Orlando',
      slug: 'warped-orlando',
      startsOn: '2026-11-14',
      endsOn: '2026-11-15',
      timezone: 'America/New_York',
      dayStartHour: 6,
      mainMedical: 'Main Med',
      lastSeen: ['Main stage', 'Ferris wheel'],
      department: 'Ground Control',
      staffing: [{ role: 'Lead', name: 'Dana Kim' }],
      preparedBy: null,
    });
    expect(p['posts']).toEqual([
      { id: 'fa1', label: 'FA 1' },
      { id: 'cmd', label: 'Command post', short: 'Cmd' },
    ]);
    expect(p['teams']).toEqual([
      { id: 'disp', label: 'Dispatch', medical: false },
      { id: 'med', label: 'Medical', short: 'Med', medical: true },
    ]);
  });
  it('trims and collapses spaces, drops blank staffing rows, sends blank report lines as null', () => {
    const form: SetupForm = {
      ...emptyForm('2026-11-14'),
      name: '  Warped   Tour ',
      slug: ' Warped-Tour ',
      department: '   ',
      preparedBy: ' Dana  Kim ',
      staffing: [
        { key: 'a', role: ' Lead ', name: ' Dana ' },
        { key: 'b', role: '', name: '  ' },
      ],
    };
    const p = payloadFromForm(form);
    expect(p['name']).toBe('Warped Tour');
    expect(p['slug']).toBe('warped-tour');
    expect(p['department']).toBeNull();
    expect(p['preparedBy']).toBe('Dana Kim');
    expect(p['staffing']).toEqual([{ role: 'Lead', name: 'Dana' }]);
  });
});

describe('changedPayload', () => {
  it('sends only what changed', () => {
    const base = formFromEvent(event());
    const form = { ...base, name: 'Warped Tour', posts: updateItem(base.posts, base.posts[0]!.key, { label: 'FA One' }) };
    const patch = changedPayload(base, form, 'practice');
    expect(Object.keys(patch).sort()).toEqual(['name', 'posts']);
    expect((patch['posts'] as Array<{ id: string; label: string }>)[0]).toEqual({ id: 'fa1', label: 'FA One' });
    expect(isDirty(base, base, 'practice')).toBe(false);
    expect(isDirty(base, form, 'practice')).toBe(true);
  });
  it('never sends an archived event its frozen settings', () => {
    const base = formFromEvent(event({ stage: 'archived' }));
    const form = { ...base, timezone: 'America/Chicago', dayStartHour: 7, posts: [], name: 'Renamed', department: 'GC' };
    expect(changedPayload(base, form, 'archived')).toEqual({ name: 'Renamed', department: 'GC' });
  });
});

describe('validateForm', () => {
  const ok = (): SetupForm => ({ ...formFromEvent(event()) });
  it('passes a good form', () => {
    expect(validateForm(ok())).toEqual({});
  });
  it('requires a name, a link name and dates in order', () => {
    expect(validateForm({ ...ok(), name: ' ' }).name).toBe('Required');
    expect(validateForm({ ...ok(), slug: 'Bad Slug' }).slug).toMatch(/lowercase/);
    expect(validateForm({ ...ok(), slug: 'a' }).slug).toBeTruthy();
    expect(validateForm({ ...ok(), endsOn: '2026-11-13' }).dates).toBe('The last day is before the first');
    expect(validateForm({ ...ok(), startsOn: '' }).dates).toBe('Required');
    expect(validateForm({ ...ok(), startsOn: '2026-10-01', endsOn: '2026-11-15' }).dates).toMatch(/At most/);
  });
  it('checks posts, teams and chips like the server', () => {
    const f = ok();
    expect(validateForm({ ...f, posts: addItem(f.posts, { label: 'fa 1', short: '' }) }).posts).toMatch(/Already there/);
    expect(validateForm({ ...f, posts: addItem(f.posts, { label: 'Other', short: '' }) }).posts).toMatch(/Other/);
    expect(validateForm({ ...f, teams: addItem(f.teams, { label: 'X', short: '' }) }).teams).toMatch(/2 characters/);
    expect(validateForm({ ...f, teams: addItem(f.teams, { label: 'A · B', short: '' }) }).teams).toMatch(/·/);
    expect(validateForm({ ...f, teams: f.teams.map((t) => ({ ...t, medical: true })) }).teams).toBe('Only one medical team');
    const many = Array.from({ length: 13 }, (_, i) => ({ key: `k${i}`, label: `Post ${i}`, short: '' }));
    expect(validateForm({ ...f, posts: many }).posts).toBe('At most 12');
    expect(validateForm({ ...f, mainMedical: '' }).mainMedical).toBe('Required');
  });
  it('wants both cells of a staffing row', () => {
    expect(validateForm({ ...ok(), staffing: [{ key: 'a', role: 'Lead', name: '' }] }).staffing).toBe('Role and name');
    expect(validateForm({ ...ok(), staffing: [{ key: 'a', role: '', name: '' }] }).staffing).toBeUndefined();
  });
});

describe('itemError', () => {
  it('lets an item keep its own label', () => {
    const list = formFromEvent(event()).posts;
    expect(itemError('post', list, list[0]!)).toBeNull();
    expect(itemError('post', list, { key: 'new', label: 'FA 1', short: '' })).toBe('Already there');
    expect(itemError('post', list, { key: 'new', label: 'FA 9', short: 'x'.repeat(17) })).toMatch(/Short/);
    expect(itemError('lastSeen', [], { key: 'n', label: 'Other', short: '' })).toBeNull();
  });
});

describe('Short left empty (derived from the label)', () => {
  const ok = (): SetupForm => ({ ...formFromEvent(event()) });
  const warped = (): SetupForm => {
    let f: SetupForm = { ...ok(), posts: [], teams: [] };
    for (const label of ['FA 1 – Main Stage', 'FA 2 – Vans Stage', 'Main Medical', 'Command', 'Roaming', 'Gate A']) f = { ...f, posts: addItem(f.posts, { label, short: '' }) };
    f = { ...f, teams: addItem(f.teams, { label: 'Ground Control Dispatch Team', short: '' }) };
    return f;
  };
  it('a realistic post or team name with no Short passes', () => {
    expect(validateForm(warped())).toEqual({});
    const f = warped();
    expect(f.posts.map((p) => shortOf('post', p))).toEqual(['FA 1', 'FA 2', 'Main Medical', 'Command', 'Roaming', 'Gate A']);
    expect(shortOf('team', f.teams[0]!)).toBe('Ground Control Dispatch');
    // Short stays out of the payload: the server derives the same one.
    expect((payloadFromForm(f)['posts'] as Array<Record<string, unknown>>)[0]).toEqual({ label: 'FA 1 – Main Stage' });
  });
  it('a derived short shows as an empty Short field when the event is read back', () => {
    const f = formFromEvent(event({ posts: [{ id: 'fa1', label: 'FA 1 – Main Stage', short: 'FA 1' }, { id: 'fa2', label: 'FA 2 – Vans Stage', short: 'Vans' }] }));
    expect(f.posts.map((p) => p.short)).toEqual(['', 'Vans']);
  });
  it('two posts with the same Short, typed or derived, any case: the second one, on its Short', () => {
    const f = ok();
    const typed = { ...f, posts: addItem(f.posts, { label: 'Command tent', short: 'cmd' }) };
    expect(itemFlags(typed).posts).toMatchObject({ key: typed.posts[2]!.key, part: 'short', message: 'Short already used' });
    expect(validateForm(typed).posts).toBe('Command tent: Short already used');
    const derived = { ...f, posts: addItem(addItem([], { label: 'Gate A – North Side', short: '' }), { label: 'Gate A – South Side', short: '' }) };
    expect(itemFlags(derived).posts).toMatchObject({ key: derived.posts[1]!.key, part: 'short' });
    const teams = { ...f, teams: addItem(f.teams, { label: 'Medical Ops', short: 'MED' }) };
    expect(itemFlags(teams).teams).toMatchObject({ key: teams.teams[2]!.key, part: 'short' });
    expect(validateForm({ ...f, posts: addItem(f.posts, { label: 'Command 2', short: 'Cmd 2' }) })).toEqual({});
  });
  it('marks the Label or the Short of the item', () => {
    const list = formFromEvent(event()).posts;
    expect(itemProblem('post', list, { key: 'n', label: '', short: '' })).toEqual({ part: 'label', message: 'Required' });
    expect(itemProblem('post', list, { key: 'n', label: 'FA 1', short: '' })).toEqual({ part: 'label', message: 'Already there' });
    expect(itemProblem('post', list, { key: 'n', label: 'FA 9', short: 'x'.repeat(17) })).toEqual({ part: 'short', message: 'Short: at most 16 characters' });
    expect(itemProblem('post', list, { key: 'n', label: 'Command post 2', short: 'CMD' })).toEqual({ part: 'short', message: 'Short already used' });
    expect(itemProblem('post', list, { key: 'n', label: 'FA 1 – Main Stage', short: '' })).toEqual({ part: 'short', message: 'Short already used' });
  });
  it('a server refusal that names an item marks that item', () => {
    const f = warped();
    expect(flagFromServer(f, { field: 'posts', index: 3, part: 'short', message: 'Short already used' })).toEqual({
      field: 'posts',
      flag: { key: f.posts[3]!.key, part: 'short', message: 'Short already used' },
    });
    expect(flagFromServer(f, { field: 'teams', index: 0, message: 'Each team once' })?.flag.part).toBe('label');
    expect(flagFromServer(f, { field: 'posts', message: 'x' })).toBeNull();
    expect(flagFromServer(f, { field: 'posts', index: 9, message: 'x' })).toBeNull();
    expect(flagFromServer(f, { field: 'name', index: 0, message: 'x' })).toBeNull();
  });
});

describe('lists', () => {
  const list = (): ListItem[] => ['A', 'B', 'C'].map((label) => ({ key: label, label, short: '' }));
  it('moves an item up and down, and not past either end', () => {
    expect(labels(moveItem(list(), 'B', -1))).toEqual(['B', 'A', 'C']);
    expect(labels(moveItem(list(), 'B', 1))).toEqual(['A', 'C', 'B']);
    expect(labels(moveItem(list(), 'A', -1))).toEqual(['A', 'B', 'C']);
    expect(labels(moveItem(list(), 'C', 1))).toEqual(['A', 'B', 'C']);
  });
  it('adds, renames and removes', () => {
    const added = addItem(list(), { label: 'D', short: 'd' });
    expect(labels(added)).toEqual(['A', 'B', 'C', 'D']);
    expect(added[3]!.key).not.toBe('D');
    expect(labels(updateItem(added, 'B', { label: 'Bee' }))).toEqual(['A', 'Bee', 'C', 'D']);
    expect(labels(removeItem(added, 'A'))).toEqual(['B', 'C', 'D']);
  });
  it('keeps at most one medical team', () => {
    const teams = list().map((t, i) => ({ ...t, medical: i === 0 }));
    const next = setMedical(teams, 'C', true);
    expect(next.map((t) => t.medical)).toEqual([false, false, true]);
    expect(setMedical(next, 'C', false).map((t) => t.medical)).toEqual([false, false, false]);
    expect(setMedical(teams, 'B', false).map((t) => t.medical)).toEqual([true, false, false]);
  });
});

describe('fieldKeyOf', () => {
  it('puts each server field next to its field', () => {
    expect(fieldKeyOf('slug')).toBe('slug');
    expect(fieldKeyOf('password')).toBe('password');
    expect(fieldKeyOf('posts')).toBe('posts');
    expect(fieldKeyOf('teams')).toBe('teams');
    expect(fieldKeyOf('startsOn')).toBe('dates');
    expect(fieldKeyOf('endsOn')).toBe('dates');
    expect(fieldKeyOf('expiresAt')).toBe('joinLink');
    expect(fieldKeyOf(undefined)).toBe('form');
    expect(fieldKeyOf('body')).toBe('form');
  });
});

describe('stage', () => {
  it('goes live only from practice with a post and a team', () => {
    expect(canGoLive(event())).toBe(true);
    expect(canGoLive(event({ posts: [] }))).toBe(false);
    expect(canGoLive(event({ teams: [] }))).toBe(false);
    expect(canGoLive(event({ stage: 'live' }))).toBe(false);
  });
  it('numbers LP-0001', () => {
    expect(lpNumber(1)).toBe('LP-0001');
    expect(lpNumber(12345)).toBe('LP-12345');
  });
});
