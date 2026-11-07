// Test hygiene on the shared local stack (regression: integration runs left dozens of open TEST-S rows,
// some with undecodable photos, which then showed in Pending and broke the e2e smoke spec under tracing).
//   * Every request a file creates is closed when the file ends (harness closeCreatedRequests).
//   * The image fixtures the integration and e2e tests upload are real, decodable images.
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { STATUS } from '@/lib/domain';
import { TINY_WEBP, syntheticPng } from '../helpers/images';
import { admin, api, closeCreatedRequests, cookieFor, createRequest, createdRequestIds, newStaff, withTestServer } from './harness';

withTestServer();

async function statusOf(id: string): Promise<{ status: string; closed_at: string | null }> {
  const { data, error } = await admin().from('patients').select('status, closed_at').eq('id', id).single();
  if (error) throw new Error(`select failed: ${error.code}`);
  return data as { status: string; closed_at: string | null };
}

describe('integration test cleanup', () => {
  it('closes the requests a file created: Waiting → Cancelled, In medical → Reunited; answers stay', async () => {
    const staff = newStaff();
    const cookie = await cookieFor(staff);
    const waiting = await createRequest(staff);
    const inMedical = await createRequest(staff);
    const answered = await createRequest(staff);
    for (const [row, status] of [
      [inMedical, STATUS.inMedical],
      [answered, STATUS.notInMedical],
    ] as const) {
      const res = await api(`/api/requests/${row.id}/status`, { json: { status, expectedVersion: row.rowVersion, kind: 'answer' }, cookie });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      // (F5) The first Not found only puts it on hold; the second is the final, closed answer.
      if (status === STATUS.notInMedical) {
        const final = await api(`/api/requests/${row.id}/status`, { json: { status, expectedVersion: res.body.request.rowVersion, kind: 'answer' }, cookie });
        expect(final.body.request.status).toBe(STATUS.notInMedical);
      }
    }
    // A create through api() directly (not createRequest) is tracked too.
    const direct = await api('/api/requests', {
      json: { clientMutationId: crypto.randomUUID(), reportingLocation: 'FA 4 – Oasis', name: 'TEST-S Hygiene Direct' },
      cookie,
    });
    expect(direct.status).toBe(201);
    for (const id of [waiting.id, inMedical.id, answered.id, direct.body.request.id as string]) expect(createdRequestIds().has(id)).toBe(true);

    await closeCreatedRequests();

    expect(await statusOf(waiting.id)).toMatchObject({ status: STATUS.cancelled, closed_at: expect.any(String) });
    expect(await statusOf(direct.body.request.id as string)).toMatchObject({ status: STATUS.cancelled });
    expect(await statusOf(inMedical.id)).toMatchObject({ status: STATUS.reunited, closed_at: expect.any(String) });
    expect((await statusOf(answered.id)).status).toBe(STATUS.notInMedical);
    expect(createdRequestIds().size).toBe(0);
  });
});

describe('image fixtures are decodable', () => {
  it('syntheticPng: IHDR, one zlib IDAT holding every scanline, IEND', () => {
    const png = syntheticPng(48, 64);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const chunks: Array<{ type: string; data: Buffer }> = [];
    for (let at = 8; at < png.length; ) {
      const len = png.readUInt32BE(at);
      chunks.push({ type: png.subarray(at + 4, at + 8).toString('ascii'), data: png.subarray(at + 8, at + 8 + len) });
      at += 12 + len;
    }
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    const ihdr = chunks[0]!.data;
    expect([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9]]).toEqual([48, 64, 8, 2]);
    expect(inflateSync(chunks[1]!.data).length).toBe((48 * 3 + 1) * 64);
  });

  it('TINY_WEBP: RIFF size matches, one VP8L chunk with its signature', () => {
    expect(TINY_WEBP.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(TINY_WEBP.readUInt32LE(4)).toBe(TINY_WEBP.length - 8);
    expect(TINY_WEBP.subarray(8, 16).toString('ascii')).toBe('WEBPVP8L');
    const size = TINY_WEBP.readUInt32LE(16);
    expect(20 + size + (size % 2)).toBe(TINY_WEBP.length);
    expect(TINY_WEBP[20]).toBe(0x2f);
  });
});
