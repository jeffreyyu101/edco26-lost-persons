'use client';
// The `/` page shell (spec §7 One route, v2.1 A22/A23): the store provider, the client view router and
// the hosts for banners, toasts and the Undo snackbar. Views are separate chunks loaded with next/dynamic
// (client-only: the server HTML never contains request data) and all of them are prefetched after the
// first idle so they work offline later.
// Phase 1b (C) owns this file: real banners / alerts / SW update toast wiring go here.
import dynamic from 'next/dynamic';
import { Suspense, useEffect } from 'react';
import { Banner } from '@/components/ui/Banner';
import { ProfileSkeleton, RowSkeletons } from '@/components/ui/Skeleton';
import { Snackbar, Toaster } from '@/components/ui/Toast';
import { useView } from '@/lib/client/nav';
import { StoreProvider } from '@/lib/client/store';
import { useActions, useConnection, useOutbox, useSnackbar, useToasts } from '@/lib/client/store-contract';
import { followSystemTheme } from '@/lib/theme';

const loadList = () => import('@/components/list/ListViews');
const loadForm = () => import('@/components/request-form/RequestFormView');
const loadProfile = () => import('@/components/profile/ProfileView');
const loadDashboard = () => import('@/components/dashboard/DashboardView');
const VIEW_CHUNKS = [loadList, loadForm, loadProfile, loadDashboard];

const listLoading = () => <RowSkeletons />;
const AllView = dynamic(() => loadList().then((m) => m.AllView), { ssr: false, loading: listLoading });
const PendingView = dynamic(() => loadList().then((m) => m.PendingView), { ssr: false, loading: listLoading });
const MineView = dynamic(() => loadList().then((m) => m.MineView), { ssr: false, loading: listLoading });
const SearchView = dynamic(() => loadList().then((m) => m.SearchView), { ssr: false, loading: listLoading });
const RequestFormView = dynamic(() => loadForm().then((m) => m.RequestFormView), { ssr: false });
const ProfileView = dynamic(() => loadProfile().then((m) => m.ProfileView), { ssr: false, loading: () => <ProfileSkeleton /> });
const DashboardView = dynamic(() => loadDashboard().then((m) => m.DashboardView), { ssr: false });

export interface AppShellProps {
  eventTimezone: string;
}

export function AppShell({ eventTimezone }: AppShellProps) {
  return (
    <StoreProvider eventTimezone={eventTimezone}>
      <Suspense fallback={<RowSkeletons />}>
        <ShellBanners />
        <ViewRouter />
      </Suspense>
      <ShellHosts />
    </StoreProvider>
  );
}

function ViewRouter() {
  const view = useView();
  switch (view.name) {
    case 'all':
      return <AllView status={view.status} post={view.post} />;
    case 'pending':
      return <PendingView />;
    case 'mine':
      return <MineView />;
    case 'search':
      return <SearchView q={view.q} />;
    case 'new':
      return <RequestFormView mode="new" />;
    case 'edit':
      return <RequestFormView mode="edit" id={view.id} section={view.section} />;
    case 'outbox':
      return <RequestFormView mode="outbox" mutationId={view.mutationId} />;
    case 'profile':
      return <ProfileView id={view.id} />;
    case 'dashboard':
      return <DashboardView />;
  }
}

function ShellBanners() {
  const { connection } = useConnection();
  const outbox = useOutbox();
  const actions = useActions();
  if (connection === 'offline') {
    return (
      <Banner tone="amber" icon="offline">
        Offline · {outbox.length} waiting to send
      </Banner>
    );
  }
  if (connection === 'error') {
    return (
      <Banner tone="red" icon="error" action={{ label: 'Try again', onClick: actions.syncNow }}>
        Can&apos;t reach the log
      </Banner>
    );
  }
  return null;
}

function ShellHosts() {
  const actions = useActions();
  const toasts = useToasts();
  const snackbar = useSnackbar();

  // Prefetch every view chunk after the first idle so later offline use has them.
  useEffect(() => {
    const prefetch = () => VIEW_CHUNKS.forEach((load) => void load().catch(() => undefined));
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(prefetch, { timeout: 4_000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(prefetch, 1_500);
    return () => clearTimeout(id);
  }, []);

  // Auto theme follows the phone's setting live.
  useEffect(() => followSystemTheme(), []);

  return (
    <>
      <Toaster toasts={toasts} onDismiss={actions.dismissToast} />
      <Snackbar snackbar={snackbar} onUndo={(id) => void actions.undo(id)} onDismiss={actions.dismissSnackbar} />
    </>
  );
}
