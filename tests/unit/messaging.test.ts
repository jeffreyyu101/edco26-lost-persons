// F3 messages and en route, the pure rules (lib/messaging.ts, lib/client/messages-logic.ts): quick lines by
// status × side, the en route row, notification details, previews, thread merging and bubbles, receipts,
// the optimistic en route, carrying activity over mutation answers, the outbox classification and the
// message alert. Synthetic data only.
import { describe, expect, it } from 'vitest';
import type { EnrouteSummary, RequestSummary, ThreadMessage } from '@/lib/api-types';
import { STATUS, STATUS_META } from '@/lib/domain';
import {
  DETAIL,
  ETA_CHOICES,
  FOH_WAITING_LINES,
  MEDICAL_LINES,
  enrouteDetail,
  enrouteView,
  etaPhrase,
  fillWithQuickLine,
  iAmEnroute,
  maskContacts,
  messageDetail,
  previewText,
  quickLines,
  quickStage,
  senderShort,
  shortStaffName,
  sideOfStaff,
  sideOfTeam,
  truncateText,
} from '@/lib/messaging';
import {
  activityOf,
  addConfirmed,
  buildBubbles,
  carryActivity,
  classifyJobFailure,
  diffMessageAlerts,
  effectiveEnroute,
  failedEnrouteTap,
  jobOrder,
  jobSendable,
  mergeEarlierPage,
  mergeLatestPage,
  RUN_BREAK_MS,
  receiptFor,
  storedJob,
  type MessageJob,
} from '@/lib/client/messages-logic';
import { mergeRows, sameRow } from '@/lib/client/sync-merge';
import { makeRow } from './client/helpers/fake-server';

