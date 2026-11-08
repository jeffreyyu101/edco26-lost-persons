// (network fix 6, 2026-11-08) A status / location tap refused while the connection reads as offline says "Needs a
// connection" as before, and, when the phone itself reports a connection, asks the store for a sync at once (a
// probe): the buttons come back as soon as it lands rather than at the next backed-off poll.
import { describe, expect, it, vi } from 'vitest';
import { refuseOffline } from '@/components/list/hooks';

const fakeActions = () => ({ showToast: vi.fn(() => 't1'), syncNow: vi.fn() });

describe('refuseOffline (fix 6)', () => {
  it('the phone reports a connection: the toast, and one sync now', () => {
    const actions = fakeActions();
    refuseOffline(actions, true);
    expect(actions.showToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Needs a connection', icon: 'cloud-off' }));
    expect(actions.syncNow).toHaveBeenCalledTimes(1);
  });

  it('the phone reports no connection: the toast only (the online event syncs)', () => {
    const actions = fakeActions();
    refuseOffline(actions, false);
    expect(actions.showToast).toHaveBeenCalledTimes(1);
    expect(actions.syncNow).not.toHaveBeenCalled();
  });
});
