'use client';
// The dashboard's compact Offline / Retrying chip: on the dashboard's title row on a phone, beside the top
// bar's title on the desk. Always in the tree so a change is announced; empty (and invisible) while live.
import { CloudOff, RefreshCw } from 'lucide-react';
import type { DashboardConnection } from './connection-signal';
import s from './dashboard.module.css';

export function DashboardConnectionChip({ state, className }: { state: DashboardConnection; className?: string }) {
  return (
    <span className={className ? `${s.conn} ${className}` : s.conn} role="status" data-state={state} data-testid="dashboard-connection">
      {state === 'offline' ? (
        <>
          <CloudOff size={14} aria-hidden />
          Offline
        </>
      ) : state === 'retrying' ? (
        <>
          <RefreshCw size={14} aria-hidden />
          Retrying
        </>
      ) : null}
    </span>
  );
}
