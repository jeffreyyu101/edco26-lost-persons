'use client';
// The `/` page shell (spec §7 One route, v2.1 A22/A23): the store provider, the client view router and
// the hosts for banners, toasts, the Undo snackbar, alerts (chime / vibration), the outbox operator prompt,
// Web Push and Activity (F4, with the Alerts sheet that replaced the "Alerts are on" sheet), and the offline
// precache. Views are separate chunks loaded with next/dynamic
// (client-only: the server HTML never contains request data); all of them are prefetched after the first
// idle and then handed to the service worker (A15) so they work offline later.
//
// Desk (from 768 px, components/desk): the same views inside the desk frame. The main column keeps a list
// or the dashboard; a request (?r=) opens beside it in the detail pane, and a form (?new=1, edit,
// needs attention) opens over it as a dialog. A form keeps one place in the tree at every width (after the
// main column's view), so crossing 768 px (an iPad mini rotated, a window snapped to half a screen) only
// changes how it is presented and never drops what is being typed. The frame is CSS-only and always
// rendered (no layout flash); its sidebar, top bar, pane header and keyboard come from the desk
// chunk, loaded only on the desk. All
// requests, My requests and Search are the desk's request table there (components/desk/table, its own
// chunk, also desk only); Pending and the dashboard render their views as they are.
// All requests opens with Jeffrey's brand row above the top bar (the phone's compact row, F1.1, with its X
// and "Show header"); it is drawn from the server on (no data in it), so it is there at the first paint, and
// dropped once hydrated on a phone, whose list has its own (until then it is display: none there, and its
// lazy logos are never fetched), or when its X hid it on this device (lib/brand-pref.ts keeps that one
// hidden before hydration too).
// Under 768 px the view router renders exactly what it always did.
import dynamic from 'next/dynamic';
import { Suspense, useCallback, useEffect, type ReactNode } from 'react';
import { isDeskNow, useHydrated, useIsDesk } from '@/components/desk/breakpoints';
import { DeskFrame, useBrandInHtml } from '@/components/desk/DeskFrame';
import { useMainView } from '@/components/desk/use-main-view';
import { isFormView, paneRequestId, type MainView } from '@/components/desk/views';
import { ProfileSkeleton, RowSkeletons } from '@/components/ui/Skeleton';
import { Snackbar, Toaster } from '@/components/ui/Toast';
import { useView, type View, type ViewName } from '@/lib/client/nav';
import { StoreProvider } from '@/lib/client/store';
import { useActions, useAppStore, usePrefs, useSnackbar, useStoreSelector, useToasts, type StoreState } from '@/lib/client/store-contract';
import { followSystemTheme } from '@/lib/theme';

const loadList = () => import('@/components/list/ListViews');
const loadForm = () => import('@/components/request-form/RequestFormView');
const loadProfile = () => import('@/components/profile/ProfileView');
const loadDashboard = () => import('@/components/dashboard/DashboardView');
const loadDialogs = () => import('@/components/ui/ShellDialogs');
// Photo compression (store.actions.preparePhoto) is its own chunk: without it, a photo can't be added to a
// new request once the phone is offline.
const loadImage = () => import('@/lib/client/image');
// The alert chime and vibration (lib/client/chime.ts, see ShellHosts): its own chunk, so the first load (A25) does
// not carry it; loaded when the shell mounts, and prefetched and cached with the views.
const loadChime = () => import('@/lib/client/chime');
const VIEW_CHUNKS = [loadList, loadForm, loadProfile, loadDashboard, loadDialogs, loadImage, loadChime];
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
// The shell's fallback banner (ShellBanners: a phone's request page until its chunk is in) loads like the views
// that draw their own, so the banner and the live status it derives stay off the first load (A25 budget). It is
// the same module the views import: the shell's copy still steps aside while a view's is mounted.
const ConnectionBanner = dynamic(() => import('@/components/ui/Banner').then((m) => m.ConnectionBanner), { ssr: false });
// Web Push and Activity (F4): starts after hydration, through the dialogs chunk (no new first-load entry, A25).
const ActivityHost = dynamic(() => loadDialogs().then((m) => m.ActivityHost), { ssr: false });
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
  /**
   * The desk's brand row, rendered by the page (a server component): <BrandCard logoLoading="lazy" />. Shown
   * above the top bar on All requests from 768 px, unless its X hid it on this device.
   */
  brand?: ReactNode;
}

