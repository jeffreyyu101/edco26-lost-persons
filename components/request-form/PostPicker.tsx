'use client';
// "Reporting from" picker sheet (states.html PostPicker): FA 3 – Kinetic, FA 4 – Oasis, Command, Base and
// Other; Other shows a "Where?" field (other_location, 1–80 characters). The last pick is remembered by
// the caller (store prefs.lastPost). STUB (Phase 1a): props are final; F (Phase 2) builds the real sheet.
import { Button } from '@radix-ui/themes';
import { useState } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { LIMITS, OTHER_POST, POSTS, type PostValue } from '@/lib/domain';

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
  const [post, setPost] = useState<PostValue | null>(value?.reportingLocation ?? null);
  const [other, setOther] = useState(value?.otherLocation ?? '');
  const done = () => {
    if (!post) return;
    if (post === OTHER_POST && !other.trim()) return;
    onChange({ reportingLocation: post, otherLocation: post === OTHER_POST ? other.trim() : null });
    onOpenChange(false);
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Reporting from">
      <div role="radiogroup" aria-label="Reporting from" style={{ display: 'grid', gap: 4, margin: '12px 0' }}>
        {POSTS.map((p) => (
          <label key={p.value} style={{ display: 'flex', gap: 12, alignItems: 'center', minHeight: 48 }}>
            <input type="radio" name="post" checked={post === p.value} onChange={() => setPost(p.value)} />
            {p.value}
          </label>
        ))}
        {post === OTHER_POST ? (
          <input
            aria-label="Other location"
            placeholder="Where?"
            maxLength={LIMITS.otherLocation}
            value={other}
            onChange={(e) => setOther(e.currentTarget.value)}
            style={{ fontSize: 16, minHeight: 44 }}
          />
        ) : null}
      </div>
      <Button size="3" highContrast style={{ width: '100%' }} onClick={done} disabled={!post || (post === OTHER_POST && !other.trim())}>
        Done
      </Button>
    </Sheet>
  );
}
