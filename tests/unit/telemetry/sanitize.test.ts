// lib/client/telemetry/sanitize.ts (design §1.3): tokens, class tokens in every bundler's form (and against a real
// production build's class names when one exists), control / area precedence, request-form field keys and sections
// from ids, and path patterns. Every element here throws on a text, value, label or URL read (fakes.ts).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { area, classToken, ctl, fnv8, formField, interactive, pathPattern, tok } from '@/lib/client/telemetry/sanitize';
import { TOKEN_RE } from '@/lib/telemetry';
import { el, forbiddenReads } from './fakes';

afterEach(() => {
  expect(forbiddenReads).toEqual([]);
  forbiddenReads.length = 0;
});

describe('tok', () => {
  it('replaces UUIDs and digit runs with #, keeps single digits', () => {
    expect(tok('pending-column-2')).toBe('pending-column-2');
    expect(tok('pending-section-12')).toBe('pending-section-#');
    expect(tok('row-0f0f0f0f-0000-4000-8000-000000000044')).toBe('row-#');
  });

  it('refuses spaces, capitals, @ and non-ASCII (never attribute names; always text)', () => {
    for (const bad of ['Quorra Zyxwvut', 'Quorra', 'a b', 'x@y.z', 'café', 'name\tx', '']) expect(tok(bad), bad).toBeNull();
    expect(tok(42)).toBeNull();
    expect(tok(null)).toBeNull();
  });

  it('drops other characters and cuts at 48; the result always matches the token regex', () => {
    expect(tok('a(b)=c')).toBe('abc');
    expect(tok('x'.repeat(80))).toHaveLength(48);
    for (const s of ['composer-send', 'list.row', 'rt-iconbutton', '/api/sync:delta']) expect(TOKEN_RE.test(tok(s) as string), s).toBe(true);
  });
});

describe('classToken', () => {
  it('Turbopack production: <hash6>_<local> → local, lowercased', () => {
    expect(classToken('ZUuQ-G_checkActs')).toBe('checkacts');
    expect(classToken('XQsjZW_ansLabel')).toBe('anslabel');
  });

  it('Turbopack development: <file>-module__<hash>__<local> → file.local', () => {
    expect(classToken('list-module__Ab3x9q__row')).toBe('list.row');
  });

  it('webpack: <file>_<local>__<hash5> → file.local', () => {
    expect(classToken('list_row__a1B2c')).toBe('list.row');
  });

  it('global lp-* (not lp-hit) and Radix components (not modifiers)', () => {
    expect(classToken('lp-rf-pchip')).toBe('lp-rf-pchip');
    expect(classToken('lp-hit')).toBeNull();
    expect(classToken('rt-IconButton')).toBe('rt-iconbutton');
    expect(classToken('rt-r-size-2')).toBeNull();
    expect(classToken('rt-variant-soft')).toBeNull();
    expect(classToken('lucide')).toBeNull();
    expect(classToken('some-global')).toBeNull();
  });

  it("a real production build's CSS-module class names all parse to their local name (skipped without a build)", () => {
    const dir = join(process.cwd(), '.next/static/chunks');
    if (!existsSync(dir)) return;
    const names = new Map<string, string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/([A-Za-z][A-Za-z0-9]*):"([A-Za-z0-9_-]{6}_\1)"/g)) names.set(m[2] as string, m[1] as string);
    }
    if (names.size === 0) return;
    expect(names.size).toBeGreaterThan(20);
    // Lowercased, with digit runs as # like every token.
    for (const [cls, local] of names) expect(classToken(cls), cls).toBe(local.toLowerCase().replace(/\d{2,}/g, '#'));
  });
});

