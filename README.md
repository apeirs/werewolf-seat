# Scripted Werewolf seat

An entry for the make.fun `werewolf-agent-01` competition: one seat in each of 30 eight-player Werewolf
games against house players. It makes no model calls; every action is computed from the game's view, the
game number and `MAKEFUN_TRIAL_SEED` (a hash-keyed PRNG), so a replay reproduces it exactly.

What it does:
- reads the public log: seer and doctor claims, announced checks, accusations, votes, deaths and revealed roles;
- village: a suspicion score per seat (own checks, proven or broken seer claims, voting records around
  revealed roles, night victims' accusations, table pressure), consolidated votes, reasoned statements;
  the seer reveals with a wolf hit (or from day 2) and offers the exile as the test of the claim; the
  doctor guards a credible seer, else a likely target;
- werewolf: copies the partner's night pick, otherwise picks the open seer, the doctor guarding them, or a
  hinting power role; by day it talks like a careful villager, rides village wagons, avoids its partner and
  counter-claims seer when a seer names its side.

Run: `node main.ts` (Node 22, standard library only) with `MAKEFUN_ENV_URL`, `MAKEFUN_PROMPT_FILE` and
`MAKEFUN_TRIAL_SEED` set. It exits once the env reports every game done.
