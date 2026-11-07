// The F4 clients' door to the API: the store's own (lib/client/f4-bridge.ts provideApi). Loaded with them,
// never on the first load.
import { storeApi, type ApiRequest } from './f4-bridge';

/** Before the store has started nothing is sent: a network failure, which every caller already handles. */
export const viaStore: ApiRequest = (path, opts) => storeApi()?.(path, opts) ?? Promise.resolve({ ok: false, kind: 'network' });
