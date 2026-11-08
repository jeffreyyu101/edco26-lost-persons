'use client';
// The request form body (new-request.html v3, reordered by Jeffrey on 2026-11-06): Cancel + title top bar,
// "Reporting from" row, Missing person (the ID card: photo slot, Name, Age, Gender + quick-fill chips; then
// Wearing, Last seen + stage chips while focus is within the row), More details, Friend or family
// (optional, last), and the pinned Send button. Every group is open; the form scrolls, and the focused row
// stays above the on-screen keyboard (useKeyboardFit). Every person and contact field is free text.
// Controlled: RequestFormView owns the values, the draft and the store calls.
// Tablet and desktop (desktop-new-tablet.html frame 1, `presentation` sheet / modal): the same fields in a
// dialog, in Jeffrey's order (10:31) with nothing to expand. The post is a chip in the header; Missing
// person is boxed fields labelled by their placeholders (screen readers keep the real labels) with the
// place chips always on screen; More details follows it in the same column as one card of label / value
// rows (labels stay visible: these values don't name themselves); Friend or family is last. The modal puts
// Missing person + More details left and Friend or family right; the side sheet stacks the same order in
// one column. The footer is Cancel + Send with its ⌘↵ key cap. The phone page keeps Jeffrey's order and
// markup exactly (no column wrappers under 768 px).
import { Badge, Button, Text } from '@radix-ui/themes';
import { ArrowUpRight, Check, ChevronDown, CloudOff, MapPin, UserRoundSearch } from 'lucide-react';
import {
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
import { LIMITS, OTHER_POST, STAGE_CHIPS, isValidPhone, postFull, type EditSection, type PhotoTiming } from '@/lib/domain';
import { formatCaseNumber } from '@/lib/format';
import { FormSurface } from './FormSurface';
import { GENDER_CHIPS, genderAfterChip, genderChipFor, lastSeenWithChip, moreFieldsFor, type MoreField } from './form-logic';
import { PhotoSlot } from './PhotoSlot';
import { PostPicker, PostPickerPopover, type PostChoice } from './PostPicker';
import { isApplePlatform, isOverlay, sendShortcut, usePresentation, type FormPresentation } from './presentation';
import { useKeyboardFit } from './use-keyboard-fit';
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

  // Added for tablet and desktop (all optional).
  /** page (phone, default), sheet (768–1023) or modal (1024+). Defaults to RequestFormView's context. */
  presentation?: FormPresentation;
  /**
   * sheet / modal: ×, Esc or a click outside. Closes without discarding (a new request keeps its draft,
   * as leaving does on the phone). Defaults to onCancel.
   */
  onDismiss?: () => void;
}

const DEFAULT_TITLE: Readonly<Record<RequestFormMode, string>> = {
  create: 'New request',
  edit: 'Edit details',
  outbox: 'Not sent',
};

/**
 * Tablet / desktop placeholders: the boxed fields have no visible label (the mockup's "Last seen · where,
 * roughly when"), so the placeholder names the field. The <label> stays for screen readers.
 */
const DESK_PLACEHOLDER = {
  age: 'Age · e.g. 24 or mid-20s',
  gender: 'Gender',
  clothing: 'Wearing · clothing, colors, accessories',
  lastSeen: 'Last seen · where, roughly when',
  contactName: 'Name · who’s looking',
  contactPhone: 'Phone',
  contactRelationship: 'Relation · friend, partner, sibling…',
  contactNotes: 'Notes',
} as const;

const MORE_ROWS: Readonly<Record<MoreField, { label: string; placeholder: string; multiline: boolean; max: number }>> = {
  hair: { label: 'Hair', placeholder: '', multiline: false, max: LIMITS.hair },
  heightBuild: { label: 'Build', placeholder: 'Height, build', multiline: false, max: LIMITS.heightBuild },
  identifyingFeatures: { label: 'Features', placeholder: 'Tattoos, piercings, glasses', multiline: false, max: LIMITS.identifyingFeatures },
  physicalDescription: { label: 'Description', placeholder: '', multiline: true, max: LIMITS.physicalDescription },
  additionalNotes: { label: 'Other notes', placeholder: '', multiline: true, max: LIMITS.additionalNotes },
};

