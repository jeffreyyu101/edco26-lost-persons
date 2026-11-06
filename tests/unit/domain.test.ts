import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STATUS,
  STATUSES,
  STATUS_META,
  TEAM_ALIASES,
  TRANSITIONS,
  ageGender,
  appendChip,
  avatarInitials,
  canCancel,
  canTransition,
  canonStaff,
  canonicalTeam,
  displayChanges,
  genderShort,
  initials,
  isCreatorOnlyTransition,
  isValidPhone,
  menuActions,
  parseStaff,
  postFull,
  postShort,
  primaryActions,
  sameStaff,
  splitName,
  staffString,
  statusBucket,
  statusMeta,
  teamShort,
  telHref,
  undoTarget,
  waitTone,
} from '@/lib/domain';

const ROOT = join(__dirname, '..', '..');
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20261106000000_rework.sql'), 'utf8');

function sqlBlock(marker: string): string {
  const start = MIGRATION.indexOf(`-- ${marker}:BEGIN`);
  const end = MIGRATION.indexOf(`-- ${marker}:END`);
  expect(start, `${marker} block in the migration`).toBeGreaterThan(0);
  return MIGRATION.slice(start, end);
}

describe('statuses', () => {
  it('labels, tones and glyphs match the spec table', () => {
    expect(STATUS_META[STATUS.waiting]).toMatchObject({ label: 'Waiting for check', tone: 'blue', glyph: 'waiting', bucket: 'open' });
    expect(STATUS_META[STATUS.notInMedical]).toMatchObject({ label: 'Not in medical', tone: 'gray', glyph: 'notInMedical', bucket: 'closed' });
    expect(STATUS_META[STATUS.inMedical]).toMatchObject({ label: 'In medical · friend coming', shortLabel: 'In medical', tone: 'green', glyph: 'inMedical', bucket: 'open' });
    expect(STATUS_META[STATUS.reunited]).toMatchObject({ label: 'Reunited', tone: 'gray', glyph: 'closed', bucket: 'closed' });
    expect(STATUS_META[STATUS.discharged]).toMatchObject({ label: 'Discharged', tone: 'gray', glyph: 'closed', bucket: 'closed' });
    expect(STATUS_META[STATUS.cancelled]).toMatchObject({ label: 'Cancelled', tone: 'gray', glyph: 'closed', bucket: 'closed' });
  });

  it('treats legacy Bring friend to medical like In medical', () => {
    expect(statusMeta(STATUS.legacyBringFriend)).toEqual(statusMeta(STATUS.inMedical));
    expect(statusBucket(STATUS.legacyBringFriend)).toBe('open');
  });

  it('shows unknown legacy values verbatim, grey and closed, with no actions', () => {
    expect(statusMeta('Found – Transported')).toEqual({
      label: 'Found – Transported',
      shortLabel: 'Found – Transported',
      tone: 'gray',
      glyph: 'closed',
      bucket: 'closed',
    });
    expect(primaryActions('Found – Transported')).toEqual([]);
    expect(menuActions('Found – Transported', true)).toEqual([]);
  });

  it('lists every value of the database CHECK', () => {
    expect([...STATUSES].sort()).toEqual(
      ['Added', 'Bring friend to medical', 'Cancelled', 'Checked – Not Found', 'Found – Awaiting Reunion', 'Found – Discharged', 'Reunited – Closed'].sort(),
    );
  });
});