const NOW = Date.parse('2026-11-07T03:00:00Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();

describe('sides and names', () => {
  it('the Medical team is medical, every other team is front of house', () => {
    expect(sideOfTeam('Medical')).toBe('medical');
    expect(sideOfTeam('medical')).toBe('medical');
    expect(sideOfTeam('GC/HX - Dispatch')).toBe('foh');
    expect(sideOfTeam('GC/HX - Special Operations/Med Transpo')).toBe('foh');
    expect(sideOfTeam('Prevent')).toBe('foh');
    expect(sideOfTeam('')).toBe('foh');
    expect(sideOfStaff('Rae Chen · Medical')).toBe('medical');
    expect(sideOfStaff('Dana Kim · GC/HX - Base')).toBe('foh');
  });

  it('a sender is first name + last initial, never the full name', () => {
    expect(shortStaffName('Rae Chen')).toBe('Rae C.');
    expect(shortStaffName('Mary Ann Smith')).toBe('Mary S.');
    expect(shortStaffName('Rae')).toBe('Rae');
    expect(shortStaffName('  ')).toBe('');
    expect(senderShort('Dana Kim · GC/HX - Base')).toBe('Dana K.');
  });

  it('truncates to 120 characters with an ellipsis, counting code points', () => {
    expect(truncateText('short', 120)).toBe('short');
    const long = 'x'.repeat(130);
    expect(Array.from(truncateText(long, 120))).toHaveLength(120);
    expect(truncateText(long, 120).endsWith('…')).toBe(true);
    expect(truncateText('a  b\n c', 120)).toBe('a b c');
  });
});

describe('quick lines (status × side)', () => {
  const row = (status: string, extra: Record<string, unknown> = {}) => ({ status, ...extra });

  it('stages: waiting (incl. the Pending hold), in medical, closed', () => {
    expect(quickStage(row(STATUS.waiting))).toBe('waiting');
    expect(quickStage(row(STATUS.notInMedical, { recheckAt: at(20) }))).toBe('waiting');
    expect(quickStage(row(STATUS.notInMedical))).toBe('closed');
    expect(quickStage(row(STATUS.notInMedical, { recheckAt: null }))).toBe('closed');
    expect(quickStage(row(STATUS.inMedical))).toBe('in_medical');
    expect(quickStage(row(STATUS.legacyBringFriend))).toBe('in_medical');
    for (const closed of [STATUS.reunited, STATUS.discharged, STATUS.cancelled]) expect(quickStage(row(closed))).toBe('closed');
  });

  it('the whole table', () => {
    const texts = (stage: Parameters<typeof quickLines>[0], side: Parameters<typeof quickLines>[1], mine = false, arrived = false) =>
      quickLines(stage, side, mine, arrived).map((l) => `${l.kind}:${l.text}`);
    expect(texts('waiting', 'medical')).toEqual(['message:Any tattoos or marks?', 'message:What are they wearing?', 'message:Do you have a photo?']);
    expect(texts('waiting', 'foh')).toEqual(['message:Friend is still here', 'message:Friend left the area']);
    // (HIPAA, Brian 2026-11-07 14:18) "Not ready yet — wait" (was "Being worked up — wait"); "Hold — not ready yet",
    // now the same words, is gone.
    expect(texts('in_medical', 'medical')).toEqual(['message:Bring 1 person only', 'message:Not ready yet — wait', 'message:Ready for them']);
    // (2026-11-07 13:52) "Can't find them" is gone; En route and "Friend left the area" stay.
    expect(texts('in_medical', 'foh')).toEqual(['enroute:En route', 'message:Friend left the area']);
    // (2026-11-08) No Arrived: once I am en route the line is gone (my row in the status block changes or cancels it;
    // Reunited is in the request's bar).
    expect(texts('in_medical', 'foh', true)).toEqual(['message:Friend left the area']);
    // An old row whose friend arrived offers no En route either (as on the cards).
    expect(texts('in_medical', 'foh', false, true)).toEqual(['message:Friend left the area']);
    expect(texts('in_medical', 'foh', true, true)).toEqual(['message:Friend left the area']);
    for (const stage of ['waiting', 'in_medical', 'closed'] as const) {
      for (const side of ['medical', 'foh'] as const) {
        for (const mine of [false, true]) {
          for (const arrived of [false, true]) {
            const all = texts(stage, side, mine, arrived).join('|');
            expect(all).not.toContain("Can't find them");
            expect(all).not.toMatch(/worked up|Hold —/);
            // (2026-11-08) Arrived is offered nowhere, as a kind or as words.
            expect(all, `${stage} ${side} ${mine} ${arrived}`).not.toMatch(/arrived|Arrived/);
          }
        }
      }
    }
    expect(texts('closed', 'medical')).toEqual([]);
    expect(texts('closed', 'foh')).toEqual([]);
    // Medical's lines never depend on en route.
    expect(quickLines('in_medical', 'medical', true)).toBe(MEDICAL_LINES.in_medical);
    expect(quickLines('waiting', 'foh', true)).toBe(FOH_WAITING_LINES);
  });

  it('a tap fills the composer (2026-11-07 13:55): set when empty, appended after a space, typed text never lost', () => {
    expect(fillWithQuickLine('', 'Any tattoos or marks?')).toBe('Any tattoos or marks?');
    expect(fillWithQuickLine('   ', 'Any tattoos or marks?')).toBe('Any tattoos or marks?');
    expect(fillWithQuickLine('Hi Rae.', 'Do you have a photo?')).toBe('Hi Rae. Do you have a photo?');
    expect(fillWithQuickLine('Hi Rae. ', 'Do you have a photo?')).toBe('Hi Rae. Do you have a photo?');
    expect(fillWithQuickLine('Line one\n', 'Ready for them')).toBe('Line one\nReady for them');
    // Two taps: both lines, in order.
    expect(fillWithQuickLine(fillWithQuickLine('', 'Bring 1 person only'), 'Ready for them')).toBe('Bring 1 person only Ready for them');
  });
});

describe('en route row', () => {
  const summary = (patch: Partial<EnrouteSummary> = {}): EnrouteSummary => ({ count: 1, earliestEta: at(4), state: 'enroute', mine: null, ...patch });

  it('counts down to the ETA in whole minutes, "now" around it, amber "late" after a minute past', () => {
    expect(etaPhrase(at(4), NOW)).toEqual({ text: '~4 min', late: false });
    expect(etaPhrase(at(3.2), NOW)).toEqual({ text: '~3 min', late: false });
    expect(etaPhrase(at(3.6), NOW)).toEqual({ text: '~4 min', late: false });
    // A fresh ~5 min stays 5 with the server's clock a few seconds ahead.
    expect(etaPhrase(at(5.05), NOW)).toEqual({ text: '~5 min', late: false });
    expect(etaPhrase(at(0.6), NOW)).toEqual({ text: '~1 min', late: false });
    expect(etaPhrase(at(0.2), NOW)).toEqual({ text: 'now', late: false });
    expect(etaPhrase(at(-0.9), NOW)).toEqual({ text: 'now', late: false });
    expect(etaPhrase(at(-2), NOW)).toEqual({ text: 'late', late: true });
    expect(etaPhrase(null, NOW)).toBeNull();
  });

  it('one row: teal with the ETA, no ETA, amber late, a count when several, green arrived', () => {
    expect(enrouteView(summary(), NOW)).toMatchObject({ label: 'Friend en route', eta: '~4 min', tone: 'teal', count: 1 });
    expect(enrouteView(summary({ earliestEta: null }), NOW)).toMatchObject({ eta: null, tone: 'teal' });
    expect(enrouteView(summary({ earliestEta: at(-5) }), NOW)).toMatchObject({ eta: 'late', tone: 'amber', late: true });
    expect(enrouteView(summary({ count: 2, earliestEta: at(2) }), NOW)).toMatchObject({ count: 2, eta: '~2 min' });
    expect(enrouteView(summary({ state: 'arrived', count: 0 }), NOW)).toMatchObject({ label: 'Friend arrived', tone: 'green', eta: null });
    expect(enrouteView(null, NOW)).toBeNull();
    // Only while In medical.
    expect(enrouteView(summary(), NOW, STATUS.reunited)).toBeNull();
    expect(enrouteView(summary(), NOW, STATUS.inMedical)).not.toBeNull();
    // No names or teams anywhere.
    expect(JSON.stringify(enrouteView(summary({ count: 2 }), NOW))).not.toMatch(/Dana|Rae|Medical|Dispatch/);
  });

  it('am I en route', () => {
    expect(iAmEnroute(summary({ mine: { etaAt: at(5), etaMinutes: 5, state: 'enroute' } }))).toBe(true);
    expect(iAmEnroute(summary({ mine: null }))).toBe(false);
    expect(iAmEnroute(summary({ state: 'arrived', mine: { etaAt: null, state: 'arrived' } }))).toBe(false);
  });

  it('the sheet offers Now / ~5 / ~10 / ~15', () => {
    expect(ETA_CHOICES.map((c) => c.label)).toEqual(['Now', '~5 min', '~10 min', '~15 min']);
  });
});

describe('notification details (contract B)', () => {
  it('message: sender short name and the text cut to 120', () => {
    expect(messageDetail('Rae Chen · Medical', 'Bring 1 person only')).toBe('Rae C.: Bring 1 person only');
    const d = messageDetail('Rae Chen · Medical', 'y'.repeat(300));
    expect(d.startsWith('Rae C.: ')).toBe(true);
    expect(Array.from(d.slice('Rae C.: '.length))).toHaveLength(120);
  });

  it('en route with and without an ETA, cancelled, arrived', () => {
    expect(enrouteDetail(at(4), NOW)).toBe('Friend en route · ~4 min');
    expect(enrouteDetail(null, NOW)).toBe('Friend en route');
    expect(enrouteDetail(at(0), NOW)).toBe('Friend en route · now');
    expect(DETAIL.enrouteCancelled).toBe('En route cancelled');
    expect(DETAIL.arrived).toBe('Friend arrived');
  });

  it('never a phone number or an LP number in a detail', () => {
    expect(messageDetail('Rae Chen · Medical', 'Call me')).not.toMatch(/LP-\d/);
  });

  it('masks phone numbers and email addresses (contract E), keeps short numbers', () => {
    expect(messageDetail('Dana Kent · Dispatch', 'Her sister is at 407-555-0199')).toBe('Dana K.: Her sister is at •••');
    for (const phone of ['(407) 555 0199', '+1 407 555 0199', '407.555.0199', '4075550199', '555-0199']) {
      expect(maskContacts(`Call ${phone} now`)).toBe('Call ••• now');
    }
    expect(maskContacts('Email rae.chen+edc@example.org or text')).toBe('Email ••• or text');
    for (const kept of ['Bed 3', 'Chair 9 → Bed 3', 'Back at 4:40 PM', 'FA 4, 24 M', 'Bring 1 person only', '2 of 3 friends']) {
      expect(maskContacts(kept)).toBe(kept);
    }
    // Masked before the cut: a number at the edge never shows half.
    const long = messageDetail('Rae Chen · Medical', `${'x'.repeat(110)} 407 555 0199`);
    expect(long).not.toMatch(/\d{3}/);
  });
});

describe('previews', () => {
  it('"You" for mine, the sender for theirs', () => {
    expect(previewText({ by: 'Rae C.', mine: false, text: 'Any tattoos or marks?' })).toEqual({ who: 'Rae C.', text: 'Any tattoos or marks?' });
    expect(previewText({ by: 'Rae C.', mine: true, text: 'Any tattoos or marks?' })).toEqual({ who: 'You', text: 'Any tattoos or marks?' });
  });
});

// ---------------------------------------------------------------------------------------------------

const msg = (n: number, patch: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id: `m${String(n).padStart(3, '0')}`,
  staff: 'Rae Chen · Medical',
  by: 'Rae C.',
  team: 'Medical',
  body: `Message ${n}`,
  createdAt: at(n),
  mine: false,
  clientMutationId: `c${n}`,
  ...patch,
});

