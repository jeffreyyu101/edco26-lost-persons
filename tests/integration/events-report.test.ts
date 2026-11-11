// (Events, phase 2b) The report's setup fields (spec "Report": Event setup stores the department, the staffing rows
// [{role, name}] and the prepared-by line): created and changed through the lead routes, blank stored as none, checked
// on the way in, and still editable once the event is archived (the report is written after the end) while the
// settings its records were made with stay frozen. Synthetic values only.
import { describe, expect, it } from 'vitest';
import type { EventAdmin } from '@/lib/api-types';
import { api, cookieFor, pii, psql, uniq, withTestServer } from './harness';

withTestServer();

const lead = () => cookieFor({ staffName: pii(`TEST-S Lead ${uniq()}`), team: 'Site Ops' }, { role: 'lead', eventId: null });
const today = () => new Date().toISOString().slice(0, 10);

async function create(extra: Record<string, unknown> = {}): Promise<{ event: EventAdmin; cookie: string }> {
  const cookie = await lead();
  const res = await api<{ event: EventAdmin }>('/api/events', {
    json: { slug: `t-${uniq()}`.toLowerCase(), name: pii(`TEST-S Report ${uniq()}`), startsOn: today(), endsOn: today(), posts: [{ label: 'Gate A' }], teams: [{ label: 'Rovers' }], ...extra },
    cookie,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { event: res.body.event, cookie };
}

describe('the report fields of an event', () => {
  it('are stored on create and read back, blank as none', async () => {
    const { event } = await create({ department: '  Ground   Control ', staffing: [{ role: ' Lead ', name: 'TEST-S Dana' }], preparedBy: '   ' });
    expect(event.department).toBe('Ground Control');
    expect(event.staffing).toEqual([{ role: 'Lead', name: 'TEST-S Dana' }]);
    expect(event.preparedBy).toBeNull();
    const row = psql(`select coalesce(department, '∅') || '|' || staffing::text || '|' || coalesce(prepared_by, '∅') from public.events where id = '${event.id}'`);
    expect(row).toBe('Ground Control|[{"name": "TEST-S Dana", "role": "Lead"}]|∅');
  });

  it('default to none on an event created without them', async () => {
    const { event } = await create();
    expect([event.department, event.staffing, event.preparedBy]).toEqual([null, [], null]);
  });

  it('change through PATCH, alone', async () => {
    const { event, cookie } = await create();
    const res = await api<{ event: EventAdmin }>(`/api/events/${event.id}`, {
      method: 'PATCH',
      json: { preparedBy: 'TEST-S Prepared by Dana Kim', staffing: [{ role: 'Lead', name: 'TEST-S A' }, { role: 'Medic', name: 'TEST-S B' }] },
      cookie,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.event.preparedBy).toBe('TEST-S Prepared by Dana Kim');
    expect(res.body.event.staffing.map((r) => r.role)).toEqual(['Lead', 'Medic']);
    expect(res.body.event.posts.map((p) => p.label)).toEqual(['Gate A']);
    const cleared = await api<{ event: EventAdmin }>(`/api/events/${event.id}`, { method: 'PATCH', json: { department: null, staffing: [] }, cookie });
    expect(cleared.status).toBe(200);
    expect([cleared.body.event.department, cleared.body.event.staffing]).toEqual([null, []]);
  });

  it('are checked: a staffing row needs both cells; at most 40 rows; lines have a length limit', async () => {
    const { event, cookie } = await create();
    const bad = async (json: Record<string, unknown>) => api(`/api/events/${event.id}`, { method: 'PATCH', json, cookie });
    let res = await bad({ staffing: [{ role: 'Lead', name: ' ' }] });
    expect([res.status, res.body.error.field]).toEqual([422, 'staffing']);
    res = await bad({ staffing: [{ role: 'Lead' }] });
    expect([res.status, res.body.error.field]).toEqual([422, 'staffing']);
    res = await bad({ staffing: Array.from({ length: 41 }, (_, i) => ({ role: 'R', name: `N${i}` })) });
    expect([res.status, res.body.error.field]).toEqual([422, 'staffing']);
    res = await bad({ department: 'x'.repeat(121) });
    expect([res.status, res.body.error.field]).toEqual([422, 'department']);
    res = await bad({ preparedBy: 'x'.repeat(201) });
    expect([res.status, res.body.error.field]).toEqual([422, 'preparedBy']);
  });

  it('are checked in SQL too (the server is not the only door)', () => {
    const tooMany = JSON.stringify(Array.from({ length: 41 }, () => ({ role: 'R', name: 'N' })));
    expect(() => psql(`select public.lp_event_create('{"slug":"t-${uniq().toLowerCase()}","name":"x","starts_on":"${today()}","ends_on":"${today()}","staffing":${tooMany}}'::jsonb)`)).toThrow(/invalid_field/);
    expect(() => psql(`select public.lp_event_create('{"slug":"t-${uniq().toLowerCase()}","name":"x","starts_on":"${today()}","ends_on":"${today()}","staffing":[{"role":"R","name":"N","x":1}]}'::jsonb)`)).toThrow(/invalid_field/);
  });

  it('stay editable on an archived event, whose posts do not', async () => {
    const { event, cookie } = await create();
    const pw = await api(`/api/events/${event.id}/go-live`, { method: 'POST', cookie });
    expect(pw.status).toBe(200);
    expect((await api(`/api/events/${event.id}/end`, { method: 'POST', cookie })).status).toBe(200);
    const ok = await api<{ event: EventAdmin }>(`/api/events/${event.id}`, { method: 'PATCH', json: { department: 'Ground Control', preparedBy: 'TEST-S Dana' }, cookie });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.event.department).toBe('Ground Control');
    const frozen = await api(`/api/events/${event.id}`, { method: 'PATCH', json: { posts: [{ label: 'Gate B' }] }, cookie });
    expect([frozen.status, frozen.body.error.code, frozen.body.error.field]).toEqual([409, 'conflict', 'posts']);
  });

  it('never reach a staff session: the event config has none of them', async () => {
    const { event, cookie } = await create();
    await api(`/api/events/${event.id}`, { method: 'PATCH', json: { department: 'Ground Control' }, cookie });
    const opened = await api<{ event: Record<string, unknown> }>('/api/session/event', { json: { eventId: event.id }, cookie });
    expect(opened.status).toBe(200);
    expect(Object.keys(opened.body.event)).not.toContain('department');
    expect(Object.keys(opened.body.event)).not.toContain('staffing');
  });
});
