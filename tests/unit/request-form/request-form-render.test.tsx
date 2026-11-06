// RequestForm markup per mode and state (server render over the stub store): "Choose post" blocks Send,
// Send needs a detail (a photo counts), the offline label, the sections of edit, the read-only outbox
// job and field errors. Interaction (chips, picker, draft) is covered by tests/e2e/new-request.spec.ts.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RequestForm, type RequestFormProps } from '@/components/request-form/RequestForm';
import { EMPTY_FORM_VALUES, canSend, type RequestFormValues } from '@/lib/client/form-values';
import { StoreContext, type DraftPhoto } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';

const noop = () => undefined;

function render(overrides: Partial<RequestFormProps> = {}): string {
  const values = overrides.values ?? EMPTY_FORM_VALUES;
  const photos = overrides.photos ?? [];
  const props: RequestFormProps = {
    mode: 'create',
    section: 'all',
    values,
    onChange: noop,
    photos,
    onPhotosChange: noop,
    photoTiming: 'today',
    onPhotoTimingChange: noop,
    offline: false,
    busy: false,
    submitLabel: 'Send request',
    submitDisabled: !canSend(values, photos.length),
    onSubmit: noop,
    onCancel: noop,
    ...overrides,
  };
  const store = createStubStore({ eventTimezone: 'America/New_York', empty: true });
  return renderToString(
    <StoreContext.Provider value={store}>
      <RequestForm {...props} />
    </StoreContext.Provider>,
  );
}

const v = (patch: Partial<RequestFormValues>): RequestFormValues => ({ ...EMPTY_FORM_VALUES, ...patch });
const submitTag = (html: string) => /<button[^>]*data-testid="request-form-submit"[^>]*>/.exec(html)?.[0] ?? '';
const photo = (id: string): DraftPhoto => ({ photoId: id, blob: new Blob(['x']), thumbBlob: new Blob(['x']), width: 0, height: 0 });

describe('RequestForm (create)', () => {
  it('asks for a post first and blocks Send without one', () => {
    const html = render({ values: v({ name: 'TEST-F T.R.' }) });
    expect(html).toContain('Choose post');
    expect(html).toContain('data-empty=""');
    expect(submitTag(html)).toContain('disabled');
  });

  it('shows the remembered post and enables Send once a detail is in', () => {
    const empty = render({ values: v({ reportingLocation: 'FA 3 – Kinetic' }) });
    expect(empty).toContain('FA 3 – Kinetic');
    expect(empty).not.toContain('Choose post');
    expect(submitTag(empty)).toContain('disabled');

    const filled = render({ values: v({ reportingLocation: 'FA 3 – Kinetic', clothing: 'Red hoodie' }) });
    expect(submitTag(filled)).not.toContain('disabled');
  });

  it('counts a photo as a detail and shows the count badge and timing tag', () => {
    const html = render({ values: v({ reportingLocation: 'Base' }), photos: [photo('a'), photo('b')] });
    expect(submitTag(html)).not.toContain('disabled');
    expect(html).toContain('class="lp-rf-cnt"');
    expect(html).toMatch(/<span class="lp-rf-cnt"[^>]*>2<\/span>/);
    expect(html).toContain('>Today</span>');
  });

  it('shows the Other location as the post', () => {
    expect(render({ values: v({ reportingLocation: 'Other', otherLocation: 'Info booth', name: 'X' }) })).toContain('Info booth');
  });

  it('lays out the mockup rows with 16 px inputs and the placeholders from the spec', () => {
    const html = render();
    for (const text of ['Name or initials, e.g. J.D.', 'Clothing, colors, accessories', 'Where, roughly when', "Who&#x27;s looking", 'Phone number', 'Friend, partner, sibling…']) {
      expect(html).toContain(text);
    }
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('pattern="[0-9]*"');
    expect(html).toContain('type="tel"');
    expect(html).toContain('accept="image/*"');
    expect(html).toContain('multiple=""');
    // Stage chips only appear while Last seen has focus.
    expect(html).not.toContain('kineticFIELD');
    // More details starts closed when its fields are empty.
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('Tattoos, piercings, glasses');
  });

  it('marks a valid phone with a check', () => {
    expect(render({ values: v({ contactPhone: '(407) 555-0142' }) })).toContain('aria-label="Valid number"');
    expect(render({ values: v({ contactPhone: '555-0142' }) })).not.toContain('aria-label="Valid number"');
  });

  it('opens More details when one of its fields has text', () => {
    const html = render({ values: v({ hair: 'Blond, two braids' }) });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Tattoos, piercings, glasses');
  });

  it('switches to Save offline with the offline banner', () => {
    const html = render({ offline: true, submitLabel: 'Save offline' });
    expect(html).toContain('Offline · <!-- -->0<!-- --> waiting to send');
    expect(html).toContain('Save offline');
  });

  it('shows the duplicate hint chip', () => {
    expect(render({ duplicateOf: { id: 'x', caseNumber: 1009 } })).toContain('Similar open request: <!-- -->LP-1009');
  });
});

