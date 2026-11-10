'use client';
// (Events, lead screens) An ordered chip list on Event setup: posts (label + short), teams (label + short, at most one
// medical, marked with a cross) and the "Last seen" chips (label). A chip's label opens its sheet (rename, short,
// medical, move up or down); its × removes it; "+" adds one. Read-only (an archived event): plain chips. A chip shows
// the Short it will be stored with (typed, or derived from the label: lib/short-label.ts). A chip with a problem (the
// form's own check, or a server refusal that names it) has the error outline and glyph, and its sheet opens with the
// wrong field (Label or Short) marked.
import { Button, Flex, IconButton, Switch, TextField, VisuallyHidden } from '@radix-ui/themes';
import { ArrowDown, ArrowUp, CircleAlert, Cross, Plus, X } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { FieldError } from './parts';
import { deriveShort } from '@/lib/short-label';
import { addItem, itemProblem, moveItem, removeItem, setMedical, shortMaxOf, shortOf, updateItem, LIMITS, type ItemFlag, type ItemProblem, type ListItem } from './setup-model';
import s from './events.module.css';

export type ListKind = 'post' | 'team' | 'lastSeen';

const NOUN: Readonly<Record<ListKind, string>> = { post: 'post', team: 'team', lastSeen: 'Last seen chip' };
const TITLE: Readonly<Record<ListKind, string>> = { post: 'Post', team: 'Team', lastSeen: 'Last seen' };

interface ListEditorProps {
  kind: ListKind;
  items: ListItem[];
  onChange: (items: ListItem[]) => void;
  readOnly?: boolean;
  /** The group's visible label (its id names the list). */
  labelId: string;
  error?: string;
  /** The error line's id (the form focuses and tests find it). */
  errorId?: string;
  /** The item the error is about: its chip shows the error state. */
  flag?: ItemFlag;
  testId?: string;
}