const job = (n: number, patch: Partial<MessageJob> = {}): MessageJob => ({
  id: `j${n}`,
  kind: 'message',
  requestId: 'r1',
  body: `Queued ${n}`,
  operator: 'Dana Kim · GC/HX - Dispatch',
  createdAt: NOW + n * 1000,
  state: 'pending',
  attempts: 0,
  nextAttemptAt: null,
  error: null,
  ...patch,
});

describe('thread pages', () => {
  it('a fresh latest page replaces what it covers (an unsent message goes) and keeps older loaded pages', () => {
    const current = [msg(1), msg(2), msg(3), msg(4)];
    // The latest page holds 3 and 4 only (2 was unsent), and there are earlier ones.
    expect(mergeLatestPage(current, [msg(3), msg(4), msg(5)], true).map((m) => m.id)).toEqual(['m001', 'm002', 'm003', 'm004', 'm005']);
    expect(mergeLatestPage(current, [msg(4), msg(5)], true).map((m) => m.id)).toEqual(['m001', 'm002', 'm003', 'm004', 'm005']);
    // A complete page (no earlier ones) is the whole thread.
    expect(mergeLatestPage(current, [msg(1), msg(4)], false).map((m) => m.id)).toEqual(['m001', 'm004']);
    expect(mergeEarlierPage([msg(3), msg(4)], [msg(1), msg(2), msg(3)]).map((m) => m.id)).toEqual(['m001', 'm002', 'm003', 'm004']);
    expect(addConfirmed([msg(1)], msg(2)).map((m) => m.id)).toEqual(['m001', 'm002']);
    expect(addConfirmed([msg(1), msg(2)], msg(2))).toHaveLength(2);
  });

  it('bubbles group runs like iMessage, and a queued message shows once (as the server\'s when confirmed)', () => {
    const messages = [msg(1), msg(2), msg(3, { mine: true, by: 'Dana K.', team: 'Dispatch', clientMutationId: 'j9' }), msg(4, { by: 'Sam L.', team: 'GCHX Base', staff: 'Sam Lee · GC/HX - Base' })];
    const bubbles = buildBubbles(messages, [job(9), job(10), job(11, { state: 'failed' })], { by: 'Dana K.', team: 'Dispatch' });
    expect(bubbles.map((b) => [b.body, b.runStart, b.runEnd, b.pending])).toEqual([
      ['Message 1', true, false, null],
      ['Message 2', false, true, null],
      ['Message 3', true, true, null],
      ['Message 4', true, true, null],
      ['Queued 10', true, false, 'sending'],
      ['Queued 11', false, true, 'failed'],
    ]);
    // En route jobs are not bubbles.
    expect(buildBubbles([], [job(1, { kind: 'enroute', body: undefined, enroute: { action: 'set', etaMinutes: 5 } })], { by: '', team: '' })).toEqual([]);
  });

  it('(T5) a run also breaks after more than 5 minutes since the bubble before it, so its time fits every bubble under it', () => {
    expect(RUN_BREAK_MS).toBe(5 * 60_000);
    const sec = (s: number) => new Date(NOW + s * 1000).toISOString();
    const runs = (messages: ThreadMessage[], queued: MessageJob[] = []) =>
      buildBubbles(messages, queued, { by: 'Dana K.', team: 'Dispatch' }).map((b) => `${b.body}:${b.runStart ? 'S' : '-'}${b.runEnd ? 'E' : '-'}`);
    // Same sender: 4 min, then exactly 5 min (still one run), then 5 min 1 s (a new run), then 1 min.
    expect(
      runs([
        msg(1, { createdAt: sec(0) }),
        msg(2, { createdAt: sec(240) }),
        msg(3, { createdAt: sec(540) }),
        msg(4, { createdAt: sec(841) }),
        msg(5, { createdAt: sec(901) }),
      ]),
    ).toEqual(['Message 1:S-', 'Message 2:--', 'Message 3:-E', 'Message 4:S-', 'Message 5:-E']);
    // My own runs break the same way; another sender still breaks at once.
    const mine = (n: number, s: number) => msg(n, { mine: true, by: 'Dana K.', team: 'Dispatch', createdAt: sec(s) });
    expect(runs([mine(1, 0), mine(2, 60), mine(3, 1_000), msg(4, { createdAt: sec(1_010) })])).toEqual(['Message 1:S-', 'Message 2:-E', 'Message 3:SE', 'Message 4:SE']);
    // A queued bubble timed by the phone before the server's last message (clocks apart) never breaks its run; one
    // queued 20 minutes after my last confirmed one starts a new run.
    expect(runs([mine(1, 600)], [job(1, { createdAt: NOW + 590_000 })])).toEqual(['Message 1:S-', 'Queued 1:-E']);
    expect(runs([mine(1, 0)], [job(1, { createdAt: NOW + 1_200_000 })])).toEqual(['Message 1:SE', 'Queued 1:SE']);
    // An unreadable time never breaks a run.
    expect(runs([msg(1, { createdAt: 'not a time' }), msg(2, { createdAt: sec(3_600) })])).toEqual(['Message 1:S-', 'Message 2:-E']);
  });

  it('the receipt sits under my latest confirmed message: Read with the time, else Delivered', () => {
    const messages = [msg(1, { mine: true }), msg(2), msg(3, { mine: true })];
    expect(receiptFor(messages, { messageId: 'm003', readAt: at(4) })).toEqual({ messageId: 'm003', readAt: at(4) });
    expect(receiptFor(messages, { messageId: 'm003', readAt: null })).toEqual({ messageId: 'm003', readAt: null });
    expect(receiptFor(messages, { messageId: 'm001', readAt: at(1) })).toEqual({ messageId: 'm003', readAt: null });
    expect(receiptFor([msg(1)], null)).toBeNull();
  });
});