describe('transitions', () => {
  it('match the lp_set_status CASE in the migration exactly', () => {
    const block = sqlBlock('TRANSITIONS');
    const fromSql: Record<string, string[]> = {};
    for (const m of block.matchAll(/when '([^']+)' then p_status in \(([^)]*)\)/g)) {
      fromSql[m[1] as string] = [...(m[2] as string).matchAll(/'([^']+)'/g)].map((x) => x[1] as string).sort();
    }
    const fromTs = Object.fromEntries(Object.entries(TRANSITIONS).map(([k, v]) => [k, [...v].sort()]));
    expect(fromSql).toEqual(fromTs);
  });

  it('allows the spec table and rejects everything else', () => {
    expect(canTransition('Added', 'Checked – Not Found')).toBe(true);
    expect(canTransition('Added', 'Found – Awaiting Reunion')).toBe(true);
    expect(canTransition('Added', 'Cancelled')).toBe(false); // only through cancel
    expect(canTransition('Added', 'Reunited – Closed')).toBe(false);
    expect(canTransition('Checked – Not Found', 'Found – Awaiting Reunion')).toBe(true);
    expect(canTransition('Checked – Not Found', 'Added')).toBe(true);
    expect(canTransition('Checked – Not Found', 'Reunited – Closed')).toBe(false);
    expect(canTransition('Found – Awaiting Reunion', 'Found – Discharged')).toBe(true);
    expect(canTransition('Reunited – Closed', 'Found – Awaiting Reunion')).toBe(true);
    expect(canTransition('Reunited – Closed', 'Added')).toBe(false);
    expect(canTransition('Cancelled', 'Added')).toBe(true);
    expect(canTransition('Bring friend to medical', 'Reunited – Closed')).toBe(true);
    expect(canTransition('Bring friend to medical', 'Added')).toBe(false);
    expect(canTransition('Found – Transported', 'Added')).toBe(false);
  });

  it('marks Cancelled → Added as creator-only', () => {
    expect(isCreatorOnlyTransition('Cancelled', 'Added')).toBe(true);
    expect(isCreatorOnlyTransition('Checked – Not Found', 'Added')).toBe(false);
  });

  it('undo goes back to the previous status, never to the legacy value', () => {
    expect(undoTarget('Added')).toBe('Added');
    expect(undoTarget('Found – Awaiting Reunion')).toBe('Found – Awaiting Reunion');
    expect(undoTarget('Bring friend to medical')).toBe('Found – Awaiting Reunion');
    expect(undoTarget('Found – Transported')).toBeNull();
    // Every undoable tap's reverse move is allowed by the transition table.
    for (const from of STATUSES) {
      for (const a of primaryActions(from)) {
        const back = undoTarget(from);
        expect(back && canTransition(a.to, back), `${from} → ${a.to} → undo`).toBe(true);
      }
    }
  });

  it('offers the sticky actions per status', () => {
    expect(primaryActions('Added').map((a) => [a.label, a.to, a.kind])).toEqual([
      ['Not in medical', 'Checked – Not Found', 'answer'],
      ['In medical', 'Found – Awaiting Reunion', 'answer'],
    ]);
    expect(primaryActions('Found – Awaiting Reunion').map((a) => [a.label, a.to, a.kind])).toEqual([
      ['Change answer', 'Checked – Not Found', 'change'],
      ['Reunited', 'Reunited – Closed', 'reunite'],
    ]);
    expect(primaryActions('Bring friend to medical').map((a) => a.to)).toEqual(['Checked – Not Found', 'Reunited – Closed']);
    expect(primaryActions('Checked – Not Found').map((a) => [a.label, a.to])).toEqual([['Change answer', 'Found – Awaiting Reunion']]);
    for (const closed of ['Reunited – Closed', 'Found – Discharged', 'Cancelled']) expect(primaryActions(closed)).toEqual([]);
    expect(primaryActions('Added').every((a) => a.undoable)).toBe(true);
    // Every offered action is a legal transition.
    for (const s of STATUSES) for (const a of primaryActions(s)) expect(canTransition(s, a.to)).toBe(true);
  });

  it('offers the ⋯ menu status items per status', () => {
    expect(menuActions('Found – Awaiting Reunion', false).map((a) => [a.label, a.to, a.kind])).toEqual([
      ['Mark discharged', 'Found – Discharged', 'discharge'],
    ]);
    expect(menuActions('Reunited – Closed', false).map((a) => [a.label, a.to, a.kind])).toEqual([['Reopen', 'Found – Awaiting Reunion', 'reopen']]);
    expect(menuActions('Found – Discharged', false).map((a) => a.to)).toEqual(['Found – Awaiting Reunion']);
    expect(menuActions('Cancelled', false)).toEqual([]);
    expect(menuActions('Cancelled', true).map((a) => [a.to, a.creatorOnly])).toEqual([['Added', true]]);
    expect(menuActions('Added', true)).toEqual([]);
    expect(menuActions('Checked – Not Found', true)).toEqual([]);
    for (const s of STATUSES) for (const a of menuActions(s, true)) expect(canTransition(s, a.to)).toBe(true);
  });

  it('shows Cancel only to the creator while Waiting (canonical match)', () => {
    expect(canCancel('Added', 'Dana Kim · GC/HX - Dispatch', 'dana kim · Dispatch')).toBe(true);
    expect(canCancel('Added', 'Dana Kim · GC/HX - Dispatch', 'Rae Chen · Medical')).toBe(false);
    expect(canCancel('Checked – Not Found', 'Dana Kim · GC/HX - Dispatch', 'Dana Kim · GC/HX - Dispatch')).toBe(false);
    expect(canCancel('Added', 'Dana Kim · GC/HX - Dispatch', null)).toBe(false);
  });
});