export function AppShell({ brand = null }: AppShellProps) {
  return (
    <StoreProvider>
      <Suspense fallback={<RowSkeletons />}>
        <ShellBanners />
        <ViewRouter brand={brand} />
      </Suspense>
      <ShellHosts />
    </StoreProvider>
  );
}

function ViewRouter({ brand }: { brand: ReactNode }) {
  const view = useView();
  const desk = useIsDesk();
  const main = useMainView(view);
  const hydrated = useHydrated();
  const paneId = desk ? paneRequestId(view) : null;
  const prefs = usePrefs();
  const actions = useActions();
  // All requests only (Brian, 2026-11-06: Pending and My requests get no brand row). The server draws it
  // for All at every width; the hydration render keeps whatever the HTML has (useBrandInHtml: the service
  // worker's cached shell may have been drawn for another view; a row hidden on this device is in it too,
  // display: none from the pre-paint script); once hydrated, the desk only, unless its X hid it.
  const brandInHtml = useBrandInHtml(main.name === 'all');
  const showBrand = hydrated ? desk && main.name === 'all' && !prefs.brandHidden : brandInHtml;
  const hideBrand = useCallback(() => actions.setPref('brandHidden', true), [actions]);
  const form = isFormView(view) ? view : null;
  return (
    <>
      <DeskFrame
        desk={desk}
        nav={desk ? <DeskNav main={main} pane={paneId !== null} /> : null}
        brand={showBrand ? brand : null}
        onHideBrand={hideBrand}
        top={desk ? <DeskTop main={main} pane={paneId !== null} /> : null}
        pane={
          paneId ? (
            <DeskPane id={paneId} main={main}>
              <PaneProfileView id={paneId} presentation="panel" />
            </DeskPane>
          ) : null
        }
      >
        {desk ? deskMainElement(main, paneId) : form ? null : viewElement(view, false)}
        {/* The form, in this one place at every width: the phone's full-screen page under 768 px (here, in the
            main content, exactly where it always was), the side sheet at 768-1023 and the centred modal from
            1024 (components/request-form/presentation.ts), which portal a dialog over the list and the pane.
            The form's values live in its own state: a place that changed with the width would remount it
            and lose an unsaved edit. */}
        {form ? viewElement(form, desk) : null}
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
 * pane highlighted; Pending (told which request is open, so a stacked board shows its queue) and the
 * dashboard as their views.
 */
function deskMainElement(main: MainView, selected: string | null) {
  switch (main.name) {
    case 'pending':
      return <PendingView selected={selected} />;
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
  const offlineReady = useStoreSelector(selectOfflineReady);

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

  // Alerts: the store shows the toast; this host adds the chime (once a tap unlocked audio) and vibration. Both
  // are lib/client/chime.ts, its own chunk (loadChime): the first load (A25) does not carry it.
  useEffect(() => {
    let off: (() => void) | null = null;
    let gone = false;
    loadChime().then(
      (m) => {
        if (!gone) off = m.installAudioUnlock();
      },
      () => undefined,
    );
    return () => {
      gone = true;
      off?.();
    };
  }, []);
  useEffect(
    () =>
      actions.subscribeAlerts(() => {
        loadChime().then(
          (m) => {
            m.playChime();
            m.vibrate();
          },
          () => undefined,
        );
      }),
    [actions],
  );

  const answerPrompt = useCallback((send: boolean) => void actions.outbox.answerPrompt(send), [actions]);

  return (
    <>
      <Toaster toasts={toasts} onDismiss={actions.dismissToast} />
      <Snackbar snackbar={snackbar} onUndo={(id) => void actions.undo(id)} onDismiss={actions.dismissSnackbar} />
      {prompt ? <OutboxPromptDialog prompt={prompt} onAnswer={answerPrompt} /> : null}
      <ActivityHost />
    </>
  );
}