describe('the message / en route outbox', () => {
  it('goes out oldest first, only for the staff who queued it, not before its retry time, never when failed', () => {
    expect(jobOrder([job(3), job(1), job(2)]).map((j) => j.id)).toEqual(['j1', 'j2', 'j3']);
    expect(jobSendable(job(1), 'Dana Kim · GC/HX - Dispatch', NOW)).toBe(true);
    expect(jobSendable(job(1), 'dana kim · dispatch', NOW)).toBe(true);
    expect(jobSendable(job(1), 'Sam Lee · GC/HX - Base', NOW)).toBe(false);
    expect(jobSendable(job(1, { nextAttemptAt: NOW + 5000 }), 'Dana Kim · GC/HX - Dispatch', NOW)).toBe(false);
    expect(jobSendable(job(1, { state: 'failed' }), 'Dana Kim · GC/HX - Dispatch', NOW)).toBe(false);
    expect(jobSendable(job(1, { state: 'sending' }), 'Dana Kim · GC/HX - Dispatch', NOW)).toBe(false);
  });

  it('classifies answers: 401 pauses, 429 waits Retry-After, a definitive 4xx fails, the rest retries', () => {
    expect(classifyJobFailure({ ok: false, kind: 'network' })).toEqual({ type: 'retry' });
    expect(classifyJobFailure({ ok: false, kind: 'timeout' })).toEqual({ type: 'retry' });
    expect(classifyJobFailure({ ok: false, kind: 'http', status: 503, error: { code: 'unavailable', message: 'x' } })).toEqual({ type: 'retry' });
    expect(classifyJobFailure({ ok: false, kind: 'http', status: 401, error: null })).toEqual({ type: 'unauthorized' });
    expect(classifyJobFailure({ ok: false, kind: 'http', status: 429, error: { code: 'rate_limited', message: 'x', retryAfterSeconds: 12 } })).toEqual({ type: 'rate_limited', retryAfterMs: 12_000 });
    expect(classifyJobFailure({ ok: false, kind: 'http', status: 422, error: { code: 'invalid', message: 'Too long' } })).toEqual({ type: 'rejected', code: 'invalid', message: 'Too long' });
    // A portal's HTML 404 is not ours: retry, never fail the message.
    expect(classifyJobFailure({ ok: false, kind: 'http', status: 404, error: null })).toEqual({ type: 'retry' });
  });

  it('reads stored jobs back ("sending" is pending again; malformed ones are dropped)', () => {
    expect(storedJob({ ...job(1), state: 'sending' })?.state).toBe('pending');
    expect(storedJob({ ...job(1), state: 'failed' })?.state).toBe('failed');
    expect(storedJob({ id: 'x' })).toBeNull();
    expect(storedJob({ ...job(1), kind: 'other' })).toBeNull();
    expect(storedJob({ ...job(1), body: undefined })).toBeNull();
    expect(storedJob({ ...job(1), kind: 'enroute', enroute: { action: 'teleport' } })).toBeNull();
  });
});