describe('RequestForm (edit sections)', () => {
  const values = v({ name: 'TEST-F Kayla', contactName: 'TEST-F Maya', contactNotes: 'After 11', reportingLocation: 'FA 4 – Oasis' });

  it('person: the person group with labelled rows, no post, no friend, no photo slot', () => {
    const html = render({ mode: 'edit', section: 'person', values, submitLabel: 'Save' });
    expect(html).toContain('Missing person');
    expect(html).not.toContain('Friend or family');
    expect(html).not.toContain('Reporting from');
    expect(html).not.toContain('lp-rf-slot');
    expect(html).toMatch(/<label class="lp-rf-k"[^>]*>Name<\/label>/);
  });

  it('friend: the friend group with contact notes, nothing else', () => {
    const html = render({ mode: 'edit', section: 'friend', values, submitLabel: 'Save' });
    expect(html).toContain('Friend or family');
    expect(html).toContain('>Notes</label>');
    expect(html).not.toContain('Missing person');
    expect(html).not.toContain('More details');
  });

  it('all: post, both groups and More details; a legacy post shows as it is', () => {
    const html = render({ mode: 'edit', section: 'all', values: { ...values, reportingLocation: '' }, legacyPost: 'FA 3', submitLabel: 'Save' });
    expect(html).toContain('Reporting from');
    expect(html).toContain('>FA 3</span>');
    expect(html).not.toContain('Choose post');
    expect(html).toContain('More details');
  });
});

describe('RequestForm (needs-attention editor)', () => {
  it('points at the rejected field', () => {
    const html = render({ mode: 'outbox', values: v({ name: 'TEST-F x' }), errors: { name: 'Must be 120 characters or fewer' }, submitLabel: 'Resend', onDiscard: noop });
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('Must be 120 characters or fewer');
    expect(html).toContain('Discard');
    expect(html).toContain('Resend');
  });

  it('shows the job photos read-only', () => {
    const html = render({ mode: 'outbox', photos: [photo('a')], submitLabel: 'Resend' });
    expect(html).toContain('data-readonly=""');
    expect(html).not.toContain('type="file"');
    expect(html).toMatch(/class="lp-rf-when"[^>]*disabled=""/);
  });

  it('read-only job: inputs cannot change', () => {
    const html = render({ mode: 'outbox', readOnly: true, values: v({ name: 'TEST-F y' }), submitLabel: 'Send now' });
    expect(html).toMatch(/<input id="[^"]*-name"[^>]*readOnly=""[^>]*value="TEST-F y"/);
    expect(html).toMatch(/class="lp-rf-loc"[^>]*disabled=""/);
    expect(html).toMatch(/rt-SegmentedControlRoot[^"]*disabled/);
  });
});
