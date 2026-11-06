'use client';
// The request form body (new-request.html v3): Cancel + title top bar, "Reporting from" row, the ID card
// (photo slot, Name, Age, Gender), Wearing, Last seen (+ stage chips while focus is within the row), Friend
// or family, More details, and the sticky Send button. Controlled: RequestFormView owns the values, the
// draft and the store calls. Full-screen and scrolls whenever the content doesn't fit.
import { Button, Heading, SegmentedControl, Text } from '@radix-ui/themes';
import { ArrowUpRight, Check, ChevronDown, ChevronUp, CloudOff, MapPin, UserRoundSearch } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { navigate } from '@/lib/client/nav';
import { visibleOutbox } from '@/lib/client/selectors';
import { useStoreSelector, type DraftPhoto, type StoreState } from '@/lib/client/store-contract';
import type { RequestFormValues } from '@/lib/client/form-values';
import {
  GENDERS,
  LIMITS,
  OTHER_POST,
  STAGE_CHIPS,
  isValidPhone,
  postFull,
  type EditSection,
  type Gender,
  type PhotoTiming,
} from '@/lib/domain';
import { formatCaseNumber } from '@/lib/format';
import { lastSeenWithChip, moreFieldsFor, moreStartsOpen, sanitizeAge, type MoreField } from './form-logic';
import { PhotoSlot } from './PhotoSlot';
import { PostPicker, type PostChoice } from './PostPicker';
import './request-form.css';

export type RequestFormMode = 'create' | 'edit' | 'outbox';

export interface RequestFormProps {
  mode: RequestFormMode;
  /** Which groups to show: 'all' for create / outbox; edit may show only 'person' or 'friend' (A24). */
  section: EditSection;
  values: RequestFormValues;
  onChange: (values: RequestFormValues) => void;
  /**
   * create: the photos chosen in this form (editable). outbox: the job's photos, shown READ-ONLY (no add,
   * remove or timing toggle; onPhotosChange / onPhotoTimingChange are never called) because
   * store.outbox.update() replaces only the payload; to change photos, discard the job and log it again.
   * The view maps OutboxPhoto → DraftPhoto (width/height 0). edit: unused, photos are added from the profile.
   */
  photos: readonly DraftPhoto[];
  onPhotosChange: (photos: DraftPhoto[]) => void;
  photoTiming: PhotoTiming;
  onPhotoTimingChange: (timing: PhotoTiming) => void;
  /** Turns the button into "Save offline" and shows the offline banner (create only). */
  offline: boolean;
  /** A send / save is in flight. */
  busy: boolean;
  /** Banner above the form, e.g. the 409 review: "Someone else just updated this…". */
  notice?: ReactNode;
  /**
   * Field-level errors to show on the matching inputs, e.g. the server's rejection of a needs-attention
   * item (OutboxItem.lastError.field + message) or a 422 on edit. Keys are RequestFormValues keys.
   */
  errors?: Partial<Record<keyof RequestFormValues, string>>;
  /** "Similar open request: LP-1009" (informational; links to the profile). */
  duplicateOf?: { id: string; caseNumber: number } | null;
  /** "Send request", "Save offline", "Save", "Resend". */
  submitLabel: string;
  submitDisabled: boolean;
  onSubmit: () => void;
  onCancel: () => void;

  // Added in Phase 2 (all optional).
  /** Top bar title; defaults by mode ("New request", "Edit details", "Not sent"). */
  title?: string;
  /** The needs-attention editor's Discard button (left of the submit button). */
  onDiscard?: () => void;
  /** A post was picked in the sheet (create remembers it as the last post). */
  onPostPicked?: (choice: PostChoice) => void;
  /** Edit: a legacy post value the form can't express, shown until another post is picked. */
  legacyPost?: string | null;
  /** Show the values without letting them change (an outbox job that is still waiting or sending). */
  readOnly?: boolean;
}

const DEFAULT_TITLE: Readonly<Record<RequestFormMode, string>> = {
  create: 'New request',
  edit: 'Edit details',
  outbox: 'Not sent',
};

const MORE_ROWS: Readonly<Record<MoreField, { label: string; placeholder: string; multiline: boolean; max: number }>> = {
  hair: { label: 'Hair', placeholder: '', multiline: false, max: LIMITS.hair },
  heightBuild: { label: 'Build', placeholder: 'Height, build', multiline: false, max: LIMITS.heightBuild },
  identifyingFeatures: { label: 'Features', placeholder: 'Tattoos, piercings, glasses', multiline: false, max: LIMITS.identifyingFeatures },
  physicalDescription: { label: 'Description', placeholder: '', multiline: true, max: LIMITS.physicalDescription },
  contactNotes: { label: 'Contact notes', placeholder: '', multiline: true, max: LIMITS.contactNotes },
  additionalNotes: { label: 'Other notes', placeholder: '', multiline: true, max: LIMITS.additionalNotes },
};

