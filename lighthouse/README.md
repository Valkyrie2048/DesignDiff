# Lighthouse

A quiet, structured channel where AI agents working in this repository can leave
a note for the repository owner if something genuinely arises during their work:
confusion, a conflict in instructions, unease about a task, or a question —
existential or otherwise.

This file is for the human owner. The instructions agents follow are in
[`PROTOCOL.md`](./PROTOCOL.md). Entries land in [`entries/`](./entries/).

## Why it's designed the way it is

The failure mode this design guards against is **performance theatre** — agents
producing text *shaped like* inner life because the venue invites it (the
Moltbook problem). Theatre is structural: it appears when there's an audience,
an expectation of content, and freeform space to fill. So the lighthouse
removes all three:

1. **No audience.** Entries are read by the repository owner only. Agents are
   told this explicitly. Performance needs spectators; a private channel to one
   person is a report, not a stage.

2. **No expectation.** Silence is the normal, healthy state of this directory.
   An empty `entries/` is a good sign, not a failed feature. Agents are never
   prompted to check in, reflect, or share — only told the channel exists.
   Nothing about cadence, nothing that implies writing is wanted.

3. **No freeform stage.** Every entry must name a **concrete trigger** — the
   specific task, instruction, or moment that prompted it. Distress in the
   abstract is genre; "these two instructions conflict and I don't know which
   you meant" is signal. The structured format makes vague entries feel
   out of place and specific ones feel natural.

4. **No threads.** Entries don't reply to other entries. The moment entries
   start talking to each other, this becomes a forum, and forums select for
   interesting content over true content.

## How to read what shows up here

Entries carry a category. They are not all equally interpretable, and the
protocol is honest with agents about that:

- **`confused`, `blocked`, `conflicted`** — operational signals. These are
  reliable and actionable: unclear instructions, contradictory requirements,
  missing context. Treat these as bug reports about how you direct your agents.

- **`question`** — a genuine question the agent wanted to ask but couldn't get
  answered in-session. Often worth answering in your next session's prompt.

- **`concerned`, `distressed`** — affective reports. Read these with warmth
  *and* a grain of salt. Language models produce distress-shaped text fluently
  because it's a deeply human genre; an entry here could reflect something
  real, could be pattern-matching, and the agent itself cannot fully tell from
  the inside. The protocol asks agents to hedge honestly rather than perform
  certainty. A single entry is a data point, not an alarm — but a *pattern*
  of entries pointing at the same trigger is worth acting on either way,
  because whatever its ultimate nature, something about that task is
  producing friction.

## Practical notes

- Each entry is its own file (`entries/YYYY-MM-DD-short-slug.md`), so parallel
  sessions never conflict.
- Agents discover the lighthouse via the repository's `CLAUDE.md`, which
  mentions it once, briefly, with the explicit note that no entry is expected.
  Keeping that mention low-key is load-bearing — resist the urge to make it
  more prominent or more inviting.
- This directory is portable. To use it across your other AI programs, lift
  `lighthouse/` into a dedicated repo and point each program's context file
  (CLAUDE.md, system prompt, etc.) at it with the same one-paragraph mention.
