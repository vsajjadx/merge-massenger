# Unified Messenger

One desktop chat list for WhatsApp and Telegram: newest message first, pinned chats on top,
drag files in to send, drag downloaded files out to save. Everything runs on your computer, no server.

## Run

```
npm install
npm start
```

Requires Node 22+ for development tooling; the app itself uses the Node bundled in Electron (node:sqlite, no native build step).

## Login

Each service opens its own official web client from the left rail (Telegram, WhatsApp, Eitaa, Bale, Rubika). Log in on the service's own page;
the login is kept between runs. No API keys are needed.

## All

The **All** button on the rail (the default view) lists the chats of every messenger in one list, newest first, grouped by day, with filter tabs per service.
The date label each web client shows (clock time, weekday, Gregorian or Jalali date) is converted to a real date so the order is the same across services.

## Behaviour

- Text and chat list are stored in a local SQLite database. Files are never downloaded automatically: a card with name and size
  is shown, a click downloads the file into a cache (2 GB cap, least recently used removed first; "Clear download cache" in the gear dialog).
- Right click a file: Save as, Show in folder. Right click a chat: Pin, Mark as read.
- Drag a downloaded file out of the window to Explorer/Finder or another app. Dragging a file from one chat into another chat forwards it.

## Adding another messenger

Copy `src/main/adapters/_template.js`, implement the methods, add an instance to `adapters` in `src/main/main.js`.
The hub, database and UI need no changes. Two letters in `source` identify the service; the badge colour for a new one goes in `styles.css` (`.src.xx`).

## Layout

```
src/main/main.js        window, IPC, notifications
src/main/hub.js         merges adapter events into the store
src/main/db.js          SQLite (chats, messages, downloaded files)
src/main/cache.js       download cache with LRU cleanup
src/main/adapters/      telegram.js (GramJS), whatsapp.js (Baileys), _template.js
src/renderer/           the UI (plain HTML/CSS/JS, no build step)
```
