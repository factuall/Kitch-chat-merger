# Kitch chat merger

**See Twitch and Kick chat together when a streamer multistreams.**

Kitch chat merger is a browser extension for Chrome and other Chromium-based browsers (Edge, Brave, Opera). When you watch a streamer who is live on both Twitch and Kick at the same time, it shows the chat from the other platform right next to the chat you're already watching, so you see the whole community in one place.

---

## Chrome Web Store listing

### Summary (max 132 characters)

> See Twitch and Kick chat together when a streamer multistreams. Messages from the other platform appear right in the chat.

### Description

Watching a streamer who goes live on Twitch and Kick at the same time? Normally you only see half of the conversation. Kitch chat merger brings both chats together.

**How it works**

1. Open the extension and add a pair: the streamer's Twitch name and their Kick name. You can also paste a channel link.
2. Watch the stream on either platform as usual.
3. Messages from the other platform appear in the chat, marked with [Twitch] or [Kick], with usernames in their original colors.

**Features**

• Twitch + Kick in one chat: messages from the other platform appear alongside the native chat, in real time.
• Automatic pairing: when you open a verified streamer who has a verified account with the same name on the other platform, the pair is added for you.
• Works on regular channel pages and on pop-out chat.
• Display modes: inside the native chat, or in a small separate panel.
• Emotes: Kick emotes are shown as images on Twitch. Twitch emotes are shown as images in the panel and as their names inside Kick's chat.
• No account or login needed. Chat is read-only and anonymous.
• Lightweight: nothing runs on pages other than Twitch and Kick.

**Privacy**

Kitch chat merger doesn't collect, sell or share any personal data. Your list of streamer pairs is stored in your browser (synced across your devices if Chrome sync is on). There are no analytics, no tracking and no external servers of our own. The extension only talks to Twitch and Kick to read public chat.

**Notes**

• Read-only: you can read the other platform's chat, but you can't send messages to it.
• Twitch and Kick change their websites from time to time. If messages stop showing inside the chat, switch the display mode to "Separate panel" in the extension popup.

Credit: polawdomu (twitch.tv/polawdomu)

### Category

Social & Communication

### Language

English

---

## Privacy practices (developer dashboard)

### Single purpose

Shows chat messages from a streamer's channel on Twitch or Kick alongside the native chat on the other platform, for streamers who broadcast on both at the same time.

### Permission justifications

| Permission | Why it's needed |
|---|---|
| `storage` | Saves the user's settings and list of Twitch/Kick streamer pairs, and caches Kick channel IDs so they don't have to be looked up on every visit. |
| `declarativeNetRequestWithHostAccess` | Kick's chat server only accepts connections from kick.com. When the user watches on Twitch, the extension sets the `Origin` header of its own connection to Kick's chat server to `https://kick.com`. The rule applies only to WebSocket connections to that server. |
| Host: `kick.com`, `*.kick.com` | Reads public Kick channel info (channel ID, chat room ID, verification status), gets chat connection details, and connects to Kick's public chat. Runs the content script on kick.com to show Twitch chat there. |
| Host: `twitch.tv`, `www.twitch.tv` | Runs the content script on Twitch pages to show Kick chat there. |
| Host: `gql.twitch.tv` | Checks whether a Twitch channel is verified (Partner) for automatic pairing. |

### Remote code

No. All code is included in the package. The extension doesn't load or run any remote scripts.

### Data usage

The extension doesn't collect or transmit user data. Checkboxes to tick in the dashboard: none of the data categories apply.

Certify:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Before submitting

- Make sure every `DEBUG` flag is `false` (`src/background.js`, `src/kick-chat.js`, `src/kick-page-hook.js`).
- Store assets you still need to prepare: at least one screenshot (1280×800 or 640×400) and a small promo tile (440×280). The 128 px icon is in `icons/icon128.png`.
- A privacy policy URL is required if the dashboard asks for one; the "Privacy" paragraph above can be published as-is (e.g. as a GitHub Pages page or a gist).

---

## For developers

### Install from source

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder.

### Packaging for the store

Zip the contents of this folder (with `manifest.json` at the root of the zip), excluding `tools/` and `README.md`.

### How it works

- **Twitch chat**: anonymous read-only IRC over WebSocket (`wss://irc-ws.chat.twitch.tv`).
- **Kick chat**: Kick hands out realtime connection info dynamically via `web.kick.com/api/v1/realtime/channels/<channelId>/chat/connection` (Pusher or Centrifugo; currently Centrifugo). Messages arrive on `chatrooms.<chatroomId>.v2`. Channel and chatroom IDs come from `kick.com/api/v2/channels/<slug>` and are cached.
- **Showing messages on Twitch**: injected into Twitch's chat list.
- **Showing messages on Kick**: Kick's chat is a virtualized list, so a page script (`src/kick-page-hook.js`) hands messages to Kick's own chat renderer by replaying them on Kick's realtime socket in the same format as real messages. If that isn't available, a floating panel is used. For diagnostics, set `DEBUG = true` in that file and run `__mcmDebug()` in the kick.com tab console.
- **Auto-pairing**: Twitch verification = Partner status (Twitch GraphQL, the same public client ID twitch.tv uses); Kick verification = `verified` field of the channel API. Each channel is checked at most once a week; a pair the user removed is never re-added.

### Files

- `manifest.json`
- `icons/`: extension icons (generated by `tools/make_icons.py`)
- `popup/`: settings popup
- `src/background.js`: service worker (Kick/Twitch API calls, auto-pairing, Origin header rule)
- `src/twitch-chat.js`, `src/kick-chat.js`: chat clients
- `src/display.js`: rendering into the page (native chat selectors live here)
- `src/kick-page-hook.js`, `src/kick-native.js`: native message injection on kick.com
- `src/content.js`: channel detection and session management