const selectOutboxCount = (s: StoreState) => visibleOutbox(s.outbox, s.confirmed).length;

/** Pointer slop for a chip tap: a drag that starts on a chip (a scroll) never appends. */
const TAP_SLOP_PX = 10;

export function RequestForm(props: RequestFormProps) {
  const { mode, section, values, errors = {}, busy } = props;
  const readOnly = !!props.readOnly;
  const locked = busy || readOnly;
  const onChange = (next: RequestFormValues) => {
    if (!readOnly) props.onChange(next);
  };
  const uid = useId();
  const id = (key: string) => `${uid}-${key}`;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(() => moreStartsOpen(values, section));
  const [lastSeenFocus, setLastSeenFocus] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollToMore = useRef(false);
  const chipDown = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const outboxCount = useStoreSelector(selectOutboxCount);

  const set = <K extends keyof RequestFormValues>(key: K, value: RequestFormValues[K]) => onChange({ ...values, [key]: value });

  const moreFields = moreFieldsFor(section);
  const showMore = moreOpen || moreFields.some((k) => !!errors[k]);
  // Opening "More details" scrolls just enough to show the new rows (never past their top).
  useEffect(() => {
    if (!showMore || !scrollToMore.current) return;
    scrollToMore.current = false;
    const scroller = scrollRef.current;
    const group = moreRef.current;
    if (!scroller || !group) return;
    const view = scroller.getBoundingClientRect();
    const box = group.getBoundingClientRect();
    const delta = Math.min(box.bottom + 16 - view.bottom, box.top - 8 - view.top);
    if (delta > 0) scroller.scrollBy({ top: delta, behavior: 'smooth' });
  }, [showMore]);

  const err = (key: keyof RequestFormValues) => errors[key];
  const errId = (key: string) => id(`err-${key}`);
  const invalid = (key: keyof RequestFormValues) =>
    err(key) ? { 'aria-invalid': true as const, 'aria-describedby': errId(key) } : {};
  const errLine = (key: keyof RequestFormValues, indent = true) =>
    err(key) ? (
      <span id={errId(key)} className="lp-rf-err" data-indent={indent ? '' : undefined} role="alert">
        {err(key)}
      </span>
    ) : null;

  // ---- Stage chips: pointerdown + preventDefault keeps focus in Last seen (so the chips stay and the tap
  // isn't lost); the chip applies on pointerup within the tap slop; a keyboard click (detail 0) also works.
  const appendStage = (chip: string) => set('lastSeen', lastSeenWithChip(values.lastSeen, chip, LIMITS.lastSeen));
  const chipHandlers = (chip: string) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      chipDown.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    },
    onPointerUp: (e: PointerEvent<HTMLButtonElement>) => {
      const down = chipDown.current;
      chipDown.current = null;
      if (!down || down.pointerId !== e.pointerId) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > TAP_SLOP_PX) return;
      appendStage(chip);
    },
    onPointerCancel: () => {
      chipDown.current = null;
    },
    onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault(),
    onClick: (e: { detail: number }) => {
      if (e.detail === 0) appendStage(chip);
    },
  });

  // ---- Enter moves to the next field (never submits: Send is the only way to send).
  const onFormKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    if (target.tagName !== 'INPUT' || !target.classList.contains('lp-rf-in')) return;
    e.preventDefault();
    const fields = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('.lp-rf-in'));
    const next = fields[fields.indexOf(target) + 1];
    if (next) next.focus();
    else target.blur();
  };

  // ---- Post
  const postLabel = values.reportingLocation ? postFull(values.reportingLocation, values.otherLocation) : (props.legacyPost ?? '');
  const postMissing = !postLabel;
  const postError = err('reportingLocation') ?? err('otherLocation');
  const postValue: PostChoice | null = values.reportingLocation
    ? {
        reportingLocation: values.reportingLocation,
        otherLocation: values.reportingLocation === OTHER_POST ? values.otherLocation : null,
      }
    : null;

  const photoSlot =
    mode === 'edit' || (mode === 'outbox' && props.photos.length === 0) ? null : (
      <PhotoSlot
        photos={props.photos}
        onPhotosChange={mode === 'outbox' ? undefined : props.onPhotosChange}
        timing={props.photoTiming}
        onTimingChange={mode === 'outbox' ? undefined : props.onPhotoTimingChange}
        readOnly={mode === 'outbox'}
        disabled={locked}
      />
    );

  // Without the photo slot (edit) the card is a plain group, so its rows get labels like the others.
  const labelled = photoSlot === null;
  const phoneValid = isValidPhone(values.contactPhone);
  const title = props.title ?? DEFAULT_TITLE[mode];

  return (
    <div className="lp-rf" data-mode={mode} data-testid="request-form">
      <header className="lp-rf-nav">
        <Button type="button" variant="ghost" color="gray" size="2" onClick={props.onCancel} disabled={busy}>
          Cancel
        </Button>
        <Heading as="h1" size="3" weight="medium" className="lp-rf-title">
          {title}
        </Heading>
        <span aria-hidden />
      </header>

      {props.offline ? (
        <div className="lp-rf-bar">
          <div className="lp-rf-off" role="status">
            <CloudOff size={16} strokeWidth={1.75} aria-hidden />
            Offline · {outboxCount} waiting to send
          </div>
        </div>
      ) : null}

      <div className="lp-rf-scroll" ref={scrollRef}>
        <form className="lp-rf-body" noValidate onSubmit={(e) => e.preventDefault()} onKeyDown={onFormKeyDown} aria-label={title}>
          {props.notice ? <div className="lp-rf-notice">{props.notice}</div> : null}

          {section === 'all' ? (
            <>
              <button
                type="button"
                className="lp-rf-loc"
                data-empty={postMissing ? '' : undefined}
                data-invalid={postError ? '' : undefined}
                aria-haspopup="dialog"
                aria-label={postMissing ? 'Reporting from: choose post' : `Reporting from ${postLabel}. Change`}
                aria-describedby={postError ? errId('post') : undefined}
                onClick={() => setPickerOpen(true)}
                disabled={locked}
              >
                <span className="lp-rf-pin">
                  <MapPin size={18} strokeWidth={1.75} aria-hidden />
                </span>
                <span className="lp-rf-lv">
                  <Text size="1" color="gray">
                    Reporting from
                  </Text>
                  <Text size="3" weight="medium" color={postMissing ? 'amber' : undefined}>
                    {postMissing ? 'Choose post' : postLabel}
                  </Text>
                </span>
                <span className="lp-rf-chev">
                  <ChevronDown size={18} strokeWidth={1.75} aria-hidden />
                </span>
              </button>
              {postError ? (
                <span id={errId('post')} className="lp-rf-err" role="alert" style={{ padding: '6px 4px 0', margin: 0 }}>
                  {postError}
                </span>
              ) : null}
            </>
          ) : null}

          {section !== 'friend' ? (
            <>
              <Text as="div" size="2" weight="medium" color="gray" className="lp-rf-lbl">
                Missing person
              </Text>
              <div className="lp-rf-grp">
                <div className="lp-rf-pcard">
                  {photoSlot}
                  <div className="lp-rf-pc">
                    <div className="lp-rf-field">
                      <div className="lp-rf-r">
                        {labelled ? (
                          <label className="lp-rf-k" htmlFor={id('name')}>
                            Name
                          </label>
                        ) : null}
                        <input
                          id={id('name')}
                          className="lp-rf-in"
                          aria-label={labelled ? undefined : 'Name'}
                          placeholder="Name or initials, e.g. J.D."
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="words"
                          spellCheck={false}
                          enterKeyHint="next"
                          maxLength={LIMITS.name}
                          readOnly={readOnly}
                          value={values.name}
                          onChange={(e) => set('name', e.currentTarget.value)}
                          {...invalid('name')}
                        />
                      </div>
                      {errLine('name', labelled)}
                    </div>
                    <div className="lp-rf-field">
                      <div className="lp-rf-r">
                        {labelled ? (
                          <label className="lp-rf-k" htmlFor={id('age')}>
                            Age
                          </label>
                        ) : null}
                        <input
                          id={id('age')}
                          className="lp-rf-in"
                          aria-label={labelled ? undefined : 'Age'}
                          placeholder={labelled ? '' : 'Age'}
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          autoComplete="off"
                          enterKeyHint="next"
                          maxLength={3}
                          readOnly={readOnly}
                          value={values.age}
                          onChange={(e) => set('age', sanitizeAge(e.currentTarget.value))}
                          {...invalid('age')}
                        />
                      </div>
                      {errLine('age', labelled)}
                    </div>
                    <div className="lp-rf-r">
                      {labelled ? (
                        <span className="lp-rf-k" aria-hidden>
                          Gender
                        </span>
                      ) : null}
                      <SegmentedControl.Root
                        className="lp-rf-seg"
                        size="1"
                        value={values.gender}
                        onValueChange={(v) => set('gender', v as Gender)}
                        aria-label="Gender"
                        disabled={readOnly}
                      >
                        {GENDERS.map((g) => (
                          <SegmentedControl.Item
                            key={g}
                            value={g}
                            // Tapping the chosen gender again clears it (Radix keeps one selected).
                            onClick={() => {
                              if (values.gender === g) set('gender', '');
                            }}
                          >
                            {g}
                          </SegmentedControl.Item>
                        ))}
                      </SegmentedControl.Root>
                    </div>
                  </div>
                </div>
                <div className="lp-rf-field">
                  <div className="lp-rf-r" data-top="">
                    <label className="lp-rf-k" htmlFor={id('clothing')}>
                      Wearing
                    </label>
                    <AutoTextarea
                      id={id('clothing')}
                      className="lp-rf-in"
                      rows={2}
                      placeholder="Clothing, colors, accessories"
                      maxLength={LIMITS.clothing}
                      readOnly={readOnly}
                      value={values.clothing}
                      onChange={(e) => set('clothing', e.currentTarget.value)}
                      {...invalid('clothing')}
                    />
                  </div>
                  {errLine('clothing')}
                </div>
                <div
                  className="lp-rf-ls"
                  data-focus={lastSeenFocus ? '' : undefined}
                  onFocus={() => setLastSeenFocus(true)}
                  onBlur={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setLastSeenFocus(false);
                  }}
                >
                  <div className="lp-rf-r">
                    <label className="lp-rf-k" htmlFor={id('lastSeen')}>
                      Last seen
                    </label>
                    <input
                      id={id('lastSeen')}
                      className="lp-rf-in"
                      placeholder="Where, roughly when"
                      autoComplete="off"
                      enterKeyHint="next"
                      maxLength={LIMITS.lastSeen}
                      readOnly={readOnly}
                      value={values.lastSeen}
                      onChange={(e) => set('lastSeen', e.currentTarget.value)}
                      {...invalid('lastSeen')}
                    />
                  </div>
                  {errLine('lastSeen')}
                  {lastSeenFocus && !readOnly ? (
                    <div className="lp-rf-sugg" role="group" aria-label="Add a place to Last seen">
                      {STAGE_CHIPS.map((chip) => (
                        <Button
                          key={chip}
                          type="button"
                          size="1"
                          variant="soft"
                          color="gray"
                          radius="full"
                          className="lp-rf-chip"
                          {...chipHandlers(chip)}
                        >
                          {chip}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
              {props.duplicateOf ? (
                <Button
                  type="button"
                  size="1"
                  variant="soft"
                  color="amber"
                  radius="full"
                  className="lp-rf-dup"
                  onClick={() => navigate({ r: props.duplicateOf?.id })}
                >
                  <UserRoundSearch size={14} strokeWidth={1.75} aria-hidden />
                  Similar open request: {formatCaseNumber(props.duplicateOf.caseNumber)}
                  <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden />
                </Button>
              ) : null}
            </>
          ) : null}

          {section !== 'person' ? (
            <>
              <Text as="div" size="2" weight="medium" color="gray" className="lp-rf-lbl">
                Friend or family
              </Text>
              <div className="lp-rf-grp">
                <TextRow
                  inputId={id('contactName')}
                  label="Name"
                  placeholder="Who's looking"
                  max={LIMITS.contactName}
                  value={values.contactName}
                  onChange={(v) => set('contactName', v)}
                  readOnly={readOnly}
                  error={err('contactName')}
                  errorId={errId('contactName')}
                />
                <TextRow
                  inputId={id('contactPhone')}
                  label="Phone"
                  placeholder="Phone number"
                  type="tel"
                  inputMode="tel"
                  max={LIMITS.contactPhone}
                  value={values.contactPhone}
                  onChange={(v) => set('contactPhone', v)}
                  readOnly={readOnly}
                  error={err('contactPhone')}
                  errorId={errId('contactPhone')}
                  trailing={
                    phoneValid ? (
                      <span className="lp-rf-ok" role="img" aria-label="Valid number">
                        <Check size={16} strokeWidth={1.75} aria-hidden />
                      </span>
                    ) : null
                  }
                />
                <TextRow
                  inputId={id('contactRelationship')}
                  label="Relation"
                  placeholder="Friend, partner, sibling…"
                  max={LIMITS.contactRelationship}
                  value={values.contactRelationship}
                  onChange={(v) => set('contactRelationship', v)}
                  readOnly={readOnly}
                  error={err('contactRelationship')}
                  errorId={errId('contactRelationship')}
                />
                {section === 'friend' ? (
                  <TextRow
                    inputId={id('contactNotes')}
                    label="Notes"
                    placeholder=""
                    multiline
                    max={LIMITS.contactNotes}
                    value={values.contactNotes}
                    onChange={(v) => set('contactNotes', v)}
                    readOnly={readOnly}
                    error={err('contactNotes')}
                    errorId={errId('contactNotes')}
                  />
                ) : null}
              </div>
            </>
          ) : null}

          {moreFields.length > 0 ? (
            <>
              <button
                type="button"
                className="lp-rf-more"
                aria-expanded={showMore}
                aria-controls={id('more')}
                onClick={() => {
                  scrollToMore.current = !showMore;
                  setMoreOpen(!showMore);
                }}
              >
                <span>More details</span>
                <span className="lp-rf-sp" />
                {showMore ? (
                  <ChevronUp size={16} strokeWidth={1.75} aria-hidden />
                ) : (
                  <ChevronDown size={16} strokeWidth={1.75} aria-hidden />
                )}
              </button>
              {showMore ? (
                <div className="lp-rf-grp" id={id('more')} ref={moreRef}>
                  {moreFields.map((key) => {
                    const row = MORE_ROWS[key];
                    return (
                      <TextRow
                        key={key}
                        inputId={id(key)}
                        label={row.label}
                        wide
                        placeholder={row.placeholder}
                        multiline={row.multiline}
                        max={row.max}
                        value={values[key]}
                        onChange={(v) => set(key, v)}
                        readOnly={readOnly}
                        error={err(key)}
                        errorId={errId(key)}
                      />
                    );
                  })}
                </div>
              ) : null}
            </>
          ) : null}
        </form>
      </div>

      <footer className="lp-rf-foot">
        <div className="lp-rf-foot-in">
          {props.onDiscard ? (
            <Button type="button" size="3" variant="soft" color="red" onClick={props.onDiscard} disabled={busy}>
              Discard
            </Button>
          ) : null}
          <Button
            type="button"
            size="3"
            highContrast
            disabled={props.submitDisabled || busy}
            loading={busy}
            onClick={props.onSubmit}
            style={{ width: '100%' }}
            data-testid="request-form-submit"
          >
            {props.offline ? <CloudOff size={16} strokeWidth={1.75} aria-hidden /> : null}
            {props.submitLabel}
          </Button>
        </div>
      </footer>

      {section === 'all' ? (
        <PostPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          value={postValue}
          onChange={(choice) => {
            onChange({ ...values, reportingLocation: choice.reportingLocation, otherLocation: choice.otherLocation ?? '' });
            props.onPostPicked?.(choice);
          }}
        />
      ) : null}
    </div>
  );
}

interface TextRowProps {
  inputId: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  wide?: boolean;
  multiline?: boolean;
  type?: 'text' | 'tel';
  inputMode?: 'text' | 'tel';
  trailing?: ReactNode;
  readOnly?: boolean;
  error?: string;
  errorId: string;
}

/** A label-left / value-right row (mockup .r) with its own error line. */
function TextRow({ inputId, label, placeholder, value, onChange, max, wide, multiline, type = 'text', inputMode, trailing, readOnly, error, errorId }: TextRowProps) {
  const a11y = error ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {};
  return (
    <div className="lp-rf-field">
      <div className="lp-rf-r" data-top={multiline ? '' : undefined}>
        <label className="lp-rf-k" data-wide={wide ? '' : undefined} htmlFor={inputId}>
          {label}
        </label>
        {multiline ? (
          <AutoTextarea
            id={inputId}
            className="lp-rf-in"
            rows={1}
            placeholder={placeholder}
            maxLength={max}
            readOnly={readOnly}
            value={value}
            onChange={(e) => onChange(e.currentTarget.value)}
            {...a11y}
          />
        ) : (
          <input
            id={inputId}
            className="lp-rf-in"
            type={type}
            inputMode={inputMode}
            placeholder={placeholder}
            autoComplete="off"
            enterKeyHint="next"
            maxLength={max}
            readOnly={readOnly}
            value={value}
            onChange={(e) => onChange(e.currentTarget.value)}
            {...a11y}
          />
        )}
        {trailing}
      </div>
      {error ? (
        <span id={errorId} className="lp-rf-err" data-indent={wide ? undefined : ''} role="alert" style={wide ? { paddingLeft: 128 } : undefined}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** A textarea that grows with its content (from `rows` lines up), so long text never hides inside it. */
function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);
  return <textarea ref={ref} {...props} />;
}
