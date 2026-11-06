'use client';
// Request profile (?r=<id>, spec §8 Profile). Renders immediately from the summary; photos and audit load
// through useDetail(id), which refetches when the synced rowVersion changes.
// PLACEHOLDER (Phase 1a): the exported name and props are FINAL; P (Phase 2) builds the real screen.
import { Button, Heading, IconButton, Text } from '@radix-ui/themes';
import { X } from 'lucide-react';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import { ProfileSkeleton } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { goBack } from '@/lib/client/nav';
import { useActions, useIsLoading, useRequest } from '@/lib/client/store-contract';
import { ageGender, primaryActions, statusMeta } from '@/lib/domain';
import { formatCaseNumber } from '@/lib/format';

export interface ProfileViewProps {
  /** Request id from ?r=. */
  id: string;
}

export function ProfileView({ id }: ProfileViewProps) {
  const row = useRequest(id);
  const loading = useIsLoading();
  const actions = useActions();
  const close = () => goBack({});

  if (!row) {
    return loading ? <ProfileSkeleton /> : <EmptyState icon="search" title="Request not found" action={{ label: 'Back', onClick: close }} />;
  }
  const meta = statusMeta(row.status);
  return (
    <div style={{ minHeight: '100dvh', padding: 14 }} data-testid="profile">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <IconButton variant="soft" color="gray" radius="full" aria-label="Close" onClick={close}>
          <X size={16} aria-hidden />
        </IconButton>
        <Text size="2" weight="medium" color="gray">
          {formatCaseNumber(row.caseNumber)}
        </Text>
        <span style={{ width: 32 }} />
      </div>
      <Heading size="5" weight="medium" mt="3">
        {row.name || '—'}
      </Heading>
      <Text size="3" color="gray">
        {ageGender(row.age, row.gender)}
      </Text>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '12px 0' }}>
        <StatusGlyph status={row.status} size={18} />
        <Text size="3" weight="medium" color={meta.tone}>
          {meta.label}
        </Text>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {primaryActions(row.status).map((a) => (
          <Button key={a.id} size="3" variant="soft" color="gray" onClick={() => void actions.setStatus(row.id, a.to, a.kind)}>
            {a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
