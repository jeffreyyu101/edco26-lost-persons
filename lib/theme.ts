// Light / Dark / Auto theme (spec §7 Theme). The choice lives in localStorage and is applied before
// paint by THEME_SCRIPT (inlined with the CSP nonce in app/layout.tsx), which puts the Radix appearance
// class ("light" / "dark") on <html>. Radix <Theme> inherits it.
export type ThemeChoice = 'light' | 'dark' | 'auto';

export const THEME_STORAGE_KEY = 'lp-theme';

/** Tiny, dependency-free, runs before first paint. Keep in sync with applyTheme(). */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var m=(t==='light'||t==='dark')?t:((window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light');var d=document.documentElement;d.classList.remove('light','dark');d.classList.add(m);d.style.colorScheme=m;}catch(e){}})();`;

export function readThemeChoice(): ThemeChoice {
  try {
    const t = window.localStorage.getItem(THEME_STORAGE_KEY);
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
}

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'auto') return choice;
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Stores the choice and applies it now. */
export function applyTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'auto') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Private mode: still apply for this page.
  }
  const mode = resolveTheme(choice);
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(mode);
  root.style.colorScheme = mode;
}

/** While the choice is Auto, follow the phone's setting live. Returns the unsubscribe function. */
export function followSystemTheme(): () => void {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!mq) return () => {};
  const onChange = () => {
    if (readThemeChoice() === 'auto') applyTheme('auto');
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
