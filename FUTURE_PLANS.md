# MyBeam — Future Plans

Each phase ships working on its own. No big-bang rewrites.

---

## Shipped

### Phase 0 — Foundations
- `.gitignore`, `README.md`, `FUTURE_PLANS.md`, `LICENSE`, `package.json`
- Repo pushed to GitHub

### Phase 0a — Modular structure
- `server.js` split into `lib/` (`static`, `config`, `workspace`, `dialog`, `memory`, `provider`, `edits`, `apply`, `cancel`, `prompt`)
- UI split into `ui/index.html`, `ui/app.js`, `ui/style.css`
- Extension restructured into `content-core/` + `content-providers/`

### Phase 1 — Workspace
- Native Windows folder picker via PowerShell shim (`lib/dialog.js`)
- Sandboxed file reads and tree listing (`lib/workspace.js`)
- File tree sidebar, file preview pane with syntax highlighting
- Config persisted to `%APPDATA%\MyBeam\config.json`
- `.mybeam/` per-project state folder (memory, transcripts, history)

### Phase 2 — Multi-provider
- Provider abstraction: `oxalpha` + `deepseek` adapters
- Provider switcher in the header, active choice persisted
- Auto-switch on repeated failures (opt-in)
- SPA-navigation-aware retry (`navigated-retry`)
- Extension auto-recovery from invalidated contexts

### Phase 3 — Directives + disk writes
- AI emits `<<<NEW`, `<<<EDIT` (find/replace), `<<<DELETE`
- Server parses, shows an edit card (Ask mode), or auto-applies (Auto mode), or refuses (Read mode)
- Atomic writes, backups to `.mybeam/history/`, log to `.mybeam/memory/CHANGES.md`
- Strict parser strips site-injected chrome (`code`, `python`, `Copy`, `Download`)
- `CODEGEN_CHECKPOINT` (CodeDrop) format also supported

### Phase 4 — Session hygiene
- Context block wrapped only on the first user message of a session (or after 8h idle)
- Queued/running state clearly surfaced; queued messages can be cancelled
- Cancel button (running tasks), Cancel pill (queued tasks)
- Directives stripped from the display; only prose and edit cards shown

---

## Next

### Phase 5 — Project awareness
**Goal: the agent knows what's in your folder without being told.**

- On first workspace open (or on-demand Refresh), walk the tree
- Send the file list + sizes to the active model
- Get back a short `PROJECT_MAP.md`: what this project is, how it's organized, key files
- Write it to `.mybeam/memory/PROJECT_MAP.md`
- Prepend it (compressed) to the first message of every new session
- Refresh on demand or when the tree changes significantly

**Exit criteria:** open a folder you didn't write, ask "what's in here?", get a useful answer without describing anything.

### Phase 6 — Just-in-time file reads
**Goal: the agent can read files on its own.**

- `@filename` in the composer attaches a file's contents to the message
- `<<<READ path` directive in a reply: the server reads the file and sends it back as a new user turn
- Cap on reads per turn (say 10) to prevent loops
- UI shows read cards in the reply

**Exit criteria:** ask "find the bug in the auth flow" and the agent explores 3 files on its own and diagnoses.

### Phase 7 — Command execution
**Goal: the agent can run shell commands, gated.**

- `<<<RUN cmd` directive in a reply
- Confirmation card with the exact command and working directory
- Live stdout/stderr streamed into the card
- Permission-gated (Read mode refuses; Ask shows the card; Auto runs)
- Timeout (default 60s), refuses commands that escape the workspace root

**Exit criteria:** ask the agent to `npm install` a package and it does, with output you can watch and interrupt.

### Phase 8 — Memory pipeline
**Goal: never lose context, even across sessions.**

- Full transcript on disk (already started in `.mybeam/transcripts/`)
- Rolling summaries: when a session crosses a token threshold, the oldest chunk is summarized into a compact paragraph
- Retrieval: keyword (later embedding) search over past transcripts, top-M relevant turns prepended to the current context
- Session handoff: kill the browser, restart the server, come back in a week — the conversation resumes

**Exit criteria:** a 500-message session stays coherent across restarts, and the agent can recall "what did we decide about X three hours ago?"

### Phase 9 — Voice
**Goal: replies can be spoken.**

- Toggle in the header
- Pluggable TTS adapter (Fish Audio, ElevenLabs, or local)
- Streaming audio: start speaking as soon as the first sentence is ready
- Pause / resume / skip / interrupt
- Optional: voice input

### Phase 10 — Desktop shell
**Goal: a real app, not a terminal + a browser tab.**

- Small launcher (Electron or Tauri)
- System tray icon
- The whole stack ships as a single installable
- Optional: run the hidden browser (Playwright/Puppeteer) inside the app, so no Chrome extension is required

### Phase 11 — More providers
**Goal: not married to two websites.**

- Add adapters for additional web chat sites
- Adapter contract: `findComposer`, `findSendButton`, `findFileInput`, `findAssistantMessages`, `findAllMessages`, `extractText`, `hasVerification`, `pageLooksReady`
- Adding a provider = one file in `content-providers/` + one entry in `manifest.json` + one entry in `lib/provider.js`

---

## How we work

- One phase at a time. No mixing.
- Each phase has a rollback story (usually `git revert`).
- The current phase always works before we start the next.
- If a phase is too big, split it.
- The UI never lies: if something is disabled or failing, it says so.