describe('staff identity', () => {
  const fixtures = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/canon-staff.json'), 'utf8')) as Array<{ input: string; expected: string }>;

  it.each(fixtures)('canonStaff($input)', ({ input, expected }) => {
    expect(canonStaff(input)).toBe(expected);
  });

  it('keeps SQL null semantics', () => {
    expect(canonStaff(null)).toBeNull();
    expect(canonStaff(undefined)).toBeNull();
  });

  it('TEAM_ALIASES matches the lp_canon_staff alias block exactly', () => {
    const block = sqlBlock('TEAM_ALIASES');
    const fromSql = Object.fromEntries([...block.matchAll(/when '([^']+)' then '([^']+)'/g)].map((m) => [m[1], m[2]]));
    expect(fromSql).toEqual(TEAM_ALIASES);
  });

  it('lp_canon_staff uses the same whitespace and separator classes as canonStaff', () => {
    const domainSource = readFileSync(join(ROOT, 'lib/domain.ts'), 'utf8');
    const ws = String.raw`\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+`;
    const sep = String.raw`[\u2022\u00b7\u2219\u22c5\u30fb\uff65\u0387] ?`;
    expect(MIGRATION).toContain(String.raw`'[\u0009\u000a\u000b\u000c\u000d\u0020` + ws);
    expect(domainSource).toContain(String.raw`/[\t\n\v\f\r ` + ws);
    expect(MIGRATION).toContain(`' ?${sep}'`);
    expect(domainSource).toContain(`/ ?${sep}/g`);
  });

  it('sameStaff needs both sides present', () => {
    expect(sameStaff('Dana Kim · Dispatch', 'DANA KIM · GC/HX - Dispatch')).toBe(true);
    expect(sameStaff('', '')).toBe(false);
    expect(sameStaff(null, null)).toBe(false);
    expect(sameStaff('Dana Kim · Dispatch', 'Dana Kim · Medical')).toBe(false);
  });

  it('builds and parses attribution strings', () => {
    expect(staffString('  Dana  Kim ', 'GC/HX - Dispatch')).toBe('Dana Kim · GC/HX - Dispatch');
    expect(parseStaff('Rae Chen · GC/HX - Special Operations/Med Transpo')).toEqual({
      name: 'Rae Chen',
      team: 'GC/HX - Special Operations/Med Transpo',
      teamShort: 'GCHX Med Transpo',
    });
    expect(parseStaff('Dana Kim · GC/HX - Dispatch').teamShort).toBe('Dispatch');
    expect(parseStaff('Old · Prevent')).toEqual({ name: 'Old', team: 'Prevent', teamShort: 'Prevent' });
    expect(parseStaff('Just a name')).toEqual({ name: 'Just a name', team: '', teamShort: '' });
    expect(parseStaff(null).name).toBe('');
  });

  it('maps teams to canonical values and short labels', () => {
    expect(canonicalTeam('gchx base')).toBe('GC/HX - Base');
    expect(canonicalTeam('GC/HX - Dispatch')).toBe('GC/HX - Dispatch');
    expect(canonicalTeam('transport')).toBe('GC/HX - Special Operations/Med Transpo');
    expect(canonicalTeam('prevent')).toBe('Prevent');
    expect(canonicalTeam('  Info Booth ')).toBe('Info Booth');
    expect(teamShort('GC/HX - Special Operations/Med Transpo')).toBe('GCHX Med Transpo');
    expect(teamShort('Medical')).toBe('Medical');
    expect(teamShort('Info Booth')).toBe('Info Booth');
  });
});

describe('posts', () => {
  it('postShort', () => {
    expect(postShort('FA 3 – Kinetic')).toBe('FA 3');
    expect(postShort('FA 4 – Oasis')).toBe('FA 4');
    expect(postShort('Command')).toBe('Command');
    expect(postShort('Base')).toBe('Base');
    expect(postShort('Other', ' Info booth ')).toBe('Info booth');
    expect(postShort('Other', null)).toBe('Other');
    expect(postShort('Other', '  ')).toBe('Other');
    expect(postShort('FA 3')).toBe('FA 3'); // legacy value passes through
    expect(postShort(null)).toBe('');
  });

  it('postShort matches the CASE used in lp_stats', () => {
    expect(MIGRATION).toContain("when 'FA 3 – Kinetic' then 'FA 3'");
    expect(MIGRATION).toContain("when 'FA 4 – Oasis' then 'FA 4'");
    expect(MIGRATION).toContain("when 'Other' then coalesce(nullif(pg_catalog.btrim(p.other_location), ''), 'Other')");
  });

  it('postFull', () => {
    expect(postFull('FA 3 – Kinetic')).toBe('FA 3 – Kinetic');
    expect(postFull('Other', 'Info booth')).toBe('Info booth');
  });
});

