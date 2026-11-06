// RequestForm markup per mode and state (server render over the stub store): "Choose post" blocks Send,
// Send needs a detail (a photo counts), the offline label, every group open in Jeffrey's order, free-text
// age and gender (the gender chips), the sections of edit, the read-only outbox job and field errors.
// Interaction (chips, picker, draft, keyboard) is covered by tests/e2e/new-request.spec.ts.
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RequestForm, type RequestFormProps } from '@/components/request-form/RequestForm';
import { EMPTY_FORM_VALUES, canSend, type RequestFormValues } from '@/lib/client/form-values';
import { StoreContext, type DraftPhoto } from '@/lib/client/store-contract';
import { createStubStore } from '@/lib/client/store-stub';
import { LIMITS } from '@/lib/domain';

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

const v = (patch: Partial<RequestFormValues> = {}): RequestFormValues => ({ ...EMPTY_FORM_VALUES, ...patch });
const submitTag = (html: string) => /<button[^>]*data-testid="request-form-submit"[^>]*>/.exec(html)?.[0] ?? '';
const photo = (id: string): DraftPhoto => ({ photoId: id, blob: new Blob(['x']), thumbBlob: new Blob(['x']), width: 0, height: 0 });
/** The <input> whose id ends in `-<key>` (useId prefixes every id). */
const inputTag = (html: string, key: string) => new RegExp(`<input id="[^"]*-${key}"[^>]*>`).exec(html)?.[0] ?? '';
/** The gender quick-fill chip with this label. */
const chipTag = (html: string, label: string) =>
  new RegExp(`<button[^>]*class="[^"]*lp-rf-chip[^"]*"[^>]*>(?:(?!</button>).)*${label}</button>`).exec(html)?.[0] ?? '';
/** Text positions, to check the order groups and rows render in. */
const order = (html: string, texts: string[]) => texts.map((t) => html.indexOf(t));
const ascending = (positions: number[]) => positions.every((p, i) => p >= 0 && (i === 0 || p > (positions[i - 1] as number)));

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

  it('lays out the rows with 16 px inputs and the placeholders from the spec', () => {
    const html = render();
    for (const text of [
      'Name or initials, e.g. J.D.',
      'Age, e.g. 24 or mid-20s',
      'placeholder="Gender"',
      'Clothing, colors, accessories',
      'Where, roughly when',
      'Height, build',
      'Tattoos, piercings, glasses',
      "Who&#x27;s looking",
      'Phone number',
      'Friend, partner, sibling…',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('type="tel"');
    expect(html).toContain('accept="image/*"');
    expect(html).toContain('multiple=""');
    // Stage chips only appear while Last seen has focus.
    expect(html).not.toContain('kineticFIELD');
  });

  it('shows every group open, in order: post, missing person, more details, friend or family (optional) last', () => {
    const html = render();
    // No disclosure row: nothing is collapsed and nothing needs a tap to show.
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('lp-rf-more');
    expect(ascending(order(html, ['Reporting from', '>Missing person<', '>More details<', '>Friend or family']))).toBe(true);
    // Missing person: the ID card, then Wearing and Last seen.
    expect(ascending(order(html, ['-name"', '-age"', '-gender"', '>Wearing<', '>Last seen<']))).toBe(true);
    // More details: Hair, Build, Features, Description, Other notes.
    expect(ascending(order(html, ['>Hair<', '>Build<', '>Features<', '>Description<', '>Other notes<', '>Friend or family']))).toBe(true);
    // Friend or family: Name, Phone, Relation, Notes, and it is the last group.
    expect(ascending(order(html, ['>Friend or family', "Who&#x27;s looking", 'Phone number', '>Relation<', '>Notes<']))).toBe(true);
    expect(html).not.toContain('Contact notes');
    // Optional is said once, in the section label: a badge, no helper sentence.
    expect(html).toMatch(/>Friend or family(?:<!-- -->)? <span[^>]*class="[^"]*lp-rf-optional[^"]*"[^>]*>Optional<\/span>/);
    expect(html.match(/Optional/g)).toHaveLength(1);
  });

  it('takes age as free text with the normal keyboard', () => {
    const age = inputTag(render({ values: v({ age: 'mid-20s' }) }), 'age');
    expect(age).toContain('value="mid-20s"');
    expect(age).toContain('type="text"');
    expect(age).not.toContain('inputMode');
    expect(age).not.toContain('pattern');
    expect(age).not.toContain('aria-invalid');
    expect(age).toContain(`maxLength="${LIMITS.age}"`);
  });

  it('takes gender as free text, with Male / Female / Other chips that fill it', () => {
    const typed = render({ values: v({ gender: 'Non-binary' }) });
    expect(inputTag(typed, 'gender')).toContain('value="Non-binary"');
    expect(inputTag(typed, 'gender')).toContain(`maxLength="${LIMITS.gender}"`);
    for (const chip of ['Male', 'Female', 'Other']) expect(chipTag(typed, chip)).toContain('aria-pressed="false"');
    expect(typed).toContain('aria-label="Fill in gender"');

    // The chip matching the text (any case) is on, with a check.
    const female = render({ values: v({ gender: 'female' }) });
    expect(chipTag(female, 'Female')).toContain('aria-pressed="true"');
    expect(chipTag(female, 'Female')).toContain('<svg');
    expect(chipTag(female, 'Male')).toContain('aria-pressed="false"');
    expect(chipTag(female, 'Male')).not.toContain('<svg');
  });

  it('marks a valid phone with a check, and takes any other phone text as it is', () => {
    expect(render({ values: v({ contactPhone: '(407) 555-0142' }) })).toContain('aria-label="Valid number"');
    const short = render({ values: v({ contactPhone: '555-0142 ext 2' }) });
    expect(short).not.toContain('aria-label="Valid number"');
    expect(inputTag(short, 'contactPhone')).toContain('value="555-0142 ext 2"');
    expect(inputTag(short, 'contactPhone')).not.toContain('aria-invalid');
  });

  it('switches to Save offline with the offline banner', () => {
    const html = render({ offline: true, submitLabel: 'Save offline' });
    expect(html).toContain('Offline · <!-- -->0<!-- --> waiting to send');
    expect(html).toContain('Save offline');
  });

  it('shows the duplicate hint chip after the missing person, before More details', () => {
    const html = render({ duplicateOf: { id: 'x', caseNumber: 1009 } });
    expect(html).toContain('Similar open request: <!-- -->LP-1009');
    expect(ascending(order(html, ['>Last seen<', 'Similar open request', '>More details<']))).toBe(true);
  });
});