describe('optimistic en route', () => {
  const me = (action: 'set' | 'cancel' | 'arrive', minutes: number | null = null, n = 1): MessageJob =>
    job(n, { kind: 'enroute', body: undefined, enroute: { action, etaMinutes: minutes } });

  it('a queued En route shows at once (ETA from the tap), a change replaces it, a cancel removes it', () => {
    const set = effectiveEnroute(null, [me('set', 5)], NOW);
    expect(set).toMatchObject({ count: 1, state: 'enroute', mine: { etaMinutes: 5 } });
    expect(set?.earliestEta).toBe(new Date(NOW + 1000 + 5 * 60_000).toISOString());
    const server: EnrouteSummary = { count: 1, earliestEta: at(5), state: 'enroute', mine: { etaAt: at(5), etaMinutes: 5, state: 'enroute' } };
    expect(effectiveEnroute(server, [me('cancel')], NOW)).toBeNull();
    expect(effectiveEnroute(server, [me('set', 10)], NOW)).toMatchObject({ count: 1, mine: { etaMinutes: 10 } });
    expect(effectiveEnroute(server, [me('arrive')], NOW)).toMatchObject({ state: 'arrived' });
    // Someone else stays when I cancel.
    const two: EnrouteSummary = { count: 2, earliestEta: at(2), state: 'enroute', mine: { etaAt: at(5), etaMinutes: 5, state: 'enroute' } };
    expect(effectiveEnroute(two, [me('cancel')], NOW)).toMatchObject({ count: 1, mine: null });
    // The latest tap wins; one that was not delivered still shows what I asked for (with Retry under it).
    expect(effectiveEnroute(null, [me('set', 5, 1), me('cancel', null, 2)], NOW)).toBeNull();
    expect(effectiveEnroute(server, [{ ...me('cancel'), state: 'failed' }], NOW)).toBeNull();
    expect(effectiveEnroute(null, [{ ...me('set', 5), state: 'failed' }], NOW)).toMatchObject({ count: 1, state: 'enroute', mine: { etaMinutes: 5 } });
    expect(effectiveEnroute(server, [{ ...me('arrive'), state: 'failed' }], NOW)).toMatchObject({ state: 'arrived' });
    // The Undo of a cancel puts the exact ETA back.
    expect(effectiveEnroute(null, [job(1, { kind: 'enroute', body: undefined, enroute: { action: 'set', etaMinutes: 5, etaAt: at(7) } })], NOW)?.mine?.etaAt).toBe(at(7));
  });

  it('the tap that was not delivered (for "Not delivered · Retry"): the latest failed en route tap only', () => {
    expect(failedEnrouteTap([me('set', 5)])).toBeNull();
    const failed = { ...me('set', 5, 1), state: 'failed' as const };
    expect(failedEnrouteTap([failed])).toBe(failed);
    expect(failedEnrouteTap([failed, me('cancel', null, 2)])).toBe(failed);
    expect(failedEnrouteTap([{ ...job(1), state: 'failed' }])).toBeNull();
  });
});

