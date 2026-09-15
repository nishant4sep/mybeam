<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=12,20,24,30&height=200&section=header&text=MyBeam&fontSize=72&fontAlignY=38&desc=Talk%20to%20your%20AI.%20From%20your%20terminal.%20Like%20a%20human.&descAlignY=58&descSize=18&animation=fadeIn" />

<a href="#what-is-this"><img src="https://img.shields.io/badge/what-is%20this%3F-7d6cff?style=for-the-badge" /></a>
<a href="#how-it-works"><img src="https://img.shields.io/badge/how%20it%20works-6248ff?style=for-the-badge" /></a>
<a href="#setup"><img src="https://img.shields.io/badge/setup-3ddc97?style=for-the-badge" /></a>
<a href="FUTURE_PLANS.md"><img src="https://img.shields.io/badge/roadmap-ffb454?style=for-the-badge" /></a>

<br/><br/>

<strong>A tiny local workstation that lets you chat with an AI in your browser —<br/>
without ever touching the browser. Type here. Watch it type there.</strong>

<br/><br/>

</div>

---

## What is this?

MyBeam is a **bridge**. It sits between a chat website you already have open in a browser tab and a clean, fast, purpose-built UI running on `http://localhost:3210` on your machine.

You type here → MyBeam's Chrome extension types it into the real website → the site's reply streams back → you read it here.

It feels like the chat site is *native to your desktop*.

```
┌──────────────┐   type a message   ┌──────────────────┐   types it   ┌──────────────┐
│  You         │ ─────────────────▶ │  MyBeam UI       │ ───────────▶ │  oxalpha.com │
│              │                    │  localhost:3210  │              │  (real chat) │
│              │ ◀───────────────── │                  │ ◀─────────── │              │
└──────────────┘   streams the      └──────────────────┘   reads the   └──────────────┘
                   reply live              ▲              reply live
                                           │
                                    ┌──────────────┐
                                    │  Chrome      │
                                    │  extension   │
                                    └──────────────┘
```

---

## How it works

Three small pieces:

| Piece | What it does | Where it lives |
|---|---|---|
| **Server** | Serves the workstation UI, queues tasks, streams replies back over Server-Sent Events | `server.js` (Node, no dependencies) |
| **Extension** | Runs in the background, watches oxalpha's DOM, types and submits for you | `manifest.json`, `background.js`, `content.js`, `offscreen.js` |
| **Workstation** | The pretty chat you actually use | Served by the server, opens at `http://localhost:3210` |

No frameworks. No build step. No API keys. Just three files of JavaScript and a Chrome extension.

---

## Setup

**1. Install Node 18 or later.** ([nodejs.org](https://nodejs.org))

**2. Clone and start the server.**

```bash
git clone https://github.com/YOUR-USERNAME/mybeam.git
cd mybeam
node server.js
```

Open <http://localhost:3210> — you'll see the workstation.

**3. Load the extension.**

- Open `chrome://extensions`
- Turn on **Developer mode** (top right)
- Click **Load unpacked**
- Pick this project folder

**4. Log into oxalpha.com once.**

Open <https://oxalpha.com> in a normal tab and sign in. MyBeam will adopt that tab.

**5. Done.**

Send a message from the workstation. It'll appear in oxalpha. The reply will stream back.

---

## What's next

A lot. Voice replies, real file reading and writing, a plan-mode agent, memory that survives session changes, and a one-click "publish this project to GitHub" button. All of it is laid out phase by phase in [`FUTURE_PLANS.md`](FUTURE_PLANS.md).

We ship one phase at a time, and each phase is usable on its own.

---

## Why does this exist?

Because the best AI chat UIs live in the browser and feel like the browser. MyBeam gives you the power of that chat without the tab, the notifications, the "are you still watching" prompts, or the reminder that you're inside a web page.

You type here. It types there. That's it.

---

<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&customColorList=12,20,24,30&height=120&section=footer" />

<sub>Built in a text editor at 3am. Ship it.</sub>

</div>