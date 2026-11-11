'use client';
// (Events, lead screens) New event / Event setup (design/screens/events-v2-b): one form, also the edit screen. A new
// event takes its settings and is created (stage practice); the same screen then edits it and adds the logo, the staff
// password, the join link and the stage actions. Saving sends only what changed (PATCH). Server field errors show
// next to their field. An archived event shows the settings its records were made with read-only (the server
// would refuse them: bad_stage) and offers Reopen instead of the password and join link (an archived event takes
// neither; End holds both for 24 h, so a Reopen inside them keeps them, and the Reopen sheet says which).
import { Button, IconButton, TextField, VisuallyHidden } from '@radix-ui/themes';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Link2, Plus, Trash2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import type { EventAdmin } from '@/lib/api-types';
import { followSystemTheme } from '@/lib/theme';
import { Sheet } from '@/components/ui/Sheet';
import { api } from './api';
import { defaultZone, formatDates, hourLabel, shortDate, todayIso, zoneLabel, zoneOptions } from './format';
import { ListEditor } from './ListEditor';
import { EventLogo, FieldError, StageChip } from './parts';
import { SecretSheet } from './SecretSheet';
import {
  changedPayload,
  emptyForm,
  fieldKeyOf,
  flagFromServer,
  flagLine,
  formFromEvent,
  itemFlags,
  newKey,
  payloadFromForm,
  suggestSlug,
  validateForm,
  LIMITS,
  type FieldErrors,
  type FieldKey,
  type ItemFlags,
  type SetupForm,
} from './setup-model';
import { StageSheet, type StageAction } from './StageSheets';
import s from './events.module.css';

const LOGO_MAX_BYTES = 1024 * 1024;

export interface SetupScreenProps {
  /** The event's id, or 'new'. */
  id: string;
  /** Opened from the app's "Event" item: Back goes to the app, not the Events list. */
  fromApp: boolean;
}

type OpenSheet = StageAction | 'password' | 'dates' | null;

