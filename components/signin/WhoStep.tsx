'use client';
// Step 1 (design/screens/sign-in.html `Who`): name with a person icon, "Your team" cards (two columns: the teams of
// the events running now, in setup order, from the server page), the "Other team" field, Continue (disabled until valid). A card and the Other text are mutually
// exclusive: picking a card clears the text, typing a team clears the card.
// From 768 px (desktop-sign-in.html): ↵ on Continue and Enter continues from anywhere but a text field or
// another button; 1–4 pick a team (cap in each card's corner) unless focus is in a text field.
// With a team join link (J1) the screen is the same; Continue signs in itself (`submitting`, `message`,
// `locked` after a 429), and only screen readers hear that it uses the link.
import { Button, Flex, RadioCards, Text, TextField, VisuallyHidden } from '@radix-ui/themes';
import { Ambulance, Cross, House, Radio, UserRound, UsersRound, type LucideIcon } from 'lucide-react';
import { useId, useRef, type FormEvent, type KeyboardEvent } from 'react';
import { OTHER_TEAM_MAX, STAFF_NAME_MAX } from '@/lib/domain';
import { isEnterControl, isTextEntry, useStepKeys, useWide } from './desktop';
import { checkWho, type Identity, type SignInTeam, type WhoDraft } from './logic';
import { ErrorLine, Kbd, StepCard } from './parts';
import styles from './signin.module.css';

/** A card's icon: the medical team's cross; otherwise one that matches the team's words, else people. */
function teamIcon(team: SignInTeam): LucideIcon {
  if (team.medical) return Cross;
  const words = `${team.label} ${team.short}`.toLowerCase();
  if (/transpo|transport|ambulance/.test(words)) return Ambulance;
  if (/dispatch|radio|comms/.test(words)) return Radio;
  if (/\bbase\b/.test(words)) return House;
  return UsersRound;
}

export interface WhoStepProps {
  /** (Events) The cards: every running event's teams (none: the Other field alone). */
  teams: readonly SignInTeam[];
  /** (Events) The event logo beside Ground Control's (a join link names its event), or null. */
  eventLogo?: string | null;
  draft: WhoDraft;
  onDraft: (draft: WhoDraft) => void;
  onContinue: (identity: Identity) => void;
  /** Focus the name field on mount (after "Change"). */
  autoFocus: boolean;
  /** Continue is signing in (a team join link): it shows a spinner and ignores presses. */
  submitting?: boolean;
  /** Why the last sign-in with the link didn't go through (signal, server, too many attempts), above Continue. */
  message?: string | null;
  /** Too many attempts with the link: Continue stays disabled until the lock passes. */
  locked?: boolean;
  /** Screen-reader description of Continue (a team join link signs in with it). */
  continueHint?: string | null;
}

