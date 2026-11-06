'use client';
// Dashboard (?dashboard=1, spec §8 Dashboard): GET /api/stats every 15 s while open via useStats(true).
// PLACEHOLDER (Phase 1a): the exported name and props are FINAL; P (Phase 2) builds the real screen.
import { Heading, IconButton, Text } from '@radix-ui/themes';
import { ArrowLeft } from 'lucide-react';
import { goBack } from '@/lib/client/nav';
import { useStats } from '@/lib/client/store-contract';

export type DashboardViewProps = Record<string, never>;

export function DashboardView(_props: DashboardViewProps) {
  const { stats } = useStats(true);
  return (
    <div style={{ minHeight: '100dvh', padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <IconButton variant="ghost" color="gray" aria-label="Back to requests" onClick={() => goBack({})}>
          <ArrowLeft size={20} aria-hidden />
        </IconButton>
        <Heading size="4" weight="medium">
          Dashboard
        </Heading>
      </div>
      <Text as="div" size="2" color="gray" mt="4">
        Open requests
      </Text>
      <Text as="div" size="8" weight="medium">
        {stats ? stats.open.waiting + stats.open.inMedical : '–'}
      </Text>
    </div>
  );
}