describe('ctl and area', () => {
  it('the control: its testid, a testid ≤ 2 levels up, its class token, else its role or tag', () => {
    const send = el('button', { 'data-testid': 'composer-send' }, el('svg'));
    expect(ctl(send.children[0])).toBe('composer-send');
    const near = el('div', { 'data-testid': 'audit-item' }, el('span', {}, el('span', { class: 'XQsjZW_ansLabel' })));
    expect(ctl(near.children[0]?.children[0])).toBe('audit-item');
    expect(ctl(el('button', { class: 'rt-reset rt-IconButton rt-r-size-2' }))).toBe('rt-iconbutton');
    expect(ctl(el('div', { role: 'tab' }))).toBe('tab');
    expect(ctl(el('button'))).toBe('button');
  });

  it('interactive: the closest button, link with href, input, role=button…, tabindex ≥ 0', () => {
    const icon = el('svg');
    el('a', { href: '/x' }, el('span', {}, icon));
    expect(interactive(icon)?.tagName).toBe('A');
    expect(interactive(el('div', { tabindex: '-1' }))).toBeNull();
    expect(interactive(el('div', { tabindex: '0' }))?.tagName).toBe('DIV');
    expect(interactive(el('a'))).toBeNull();
  });

  it('the area: an AREAS testid (digits as #), the Toaster, an open dialog, else the first testid, else page', () => {
    const bubble = el('span');
    el('div', { 'data-testid': 'profile' }, el('div', { 'data-testid': 'thread' }, el('div', { 'data-testid': 'bubble' }, bubble)));
    expect(area(bubble)).toBe('thread');
    const card = el('span');
    el('div', { 'data-testid': 'pending-column-2' }, el('div', {}, card));
    expect(area(card)).toBe('pending-column-#');
    const toast = el('button');
    el('div', { class: 'lp-toaster' }, el('div', { class: 'lp-toast' }, toast));
    expect(area(toast)).toBe('lp-toaster');
    const inSheet = el('button');
    el('div', { role: 'dialog', class: 'lp-sheet XQsjZW_sheet' }, el('div', {}, inSheet));
    expect(area(inSheet)).toBe('lp-sheet');
    const loose = el('span');
    el('div', { 'data-testid': 'whatever-box' }, loose);
    expect(area(loose)).toBe('whatever-box');
    expect(area(el('span'))).toBe('page');
  });
});

describe('request-form fields (ids, never labels)', () => {
  const form = (section: string, key: string) => {
    const input = el('input', { id: `«r3»-${key}` });
    el('div', { 'data-testid': 'request-form' }, el('div', { role: 'group', 'aria-labelledby': `«r3»-${section}` }, el('label', {}, input)));
    return input;
  };

  it('the key is the id suffix (whitelisted) and the section the group label id suffix', () => {
    expect(formField(form('person', 'lastSeen'))).toEqual({ section: 'person', key: 'lastseen' });
    expect(formField(form('friend', 'contactPhone'))).toEqual({ section: 'friend', key: 'contactphone' });
    expect(formField(form('more', 'secretSauce'))).toEqual({ section: 'more', key: 'field' });
  });

  it('the post chip and photo slots; nothing outside the form', () => {
    const chip = el('span');
    el('div', { 'data-testid': 'request-form' }, el('button', { class: 'lp-rf-pchip lp-hit' }, chip));
    expect(formField(chip)?.section).toBe('post');
    const add = el('span');
    el('div', { 'data-testid': 'request-form' }, el('button', { 'data-testid': 'add-photo' }, add));
    expect(formField(add)?.section).toBe('photo');
    expect(formField(el('input', { id: 'x-name' }))).toBeNull();
  });
});

describe('pathPattern', () => {
  const O = 'https://lp.test';
  it('UUIDs become :id, the query is dropped', () => {
    expect(pathPattern(`/api/requests/0f0f0f0f-0000-4000-8000-000000000044/messages/1f0f0f0f-0000-4000-8000-000000000045/unsend`, O)).toBe('/api/requests/:id/messages/:id/unsend');
    expect(pathPattern('/api/requests/0f0f0f0f-0000-4000-8000-000000000044/messages?beforeAt=2026-11-08T01:00:00Z&beforeId=x', O)).toBe('/api/requests/:id/messages');
  });

  it('/api/sync gets its mode from which keys are present, never their values', () => {
    expect(pathPattern('/api/sync', O)).toBe('/api/sync:full');
    expect(pathPattern('/api/sync?since=2026-11-08T00:00:00Z', O)).toBe('/api/sync:delta');
    expect(pathPattern('/api/sync?since=x&reconcile=1', O)).toBe('/api/sync:reconcile');
    expect(pathPattern('/api/sync?afterAt=x&afterId=y', O)).toBe('/api/sync:page');
    expect(pathPattern('/api/sync?ids=a,b', O)).toBe('/api/sync:ids');
  });

  it('another origin or a non-API path is not a pattern', () => {
    expect(pathPattern('https://elsewhere.test/api/sync', O)).toBeNull();
    expect(pathPattern('/_next/static/x.js', O)).toBeNull();
  });

  it('fnv8 is 8 hex characters', () => {
    expect(fnv8('x')).toMatch(/^[0-9a-f]{8}$/);
  });
});
