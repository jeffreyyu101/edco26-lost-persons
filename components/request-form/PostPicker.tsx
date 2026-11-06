'use client';
// "Reporting from" picker sheet (states.html PostPicker): FA 3 – Kinetic, FA 4 – Oasis, Command, Base and
// Other; Other shows a "Where?" field (other_location, 1–80 characters). The last pick is remembered by
// the caller (store prefs.lastPost). Real radio inputs (visually hidden) give arrow-key navigation and
// correct semantics; each option row is its label.
import { Button } from '@radix-ui/themes';
import { Check, MapPin } from 'lucide-react';
import { useId, useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { LIMITS, OTHER_POST, POSTS, type PostValue } from '@/lib/domain';
import './request-form.css';

export interface PostChoice {
  reportingLocation: PostValue;
  /** Only for Other; null otherwise. */
  otherLocation: string | null;
}

export interface PostPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Current choice, or null when none has been made yet ("Choose post"). */
  value: PostChoice | null;
  /** Called with a complete choice (Other always carries a non-empty location). */
  onChange: (choice: PostChoice) => void;
}

export function PostPicker({ open, onOpenChange, value, onChange }: PostPickerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Reporting from">
      {/* Mounted only while open, so every opening starts from the current value. */}
      {open ? (
        <PostPickerBody
          value={value}
          onDone={(choice) => {
            onChange(choice);
            onOpenChange(false);
          }}
        />
      ) : null}
    </Sheet>
  );
}

/** A complete choice from the picker state, or null while Other has no location yet. */
export function postChoiceFrom(post: PostValue | null, other: string): PostChoice | null {
  if (!post) return null;
  if (post !== OTHER_POST) return { reportingLocation: post, otherLocation: null };
  const where = other.trim().replace(/\s+/g, ' ');
  return where ? { reportingLocation: post, otherLocation: where } : null;
}

function PostPickerBody({ value, onDone }: { value: PostChoice | null; onDone: (choice: PostChoice) => void }) {
  const [post, setPost] = useState<PostValue | null>(value?.reportingLocation ?? null);
  const [other, setOther] = useState(value?.otherLocation ?? '');
  const name = useId();
  const choice = postChoiceFrom(post, other);
  const done = () => {
    if (choice) onDone(choice);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        done();
      }}
    >
      <div className="lp-rf-grp lp-rf-opts" role="radiogroup" aria-label="Reporting from">
        {POSTS.map((p) => {
          const checked = post === p.value;
          return (
            <label key={p.value} className="lp-rf-opt">
              <input
                className="lp-rf-radio"
                type="radio"
                name={name}
                value={p.value}
                checked={checked}
                onChange={() => setPost(p.value)}
              />
              <MapPin size={17} strokeWidth={1.75} aria-hidden />
              <span className="lp-rf-sp">{p.value}</span>
              {checked ? (
                <span className="lp-rf-ck">
                  <Check size={17} strokeWidth={1.75} aria-hidden />
                </span>
              ) : null}
            </label>
          );
        })}
        {post === OTHER_POST ? (
          <div className="lp-rf-opt">
            <span style={{ width: 17, flex: 'none' }} aria-hidden />
            <input
              className="lp-rf-where"
              aria-label="Other location"
              placeholder="Where?"
              autoComplete="off"
              autoCapitalize="sentences"
              enterKeyHint="done"
              maxLength={LIMITS.otherLocation}
              value={other}
              onChange={(e) => setOther(e.currentTarget.value)}
              // Picking Other means the next thing to do is type where.
              autoFocus={value?.reportingLocation !== OTHER_POST}
            />
          </div>
        ) : null}
      </div>
      <Button type="submit" size="3" highContrast mt="4" className="lp-hit" style={{ width: '100%' }} disabled={!choice}>
        Done
      </Button>
    </form>
  );
}
