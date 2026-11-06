'use client';
// Loading skeletons built with Radix <Skeleton> (design/screens/skeletons.html): shown only while there is
// no cache yet. STUB (Phase 1a): props are final; C ports the exact shapes.
import { Skeleton } from '@radix-ui/themes';

/** All requests: rows with a status dot, a name line, a status line and a time (varying widths). */
export function RowSkeletons({ count = 8 }: { count?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading requests">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ display: 'flex', gap: 10, padding: '10px 16px 11px' }}>
          <Skeleton width="14px" height="14px" style={{ borderRadius: '50%' }} />
          <div style={{ flex: 1, display: 'grid', gap: 6 }}>
            <Skeleton height="14px" width={`${40 + ((i * 17) % 35)}%`} />
            <Skeleton height="12px" width={`${55 + ((i * 11) % 30)}%`} />
          </div>
          <Skeleton width="28px" height="12px" />
        </div>
      ))}
    </div>
  );
}

/** Pending (photo square, two lines, two buttons) or My requests (four stepper dots) cards. */
export function CardSkeletons({ count = 3, variant }: { count?: number; variant: 'pending' | 'mine' }) {
  return (
    <div aria-busy="true" aria-label="Loading requests" style={{ display: 'grid', gap: 10, padding: '4px 12px' }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ padding: 12, borderRadius: 'var(--radius-4)', boxShadow: 'inset 0 0 0 1px var(--gray-a4)', display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 12 }}>
            <Skeleton width="40px" height="40px" />
            <div style={{ flex: 1, display: 'grid', gap: 6 }}>
              <Skeleton height="14px" width="50%" />
              <Skeleton height="12px" width="35%" />
            </div>
          </div>
          {variant === 'pending' ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <Skeleton height="32px" />
              <Skeleton height="32px" />
            </div>
          ) : (
            <Skeleton height="10px" />
          )}
        </div>
      ))}
    </div>
  );
}

/** Profile: portrait, name lines, status block, detail rows and the action buttons. */
export function ProfileSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading request" style={{ display: 'grid', gap: 14, padding: '8px 14px' }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <Skeleton width="64px" height="82px" />
        <div style={{ flex: 1, display: 'grid', gap: 6 }}>
          <Skeleton height="20px" width="60%" />
          <Skeleton height="14px" width="30%" />
        </div>
      </div>
      <Skeleton height="56px" />
      <Skeleton height="120px" />
    </div>
  );
}
