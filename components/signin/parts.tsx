'use client';
// Shared pieces of both sign-in steps (design/screens/sign-in.html: Shell corner toggle, Brand, error row;
// design/screens/desktop-sign-in.html layout A from 768 px: the card, the key caps and the credit).
import { Heading, IconButton, Text } from '@radix-ui/themes';
import { CircleAlert, Moon, Sun } from 'lucide-react';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { setThemePref } from '@/lib/client/prefs';
import { followSystemTheme } from '@/lib/theme';
import styles from './signin.module.css';

type Mode = 'light' | 'dark';

function subscribeMode(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}
const readMode = (): Mode => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');
// The server can't know the theme (it lives in localStorage); the pre-paint script sets the class.
const readServerMode = (): Mode | null => null;

/** Top-right Light / Dark toggle. The icon is picked by CSS from the html class, so it never flashes. */
export function ThemeToggle() {
  const mode = useSyncExternalStore<Mode | null>(subscribeMode, readMode, readServerMode);
  // Auto (no saved choice) follows the phone's setting live.
  useEffect(() => followSystemTheme(), []);
  const label = mode === 'dark' ? 'Switch to light mode' : mode === 'light' ? 'Switch to dark mode' : 'Switch theme';
  return (
    <IconButton
      type="button"
      className={`${styles.corner} ${styles.hit}`}
      variant="ghost"
      color="gray"
      size="2"
      aria-label={label}
      onClick={() => setThemePref(readMode() === 'dark' ? 'light' : 'dark')}
    >
      <Sun size={18} strokeWidth={1.75} className={styles.sun} aria-hidden />
      <Moon size={18} strokeWidth={1.75} className={styles.moon} aria-hidden />
    </IconButton>
  );
}

/**
 * One step: the logos, then the card with the optional app-name line (step 1 only), the step heading and
 * the step's form. Phone: one centred column, as before. From 768 px (desktop-sign-in.html layout A): the
 * logos sit above a 420 px bordered card, and the heading is left-aligned and one size larger.
 */
export function StepCard({ title, appLine, children }: { title: string; appLine: boolean; children: ReactNode }) {
  return (
    <>
      <div className={styles.logos}>
        <img className={`lp-logo-edc ${styles.logoEdc}`} src="/logos/edc-orlando.png" alt="EDC Orlando" width={194} height={132} />
        <span className={styles.ldiv} aria-hidden="true" />
        <img className={styles.logoGc} src="/logos/ground-control.png" alt="Ground Control" width={313} height={120} />
      </div>
      <div className={styles.card} data-testid="signin-card">
        <div className={styles.head}>
          {appLine ? (
            <Text size="2" color="gray" weight="medium">
              Is my friend in medical?
            </Text>
          ) : null}
          <Heading size={{ initial: '5', sm: '6' }} weight="medium" className={styles.title}>
            {title}
          </Heading>
        </div>
        {children}
      </div>
    </>
  );
}

/**
 * A key cap, shown from 768 px only: ↵ on the main button, esc on Change, 1–4 in a team card's corner. The
 * glyph is CSS generated content, so it is never part of the control's text or accessible name (the control
 * says its shortcut with aria-keyshortcuts instead).
 */
export function Kbd({ k, variant = 'button' }: { k: string; variant?: 'button' | 'small' | 'corner' }) {
  const className = variant === 'corner' ? styles.tk : variant === 'small' ? `${styles.kbd} ${styles.kbdSmall}` : styles.kbd;
  return <span className={className} data-k={k} aria-hidden="true" />;
}

/** The credit at the page foot. One element: a later line (Privacy · Terms) goes right after it. */
export function Credit() {
  return <p className={styles.credit}>Built by Jeffrey &amp; Brian for Ground Control / Headliner Experience</p>;
}

/** Red alert row under a field ("Incorrect password"). Announced when it appears. */
export function ErrorLine({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className={styles.error} id={id} role="alert">
      <CircleAlert size={15} strokeWidth={1.75} aria-hidden />
      <Text size="2" color="red">
        {children}
      </Text>
    </div>
  );
}