describe('rows: carried activity and sameRow', () => {
  const withActivity = (patch: Partial<RequestSummary> = {}) =>
    makeRow(1, {
      messageCount: 2,
      lastMessageAt: at(1),
      unread: 1,
      needsInfo: true,
      lastMessage: { by: 'Rae C.', mine: false, text: 'Any tattoos or marks?' },
      enroute: null,
      involved: true,
      ...patch,
    });

  it('a mutation answer without activity keeps the client\'s; a status change ends Needs info and en route', () => {
    const before = withActivity();
    const sameStatus = makeRow(1, { rowVersion: 2, clothing: 'Blue' });
    expect(carryActivity(before, sameStatus)).toMatchObject({ messageCount: 2, unread: 1, needsInfo: true, clothing: 'Blue' });
    const answered = makeRow(1, { rowVersion: 2, status: STATUS.inMedical });
    expect(carryActivity(before, answered)).toMatchObject({ needsInfo: false, messageCount: 2 });
    const inMed = withActivity({ status: STATUS.inMedical, needsInfo: false, enroute: { count: 1, earliestEta: at(4), state: 'enroute', mine: null } });
    expect(carryActivity(inMed, makeRow(1, { rowVersion: 3, status: STATUS.reunited })).enroute).toBeNull();
    // A row that has activity is taken as it is.
    const fresh = withActivity({ rowVersion: 2, unread: 0 });
    expect(carryActivity(before, fresh)).toBe(fresh);
    expect(activityOf(makeRow(2))).toMatchObject({ messageCount: 0, unread: 0, lastMessage: null, enroute: null });
  });

  it('regression: medical\'s "Pending" on a Needs info request ends Needs info (status unchanged, the hold set), and so does its Undo', () => {
    const before = withActivity({ recheckAt: null, notFoundChecks: 0 });
    const held = makeRow(1, { rowVersion: 2, status: STATUS.waiting, recheckAt: '2026-11-07T03:20:00.000000+00:00', notFoundChecks: 1 });
    expect(carryActivity(before, held)).toMatchObject({ needsInfo: false, messageCount: 2, unread: 1 });
    const heldAsking = withActivity({ recheckAt: '2026-11-07T03:20:00.000000+00:00', notFoundChecks: 1 });
    expect(carryActivity(heldAsking, makeRow(1, { rowVersion: 3, status: STATUS.waiting, recheckAt: null, notFoundChecks: 0 }))).toMatchObject({ needsInfo: false });
    // An edit of a held request (hold unchanged) keeps it.
    expect(carryActivity(heldAsking, makeRow(1, { rowVersion: 3, status: STATUS.waiting, recheckAt: '2026-11-07T03:20:00.000000+00:00', notFoundChecks: 1, clothing: 'Red' }))).toMatchObject({ needsInfo: true });
  });

  it('a row that has activity is taken as it is (activityOf zeros)', () => {
    const before = withActivity();
    const fresh = withActivity({ rowVersion: 2, unread: 0 });
    expect(carryActivity(before, fresh)).toBe(fresh);
    expect(activityOf(makeRow(2))).toMatchObject({ messageCount: 0, unread: 0, lastMessage: null, enroute: null });
  });

  it('merging keeps the activity over a status answer, and equal activity objects keep the row', () => {
    const before = withActivity();
    const merged = mergeRows(new Map([[before.id, before]]), [makeRow(1, { rowVersion: 2, status: STATUS.inMedical })]);
    expect(merged?.get(before.id)).toMatchObject({ status: STATUS.inMedical, messageCount: 2, needsInfo: false });
    // A poll that brings the same activity in new objects changes nothing (no re-render).
    const again = withActivity({ lastMessage: { by: 'Rae C.', mine: false, text: 'Any tattoos or marks?' } });
    expect(sameRow(before, again)).toBe(true);
    expect(mergeRows(new Map([[before.id, before]]), [again])).toBeNull();
  });
});