export function SetupScreen({ id, fromApp }: SetupScreenProps) {
  const [event, setEvent] = useState<EventAdmin | null>(null);
  // A new event until it is created (the address then names it; this screen goes on editing it).
  const creating = id === 'new' && !event;
  const [loadFailed, setLoadFailed] = useState(false);
  const [base, setBase] = useState<SetupForm>(() => emptyForm(todayIso(), defaultZone()));
  const [form, setForm] = useState<SetupForm>(base);
  const [slugTouched, setSlugTouched] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  // The post, team or chip each list's error is about (its chip shows the error state).
  const [flags, setFlags] = useState<ItemFlags>({});
  const [saving, setSaving] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [counts, setCounts] = useState<{ requests: number; open: number } | null>(null);
  const [joinLink, setJoinLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<'logo' | 'link' | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ids = { event: useId(), posts: useId(), teams: useId(), lastSeen: useId(), name: useId(), slug: useId(), tz: useId(), day: useId(), mm: useId(), dept: useId(), prep: useId(), staffing: useId() };

  const apply = useCallback((e: EventAdmin) => {
    setEvent(e);
    const f = formFromEvent(e);
    setBase(f);
    setForm(f);
  }, []);

  useEffect(() => followSystemTheme(), []);

  useEffect(() => {
    if (id === 'new') return;
    let live = true;
    void api.get(id).then((res) => {
      if (!live) return;
      if (res.ok) apply(res.data.event);
      else if (res.status !== 401) setLoadFailed(true);
    });
    return () => {
      live = false;
    };
  }, [id, apply]);

  const stage = event?.stage ?? 'practice';
  const archived = stage === 'archived';
  const dirty = creating ? true : Object.keys(changedPayload(base, form, stage)).length > 0;
  const backHref = fromApp ? '/' : '/events';

  const set = <K extends keyof SetupForm>(key: K, value: SetupForm[K], field: FieldKey = key as FieldKey) => {
    setForm((f) => {
      const next = { ...f, [key]: value };
      if (creating && key === 'name' && !slugTouched) next.slug = suggestSlug(String(value));
      return next;
    });
    if (errors[field]) setErrors((e) => ({ ...e, [field]: undefined }));
    if (field === 'posts' || field === 'teams' || field === 'lastSeen') setFlags((f) => (f[field] ? { ...f, [field]: undefined } : f));
  };

  const focusField = (key: FieldKey) => {
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-field="${key}"]`);
      // A list with a marked chip: that chip.
      const flagged = el?.querySelector<HTMLElement>('[data-invalid] button');
      const target = el?.matches('input, select, button') ? el : (flagged ?? el?.querySelector<HTMLElement>('input, select, button'));
      target?.focus();
    });
  };

  const showErrors = (next: FieldErrors) => {
    setErrors(next);
    const first = (Object.keys(next) as FieldKey[]).find((k) => next[k]);
    if (first) focusField(first);
  };

  const save = async () => {
    const problems = validateForm(form);
    if (Object.values(problems).some(Boolean)) {
      setFlags(itemFlags(form));
      return showErrors(problems);
    }
    setSaving(true);
    const res = creating || !event ? await api.create(payloadFromForm(form)) : await api.update(event.id, changedPayload(base, form, stage));
    setSaving(false);
    if (!res.ok) {
      if (res.status === 401) return;
      // A refusal that names a post or team marks its chip (the lists are sent in the form's order).
      const named = flagFromServer(form, res);
      if (named) {
        setFlags({ [named.field]: named.flag });
        return showErrors({ [named.field]: flagLine(form, named.field, named.flag) });
      }
      setFlags({});
      return showErrors({ [fieldKeyOf(res.field)]: res.message });
    }
    apply(res.data.event);
    setErrors({});
    setFlags({});
    setAnnounce('Saved');
    if (creating) window.history.replaceState(null, '', `/events/${res.data.event.id}`);
  };

  const discard = () => {
    setForm(base);
    setErrors({});
    setFlags({});
  };

  const openStage = (action: StageAction) => {
    setCounts(null);
    setSheet(action);
    void api.list().then((res) => {
      const row = res.ok ? res.data.events.find((e) => e.id === event?.id) : undefined;
      if (row) setCounts({ requests: row.requests ?? 0, open: row.open ?? 0 });
    });
  };

  const runStage = async (action: StageAction): Promise<string | null> => {
    if (!event) return null;
    const res = action === 'goLive' ? await api.goLive(event.id) : action === 'end' ? await api.end(event.id) : await api.reopen(event.id);
    if (!res.ok) return res.status === 401 ? null : res.message;
    apply(res.data.event);
    if (action === 'reopen') setJoinLink(null);
    setSheet(null);
    setAnnounce(action === 'goLive' ? 'Live' : action === 'end' ? 'Archived' : 'Live');
    return null;
  };

  const savePassword = async (password: string): Promise<string | null> => {
    if (!event) return null;
    const res = await api.setPassword(event.id, password);
    if (!res.ok) return res.status === 401 ? null : res.message;
    apply(res.data.event);
    setSheet(null);
    setAnnounce('Password saved');
    return null;
  };

  const newLink = async () => {
    if (!event) return;
    setBusy('link');
    setCopied(false);
    const res = await api.newJoinLink(event.id);
    setBusy(null);
    if (!res.ok) {
      if (res.status !== 401) setErrors((e) => ({ ...e, joinLink: res.message }));
      return;
    }
    setErrors((e) => ({ ...e, joinLink: undefined }));
    setEvent(res.data.event);
    setJoinLink(res.data.link);
  };

  const copyLink = async () => {
    if (!joinLink) return;
    try {
      await navigator.clipboard.writeText(joinLink);
      setCopied(true);
      setAnnounce('Join link copied');
    } catch {
      const field = document.querySelector<HTMLInputElement>('[data-testid="join-link-value"]');
      field?.select();
    }
  };

  const pickLogo = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !event) return;
    if (file.size > LOGO_MAX_BYTES) return setErrors((x) => ({ ...x, logo: 'At most 1 MB' }));
    setBusy('logo');
    const res = await api.uploadLogo(event.id, file);
    setBusy(null);
    if (!res.ok) {
      if (res.status !== 401) setErrors((x) => ({ ...x, logo: res.message }));
      return;
    }
    setErrors((x) => ({ ...x, logo: undefined }));
    setEvent(res.data.event);
  };

  const removeLogo = async () => {
    if (!event) return;
    setBusy('logo');
    const res = await api.removeLogo(event.id);
    setBusy(null);
    if (res.ok) setEvent(res.data.event);
    else if (res.status !== 401) setErrors((x) => ({ ...x, logo: res.message }));
  };

  if (!creating && !event) {
    return (
      <main className={s.screen} data-testid="event-setup" aria-busy={!loadFailed}>
        <Header title="Event" backHref={backHref} />
        <div className={s.center}>{loadFailed ? "Couldn't load the event" : null}</div>
      </main>
    );
  }

  const zone = zoneLabel(form.timezone);
  const err = (k: FieldKey) => errors[k];
  const errId = (k: FieldKey) => `setup-err-${k}`;
  const described = (k: FieldKey) => (err(k) ? { 'aria-invalid': true as const, 'aria-describedby': errId(k) } : {});

  return (
    <main className={s.screen} data-testid="event-setup" data-stage={event?.stage ?? 'new'}>
      <Header title={creating ? 'New event' : 'Event'} backHref={backHref} end={event ? <StageChip stage={event.stage} /> : null} />
      <VisuallyHidden aria-live="polite">{announce}</VisuallyHidden>
      <div className={s.body}>
        {errors.form ? <FieldError id={errId('form')}>{errors.form}</FieldError> : null}

        <h2 className={s.lbl} id={ids.event}>
          Event
        </h2>
        <div className={s.grp} role="group" aria-labelledby={ids.event}>
          <Row label="Name" htmlFor={ids.name} field="name">
            <input
              id={ids.name}
              className={s.input}
              value={form.name}
              maxLength={LIMITS.name}
              autoComplete="off"
              onChange={(e) => set('name', e.target.value)}
              {...described('name')}
              data-testid="setup-name"
            />
          </Row>
          <Row label="Link" htmlFor={ids.slug} field="slug">
            <input
              id={ids.slug}
              className={s.input}
              value={form.slug}
              maxLength={LIMITS.slug}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => {
                setSlugTouched(true);
                set('slug', e.target.value.toLowerCase());
              }}
              {...described('slug')}
              data-testid="setup-slug"
            />
          </Row>
          <Row label="Dates" field="dates" labelId={`${ids.event}-dates`}>
            {archived ? (
              <span className={s.v} data-testid="setup-dates">
                {formatDates(form.startsOn, form.endsOn, true)}
              </span>
            ) : (
              <button
                type="button"
                className={s.valueBtn}
                onClick={() => setSheet('dates')}
                aria-label={`Dates: ${formatDates(form.startsOn, form.endsOn, true) || 'not set'}. Change`}
                {...described('dates')}
                data-testid="setup-dates"
              >
                <span className={s.v}>{formatDates(form.startsOn, form.endsOn, true)}</span>
                <ChevronRight size={16} className={s.muted} aria-hidden />
              </button>
            )}
          </Row>
          <Row label="Time zone" htmlFor={ids.tz} field="timezone">
            {archived ? (
              <span className={s.v}>
                {zone.label}
                {zone.short ? <span className={s.zoneShort}>{zone.short}</span> : null}
              </span>
            ) : (
              <span className={s.selectWrap}>
                <select id={ids.tz} className={s.select} value={form.timezone} onChange={(e) => set('timezone', e.target.value)} {...described('timezone')} data-testid="setup-tz">
                  {zoneOptions(form.timezone).map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.short ? `${z.label} (${z.short})` : z.label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={16} className={s.chev} aria-hidden />
              </span>
            )}
          </Row>
          <Row label="Day starts" htmlFor={ids.day} field="dayStartHour">
            {archived ? (
              <span className={s.v}>{hourLabel(form.dayStartHour)}</span>
            ) : (
              <span className={s.selectWrap}>
                <select
                  id={ids.day}
                  className={s.select}
                  value={form.dayStartHour}
                  onChange={(e) => set('dayStartHour', Number(e.target.value))}
                  {...described('dayStartHour')}
                  data-testid="setup-day"
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
                <ChevronDown size={16} className={s.chev} aria-hidden />
              </span>
            )}
          </Row>
        </div>
        {(['name', 'slug', 'dates', 'timezone', 'dayStartHour'] as const).map((k) => (err(k) ? <FieldError key={k} id={errId(k)}>{err(k)}</FieldError> : null))}

        {event ? (
          <>
            <h2 className={s.lbl}>Logo</h2>
            <div className={s.grp} data-field="logo">
              <div className={s.logoRow}>
                <EventLogo name={form.name || event.name} logoUrl={event.logoUrl} size={56} />
                <div className={s.logoActs}>
                  {event.logoUrl ? (
                    <IconButton size="3" variant="soft" color="gray" aria-label="Remove the logo" onClick={removeLogo} disabled={busy === 'logo'}>
                      <Trash2 size={16} aria-hidden />
                    </IconButton>
                  ) : null}
                  <Button size="3" variant="soft" color="gray" onClick={() => fileRef.current?.click()} loading={busy === 'logo'} aria-describedby={err('logo') ? errId('logo') : undefined} data-testid="logo-upload">
                    <Upload size={16} aria-hidden />
                    {event.logoUrl ? 'Replace' : 'Upload'}
                  </Button>
                  <input ref={fileRef} type="file" accept="image/png,image/webp,image/jpeg" hidden onChange={pickLogo} data-testid="logo-file" />
                </div>
              </div>
            </div>
            {err('logo') ? <FieldError id={errId('logo')}>{err('logo')}</FieldError> : null}
          </>
        ) : null}

        <h2 className={s.lbl} id={ids.posts}>
          Posts
        </h2>
        <div data-field="posts">
          <ListEditor kind="post" items={form.posts} onChange={(v) => set('posts', v)} readOnly={archived} labelId={ids.posts} error={err('posts')} errorId={errId('posts')} flag={flags.posts} testId="setup-posts" />
        </div>

        <h2 className={s.lbl}>
          <label htmlFor={ids.mm}>Main medical</label>
        </h2>
        <div className={s.grp} data-invalid={err('mainMedical') ? '' : undefined}>
          <div className={s.r} data-field="mainMedical">
            <input
              id={ids.mm}
              className={s.input}
              value={form.mainMedical}
              maxLength={LIMITS.mainMedical}
              readOnly={archived}
              autoComplete="off"
              onChange={(e) => set('mainMedical', e.target.value)}
              {...described('mainMedical')}
              data-testid="setup-main-medical"
            />
          </div>
        </div>
        {err('mainMedical') ? <FieldError id={errId('mainMedical')}>{err('mainMedical')}</FieldError> : null}

        <h2 className={s.lbl} id={ids.teams}>
          Teams
        </h2>
        <div data-field="teams">
          <ListEditor kind="team" items={form.teams} onChange={(v) => set('teams', v)} readOnly={archived} labelId={ids.teams} error={err('teams')} errorId={errId('teams')} flag={flags.teams} testId="setup-teams" />
        </div>

        <h2 className={s.lbl} id={ids.lastSeen}>
          Last seen
        </h2>
        <div data-field="lastSeen">
          <ListEditor kind="lastSeen" items={form.lastSeen} onChange={(v) => set('lastSeen', v)} readOnly={archived} labelId={ids.lastSeen} error={err('lastSeen')} errorId={errId('lastSeen')} flag={flags.lastSeen} testId="setup-last-seen" />
        </div>

        {event && !archived ? (
          <>
            <h2 className={s.lbl}>Password</h2>
            <div className={s.grp}>
              <div className={s.r} data-field="password">
                <span className={s.k}>Staff</span>
                <span className={`${s.v} ${event.hasStaffPassword ? s.dots : s.muted}`} data-testid="password-state">
                  {event.hasStaffPassword ? '••••••••' : '—'}
                  <VisuallyHidden>{event.hasStaffPassword ? 'Staff password set' : 'No staff password'}</VisuallyHidden>
                </span>
                <Button size="2" variant="soft" color="gray" onClick={() => setSheet('password')} data-testid="password-set">
                  {event.hasStaffPassword ? 'Change' : 'Set'}
                </Button>
              </div>
              <div className={s.r} data-field="joinLink">
                <Link2 size={16} className={s.muted} aria-hidden />
                <span className={s.k} style={{ width: 'auto' }}>
                  Join link
                </span>
                {joinLink ? (
                  <input
                    className={`${s.input} ${s.linkField}`}
                    value={joinLink}
                    readOnly
                    aria-label="Join link"
                    onFocus={(e) => e.currentTarget.select()}
                    data-testid="join-link-value"
                  />
                ) : (
                  <span className={`${s.v} ${s.muted}`} style={{ textAlign: 'right' }} data-testid="join-link-state">
                    {event.joinLinkExpiresAt ? shortDate(event.joinLinkExpiresAt, event.timezone) : '—'}
                    <VisuallyHidden>{event.joinLinkExpiresAt ? 'A join link works until then' : 'No join link'}</VisuallyHidden>
                  </span>
                )}
                {joinLink ? (
                  <Button size="2" variant="soft" color="gray" onClick={copyLink} data-testid="join-link-copy">
                    {copied ? <Check size={15} aria-hidden /> : <Copy size={15} aria-hidden />}
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                ) : (
                  <Button size="2" variant="soft" color="gray" onClick={newLink} loading={busy === 'link'} data-testid="join-link-new">
                    {event.joinLinkExpiresAt ? 'New link' : 'Create'}
                  </Button>
                )}
              </div>
            </div>
            {err('joinLink') ? <FieldError id={errId('joinLink')}>{err('joinLink')}</FieldError> : null}
          </>
        ) : null}

        <h2 className={s.lbl}>Report</h2>
        <div className={s.grp}>
          <Row label="Department" htmlFor={ids.dept} field="department">
            <input
              id={ids.dept}
              className={s.input}
              value={form.department}
              maxLength={LIMITS.department}
              autoComplete="organization"
              onChange={(e) => set('department', e.target.value)}
              {...described('department')}
              data-testid="setup-department"
            />
          </Row>
          <Row label="Prepared by" htmlFor={ids.prep} field="preparedBy">
            <input
              id={ids.prep}
              className={s.input}
              value={form.preparedBy}
              maxLength={LIMITS.preparedBy}
              autoComplete="off"
              onChange={(e) => set('preparedBy', e.target.value)}
              {...described('preparedBy')}
              data-testid="setup-prepared-by"
            />
          </Row>
        </div>
        {(['department', 'preparedBy'] as const).map((k) => (err(k) ? <FieldError key={k} id={errId(k)}>{err(k)}</FieldError> : null))}

        <h2 className={s.lbl} id={ids.staffing}>
          Staffing
        </h2>
        <div className={s.grp} role="group" aria-labelledby={ids.staffing} data-field="staffing" data-invalid={err('staffing') ? '' : undefined} data-testid="setup-staffing">
          {form.staffing.map((row, i) => (
            <div key={row.key} className={s.staffRow}>
              <input
                className={s.input}
                value={row.role}
                placeholder="Role"
                aria-label={`Role, row ${i + 1}`}
                maxLength={LIMITS.staffingCell}
                onChange={(e) => set('staffing', form.staffing.map((r) => (r.key === row.key ? { ...r, role: e.target.value } : r)))}
                {...described('staffing')}
              />
              <input
                className={s.input}
                value={row.name}
                placeholder="Name"
                aria-label={`Name, row ${i + 1}`}
                maxLength={LIMITS.staffingCell}
                onChange={(e) => set('staffing', form.staffing.map((r) => (r.key === row.key ? { ...r, name: e.target.value } : r)))}
                {...described('staffing')}
              />
              <IconButton size="2" variant="ghost" color="gray" className={s.hit} aria-label={`Remove row ${i + 1}`} onClick={() => set('staffing', form.staffing.filter((r) => r.key !== row.key))}>
                <X size={15} aria-hidden />
              </IconButton>
            </div>
          ))}
          {form.staffing.length < LIMITS.staffingRows ? (
            <div className={s.addRow}>
              <Button size="2" variant="ghost" color="gray" onClick={() => set('staffing', [...form.staffing, { key: newKey('s'), role: '', name: '' }])} data-testid="staffing-add">
                <Plus size={15} aria-hidden />
                Row
              </Button>
            </div>
          ) : null}
        </div>
        {err('staffing') ? <FieldError id={errId('staffing')}>{err('staffing')}</FieldError> : null}
      </div>

      <footer className={s.foot}>
        <div className={s.footInner}>
          {creating ? (
            <Button size="4" highContrast onClick={save} loading={saving} data-testid="setup-create">
              Create
            </Button>
          ) : dirty ? (
            <>
              <Button size="4" variant="soft" color="gray" onClick={discard} disabled={saving} data-testid="setup-discard">
                Discard
              </Button>
              <Button size="4" highContrast onClick={save} loading={saving} data-testid="setup-save">
                Save
              </Button>
            </>
          ) : event?.stage === 'practice' ? (
            <Button size="4" highContrast onClick={() => openStage('goLive')} data-testid="stage-go-live">
              <span className={s.dot} aria-hidden />
              Go live
            </Button>
          ) : event?.stage === 'live' ? (
            <Button size="4" variant="soft" className={s.endBtn} onClick={() => openStage('end')} data-testid="stage-end">
              End event
            </Button>
          ) : event && !event.recordsDeletedAt ? (
            <Button size="4" highContrast onClick={() => openStage('reopen')} data-testid="stage-reopen">
              Reopen
            </Button>
          ) : null}
        </div>
      </footer>

      {event && (sheet === 'goLive' || sheet === 'end' || sheet === 'reopen') ? (
        <StageSheet action={sheet} event={event} counts={counts} onClose={() => setSheet(null)} onConfirm={() => runStage(sheet)} />
      ) : null}
      {sheet === 'dates' ? (
        <DatesSheet
          startsOn={form.startsOn}
          endsOn={form.endsOn}
          onClose={() => setSheet(null)}
          onDone={(a, b) => {
            setForm((f) => ({ ...f, startsOn: a, endsOn: b }));
            setErrors((e) => ({ ...e, dates: undefined }));
            setSheet(null);
          }}
        />
      ) : null}
      {event && sheet === 'password' ? <SecretSheet title="Staff password" label="Password" onSave={savePassword} onClose={() => setSheet(null)} testId="password-sheet" /> : null}
    </main>
  );
}

/** The first and last show day (two date fields): the Dates row opens it. */
function DatesSheet({ startsOn, endsOn, onClose, onDone }: { startsOn: string; endsOn: string; onClose: () => void; onDone: (startsOn: string, endsOn: string) => void }) {
  const [a, setA] = useState(startsOn);
  const [b, setB] = useState(endsOn);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const ids = { a: useId(), b: useId(), err: useId() };
  const done = (e: FormEvent) => {
    e.preventDefault();
    const problem = validateForm({ ...emptyForm(a), name: 'x', slug: 'xx', startsOn: a, endsOn: b }).dates;
    if (problem) return setError(problem);
    onDone(a, b);
  };
  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())} title="Dates" initialFocus={first}>
      <form onSubmit={done} noValidate>
        <div className={s.sheetField}>
          <label className={s.fieldLabel} htmlFor={ids.a}>
            First day
          </label>
          <TextField.Root id={ids.a} ref={first} size="3" type="date" value={a} onChange={(e) => (setA(e.target.value), setError(null))} data-testid="setup-starts" />
        </div>
        <div className={s.sheetField}>
          <label className={s.fieldLabel} htmlFor={ids.b}>
            Last day
          </label>
          <TextField.Root
            id={ids.b}
            size="3"
            type="date"
            value={b}
            min={a}
            onChange={(e) => (setB(e.target.value), setError(null))}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? ids.err : undefined}
            data-testid="setup-ends"
          />
          {error ? <FieldError id={ids.err}>{error}</FieldError> : null}
        </div>
        <div className={s.sheetActs}>
          <Button type="button" size="3" variant="soft" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="3" highContrast data-testid="dates-done">
            Done
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

function Header({ title, backHref, end }: { title: string; backHref: string; end?: ReactNode }) {
  return (
    <header className={s.head}>
      <div className={s.headInner}>
        <IconButton asChild size="3" variant="ghost" color="gray" className={s.back}>
          <a href={backHref} aria-label={backHref === '/' ? 'Back to the log' : 'Back to Events'} data-testid="setup-back">
            <ChevronLeft size={22} aria-hidden />
          </a>
        </IconButton>
        <h1 className={s.title}>{title}</h1>
        {end}
      </div>
    </header>
  );
}

function Row({ label, htmlFor, labelId, field, children }: { label: string; htmlFor?: string; labelId?: string; field: FieldKey; children: ReactNode }) {
  return (
    <div className={s.r} data-field={field}>
      {htmlFor ? (
        <label className={s.k} htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className={s.k} id={labelId}>
          {label}
        </span>
      )}
      {children}
    </div>
  );
}
