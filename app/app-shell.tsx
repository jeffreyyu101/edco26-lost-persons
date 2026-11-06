'use client';
// The `/` page shell (spec §7 One route, v2.1 A22/A23): the store provider, the client view router and
// the hosts for banners, toasts, the Undo snackbar, alerts (chime / vibration), the outbox operator prompt,
// the "Alerts are on" sheet, and the offline precache. Views are separate chunks loaded with next/dynamic
// (client-only: the server HTML never contains request data); all of them are prefetched after the first
// idle and then handed to the service worker (A15) so they work offline later.
import dynamic from 'next/dynamic';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionBanner } from '@/components/ui/Banner';
import { ProfileSkeleton, RowSkeletons } from '@/components/ui/Skeleton';
import { Snackbar, Toaster } from '@/components/ui/Toast';
import { installAudioUnlock, playChime, vibrate } from '@/lib/client/chime';
import { useView, type ViewName } from '@/lib/client/nav';
import { StoreProvider } from '@/lib/client/store';
import { useAppStore, usePrefs, useSnackbar, useStoreSelector, useToasts, type StoreState } from '@/lib/client/store-contract';
import { followSystemTheme } from '@/lib/theme';

const loadList = () => import('@/components/list/ListViews');
const loadForm = () => import('@/components/request-form/RequestFormView');
const loadProfile = () => import('@/components/profile/ProfileView');
const loadDashboard = () => import('@/components/dashboard/DashboardView');
const loadDialogs = () => import('@/components/ui/ShellDialogs');
// Photo compression (store.actions.preparePhoto) is its own chunk: without it, a photo can't be added to a
// new request once the phone is offline.
const loadImage = () => import('@/lib/client/image');
const VIEW_CHUNKS = [loadList, loadForm, loadProfile, loadDashboard, loadDialogs, loadImage];

const listLoading = () => <RowSkeletons />;
const AllView = dynamic(() => loadList().then((m) => m.AllView), { ssr: false, loading: listLoading });
const PendingView = dynamic(() => loadList().then((m) => m.PendingView), { ssr: false, loading: listLoading });
const MineView = dynamic(() => loadList().then((m) => m.MineView), { ssr: false, loading: listLoading });
const SearchView = dynamic(() => loadList().then((m) => m.SearchView), { ssr: false, loading: listLoading });
const RequestFormView = dynamic(() => loadForm().then((m) => m.RequestFormView), { ssr: false });
const ProfileView = dynamic(() => loadProfile().then((m) => m.ProfileView), { ssr: false, loading: () => <ProfileSkeleton /> });
const DashboardView = dynamic(() => loadDashboard().then((m) => m.DashboardView), { ssr: false });
const OutboxPromptDialog = dynamic(() => loadDialogs().then((m) => m.OutboxPromptDialog), { ssr: false });
const BellIntroSheet = dynamic(() => loadDialogs().then((m) => m.BellIntroSheet), { ssr: false });

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
      return <AllView status={view.status} post={view.post} open={!!view.open} />;
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

/**
 * Views that show the connection state in their own layout, where the mockups put it: the lists between
 * the header and the view bar (or the "Can't reach the log" empty state before any data), the form under
 * its top bar, the dashboard as its Live / Offline pill. The profile places a <ConnectionBanner /> under its
 * top bar, which makes this fallback copy step aside once the profile chunk has loaded.
 */
const OWN_CONNECTION_UI: ReadonlySet<ViewName> = new Set(['all', 'pending', 'mine', 'search', 'new', 'edit', 'outbox', 'dashboard']);

function ShellBanners() {
  const view = useView();
  if (OWN_CONNECTION_UI.has(view.name)) return null;
  return <ConnectionBanner placement="shell" />;
}

const selectPrompt = (s: StoreState) => s.outboxPrompt;
const selectOfflineReady = (s: StoreState) => s.offlineReady;

function ShellHosts() {
  const store = useAppStore();
  const actions = store.actions;
  const toasts = useToasts();
  const snackbar = useSnackbar();
  const prompt = useStoreSelector(selectPrompt);
  const prefs = usePrefs();
  const offlineReady = useStoreSelector(selectOfflineReady);
  const [bellIntro, setBellIntro] = useState(false);
  const bellWasOn = useRef<boolean | null>(null);

  // Prefetch every view chunk after the first idle, then let the service worker cache them all (A15). If the
  // signal dropped before every chunk arrived, try again when the phone is back online.
  useEffect(() => {
    let cancelled = false;
    const prefetch = () => {
      void Promise.allSettled(VIEW_CHUNKS.map((load) => load())).then((results) => {
        if (cancelled) return;
        void actions.prepareOffline?.();
        if (results.some((r) => r.status === 'rejected')) window.addEventListener('online', prefetch, { once: true });
      });
    };
    const stop = () => {
      cancelled = true;
      window.removeEventListener('online', prefetch);
    };
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(prefetch, { timeout: 4_000 });
      return () => {
        stop();
        window.cancelIdleCallback(id);
      };
    }
    const id = setTimeout(prefetch, 1_500);
    return () => {
      stop();
      clearTimeout(id);
    };
  }, [actions]);

  // <html data-offline-ready="true"> once every view chunk is cached by the service worker (A15), like
  // data-hydrated: QA and the offline specs wait for it before going offline.
  useEffect(() => {
    if (offlineReady) document.documentElement.dataset.offlineReady = 'true';
  }, [offlineReady]);

  // Auto theme follows the phone's setting live.
  useEffect(() => followSystemTheme(), []);

  // Alerts: the store shows the toast; this host adds the chime (once a tap unlocked audio) and vibration.
  useEffect(() => installAudioUnlock(), []);
  useEffect(
    () =>
      actions.subscribeAlerts(() => {
        playChime();
        vibrate();
      }),
    [actions],
  );

  // "Alerts are on": only the first time the bell is switched on (not when it was already on at load: the
  // first run reads the store itself, because the hydration render still carries the server's prefs).
  useEffect(() => {
    const was = bellWasOn.current;
    bellWasOn.current = prefs.bell;
    if (was === null) {
      bellWasOn.current = store.getState().prefs.bell;
      return;
    }
    if (!was && prefs.bell && !prefs.bellIntroSeen) {
      setBellIntro(true);
      actions.setPref('bellIntroSeen', true);
    }
  }, [actions, store, prefs.bell, prefs.bellIntroSeen]);

  const answerPrompt = useCallback((send: boolean) => void actions.outbox.answerPrompt(send), [actions]);

  return (
    <>
      <Toaster toasts={toasts} onDismiss={actions.dismissToast} />
      <Snackbar snackbar={snackbar} onUndo={(id) => void actions.undo(id)} onDismiss={actions.dismissSnackbar} />
      {prompt ? <OutboxPromptDialog prompt={prompt} onAnswer={answerPrompt} /> : null}
      {bellIntro ? <BellIntroSheet open={bellIntro} onOpenChange={setBellIntro} /> : null}
    </>
  );
}