describe('names', () => {
  it('splits at the last space like Jeffrey', () => {
    expect(splitName('Kayla Martinez')).toEqual({ firstName: 'Kayla', lastName: 'Martinez' });
    expect(splitName('  Mary  Ann   Smith ')).toEqual({ firstName: 'Mary Ann', lastName: 'Smith' });
    expect(splitName('J.D.')).toEqual({ firstName: 'J.D.', lastName: null });
    expect(splitName('   ')).toEqual({ firstName: null, lastName: null });
    expect(splitName(null)).toEqual({ firstName: null, lastName: null });
  });

  it('initials (A4)', () => {
    expect(initials('Kayla Martinez')).toBe('K.M.');
    expect(initials('T.R.')).toBe('T.R.');
    expect(initials('mary ann smith')).toBe('M.S.');
    expect(initials('Dana')).toBe('DA');
    expect(initials('J')).toBe('J.');
    expect(initials('')).toBe('');
    expect(initials(null)).toBe('');
  });

  it('avatar initials', () => {
    expect(avatarInitials('Dana Kim')).toBe('DK');
    expect(avatarInitials('rae')).toBe('RA');
    expect(avatarInitials('')).toBe('');
  });

  it('gender and age', () => {
    expect(genderShort('Male')).toBe('M');
    expect(genderShort('Female')).toBe('F');
    expect(genderShort('Other')).toBe('');
    expect(genderShort(null)).toBe('');
    expect(ageGender(19, 'Female')).toBe('19 F');
    expect(ageGender(null, 'Male')).toBe('M');
    expect(ageGender(0, null)).toBe('0');
    expect(ageGender(null, null)).toBe('');
  });
});

describe('phone', () => {
  it('validates 10–15 digits', () => {
    expect(isValidPhone('(407) 555-0142')).toBe(true);
    expect(isValidPhone('+44 20 7946 0958')).toBe(true);
    expect(isValidPhone('555-0142')).toBe(false);
    expect(isValidPhone('1234567890123456')).toBe(false);
    expect(isValidPhone('')).toBe(false);
    expect(isValidPhone(null)).toBe(false);
  });

  it('builds tel: links', () => {
    expect(telHref('(407) 555-0142')).toBe('tel:4075550142');
    expect(telHref('+44 20 7946 0958')).toBe('tel:+442079460958');
    expect(telHref('call me')).toBeNull();
  });
});

describe('wait thresholds', () => {
  it('grey under 10, amber 10–19, red 20+', () => {
    expect(waitTone(0)).toBe('gray');
    expect(waitTone(9)).toBe('gray');
    expect(waitTone(10)).toBe('amber');
    expect(waitTone(19)).toBe('amber');
    expect(waitTone(20)).toBe('red');
    expect(waitTone(240)).toBe('red');
  });
});

describe('form helpers', () => {
  it('appends stage chips with ", "', () => {
    expect(appendChip('', 'kineticFIELD')).toBe('kineticFIELD');
    expect(appendChip('   ', 'kineticFIELD')).toBe('kineticFIELD');
    expect(appendChip('Near the rail', 'kineticFIELD')).toBe('Near the rail, kineticFIELD');
    expect(appendChip('Near the rail, ', 'Taken to medical')).toBe('Near the rail, Taken to medical');
  });

  it('turns edits into display rows, merging Name and Post', () => {
    expect(displayChanges({ hair: null }, { hair: 'Blond, two braids' })).toEqual([
      { field: 'hair', label: 'Hair', from: null, to: 'Blond, two braids' },
    ]);
    expect(
      displayChanges({ firstName: 'Kayla', lastName: 'Martinez' }, { firstName: 'Kayla', lastName: 'Martin' }),
    ).toEqual([{ field: 'name', label: 'Name', from: 'Kayla Martinez', to: 'Kayla Martin' }]);
    expect(
      displayChanges(
        { reportingLocation: 'FA 3 – Kinetic', otherLocation: null },
        { reportingLocation: 'Other', otherLocation: 'Info booth' },
      ),
    ).toEqual([{ field: 'post', label: 'Post', from: 'FA 3 – Kinetic', to: 'Info booth' }]);
    expect(displayChanges({ age: 19 }, { age: 20 })).toEqual([{ field: 'age', label: 'Age', from: '19', to: '20' }]);
    expect(displayChanges({ contactName: 'Maya' }, { contactName: 'Maya' })).toEqual([]);
  });
});
