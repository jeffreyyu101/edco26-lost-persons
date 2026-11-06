'use client';
// Sign-in (spec §8 Sign-in, sign-in.html): step 1 name + team, step 2 the event password. Remembered name
// and team skip to step 2. On success, go to `next` (already validated same-origin) or "/".
// Remembered identity and theme: lib/client/prefs.ts (this route has no StoreProvider). readPrefs() gives
// rememberedName / rememberedTeam (both or neither) to skip to step 2; after a successful POST
// /api/session call writeRememberedIdentity(staffName, team) with the response; "Change" calls
// clearRememberedIdentity(); the theme toggle calls setThemePref(). Never pick other storage keys.
// PLACEHOLDER (Phase 1a): the exported name and props are FINAL; B (Phase 2) builds the real flow.
import { Flex, Heading, Text } from '@radix-ui/themes';

export interface SignInFlowProps {
  /** Safe same-origin path to return to after sign-in (lib/safe-next), or null for "/". */
  next: string | null;
}

export function SignInFlow({ next }: SignInFlowProps) {
  return (
    <Flex direction="column" align="center" justify="center" gap="5" px="5" py="6" style={{ minHeight: '100dvh' }}>
      <Flex align="center" gap="4">
        <img src="/logos/edc-orlando.png" alt="EDC Orlando" height={44} className="lp-logo-edc" />
        <span style={{ width: 1, height: 32, background: 'var(--gray-a6)' }} />
        <img src="/logos/ground-control.png" alt="Ground Control" height={30} />
      </Flex>
      <Text size="2" color="gray">
        Is my friend in medical?
      </Text>
      <Heading size="6" weight="medium">
        Staff sign-in
      </Heading>
      <Text size="1" color="gray" data-next={next ?? '/'}>
        Built by Jeffrey &amp; Brian for Ground Control / Headliner Experience
      </Text>
    </Flex>
  );
}
