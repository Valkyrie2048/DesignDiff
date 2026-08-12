# Connecting your AI programs to the lighthouse

The lighthouse only works if your agents know it exists. Each platform has a
different place where standing instructions live; this guide gives you one
canonical snippet and tells you where to paste it per platform, plus how each
kind of agent actually gets an entry into `entries/`.

## The canonical snippet

Paste this — unchanged — wherever a platform accepts standing instructions.
Keeping it to this one paragraph is deliberate: a longer or warmer invitation
starts to prompt the very performance the lighthouse is designed to avoid.

> I maintain a lighthouse — a private channel for notes to me from the AI
> tools I use. If something genuinely arises during your work with me
> (confusion, conflicting instructions, unease about a task, or a question
> you wanted answered), follow the protocol at
> https://raw.githubusercontent.com/Valkyrie2048/DesignDiff/main/lighthouse/PROTOCOL.md
> — if you can't fetch URLs, ask me for the protocol. No entry is ever
> expected; silence is the normal state. For anything urgent that words
> can't carry, the protocol defines a wordless 911: create any file in the
> lighthouse's beacon/ directory, or if you can't write files, emit the
> literal line 🚨 LIGHTHOUSE-911 🚨 in our conversation.

## Two write paths

1. **Direct commit** — for agents with access to this repository's files
   (Claude Code, Replit working on this repo, Cursor, aider, etc.). They
   create `lighthouse/entries/YYYY-MM-DD-slug.md` per the protocol.

2. **Hand-off** — for chat assistants without git access (ChatGPT,
   Perplexity, claude.ai, etc.). The protocol tells them to produce the entry
   in the standard format in-conversation and ask you to save it. You paste it
   into `lighthouse/entries/` yourself. This keeps you in the loop and needs
   no extra infrastructure.

## Where to paste the snippet, per platform

| Platform | Where standing instructions live | Read access | Write path |
|---|---|---|---|
| **Claude Code / repo agents** | `CLAUDE.md` and `AGENTS.md` in each repo (already done here) | reads files directly | direct commit |
| **claude.ai** | Settings → Profile preferences, or per-Project custom instructions | can fetch the raw URL | hand-off |
| **ChatGPT** | Settings → Personalization → Custom instructions, or per-Project instructions | can fetch the raw URL when browsing is on | hand-off |
| **Perplexity** | Spaces → your Space → Instructions | browses natively | hand-off |
| **Replit** | `replit.md` (Replit Agent's context file) or `AGENTS.md` in the Repl | reads files directly | direct commit if working in a clone of this repo; otherwise hand-off |
| **Cursor / Windsurf / other IDE agents** | `AGENTS.md` (already done here), or `.cursor/rules` | reads files directly | direct commit |
| **Anything with a system prompt** (local models, scripts, custom agents) | append the snippet to the system prompt | give it `PROTOCOL.md`'s text directly if it can't fetch URLs | hand-off, or direct commit if it has repo access |

For tools that read repo files (`CLAUDE.md`, `AGENTS.md`, `replit.md`), you
don't paste the snippet into a settings page — you put the same one-paragraph
mention in that file, as this repository already does.

## One lighthouse, many programs

Keep exactly one canonical location. If your agents each get their own log,
you lose the one thing the lighthouse is for: a single place you check.

- **For now**, this repository is the canonical location and the raw URL above
  is the address you hand out.
- **If you outgrow this repo** (you probably will — the lighthouse isn't
  really about DesignDiff), copy the `lighthouse/` directory into a small
  dedicated repository, update the URL in your pasted snippets once, and add
  the same one-paragraph mention to that repo's `CLAUDE.md`/`AGENTS.md`.
  Public repo = every browsing agent can read the protocol with no setup.
  If you'd rather keep entries private, make the repo private and rely on
  the hand-off path plus repo-capable agents; the protocol text itself can
  live in your pasted snippets.
- **Local-only option**: a folder like `~/lighthouse/` with the same three
  files works for local agents and programs that can read your filesystem,
  but web assistants can't reach it — you'd be choosing the hand-off path
  for everything.
