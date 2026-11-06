'use client';
// The `/` page shell (spec §7 One route, v2.1 A22/A23): the store provider, the client view router and
// the hosts for banners, toasts, the Undo snackbar, alerts (chime / vibration), the outbox operator prompt,
// the "Alerts are on" sheet, and the offline precache. Views are separate chunks loaded with next/dynamic
// (client-only: the server HTML never contains request data); all of them are prefetched after the first
// idle and then handed to the service worker (A15) so they work offline later.
//
// Desk (from 768 px, components/desk): the same views inside the desk frame. The main column keeps a list
// or the dashboard; a request (?r=) opens beside it in the detail pane, and a form (?new=1, edit,
// needs attention) opens over it. The frame is CSS-only and always rendered (no layout flash); its
// sidebar / rail, top bar, pane header and keyboard come from the desk chunk, loaded only on the desk. All
// requests, My requests and Search are the desk's request table there (components/desk/table, its own
// chunk, also desk only); Pending and the dashboard render their views as they are.
// Under 768 px the view router renders exactly what it always did.
import dynamic from 'next/dynamic';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { isDeskNow, useIsDesk } from '@/components/desk/breakpoints';
import { DeskFrame } from '@/components/desk/DeskFrame';
import { useMainView } from '@/components/desk/use-main-view';
import { isFormView, paneRequestId, type MainView } from '@/components/desk/views';
import { ConnectionBanner } from '@/components/ui/Banner';
import { TestDataBanner } from '@/components/ui/TestDataBanner';
import { ProfileSkeleton, RowSkeletons } from '@/components/ui/Skeleton';
import { Snackbar, Toaster } from '@/components/ui/Toast';
import { installAudioUnlock, playChime, vibrate } from '@/lib/client/chime';
import { useView, type View, type ViewName } from '@/lib/client/nav';
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
const loadDesk = () => import('@/components/desk/DeskChrome');
const loadDeskTable = () => import('@/components/desk/table/DeskTableViews');

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
// Desk only. The pane's profile skeleton has no chrome of its own: the pane draws the header.
const PaneProfileView = dynamic(() => loadProfile().then((m) => m.ProfileView), { ssr: false, loading: () => <ProfileSkeleton chrome={false} /> });
const DeskNav = dynamic(() => loadDesk().then((m) => m.DeskNav), { ssr: false });
const DeskTop = dynamic(() => loadDesk().then((m) => m.DeskTop), { ssr: false });
const DeskPane = dynamic(() => loadDesk().then((m) => m.DeskPane), { ssr: false });
const DeskKeys = dynamic(() => loadDesk().then((m) => m.DeskKeys), { ssr: false });
const DeskAllTable = dynamic(() => loadDeskTable().then((m) => m.DeskAllTable), { ssr: false, loading: listLoading });
const DeskMineTable = dynamic(() => loadDeskTable().then((m) => m.DeskMineTable), { ssr: false, loading: listLoading });
const DeskSearchTable = dynamic(() => loadDeskTable().then((m) => m.DeskSearchTable), { ssr: false, loading: listLoading });

export interface AppShellProps {
  eventTimezone: string;
}

export function AppShell({ eventTimezone }: AppShellProps) {
  return (
    <StoreProvider eventTimezone={eventTimezone}>
      <TestDataBanner />
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
  const desk = useIsDesk();
  const main = useMainView(view);
  const paneId = desk ? paneRequestId(view) : null;
  return (
    <>
      <DeskFrame
        desk={desk}
        nav={desk ? <DeskNav main={main} /> : null}
        top={desk ? <DeskTop main={main} /> : null}
        pane={
          paneId ? (
            <DeskPane id={paneId} main={main}>
              <PaneProfileView id={paneId} presentation="panel" />
            </DeskPane>
          ) : null
        }
        // The form picks its own presentation by width (components/request-form/presentation.ts): the side
        // sheet at 768-1023 and the centred modal from 1024 portal a dialog, so the layer stays empty and the
        // list (and the pane) show behind it; anything drawn in place would cover them.
        form={desk && isFormView(view) ? viewElement(view, true) : null}
      >
        {desk ? deskMainElement(main, paneId) : viewElement(view, false)}
      </DeskFrame>
      {desk ? <DeskKeys view={view} main={main} /> : null}
    </>
  );
}

/** The element for one view. On the desk, Search follows the top bar's field (?q=) by remounting per query. */
function viewElement(view: View, desk: boolean) {
  switch (view.name) {
    case 'all':
      return <AllView status={view.status} post={view.post} open={!!view.open} />;
    case 'pending':
      return <PendingView />;
    case 'mine':
      return <MineView />;
    case 'search':
      return desk ? <SearchView key={view.q} q={view.q} /> : <SearchView q={view.q} />;
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
 * The desk's main column: the request table for All, My requests and Search, with the request open in the
 * pane highlighted; Pending and the dashboard as their views.
 */
function deskMainElement(main: MainView, selected: string | null) {
  switch (main.name) {
    case 'all':
      return <DeskAllTable status={main.status} post={main.post} open={!!main.open} selected={selected} />;
    case 'mine':
      return <DeskMineTable selected={selected} />;
    case 'search':
      return <DeskSearchTable q={main.q} selected={selected} />;
    default:
      return viewElement(main, true);
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
  // On the desk the main column always holds a list or the dashboard, and the pane's profile and the forms
  // draw their own.
  const desk = useIsDesk();
  if (desk || OWN_CONNECTION_UI.has(view.name)) return null;
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
      const chunks = isDeskNow() ? [...VIEW_CHUNKS, loadDesk, loadDeskTable] : VIEW_CHUNKS;
      void Promise.allSettled(chunks.map((load) => load())).then((results) => {
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
