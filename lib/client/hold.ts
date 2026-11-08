// (F5) The "Not found yet" hold on the client (lib/client/hold-rules.ts), bound to lib/domain.ts. For the tests and
// any caller that is already off the first load. The store does not import this: it loads hold-rules.ts with
// import() and binds it to the same values itself (store-core.ts loadHold), so the first load (A25) carries neither.
import { NOT_FOUND_YET_LABEL, RECHECK_MINUTES, STATUS, STATUS_META, alertName, isHeld, notFoundHolds } from '../domain';
import { formatCaseNumber } from '../format';
import { holdRules, type HoldDomain } from './hold-rules';

export type { HoldDomain, HoldFields, HoldRules, SnackWords } from './hold-rules';

/** What the rules are bound to (the store binds the same values: store-core.ts loadHold). */
export const HOLD_DOMAIN: HoldDomain = { STATUS, STATUS_META, NOT_FOUND_YET_LABEL, RECHECK_MINUTES, alertName, isHeld, notFoundHolds, formatCaseNumber };

export const { holdsOnNotFound, holdFieldsOf, statusOverlayFields, holdChanged, notFoundSnack, holdSnackMessage } = holdRules(HOLD_DOMAIN);