export function ListEditor({ kind, items, onChange, readOnly = false, labelId, error, errorId, flag, testId }: ListEditorProps) {
  const [editing, setEditing] = useState<{ key: string | null } | null>(null);
  const ownErrId = useId();
  const errId = errorId ?? ownErrId;
  const noun = NOUN[kind];
  const editingItem = editing?.key ? (items.find((i) => i.key === editing.key) ?? null) : null;
  const full = items.length >= LIMITS.items;

  return (
    <>
      <div
        className={s.grp}
        role="group"
        aria-labelledby={labelId}
        data-invalid={error && !flag ? '' : undefined}
        aria-describedby={error ? errId : undefined}
        data-testid={testId}
      >
        <ul className={s.chips} style={{ margin: 0, listStyle: 'none' }}>
          {items.map((item) => {
            const medical = kind === 'team' && item.medical;
            const short = kind === 'lastSeen' ? '' : shortOf(kind, item);
            const flagged = flag?.key === item.key;
            const text = (
              <>
                {flagged ? <CircleAlert size={14} strokeWidth={2} className={s.chipAlert} aria-hidden /> : null}
                {medical ? <Cross size={14} strokeWidth={2} className={s.medical} aria-hidden /> : null}
                {item.label}
                {short && short !== item.label.trim() ? <span className={s.chipShort} data-testid={`${testId}-chip-short`}>{short}</span> : null}
              </>
            );
            return (
              <li key={item.key} className={s.chip} data-invalid={flagged ? '' : undefined} data-testid={`${testId}-chip`}>
                {readOnly ? (
                  <span className={s.chipStatic}>
                    {text}
                    {medical ? <VisuallyHidden>, the medical team</VisuallyHidden> : null}
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      className={s.chipLabel}
                      aria-label={`Edit ${noun} ${item.label}${medical ? ', the medical team' : ''}`}
                      aria-describedby={flagged && error ? errId : undefined}
                      onClick={() => setEditing({ key: item.key })}
                    >
                      {text}
                    </button>
                    <button type="button" className={s.chipX} aria-label={`Remove ${noun} ${item.label}`} onClick={() => onChange(removeItem(items, item.key))}>
                      <X size={14} strokeWidth={2} aria-hidden />
                    </button>
                  </>
                )}
              </li>
            );
          })}
          {readOnly || full ? null : (
            <li>
              <button type="button" className={s.addChip} aria-label={`Add a ${noun}`} onClick={() => setEditing({ key: null })} data-testid={`${testId}-add`}>
                <Plus size={16} strokeWidth={2} aria-hidden />
              </button>
            </li>
          )}
        </ul>
      </div>
      {error ? <FieldError id={errId}>{error}</FieldError> : null}
      {editing ? (
        <ItemSheet
          kind={kind}
          items={items}
          item={editingItem}
          flag={editingItem && flag?.key === editingItem.key ? flag : undefined}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            onChange(next);
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

function ItemSheet({
  kind,
  items,
  item,
  flag,
  onClose,
  onSave,
}: {
  kind: ListKind;
  items: ListItem[];
  item: ListItem | null;
  flag?: ItemProblem;
  onClose: () => void;
  onSave: (items: ListItem[]) => void;
}) {
  const [label, setLabel] = useState(item?.label ?? '');
  const [short, setShort] = useState(item?.short ?? '');
  const [medical, setMed] = useState(item?.medical === true);
  const [order, setOrder] = useState(items);
  const [error, setError] = useState<ItemProblem | null>(flag ?? null);
  const labelRef = useRef<HTMLInputElement>(null);
  const shortRef = useRef<HTMLInputElement>(null);
  const errId = useId();
  const ids = { label: useId(), short: useId(), medical: useId() };
  const hasShort = kind !== 'lastSeen';
  const shortMax = shortMaxOf(kind === 'team' ? 'team' : 'post');
  const index = item ? order.findIndex((i) => i.key === item.key) : -1;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const key = item?.key ?? '\u0000new';
    const problem = itemProblem(kind, order, { key, label, short });
    if (problem) {
      setError(problem);
      (problem.part === 'short' ? shortRef : labelRef).current?.focus();
      return;
    }
    const fields = { label: label.trim().replace(/\s+/g, ' '), short: short.trim().replace(/\s+/g, ' ') };
    let next = item ? updateItem(order, item.key, fields) : addItem(order, kind === 'team' ? { ...fields, medical: false } : fields);
    if (kind === 'team') {
      const target = item ? item.key : next[next.length - 1]!.key;
      next = setMedical(next, target, medical);
    }
    onSave(next);
  };

  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())} title={item ? TITLE[kind] : `New ${NOUN[kind]}`} initialFocus={flag?.part === 'short' ? shortRef : labelRef}>
      <form onSubmit={submit} noValidate>
        <div className={s.sheetField}>
          <label className={s.fieldLabel} htmlFor={ids.label}>
            Label
          </label>
          <TextField.Root
            id={ids.label}
            ref={labelRef}
            size="3"
            value={label}
            maxLength={kind === 'post' ? LIMITS.post : kind === 'team' ? LIMITS.team : LIMITS.lastSeen}
            onChange={(e) => {
              setLabel(e.target.value);
              setError(null);
            }}
            aria-invalid={error?.part === 'label' ? true : undefined}
            aria-describedby={error?.part === 'label' ? errId : undefined}
            autoComplete="off"
            data-testid="item-label"
          />
          {error?.part === 'label' ? <FieldError id={errId}>{error.message}</FieldError> : null}
        </div>
        {hasShort ? (
          <div className={s.sheetField}>
            <label className={s.fieldLabel} htmlFor={ids.short}>
              Short
            </label>
            <TextField.Root
              id={ids.short}
              ref={shortRef}
              size="3"
              value={short}
              placeholder={deriveShort(label, shortMax) || undefined}
              maxLength={shortMax}
              onChange={(e) => {
                setShort(e.target.value);
                setError(null);
              }}
              aria-invalid={error?.part === 'short' ? true : undefined}
              aria-describedby={error?.part === 'short' ? errId : undefined}
              autoComplete="off"
              data-testid="item-short"
            />
            {error?.part === 'short' ? <FieldError id={errId}>{error.message}</FieldError> : null}
          </div>
        ) : null}
        {kind === 'team' ? (
          <label className={s.switchRow} htmlFor={ids.medical}>
            <span>Medical team</span>
            <Switch id={ids.medical} size="3" checked={medical} onCheckedChange={setMed} data-testid="item-medical" />
          </label>
        ) : null}
        {item && order.length > 1 ? (
          <Flex gap="2" mb="4" align="center">
            <span className={s.fieldLabel} style={{ marginRight: 'auto' }}>
              Order
            </span>
            <IconButton
              type="button"
              variant="soft"
              color="gray"
              size="3"
              aria-label="Move up"
              disabled={index <= 0}
              onClick={() => setOrder((o) => moveItem(o, item.key, -1))}
            >
              <ArrowUp size={16} aria-hidden />
            </IconButton>
            <IconButton
              type="button"
              variant="soft"
              color="gray"
              size="3"
              aria-label="Move down"
              disabled={index < 0 || index >= order.length - 1}
              onClick={() => setOrder((o) => moveItem(o, item.key, 1))}
            >
              <ArrowDown size={16} aria-hidden />
            </IconButton>
            <span className={s.muted} aria-live="polite" style={{ minWidth: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {index + 1}/{order.length}
            </span>
          </Flex>
        ) : null}
        <div className={s.sheetActs}>
          <Button type="button" size="3" variant="soft" color="gray" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="3" highContrast data-testid="item-save">
            {item ? 'Done' : 'Add'}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
