# Spotify Now Playing — Ulanzi Stream Deck Plugin

[![Português](https://img.shields.io/badge/Português-555?style=for-the-badge)](README.md)
[![English](https://img.shields.io/badge/English-1DB954?style=for-the-badge)](README.en.md)
[![Español](https://img.shields.io/badge/Español-555?style=for-the-badge)](README.es.md)

A plugin for the **Ulanzi Stream Deck (D200/D201)** that shows the track playing on Spotify
(cover art + title), controls playback, likes songs, toggles shuffle/repeat, launches
playlists and opens the app — all straight from the keys and the dial.

> Main service in **Node.js v20**, integrated through the **Spotify Web API** with **OAuth
> Authorization Code + PKCE**. Playback controls require a **Premium** account.

![The plugin in Ulanzi Studio: the actions in the sidebar and the Property Inspector for a Play / Pause key](docs/images/studio-english-ui.png)

## Actions

| Action | Control | Description |
|--------|---------|-------------|
| **Now Playing** | Key | Cover art + title of the current track, refreshing automatically. With nothing playing it shows the Spotify logo; **pressing opens the Spotify app** on the PC. |
| **Now Playing (2×2 Mosaic)** | Key | One quadrant of the cover art. Four adjacent keys in a 2×2 block rebuild the full image. Pressing any of them opens Spotify. |
| **Play / Pause** | Key | Toggles playing/paused. The icon reflects the state (▶ when paused, ⏸ when playing). |
| **Next track** | Key | Skips to the next track. |
| **Previous track** | Key | Goes back to the previous one (Spotify's standard behaviour: 1st press restarts, 2nd goes back). |
| **Volume (dial)** | Encoder | Turn to adjust the volume; press to mute/unmute. |
| **Volume up** | Key | Raises the volume by 10% (for the D200, which has no dial). |
| **Volume down** | Key | Lowers the volume by 10%. |
| **Mute** | Key | Mutes and, on the next press, **restores the previous volume**. The icon follows the real volume — muting from the Spotify app updates the key too. |
| **Shuffle** | Key | Turns shuffle on/off. The icon reflects the current state. |
| **Repeat** | Key | Cycles through Spotify's three modes: off → repeat context → repeat track. Each mode has its own icon. |
| **Like** | Key | Likes/unlikes the current track. Shows **✓** when already liked, **+** when not — it checks the state whenever the track changes. |
| **Playlist** | Key | A shortcut to a playlist: shows cover art + name and plays it on press. Set the URL/URI in the Property Inspector. |

## Highlights

- **Opens Spotify from the key.** With no device playing, pressing Now Playing launches/focuses
  the desktop app (via the `spotify:` protocol). If a command is issued with no active device,
  the plugin **automatically activates Spotify on this PC** (identified by hostname) and runs
  the action.
- **No flicker.** Cover art (now playing and playlists) is cached, so icons don't blink when you
  switch pages on the Deck. Now Playing and playlists use separate caches.
- **Resilient.** Survives Ulanzi Studio restarts and hiccups (automatic reconnection with
  backoff) and respects Spotify's rate limit (429) with a persisted cooldown.

## Requirements

- [Ulanzi Studio](https://www.ulanzi.com/pages/downloads) **3.0.11+**.
- **Node.js 20+** (the main service runs on Node).
- A **Spotify Premium** account (for playback controls, volume, likes and playing playlists).

## 1. Register an app on Spotify

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app.
2. Under **Redirect URIs**, add **exactly**:
   ```
   http://127.0.0.1:8888/callback
   ```
   > Spotify no longer accepts `localhost` — use `127.0.0.1`.
3. Under **APIs used**, check **Web API**.
4. Copy the **Client ID** (no Client Secret needed: the flow is PKCE).

## 2. Install the plugin

```bash
cd com.ulanzi.spotifynowplaying.ulanziPlugin
npm install          # installs ws + sharp
```

Copy the `com.ulanzi.spotifynowplaying.ulanziPlugin/` folder into the Ulanzi Studio plugins
directory (or use the simulator — see below).

## 3. Connect to Spotify

1. Drag any of the plugin's actions onto a key and open the **Property Inspector**.
2. Paste the **Client ID** and click **Connect to Spotify**.
3. The browser opens the consent screen; once you authorise, you'll see "Connected to Spotify!"
   and can close the tab.
4. Tokens are saved in the *Global Settings* and shared by every action.

> **Scopes used:** `user-read-currently-playing`, `user-read-playback-state`,
> `user-modify-playback-state`, `user-library-read`, `user-library-modify`,
> `playlist-read-private`. If you connected before the like/playlist actions were added,
> **reconnect** once to grant the new scopes.

## 4. Usage

- **Now Playing / Mosaic**: play something on Spotify; the cover art and title appear and update
  as the track changes. For the mosaic, place the 4 keys in an adjacent 2×2 block and pick each
  one's quadrant (Top left, Top right, Bottom left, Bottom right).
- **Controls**: play/pause, next, previous, volume (dial or ±10% keys), mute.
- **Shuffle / Repeat**: toggle the mode and show the current state on the icon; they also follow
  changes made from the Spotify app.
- **Like**: press to save/remove the current track from your library.
- **Playlist**: paste the playlist URL in the Property Inspector; the key shows the cover art and
  name, and plays the playlist when pressed.
- If nothing is playing, pressing **Now Playing** opens the Spotify app on the PC.

## Development and testing (simulator)

The [official SDK](https://github.com/UlanziTechnology/UlanziDeckPlugin-SDK) ships a simulator:

```bash
# inside the SDK repository
cd UlanziDeckSimulator
npm install
npm start
# copy the plugin into UlanziDeckSimulator/plugins/ and run the main service separately:
node plugin/app.js
# open http://127.0.0.1:39069 and click "Refresh Plugin List"
```

Debugging in the desktop app: start Ulanzi Studio with `--nodeRemoteDebug` and open
`chrome://inspect`.

## Structure

```
com.ulanzi.spotifynowplaying.ulanziPlugin/
├── manifest.json
├── plugin/
│   ├── app.js                    # main service: connect + event routing
│   ├── plugin-common-node/       # Node SDK (WebSocket bridge $UD)
│   ├── spotify/
│   │   ├── auth.js               # OAuth PKCE + 127.0.0.1 callback server
│   │   ├── api.js                # endpoints: player, library, playlists, devices
│   │   └── tokenStore.js         # tokens via Global Settings + refresh
│   ├── render/cover.js           # downloads/resizes/slices the cover art (base64, cached)
│   └── actions/                  # nowPlayingRegistry (poller + observers), controls,
│                                 # volumeDial, likeTrack, playlist, shuffleToggle,
│                                 # repeatMode, muteToggle
├── property-inspector/           # configuration UIs (HTML)
├── libs/                         # common-html SDK (for the PIs)
├── assets/icons/                 # plugin and action icons
├── test/                         # regression tests (node --test)
└── en.json / pt_PT.json          # localisation
```

Running the tests:

```bash
cd com.ulanzi.spotifynowplaying.ulanziPlugin
npm test
```

## Notes

- **Playback control requires an active device.** If Spotify is open on this PC but idle, the
  plugin activates the device automatically when you issue a command. If Spotify isn't open on
  this PC, a warning appears ("Open Spotify on this computer").
- The "Now Playing" poller runs every **2 s** and is **shared**: every state action (shuffle,
  repeat, mute, like) updates from it, with no requests of their own. Cover art is cached by URL.
- **Rate limit (429).** The plugin respects `Retry-After` and blocks **every** request until the
  deadline passes — insisting makes Spotify *extend* the penalty. The cooldown is written to
  `plugin/ratelimit.json` and survives restarts; logging out discards it (the block belonged to
  the previous session). The log lives in `plugin/error.log`.

## Licence

MIT.
