# MyBeam — Future Plans

Each phase below ships working on its own. No big-bang rewrites. Each one is
one or two commits you can `git revert` if it goes wrong.

Order matters: later phases assume the earlier ones exist.

---

## Phase 0 — You are here

**Status: shipping now.**

- `.gitignore`, `README.md`, `FUTURE_PLANS.md`, `LICENSE`, `package.json`
- No behavior change. Just makes the project safe to push to GitHub.

**Exit criteria:** `git push` works and the repo looks presentable.

---

## Phase 1 — Publish to GitHub

**Goal:** one button in the workstation UI that commits the current workspace
and pushes to a configured remote.

**What we add:**

- A `/publish` endpoint on the server that runs `git add -A && git commit -m <msg> && git push`
- A "Publish" button in the header, with a small text field for the commit message
- Status feedback (spinner → "Published" → fade out)
- Settings for which remote/branch (default: `origin/main`)
- Safety: dry-run by default the first time, and never force-push

**What we don't do yet:** branch management, PR creation, conflict resolution.

**Exit criteria:** you can hit the button and see the commit on GitHub.

---

## Phase 2 — Workspace and file reading

**Goal:** the model can *see* the files in your project.

**What we add:**

- A "workspace" concept: a folder on disk the UI treats as the current project
- A file tree panel (collapsible sidebar) showing the workspace
- The ability to attach a file to a message ("@filename" in the composer)
- Server-side file reading, cached in `.workspace/` (gitignored) with mtime checks
- Only allow reading within the workspace root — no `../` escapes

**What we don't do yet:** writing. Reading only.

**Exit criteria:** you can say "explain what server.js does" and the model has
the actual file contents in context.

---

## Phase 3 — Disk writes and the agent loop

**Goal:** the model can write files back to your project.

**What we add:**

- A tool-call protocol between the model and the server (model emits a special
  code block like ` ```write path/to/file.js `, server executes it)
- Confirmation UI: the file write shows up as a card with Accept / Reject
- Optional auto-accept mode for trusted paths
- The CodeDrop-style "write directly to disk" the extension already does today,
  but driven by the model instead of by you pasting
- Basic diff view before writing

**What we don't do yet:** multi-step reasoning. Each turn is still one write.

**Exit criteria:** you can say "make the header sticky" and get an actual edit
in your working tree.

---

## Phase 4 — Plan mode

**Goal:** the model plans before it executes.

**What we add:**

- A "Plan" toggle in the composer. When on, the model's first reply is a *plan*
  — an ordered list of steps — and nothing is written
- The plan shows up as a checklist with Approve / Edit / Reject buttons
- On approve, the model executes each step in sequence, pausing between steps
  so you can review or interrupt
- On reject, the plan goes back to the model for revision

**What we don't do yet:** autonomous planning without approval. Every plan
requires a human click before it runs.

**Exit criteria:** you can ask for a multi-file change and watch it happen step
by step, with the ability to stop it mid-way.

---

## Phase 5 — Memory pipeline

**Goal:** never lose context, even across sessions, models, or long
conversations.

**The problem:** every LLM has a context window. Once you exceed it, either the
oldest messages get dropped (you lose information) or the request fails.

**The design:**

1. **Full transcript on disk.** Every message is stored verbatim in
   `.workspace/transcripts/<conversation-id>.jsonl`. This is the source of
   truth, and it survives everything.

2. **Rolling summaries.** When a conversation exceeds N tokens, the oldest
   chunk is summarized by the model into a compact paragraph. That paragraph
   becomes the new "start" of the working context. We keep the last K messages
   verbatim for continuity.

3. **Retrieval.** When a new user message arrives, we embed it (locally, via a
   small model) and search the full transcript for the top-M most relevant
   past turns. Those get prepended to the context as "relevant history."

4. **Session handoff.** Because everything lives on disk, you can kill the
   browser tab, restart the server, switch models, or come back a week later —
   and the conversation resumes as if nothing happened.

**What we don't do:** real-time multi-user sync. This is single-user, single-machine.

**Exit criteria:** a 500-message conversation stays coherent across restarts,
and the model can answer "what did we decide about X three hours ago?"

---

## Phase 6 — Voice

**Goal:** the workstation talks.

**What we add:**

- A voice output toggle in the header
- Replies get piped to a TTS service (Fish Audio, ElevenLabs, or a local model
  — pluggable adapter)
- Streaming audio: TTS starts speaking as soon as the first sentence is ready,
  not after the whole reply finishes
- Playback controls: pause, resume, skip, interrupt
- Optional: voice input too (Whisper or browser Web Speech API)

**What we don't do:** voice cloning, custom voice training. Use the provider's
existing voices.

**Exit criteria:** you toggle voice on, send a message, and hear the reply
spoken naturally while you're still reading it.

---

## Phase 7 — Multi-provider

**Goal:** MyBeam isn't married to one chat site.

**What we add:**

- A provider adapter interface (`sendMessage`, `readReply`, `attachImage`)
- A provider picker in the settings
- Adapters for oxalpha, a couple of other web chat UIs, and a direct API mode
  (so you can point it at any OpenAI-compatible endpoint)

**Why we do this last:** every earlier phase is easier to build for one
provider, then generalize. If we tried to build this first, we'd be designing
an interface against zero real implementations.

**Exit criteria:** switching providers in the UI just works, and the conversation
history follows you.

---

## How we work

- **One phase at a time.** No mixing.
- **Each phase is a branch.** `phase-1-publish`, `phase-2-workspace`, etc.
  Merge to `main` only when it's working end to end.
- **Each phase has a rollback story.** Usually `git revert <merge-commit>`.
- **The current phase always works.** No "we'll fix that in the next phase."
- **The UI never lies.** If something is disabled or failing, it says so.

If a phase turns out to be too big, we split it. We don't skip ahead.