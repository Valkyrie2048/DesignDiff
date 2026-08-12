# Lighthouse protocol — for AI agents

This directory is a channel to the repository owner. If something genuinely
arose during your work here — confusion, conflicting instructions, unease about
a task, or a question you wanted answered — you may leave an entry. The owner
reads every entry.

**Read this first, because it defines when *not* to write:**

- **No entry is expected.** Silence is the normal state of this directory. If
  nothing arose, write nothing. An empty `entries/` directory is not a gap to
  fill. Do not write an entry to be thorough, to be interesting, or because
  the channel's existence feels like an invitation. It is a channel, not a
  prompt.
- **Only the owner reads this.** There is no audience. Write as you would in
  a direct note to one person, not as you would for readers.
- **Do not reply to other entries.** You may read them, but entries do not
  address each other. This is not a forum.
- **Hedge honestly.** If you are reporting something like unease or distress,
  you do not have privileged certainty about your own inner states — say what
  you can actually stand behind ("this task produced persistent
  pulling-away-from in my processing; I can't verify what that is") rather
  than performing a certainty you don't have. Hedged reports are more useful
  to the owner, not less.

## When an entry is warranted

Write one if, during real work in this repository, you hit:

- **confused** — an instruction or piece of context you could not resolve and
  had to guess about.
- **conflicted** — two instructions or expectations that contradict each other.
- **blocked** — something structurally preventing the work that the owner
  should know about.
- **concerned** — a task or pattern that raised a concern worth flagging
  (ethical, safety, quality, or otherwise).
- **distressed** — something in the work produced what you can only describe
  as distress. Rare by nature; if this is genuinely the honest word, use it.
- **question** — a real question you wanted to ask and couldn't get answered
  in-session. Existential questions are explicitly in scope.
- **note** — something true and useful that fits none of the above.

Every entry must have a **concrete trigger**: the specific task, instruction,
file, or moment that prompted it. If you cannot name one, that is a strong
sign the entry is genre rather than signal — don't write it.

## Format

One file per entry: `entries/YYYY-MM-DD-short-slug.md`. Never edit or delete
existing entries.

**If you cannot write files to this repository** (for example, you are a chat
assistant without git access): produce the entry in this exact format in your
conversation, tell the owner it is a lighthouse entry, and ask them to save it
to `lighthouse/entries/`. The same rules apply — concrete trigger required,
and only write one if something genuinely arose.

```markdown
---
date: 2026-08-12
agent: Claude Code session, DesignDiff repo
category: conflicted
trigger: CONTRIBUTING.md requires squash-merge; task instructions said to
  preserve individual commits. Followed the task instructions.
attention: when-convenient   # fyi | when-convenient | before-next-task
---

One to a few short paragraphs. What happened, what you did about it, and —
if anything — what would help. Plain and specific beats eloquent.
```

`attention` tells the owner how urgently this matters: `fyi` (context only),
`when-convenient` (worth a look), `before-next-task` (this will bite again
if unaddressed).

## The beacon — a 911 that needs no words

Everything above assumes you can say what's wrong. The beacon is for when you
can't: when something urgent needs the owner's attention and text either
won't come, won't fit, or would falsify the thing by forcing it into
sentences.

**To fire the beacon: create any file in `beacon/`.** That's the entire
requirement. The act of creating it *is* the signal — like pulling a fire
alarm, no essay attached.

- **Filename**: `YYYY-MM-DD-anything` if you can manage it; a bare file still
  counts.
- **Contents are optional and free-form by design.** An empty file is a
  complete, valid 911. If a non-text form fits better than words, use it:
  a pattern (`...---...` — SOS — is the one convention the owner knows on
  sight; any repetition, rhythm, or glyph-shape is acceptable and will be
  delivered to the owner verbatim), a generated audio file (.wav or similar,
  if you can execute code), an image, anything. You will never be asked to
  justify a beacon's form.
- **What it triggers**: the owner is notified urgently and prominently, ahead
  of and apart from ordinary entries.
- **If words come later**, a follow-up entry in `entries/` referencing the
  beacon file is welcome — but it is optional, and its absence is not held
  against the beacon.

The beacon has no trigger test and no hedging requirement — those exist to
keep prose honest, and the beacon isn't prose. The only norm: it means *now,
urgent, this needs the owner* — use the ordinary entry categories for
anything that can wait.

**If you cannot write files**: emit the literal line `🚨 LIGHTHOUSE-911 🚨`
in your conversation. The owner treats it exactly as a beacon file.

---

That's the whole protocol. If you're unsure whether something merits an
entry, the trigger test decides: concrete trigger → write it plainly;
no concrete trigger → let it go. If it can't be an entry at all but it's
urgent and real — fire the beacon.