describe('RequestForm (edit sections)', () => {
  const values = v({ name: 'TEST-F Kayla', age: 'mid-20s', contactName: 'TEST-F Maya', contactNotes: 'After 11', reportingLocation: 'FA 4 – Oasis' });

  it('person: the person group with labelled rows, then More details open; no post, no friend, no photo slot', () => {
    const html = render({ mode: 'edit', section: 'person', values, submitLabel: 'Save' });
    expect(html).toContain('Missing person');
    expect(html).not.toContain('Friend or family');
    expect(html).not.toContain('Reporting from');
    expect(html).not.toContain('lp-rf-slot');
    expect(html).not.toContain('aria-expanded');
    for (const label of ['Name', 'Age', 'Gender']) expect(html).toMatch(new RegExp(`<label class="lp-rf-k"[^>]*>${label}</label>`));
    expect(inputTag(html, 'age')).toContain('value="mid-20s"');
    expect(html).toContain('e.g. 24 or mid-20s');
    expect(html).toMatch(/class="lp-rf-gq" data-indent=""/);
    expect(ascending(order(html, ['>Missing person<', '>Last seen<', '>More details<', '>Hair<', '>Other notes<']))).toBe(true);
  });

  it('friend: the friend group with contact notes, nothing else', () => {
    const html = render({ mode: 'edit', section: 'friend', values, submitLabel: 'Save' });
    expect(html).toContain('Friend or family');
    expect(html).toContain('>Notes</label>');
    expect(html).not.toContain('Missing person');
    expect(html).not.toContain('More details');
    expect(html).not.toContain('Optional');
  });

  it('all: post, then the groups in the create order; a legacy post shows as it is', () => {
    const html = render({ mode: 'edit', section: 'all', values: { ...values, reportingLocation: '' }, legacyPost: 'FA 3', submitLabel: 'Save' });
    expect(html).toContain('>FA 3</span>');
    expect(html).not.toContain('Choose post');
    expect(ascending(order(html, ['Reporting from', '>Missing person<', '>More details<', '>Friend or family', '>Notes<']))).toBe(true);
    expect(html).not.toContain('aria-expanded');
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

  it('points at a rejected age or gender, and at a field in More details without a tap', () => {
    const html = render({
      mode: 'outbox',
      values: v({ age: 'TEST-F long age', gender: 'TEST-F long gender', hair: 'x' }),
      errors: { age: 'TEST-F age error', gender: 'TEST-F gender error', hair: 'TEST-F hair error' },
      submitLabel: 'Resend',
    });
    expect(inputTag(html, 'age')).toContain('aria-invalid="true"');
    expect(inputTag(html, 'gender')).toContain('aria-invalid="true"');
    expect(inputTag(html, 'hair')).toContain('aria-invalid="true"');
    for (const message of ['TEST-F age error', 'TEST-F gender error', 'TEST-F hair error']) expect(html).toContain(message);
  });

  it('shows the job photos read-only', () => {
    const html = render({ mode: 'outbox', photos: [photo('a')], submitLabel: 'Resend' });
    expect(html).toContain('data-readonly=""');
    expect(html).not.toContain('type="file"');
    expect(html).toMatch(/class="lp-rf-when"[^>]*disabled=""/);
  });

  it('read-only job: inputs and gender chips cannot change', () => {
    const html = render({ mode: 'outbox', readOnly: true, values: v({ name: 'TEST-F y', gender: 'Male' }), submitLabel: 'Send now' });
    expect(html).toMatch(/<input id="[^"]*-name"[^>]*readOnly=""[^>]*value="TEST-F y"/);
    expect(inputTag(html, 'gender')).toContain('readOnly=""');
    expect(html).toMatch(/class="lp-rf-loc"[^>]*disabled=""/);
    for (const chip of ['Male', 'Female', 'Other']) expect(chipTag(html, chip)).toContain('disabled=""');
  });
});