const selectOutboxCount = (s: StoreState) => visibleOutbox(s.outbox, s.confirmed).length;

/** Pointer slop for a chip tap: a drag that starts on a chip (a scroll) never appends. */
const TAP_SLOP_PX = 10;

export function RequestForm(props: RequestFormProps) {
  const { mode, section, values, errors = {}, busy } = props;
  const contextPresentation = usePresentation();
  const presentation = props.presentation ?? contextPresentation;
  const desk = isOverlay(presentation);
  // Nothing changes while a send is in flight: whatever is typed then would be lost when the draft clears.
  const readOnly = !!props.readOnly || busy;
  const locked = readOnly;
  const onChange = (next: RequestFormValues) => {
    if (!readOnly) props.onChange(next);
  };
  const uid = useId();
  const id = (key: string) => `${uid}-${key}`;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [lastSeenFocus, setLastSeenFocus] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastSeenRef = useRef<HTMLInputElement>(null);
  const chipDown = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const outboxCount = useStoreSelector(selectOutboxCount);
  // The phone page only (rootRef is attached there): the sheet and modal are dialogs that size themselves.
  useKeyboardFit(rootRef, scrollRef);

  const set = <K extends keyof RequestFormValues>(key: K, value: RequestFormValues[K]) => onChange({ ...values, [key]: value });
  const genderOn = genderChipFor(values.gender);

  const moreFields = moreFieldsFor(section);

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
  // On tablet / desktop the chips are always there, so a click may come from elsewhere in the form: the
  // caret then follows the text into Last seen (a keyboard press leaves focus on the chip).
  const appendStage = (chip: string, focusField = false) => {
    set('lastSeen', lastSeenWithChip(values.lastSeen, chip, LIMITS.lastSeen));
    if (focusField && desk) lastSeenRef.current?.focus({ preventScroll: true });
  };
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
      appendStage(chip, true);
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
    // ⌘↵ / Ctrl+↵ is the send shortcut (FormSurface), not "next field".
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.metaKey || e.ctrlKey) return;
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
        popover={desk}
      />
    );

  // Without the photo slot (edit) the card is a plain group, so its rows get labels like the others.
  const labelled = photoSlot === null;
  const phoneValid = isValidPhone(values.contactPhone);
  const title = props.title ?? DEFAULT_TITLE[mode];
  const onPostChange = (choice: PostChoice) => {
    onChange({ ...values, reportingLocation: choice.reportingLocation, otherLocation: choice.otherLocation ?? '' });
    props.onPostPicked?.(choice);
  };
  const postAria = postMissing ? 'Reporting from: choose post' : `Reporting from ${postLabel}. Change`;
  const postErrorLine = postError ? (
    <span id={errId('post')} className="lp-rf-err" role="alert" style={{ padding: '6px 4px 0', margin: 0 }}>
      {postError}
    </span>
  ) : null;

  // Tablet / desktop: the post is a chip in the dialog header that drops the same picker.
  const headerChip =
    desk && section === 'all' ? (
      <PostPickerPopover open={pickerOpen} onOpenChange={setPickerOpen} value={postValue} onChange={onPostChange}>
        <button
          type="button"
          className="lp-rf-pchip lp-hit"
          data-empty={postMissing ? '' : undefined}
          data-invalid={postError ? '' : undefined}
          aria-label={postAria}
          aria-describedby={postError ? errId('post') : undefined}
          disabled={locked}
        >
          <MapPin size={15} strokeWidth={1.75} aria-hidden />
          <span className="lp-rf-pchip-t">{postMissing ? 'Choose post' : postLabel}</span>
          <ChevronDown size={14} strokeWidth={1.75} aria-hidden />
        </button>
      </PostPickerPopover>
    ) : null;

  const shortcut = desk ? sendShortcut(isApplePlatform(typeof navigator === 'undefined' ? undefined : navigator)) : null;
  const sendFromShortcut = () => {
    if (!props.submitDisabled && !busy) props.onSubmit();
  };

  // ---- The groups, in Jeffrey's order (Missing person, More details, Friend or family). The phone renders
  // them straight in the form; the dialog wraps Missing person + More details in one column and Friend or
  // family in the other, so the modal sets them side by side and the sheet stacks them in the same order.
  const personGroup =
    section !== 'friend' ? (
      <>
        <Text as="div" size="2" weight="medium" color="gray" className="lp-rf-lbl" id={id('person')}>
          Missing person
        </Text>
        <div className="lp-rf-grp" role="group" aria-labelledby={id('person')}>
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
                  {/* Free text with the normal keyboard: "24", "mid-20s", "18–21". */}
                  <input
                    id={id('age')}
                    className="lp-rf-in"
                    aria-label={labelled ? undefined : 'Age'}
                    placeholder={desk ? DESK_PLACEHOLDER.age : labelled ? 'e.g. 24 or mid-20s' : 'Age, e.g. 24 or mid-20s'}
                    type="text"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    enterKeyHint="next"
                    maxLength={LIMITS.age}
                    readOnly={readOnly}
                    value={values.age}
                    onChange={(e) => set('age', e.currentTarget.value)}
                    {...invalid('age')}
                  />
                </div>
                {errLine('age', labelled)}
              </div>
              <div className="lp-rf-field">
                <div className="lp-rf-r">
                  {labelled ? (
                    <label className="lp-rf-k" htmlFor={id('gender')}>
                      Gender
                    </label>
                  ) : null}
                  <input
                    id={id('gender')}
                    className="lp-rf-in"
                    aria-label={labelled ? undefined : 'Gender'}
                    placeholder={desk ? DESK_PLACEHOLDER.gender : labelled ? '' : 'Gender'}
                    type="text"
                    autoComplete="off"
                    enterKeyHint="next"
                    maxLength={LIMITS.gender}
                    readOnly={readOnly}
                    value={values.gender}
                    onChange={(e) => set('gender', e.currentTarget.value)}
                    {...invalid('gender')}
                  />
                </div>
                {/* Quick fill: a chip writes its word into Gender; the chip matching the text is on, and
                    tapping it again clears the field. */}
                <div className="lp-rf-gq" data-indent={labelled ? '' : undefined} role="group" aria-label="Fill in gender">
                  {GENDER_CHIPS.map((chip) => {
                    const on = genderOn === chip;
                    return (
                      <Button
                        key={chip}
                        type="button"
                        size="1"
                        variant={on ? 'solid' : 'soft'}
                        color="gray"
                        highContrast={on}
                        radius="full"
                        className="lp-rf-chip lp-hit"
                        aria-pressed={on}
                        disabled={!!props.readOnly}
                        onClick={() => set('gender', genderAfterChip(values.gender, chip))}
                      >
                        {on ? <Check size={13} strokeWidth={2} aria-hidden /> : null}
                        {chip}
                      </Button>
                    );
                  })}
                </div>
                {errLine('gender', labelled)}
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
                placeholder={desk ? DESK_PLACEHOLDER.clothing : 'Clothing, colors, accessories'}
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
            data-focus={lastSeenFocus && !desk ? '' : undefined}
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
                ref={lastSeenRef}
                id={id('lastSeen')}
                className="lp-rf-in"
                placeholder={desk ? DESK_PLACEHOLDER.lastSeen : 'Where, roughly when'}
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
            {(lastSeenFocus || desk) && !readOnly ? (
              <div className="lp-rf-sugg" role="group" aria-label="Add a place to Last seen">
                {STAGE_CHIPS.map((chip) => (
                  <Button
                    key={chip}
                    type="button"
                    size="1"
                    variant="soft"
                    color="gray"
                    radius="full"
                    className="lp-rf-chip lp-hit"
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
            highContrast
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
    ) : null;

  const moreGroup =
    moreFields.length > 0 ? (
      <>
        <Text as="div" size="2" weight="medium" color="gray" className="lp-rf-lbl" id={id('more')}>
          More details
        </Text>
        <div className="lp-rf-grp" role="group" aria-labelledby={id('more')} data-more={desk ? '' : undefined}>
          {moreFields.map((key) => {
            const row = MORE_ROWS[key];
            return (
              <TextRow
                key={key}
                inputId={id(key)}
                label={row.label}
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
      </>
    ) : null;

  const friendGroup =
    section !== 'person' ? (
      <>
        <Text as="div" size="2" weight="medium" color="gray" className="lp-rf-lbl" id={id('friend')}>
          Friend or family
          {/* Marked optional only beside the other groups (the space keeps the group's name as words). */}
          {section === 'all' ? (
            <>
              {' '}
              <Badge size="1" color="gray" variant="soft" radius="full" className="lp-rf-optional">
                Optional
              </Badge>
            </>
          ) : null}
        </Text>
        <div className="lp-rf-grp" role="group" aria-labelledby={id('friend')}>
          <TextRow
            inputId={id('contactName')}
            label="Name"
            placeholder={desk ? DESK_PLACEHOLDER.contactName : "Who's looking"}
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
            placeholder={desk ? DESK_PLACEHOLDER.contactPhone : 'Phone number'}
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
            placeholder={desk ? DESK_PLACEHOLDER.contactRelationship : 'Friend, partner, sibling…'}
            max={LIMITS.contactRelationship}
            value={values.contactRelationship}
            onChange={(v) => set('contactRelationship', v)}
            readOnly={readOnly}
            error={err('contactRelationship')}
            errorId={errId('contactRelationship')}
          />
          <TextRow
            inputId={id('contactNotes')}
            label="Notes"
            placeholder={desk ? DESK_PLACEHOLDER.contactNotes : ''}
            multiline
            max={LIMITS.contactNotes}
            value={values.contactNotes}
            onChange={(v) => set('contactNotes', v)}
            readOnly={readOnly}
            error={err('contactNotes')}
            errorId={errId('contactNotes')}
          />
        </div>
        {mode !== 'edit' ? <FriendInMedicalGroup values={values} set={set} readOnly={!!readOnly} id={id('companion')} /> : null}
      </>
    ) : null;

  return (
    <FormSurface
      presentation={presentation}
      title={title}
      mode={mode}
      rootRef={rootRef}
      onCancel={props.onCancel}
      cancelDisabled={busy}
      onDismiss={props.onDismiss ?? props.onCancel}
      dismissDisabled={busy}
      headerExtra={headerChip}
      onSubmitShortcut={sendFromShortcut}
      columns={section === 'all' ? 2 : 1}
    >
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

          {section === 'all' && desk ? postErrorLine : null}
          {section === 'all' && !desk ? (
            <>
              <button
                type="button"
                className="lp-rf-loc"
                data-empty={postMissing ? '' : undefined}
                data-invalid={postError ? '' : undefined}
                aria-haspopup="dialog"
                aria-label={postAria}
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
                  </Text>{' '}
                  {/* Step 12 amber on the amber highlight: step 11 there is ~4.2:1 (spec §7). The {' '}
                      keeps "Reporting from" and the post apart as words for the aria-label match. */}
                  <Text size="3" weight="medium" color={postMissing ? 'amber' : undefined} highContrast={postMissing}>
                    {postMissing ? 'Choose post' : postLabel}
                  </Text>
                </span>
                <span className="lp-rf-chev">
                  <ChevronDown size={18} strokeWidth={1.75} aria-hidden />
                </span>
              </button>
              {postErrorLine}
            </>
          ) : null}

          {desk ? (
            <>
              {personGroup || moreGroup ? (
                <div className="lp-rf-col" data-col="person">
                  {personGroup}
                  {moreGroup}
                </div>
              ) : null}
              {friendGroup ? (
                <div className="lp-rf-col" data-col="friend">
                  {friendGroup}
                </div>
              ) : null}
            </>
          ) : (
            <>
              {personGroup}
              {moreGroup}
              {friendGroup}
            </>
          )}
        </form>
      </div>

      <footer className="lp-rf-foot">
        {desk ? (
          <div className="lp-rf-foot-in">
            {props.onDiscard ? (
              <Button type="button" size="2" variant="soft" color="red" className="lp-hit" onClick={props.onDiscard} disabled={busy}>
                Discard
              </Button>
            ) : null}
            <span className="lp-rf-sp" />
            <Button type="button" size="2" variant="ghost" color="gray" className="lp-hit lp-rf-ghost" onClick={props.onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              size="2"
              highContrast
              disabled={props.submitDisabled || busy}
              loading={busy}
              onClick={props.onSubmit}
              className="lp-hit lp-rf-send"
              data-testid="request-form-submit"
              aria-keyshortcuts={shortcut?.aria}
            >
              {props.offline ? <CloudOff size={15} strokeWidth={1.75} aria-hidden /> : null}
              {props.submitLabel}
              {shortcut ? (
                <kbd className="lp-rf-kbd" aria-hidden>
                  {shortcut.cap}
                </kbd>
              ) : null}
            </Button>
          </div>
        ) : (
          <div className="lp-rf-foot-in">
            {props.onDiscard ? (
              <Button type="button" size="3" variant="soft" color="red" className="lp-hit" onClick={props.onDiscard} disabled={busy}>
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
              className="lp-hit"
              style={{ width: '100%' }}
              data-testid="request-form-submit"
            >
              {props.offline ? <CloudOff size={16} strokeWidth={1.75} aria-hidden /> : null}
              {props.submitLabel}
            </Button>
          </div>
        )}
      </footer>

      {section === 'all' && !desk ? <PostPicker open={pickerOpen} onOpenChange={setPickerOpen} value={postValue} onChange={onPostChange} /> : null}
    </FormSurface>
  );
}

interface TextRowProps {
  inputId: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  max: number;
  multiline?: boolean;
  type?: 'text' | 'tel';
  inputMode?: 'text' | 'tel';
  trailing?: ReactNode;
  readOnly?: boolean;
  error?: string;
  errorId: string;
}

/** A label-left / value-right row (mockup .r) with its own error line. */
function TextRow({ inputId, label, placeholder, value, onChange, max, multiline, type = 'text', inputMode, trailing, readOnly, error, errorId }: TextRowProps) {
  const a11y = error ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {};
  return (
    <div className="lp-rf-field">
      <div className="lp-rf-r" data-top={multiline ? '' : undefined}>
        <label className="lp-rf-k" htmlFor={inputId}>
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
        <span id={errorId} className="lp-rf-err" data-indent="" role="alert">
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

/** (Companion) "Is a friend already with them in medical?" No · Yes · Not sure (default); Yes adds an optional Name. */
const FRIEND_CHOICES = [
  { value: 'no', label: 'No' },
  { value: 'yes', label: 'Yes' },
  { value: 'unsure', label: 'Not sure' },
] as const;

function FriendInMedicalGroup({
  values,
  set,
  readOnly,
  id,
}: {
  values: RequestFormValues;
  set: <K extends keyof RequestFormValues>(key: K, value: RequestFormValues[K]) => void;
  readOnly: boolean;
  id: string;
}) {
  const current = values.friendInMedical ?? 'unsure';
  return (
    <div className="lp-rf-grp" role="group" aria-labelledby={`${id}-q`} data-testid="friend-in-medical" style={{ marginTop: 12 }}>
      <div className="lp-rf-field">
        <div className="lp-rf-r" style={{ flexWrap: 'wrap', rowGap: 8, paddingBlock: 8 }}>
          <span className="lp-rf-k" id={`${id}-q`} style={{ flex: '1 1 12em', whiteSpace: 'normal' }}>
            Is a friend already with them in medical?
          </span>
          <div role="radiogroup" aria-labelledby={`${id}-q`} style={{ display: 'flex', gap: 6 }}>
            {FRIEND_CHOICES.map((c) => {
              const on = current === c.value;
              return (
                <Button
                  key={c.value}
                  type="button"
                  size="1"
                  variant={on ? 'solid' : 'soft'}
                  color="gray"
                  highContrast={on}
                  radius="full"
                  className="lp-rf-chip lp-hit"
                  role="radio"
                  aria-checked={on}
                  disabled={readOnly}
                  data-value={c.value}
                  onClick={() => set('friendInMedical', c.value)}
                >
                  {c.label}
                </Button>
              );
            })}
          </div>
        </div>
      </div>
      {current === 'yes' ? (
        <TextRow
          inputId={`${id}-name`}
          label="Name"
          placeholder=""
          max={60}
          value={values.friendInMedicalName ?? ''}
          onChange={(v) => set('friendInMedicalName', v)}
          readOnly={readOnly}
          errorId={`${id}-name-err`}
        />
      ) : null}
    </div>
  );
}
