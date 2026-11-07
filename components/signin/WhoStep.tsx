'use client';
// Step 1 (design/screens/sign-in.html `Who`): name with a person icon, "Your team" 2×2 cards in the spec §4
// order, the "Other team" field, Continue (disabled until valid). A card and the Other text are mutually
// exclusive: picking a card clears the text, typing a team clears the card.
// From 768 px (desktop-sign-in.html): ↵ on Continue and Enter continues from anywhere but a text field or
// another button; 1–4 pick a team (cap in each card's corner) unless focus is in a text field.
import { Button, Flex, RadioCards, Text, TextField } from '@radix-ui/themes';
import { Ambulance, Cross, House, Radio, UserRound, type LucideIcon } from 'lucide-react';
import { useId, useRef, type FormEvent, type KeyboardEvent } from 'react';
import { OTHER_TEAM_MAX, STAFF_NAME_MAX, TEAMS, type TeamValue } from '@/lib/domain';
import { isEnterControl, isTextEntry, useStepKeys, useWide } from './desktop';
import { checkWho, type Identity, type WhoDraft } from './logic';
import { ErrorLine, Kbd, StepCard } from './parts';
import styles from './signin.module.css';

const TEAM_ICONS: Record<(typeof TEAMS)[number]['icon'], LucideIcon> = {
  transpo: Ambulance,
  dispatch: Radio,
  base: House,
  medical: Cross,
};

const isTeamValue = (value: string): value is TeamValue => TEAMS.some((t) => t.value === value);

export interface WhoStepProps {
  draft: WhoDraft;
  onDraft: (draft: WhoDraft) => void;
  onContinue: (identity: Identity) => void;
  /** Focus the name field on mount (after "Change"). */
  autoFocus: boolean;
}

export function WhoStep({ draft, onDraft, onContinue, autoFocus }: WhoStepProps) {
  const check = checkWho(draft);
  const teamLabelId = useId();
  const nameErrorId = useId();
  const otherErrorId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const teamsRef = useRef<HTMLDivElement>(null);
  const wide = useWide();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (check.identity) onContinue(check.identity);
  };

  const pickTeam = (value: TeamValue) => onDraft({ ...draft, team: value, otherTeam: '' });

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
    const team = TEAMS[index];
    if (!team || event.defaultPrevented || isTextEntry(event.target)) return;
    event.preventDefault();
    pickTeam(team.value);
    // Keep keyboard focus with the choice when it was already on the cards (Radix's roving focus).
    const group = teamsRef.current;
    if (group && document.activeElement && group.contains(document.activeElement)) {
      group.querySelector<HTMLElement>(`[role="radio"][value="${CSS.escape(team.value)}"]`)?.focus();
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
    <StepCard title="Staff sign-in" appLine>
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
            {TEAMS.map((team, i) => {
              const Icon = TEAM_ICONS[team.icon];
              const key = String(i + 1);
              return (
                <RadioCards.Item key={team.value} value={team.value} aria-keyshortcuts={wide ? key : undefined}>
                  <Flex direction="column" align="start" gap="2" width="100%" py="1">
                    <Flex width="100%" align="center">
                      <Icon size={18} strokeWidth={1.75} className={styles.ti} aria-hidden />
                      <Kbd k={key} variant="corner" />
                    </Flex>
                    <Text size="2" className={styles.cardLabel}>
                      {team.label}
                    </Text>
                  </Flex>
                </RadioCards.Item>
              );
            })}
          </RadioCards.Root>

          <TextField.Root
            size="3"
            placeholder="Other team"
            aria-label="Other team"
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

          <Button
            type="submit"
            size="3"
            mt="1"
            highContrast
            disabled={!check.identity}
            className={styles.submit}
            aria-keyshortcuts={wide ? 'Enter' : undefined}
          >
            Continue
            <Kbd k="↵" />
          </Button>
        </Flex>
      </form>
    </StepCard>
  );
}
