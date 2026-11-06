'use client';
// Temporary (Jeffrey, 2026-11-06 10:44): the log holds illustrative example requests until doors open. At 12:30 PM
// ET a one-time database job clears the log and restarts numbering at 1, and this banner hides itself at the same
// moment. Delete this file once the event has started.
import { FlaskConical } from 'lucide-react';
import { useEffect, useState } from 'react';
import styles from './ui.module.css';

/** 12:30 PM ET on Fri Nov 6, 2026 (EST, UTC−5). */
export const TEST_DATA_UNTIL = Date.parse('2026-11-06T17:30:00Z');

export function TestDataBanner() {
  const [show, setShow] = useState(() => Date.now() < TEST_DATA_UNTIL);
  useEffect(() => {
    if (!show) return;
    const timer = setTimeout(() => setShow(false), Math.max(0, TEST_DATA_UNTIL - Date.now()));
    return () => clearTimeout(timer);
  }, [show]);
  if (!show) return null;
  return (
    <div role="note" className={styles.testBanner} data-testid="test-data-banner">
      <FlaskConical size={20} aria-hidden style={{ flex: 'none' }} />
      <div className={styles.testBannerText}>
        <strong>Test data</strong>
        <span>These requests are examples. The log clears and restarts at 12:30 PM, when doors open.</span>
      </div>
    </div>
  );
}