export function WhoStep({ teams, eventLogo = null, draft, onDraft, onContinue, autoFocus, submitting = false, message = null, locked = false, continueHint = null }: WhoStepProps) {
  const check = checkWho(draft, teams);
  const teamLabelId = useId();
  const nameErrorId = useId();
  const otherErrorId = useId();
  const messageId = useId();
  const hintId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const teamsRef = useRef<HTMLDivElement>(null);
  const wide = useWide();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (check.identity && !submitting && !locked) onContinue(check.identity);
  };

  const pickTeam = (value: string) => onDraft({ ...draft, team: value, otherTeam: '' });
  const isTeamValue = (value: string) => teams.some((t) => t.label === value);

  useStepKeys(wide, (event) => {
    if (event.key === 'Enter') {
      // Text fields submit natively (or drop focus, below); buttons and links keep their own Enter. A radio
      // card swallows Enter (WAI-ARIA), so from a card or the page Enter continues.
      if (isTextEntry(event.target) || isEnterControl(event.target)) return;
      event.preventDefault();
      formRef.current?.requestSubmit();
      return;
    }
    const index = ['1', '2', '3', '4'].indexOf(event.key);
    const team = teams[index];
    if (!team || event.defaultPrevented || isTextEntry(event.target)) return;
    event.preventDefault();
    pickTeam(team.label);
    // Keep keyboard focus with the choice when it was already on the cards (Radix's roving focus).
    const group = teamsRef.current;
    if (group && document.activeElement && group.contains(document.activeElement)) {
      group.querySelector<HTMLElement>(`[role="radio"][value="${CSS.escape(team.label)}"]`)?.focus();
    }
  });

  // Return on the name field with no team yet: drop the keyboard so the team cards are visible.
  const nameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !check.identity) {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };

  return (
    <StepCard title="Staff sign-in" appLine eventLogo={eventLogo}>
      <form ref={formRef} method="post" noValidate onSubmit={submit}>
        <Flex direction="column" gap="3">
          <TextField.Root
            size="3"
            placeholder="Your name"
            aria-label="Your name"
            value={draft.name}
            onChange={(e) => onDraft({ ...draft, name: e.target.value })}
            onKeyDown={nameKeyDown}
            autoComplete="name"
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            maxLength={STAFF_NAME_MAX}
            autoFocus={autoFocus}
            className={check.nameError ? styles.invalid : undefined}
            aria-invalid={check.nameError ? true : undefined}
            aria-describedby={check.nameError ? nameErrorId : undefined}
          >
            <TextField.Slot>
              <UserRound size={16} strokeWidth={1.75} aria-hidden />
            </TextField.Slot>
          </TextField.Root>
          {check.nameError ? <ErrorLine id={nameErrorId}>{check.nameError}</ErrorLine> : null}

          {teams.length > 0 ? (
          <>
          <Text as="div" size="2" color="gray" mt="1" id={teamLabelId}>
            Your team
          </Text>
          <RadioCards.Root
            ref={teamsRef}
            size="1"
            columns="2"
            gap="2"
            highContrast
            value={draft.team ?? ''}
            onValueChange={(value) => {
              if (isTeamValue(value)) pickTeam(value);
            }}
            aria-labelledby={teamLabelId}
          >
            {teams.map((team, i) => {
              const Icon = teamIcon(team);
              // 1–4 pick the first four teams from the keyboard.
              const key = i < 4 ? String(i + 1) : null;
              return (
                <RadioCards.Item key={team.label} value={team.label} aria-keyshortcuts={wide && key ? key : undefined}>
                  <Flex direction="column" align="start" gap="2" width="100%" py="1">
                    <Flex width="100%" align="center">
                      <Icon size={18} strokeWidth={1.75} className={styles.ti} aria-hidden />
                      {key ? <Kbd k={key} variant="corner" /> : null}
                    </Flex>
                    <Text size="2" className={styles.cardLabel}>
                      {team.short}
                    </Text>
                  </Flex>
                </RadioCards.Item>
              );
            })}
          </RadioCards.Root>
          </>
          ) : null}

          <TextField.Root
            size="3"
            placeholder={teams.length > 0 ? 'Other team' : 'Your team'}
            aria-label={teams.length > 0 ? 'Other team' : 'Your team'}
            value={draft.otherTeam}
            onChange={(e) => {
              const otherTeam = e.target.value;
              onDraft({ ...draft, otherTeam, team: otherTeam.trim() ? null : draft.team });
            }}
            autoComplete="off"
            autoCapitalize="words"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={OTHER_TEAM_MAX}
            className={check.otherTeamError ? styles.invalid : undefined}
            aria-invalid={check.otherTeamError ? true : undefined}
            aria-describedby={check.otherTeamError ? otherErrorId : undefined}
          />
          {check.otherTeamError ? <ErrorLine id={otherErrorId}>{check.otherTeamError}</ErrorLine> : null}
          {message ? <ErrorLine id={messageId}>{message}</ErrorLine> : null}

          <Button
            type="submit"
            size="3"
            mt="1"
            highContrast
            loading={submitting}
            // Radix only defaults `disabled` to `loading` when no disabled prop is given: say both.
            disabled={!check.identity || submitting || locked}
            className={styles.submit}
            aria-keyshortcuts={wide ? 'Enter' : undefined}
            aria-describedby={[continueHint ? hintId : null, message ? messageId : null].filter(Boolean).join(' ') || undefined}
          >
            Continue
            <Kbd k="↵" />
          </Button>
          {continueHint ? <VisuallyHidden id={hintId}>{continueHint}</VisuallyHidden> : null}
        </Flex>
      </form>
    </StepCard>
  );
}