describe('message alerts', () => {
  const base = (patch: Partial<RequestSummary> = {}) =>
    makeRow(1, {
      name: 'J. D.',
      messageCount: 1,
      lastMessageAt: at(1),
      unread: 0,
      needsInfo: false,
      lastMessage: { by: 'Dana K.', mine: true, text: 'Hi' },
      enroute: null,
      involved: true,
      ...patch,
    });

  it('a new message from someone else on a request I am involved in alerts once, never for an open thread', () => {
    const prev = new Map([[base().id, base()]]);
    const next = base({ messageCount: 2, lastMessageAt: at(2), unread: 1, lastMessage: { by: 'Rae C.', mine: false, text: 'Any tattoos or marks?' } });
    const seen = new Set<string>();
    const alerts = diffMessageAlerts(prev, [next], seen, () => false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.alert).toMatchObject({ kind: 'message', title: 'J. D.', subtitle: 'Rae C.: Any tattoos or marks?' });
    expect(alerts[0]?.alert.title).not.toMatch(/LP-/);
    expect(diffMessageAlerts(prev, [next], seen, () => false)).toHaveLength(0);
    expect(diffMessageAlerts(prev, [next], new Set(), () => true)).toHaveLength(0);
  });

  it('nothing for my own message, a request I am not involved in, a read thread, or a row new to this phone', () => {
    const prev = new Map([[base().id, base()]]);
    const other = { by: 'Rae C.', mine: false, text: 'x' };
    expect(diffMessageAlerts(prev, [base({ lastMessageAt: at(2), messageCount: 2, unread: 0, lastMessage: { ...other, mine: true } })], new Set(), () => false)).toHaveLength(0);
    expect(diffMessageAlerts(prev, [base({ lastMessageAt: at(2), unread: 1, lastMessage: other, involved: false })], new Set(), () => false)).toHaveLength(0);
    expect(diffMessageAlerts(prev, [base({ lastMessageAt: at(2), unread: 0, lastMessage: other })], new Set(), () => false)).toHaveLength(0);
    expect(diffMessageAlerts(new Map(), [base({ lastMessageAt: at(2), unread: 1, lastMessage: other })], new Set(), () => false)).toHaveLength(0);
    // An unsend makes the latest older: no alert.
    const prev2 = new Map([[base().id, base({ lastMessageAt: at(5) })]]);
    expect(diffMessageAlerts(prev2, [base({ lastMessageAt: at(2), unread: 1, lastMessage: other })], new Set(), () => false)).toHaveLength(0);
  });
});

describe('labels come from STATUS_META', () => {
  it('nothing in lib/messaging.ts hard-codes a status label', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../lib/messaging.ts', import.meta.url), 'utf8');
    for (const meta of Object.values(STATUS_META)) {
      for (const label of [meta.label, meta.shortLabel]) {
        expect(src.includes(`'${label}'`), label).toBe(false);
      }
    }
  });
});
