'use client';
// List views: All, Pending, My requests and Search (spec §8 List views). The page loads each export with
// next/dynamic. PLACEHOLDER (Phase 1a): renders the store's rows plainly so Merge 1 can smoke-test the
// real store; L (Phase 2) builds the real screens. The exported names and props are FINAL.
import { Button, Text } from '@radix-ui/themes';
import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { AccountMenu } from '@/components/account/AccountMenu';
import { StatusGlyph } from '@/components/ui/StatusGlyph';
import { RowSkeletons } from '@/components/ui/Skeleton';
import { EmptyState } from '@/components/ui/EmptyState';
import { navigate } from '@/lib/client/nav';
import {
  useActions,
  useAllRows,
  useConnection,
  useCounts,
  useEventTimezone,
  useIsLoading,
  useMine,
  useNow,
  usePending,
  usePrefs,
  useSearch,
} from '@/lib/client/store-contract';
import type { RequestSummary } from '@/lib/api-types';
import { ageGender, statusMeta } from '@/lib/domain';
import { formatCaseNumber, formatListTime } from '@/lib/format';
import { AppHeader } from './AppHeader';
import { ViewSwitcher, type ListViewName } from './ViewSwitcher';

function Chrome({ view, children }: { view: ListViewName; children: ReactNode }) {
  const actions = useActions();
  const { connection, syncing } = useConnection();
  const prefs = usePrefs();
  const counts = useCounts();
  const loading = useIsLoading();
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <AppHeader
        connection={connection}
        syncing={syncing}
        onSyncNow={actions.syncNow}
        onOpenSearch={() => navigate({ q: '' })}
        bellOn={prefs.bell}
        onToggleBell={() => actions.setPref('bell', !prefs.bell)}
        account={<AccountMenu />}
      />
      <ViewSwitcher
        view={view}
        counts={loading ? null : counts}
        onSelect={(v) => navigate(v === 'all' ? {} : { view: v })}
      />
      <div style={{ flex: 1 }}>{loading ? <RowSkeletons /> : children}</div>
      <Button
        size="3"
        radius="full"
        highContrast
        onClick={() => navigate({ new: true })}
        style={{ position: 'fixed', right: 16, bottom: 'calc(24px + env(safe-area-inset-bottom))', boxShadow: 'var(--shadow-5)' }}
      >
        <Plus size={16} aria-hidden /> New request
      </Button>
    </div>
  );
}

function Row({ row }: { row: RequestSummary }) {
  const tz = useEventTimezone();
  const now = useNow();
  const meta = statusMeta(row.status);
  return (
    <button
      type="button"
      data-request-id={row.id}
      onClick={() => navigate({ r: row.id })}
      style={{ display: 'flex', gap: 10, width: '100%', padding: '10px 16px 11px', border: 0, borderTop: '1px solid var(--gray-a3)', background: 'none', textAlign: 'left', color: 'inherit', font: 'inherit', opacity: meta.bucket === 'closed' ? 0.55 : 1 }}
    >
      <span style={{ paddingTop: 3, display: 'flex' }}>
        <StatusGlyph status={row.status} />
      </span>
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Text size="2" weight="medium" truncate>
            {row.name || '—'}
          </Text>
          <Text size="2" color="gray">
            {ageGender(row.age, row.gender)}
          </Text>
          <span style={{ flex: 1 }} />
          <Text size="1" color="gray">
            {formatListTime(row.createdAt, now, tz)}
          </Text>
        </span>
        <Text size="1" truncate>
          <Text weight="medium" color={meta.tone}>
            {meta.label}
          </Text>
          <Text color="gray">
            {' '}
            · {row.postShort} · {formatCaseNumber(row.caseNumber)}
          </Text>
        </Text>
      </span>
    </button>
  );
}

function Rows({ rows }: { rows: readonly RequestSummary[] }) {
  if (rows.length === 0) return <EmptyState icon="inbox" title="No requests yet" />;
  return (
    <div data-testid="request-list">
      {rows.map((r) => (
        <Row key={r.id} row={r} />
      ))}
    </div>
  );
}

export interface AllViewProps {
  /** Status filter (database value) from ?status=, shown as a chip. */
  status: string | null;
  /** Post filter (postShort) from ?post=, shown as a chip. */
  post: string | null;
}

export function AllView({ status, post }: AllViewProps) {
  const rows = useAllRows({ status, post });
  return (
    <Chrome view="all">
      <Rows rows={rows} />
    </Chrome>
  );
}

export function PendingView() {
  const { friendComing, waiting } = usePending();
  return (
    <Chrome view="pending">
      <Rows rows={[...friendComing, ...waiting]} />
    </Chrome>
  );
}

export function MineView() {
  const rows = useMine();
  return (
    <Chrome view="mine">
      <Rows rows={rows} />
    </Chrome>
  );
}

export interface SearchViewProps {
  /** The search text from ?q= (may be empty when search was just opened). */
  q: string;
}

export function SearchView({ q }: SearchViewProps) {
  const hits = useSearch(q);
  return (
    <div style={{ minHeight: '100dvh' }}>
      <div style={{ display: 'flex', gap: 10, padding: '14px 12px 10px' }}>
        <input
          aria-label="Search requests"
          defaultValue={q}
          autoFocus
          onChange={(e) => navigate({ q: e.currentTarget.value }, { replace: true })}
          style={{ flex: 1, fontSize: 16, height: 38, padding: '0 10px' }}
        />
        <Button variant="ghost" color="gray" onClick={() => navigate({}, { replace: true })}>
          Cancel
        </Button>
      </div>
      <Text as="div" size="1" color="gray" style={{ padding: '2px 16px 8px' }}>
        {hits.length} {hits.length === 1 ? 'result' : 'results'}
      </Text>
      <Rows rows={hits.map((h) => h.row)} />
    </div>
  );
}
