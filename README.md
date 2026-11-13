# Unified Messenger for Windows

A desktop workspace for Telegram, WhatsApp, Eitaa, Bale and Rubika. Each service runs its official web client in a separate persistent session. The workspace combines the available chat lists while messaging stays with the service that owns the conversation.

## Develop and run

Install Node.js **22.12 or newer**. From the project folder:

```powershell
npm.cmd ci
npm.cmd start
```

On Windows you can also double-click `start.cmd`. It finds a standard Node installation and starts this local checkout using a separate development profile in `%LOCALAPPDATA%\UnifiedMessenger-Development`, so an already installed version can remain open. On first run Electron downloads its runtime from the official Electron release. Internet access is needed for that download and for the messaging services.

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run dist
```

For renderer integration checks, launch an isolated development profile with `--remote-debugging-port=9333`, then run `npm.cmd run test:ui`. That check uses temporary in-memory conversation fixtures and sends no messages.

The installer is written to `dist/`. It includes Desktop and Start menu shortcuts and lets you choose the installation folder. Release signing requires the project owner's Windows signing certificate; local builds are unsigned.

## Desktop workspace

- English interface with dark, light and system appearance and optional compact density.
- Unified conversation lists, search, unread, pinned and archive views, and service filters.
- Service shortcuts and a second independent account for each messenger.
- Eitaa refreshes automatically when opened from its service button or Accounts. A visible **Refresh Eitaa** button is available while either Eitaa account is open. Refresh preserves the current chat URL and sign-in; opening notifications and restoring Settings do not trigger another reload.
- Real service loading/error states with manual reload; a loaded page does not verify account login.
- System tray, close to tray, unread taskbar badge, saved window position, and optional launch at Windows login after installation.
- Native notifications controlled by a saved preference. Clicking a web-client notification reveals the correct account and restores the window while the service handles navigation to its message.
- Download directory selection, optional Save As prompts, collision-safe file names and download activity.
- Keyboard shortcuts, diagnostic log access and persistent settings with a backup copy.

Sign in inside each service's own page. QR codes, verification codes and passwords are handled by that service. No API keys are needed for the web workspace.

## Shortcuts

`Ctrl+K` focuses conversation search, `Ctrl+,` opens Settings and `Escape` dismisses dialogs. Service web clients keep their own shortcuts while focused. See Settings for the full shortcut reference supported by this version.

## Files and storage

Downloads you request go directly to your Windows Desktop by default. You can choose another folder in Settings; an existing custom choice is preserved. With **Ask where to save** enabled, Windows opens a Save As dialog. The app does not automatically download received attachments. Dragging a picture out of a service prepares a temporary local copy; old temporary drag files are cleaned up.

Official clients manage their network connections and persistent browser sessions. Settings, diagnostic logs and application data live in the app's Windows user-data folder. The app does not add encryption for locally cached text, browser sessions or downloaded files. Use the service's logout command to sign out.

For an isolated development profile, set an absolute path in `UM_USER_DATA_DIR` before starting. This keeps test logins and settings separate from the installed application's profile.

## Service capabilities and limits

Eitaa, Bale and Rubika (including second accounts) use direct Chromium sessions that bypass system HTTP/SOCKS proxies and PAC rules. Their pages, WebSockets, downloads and session-based requests share this policy. Telegram and WhatsApp retain the existing system connection. A direct session cannot bypass an operating-system VPN/TUN route: exclude the Iranian service domains in the VPN's split-routing rules when that mode is active. Bale's file gateways and CDN use `ble.ir`, so its VPN exception must include that domain as well as `bale.ai` and `bale.ir`; otherwise text can work while attachment transfers stall. Links opened in an external browser use that browser's own routing.

Text, attachments, emoji, replies, editing, groups, voice notes and calls are supplied by each official web client where supported. Availability and permission prompts depend on the service, account and web client. This release does not add cross-service calls, a new messaging network, server-side message scheduling or guaranteed offline sending.

The unified chat list is read from web-client metadata. A service can change its page structure, so lists may need a scraper update. Search covers synchronized conversation titles and previews; full conversation search remains inside each service. Pinning in the workspace is local. The app does not provide full message-history backup or session migration.

## Structure

```text
src/main/main.js          Windows lifecycle, tray, IPC and notifications
src/main/preferences.js   Validated settings and window-state persistence
src/main/webtabs.js       Service views, chat discovery and connection state
src/main/webfiles.js      Downloads, collision handling and file drag-out
src/main/db.js            Local SQLite store for adapter conversations
src/renderer/             Workspace interface and settings
src/assets/               Windows application icons
tests/                    Storage, preferences and service reliability checks
```

The older adapter modules in `src/main/adapters/` remain as extension examples. The current application starts with web clients, not those adapters.
