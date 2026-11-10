// (Events) The server's post and team lists (lib/validation.ts): a missing or blank Short is derived from the label
// (lib/short-label.ts); every short is unique, case-insensitively; an issue names the item.
import { describe, expect, it } from 'vitest';
import { invalidFromZod } from '@/lib/server/http';
import { eventCreateSchema, eventPatchSchema, eventPostsSchema, eventTeamsSchema } from '@/lib/validation';

const WARPED_POSTS = ['FA 1 – Main Stage', 'FA 2 – Vans Stage', 'Main Medical', 'Command', 'Roaming', 'Gate A'];

describe('event posts and teams: Short left empty', () => {
  it('derives each short from its label', () => {
    const posts = eventPostsSchema.parse(WARPED_POSTS.map((label) => ({ label })));
    expect(posts.map((p) => p.short)).toEqual(['FA 1', 'FA 2', 'Main Medical', 'Command', 'Roaming', 'Gate A']);
    const teams = eventTeamsSchema.parse([{ label: 'Ground Control Dispatch Team' }, { label: 'Medical Ops North Quadrant', medical: true }]);
    expect(teams.map((t) => t.short)).toEqual(['Ground Control Dispatch', 'Medical Ops North']);
  });
  it('a blank or spaces-only Short counts as empty', () => {
    expect(eventPostsSchema.parse([{ label: 'FA 1 – Main Stage', short: '' }])[0]!.short).toBe('FA 1');
    expect(eventPostsSchema.parse([{ label: 'FA 1 – Main Stage', short: '   ' }])[0]!.short).toBe('FA 1');
    expect(eventTeamsSchema.parse([{ label: 'Ground Control Dispatch Team', short: ' ' }])[0]!.short).toBe('Ground Control Dispatch');
  });
  it('keeps a typed Short, trimmed', () => {
    expect(eventPostsSchema.parse([{ label: 'FA 1 – Main Stage', short: ' Main  ' }])[0]!.short).toBe('Main');
  });
  it('a typed Short over the limit is refused on that item', () => {
    const r = eventPostsSchema.safeParse([{ label: 'A' }, { label: 'B', short: 'x'.repeat(17) }]);
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual([1, 'short']);
  });
  it('the whole create body with every Short empty passes', () => {
    const r = eventCreateSchema.safeParse({
      slug: 'warped-tour-orlando',
      name: 'Warped Tour Orlando',
      startsOn: '2026-11-14',
      endsOn: '2026-11-15',
      posts: WARPED_POSTS.map((label) => ({ label })),
      teams: [{ label: 'Ground Control Dispatch Team' }],
    });
    expect(r.success).toBe(true);
  });
});

describe('event posts and teams: each short once', () => {
  it('refuses a duplicate short (typed or derived, any case) on the second item', () => {
    const typed = eventPostsSchema.safeParse([{ label: 'North Gate', short: 'North' }, { label: 'North Tent', short: 'north' }]);
    expect(typed.error!.issues).toEqual([expect.objectContaining({ message: 'Short already used', path: [1, 'short'] })]);
    const derived = eventPostsSchema.safeParse([{ label: 'Gate A – North Side' }, { label: 'Gate A – South Side' }]);
    expect(derived.error!.issues[0]!.path).toEqual([1, 'short']);
    const mixed = eventPostsSchema.safeParse([{ label: 'FA 1' }, { label: 'FA 1 – Main Stage' }]);
    expect(mixed.error!.issues[0]!.path).toEqual([1, 'short']);
    const teams = eventTeamsSchema.safeParse([{ label: 'Medical', short: 'Med' }, { label: 'Medics', short: 'MED' }]);
    expect(teams.error!.issues[0]!.path).toEqual([1, 'short']);
  });
  it('a duplicate label is refused on the second item', () => {
    const r = eventPostsSchema.safeParse([{ label: 'Gate A' }, { label: 'gate a' }]);
    expect(r.error!.issues[0]).toMatchObject({ message: 'Each post once', path: [1, 'label'] });
  });
  it('the 422 names the field, the item and its part', () => {
    const r = eventPatchSchema.safeParse({ posts: [{ label: 'North Gate', short: 'North' }, { label: 'North Tent', short: 'North' }] });
    const body = invalidFromZod(r.error!).body();
    expect(body.error).toMatchObject({ code: 'invalid', message: 'Short already used', field: 'posts', index: 1, part: 'short' });
    const name = eventPatchSchema.safeParse({ name: '' });
    expect(invalidFromZod(name.error!).body().error).not.toHaveProperty('index');
  });
});
