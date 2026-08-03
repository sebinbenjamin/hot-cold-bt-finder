# Repository Guidelines

Guidance for AI coding agents (including Claude Code) working in this repository.

## Project

A single-page Web Bluetooth "hot/cold" finder: scan for BLE advertisements, pick a target, then walk around while a gauge, click track, and warmer/colder verdict track its RSSI.

## Project Structure & Module Organization

This is a dependency-free, single-page Web Bluetooth application. Keep the UI markup in `index.html`, application behaviour in `js/app.js`, and visual styling in `css/styles.css`. There is no generated source, package manifest, or asset pipeline. `README.md` covers end-user setup; update it when a user-visible workflow changes.

The app has two Bluetooth acquisition paths: full LE scanning and the device picker. Both populate the shared `S.devices` map, so changes to signal handling must be applied to both paths. Device names and IDs come from advertisements; escape them with `esc()` before inserting them into HTML.

## Build, Test, and Development Commands

No build step or automated test suite is configured. Serve the repository over localhost:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/`. Do not test from `file://` or in an iframe: Web Bluetooth requires a secure context and a top-level page.

Verification is manual and needs real hardware: Chrome on Android with Bluetooth and Location permission granted. `requestLEScan` is behind `chrome://flags/#enable-experimental-web-platform-features`; the picker path is not. Desktop Chrome can exercise the picker path and the UI, but not full scanning.

**Full scanning only works on Android and ChromeOS.** On Windows (and macOS/Linux) desktop Chrome, enabling the flag exposes `requestLEScan` but the backend never delivers: the permission prompt appears, the user allows it, and the promise never settles — Chromium's Windows Web Bluetooth backend rides on Windows 8 APIs that have no scanning support. Confirmed by running Google's own [scanning sample](https://googlechrome.github.io/samples/web-bluetooth/scan.html), which hangs identically on the same machine. Don't chase this as an app bug; `scanningActuallyWorks()` gates the user-facing copy on it.

## Architecture

`js/app.js` is a classic (non-module) script loaded with `defer`: top-level function declarations, event wiring at the bottom, and a single mutable `S` state object. Only Google Fonts is external. The `defer` on the `<script>` tag matters — the wiring code runs at top level (not inside a `DOMContentLoaded` handler), so it depends on the DOM already being parsed when it executes.

**Two acquisition paths, one device map.** Both write records into `S.devices` (`id -> {id, name, rssi, ema, txPower, last, pinned?}`):

- `startScan()` → `navigator.bluetooth.requestLEScan()` with a *global* `advertisementreceived` listener on `navigator.bluetooth` (`onAdvert`). Flag-gated; guarded by two watchdogs: `SCAN_PERMISSION_TIMEOUT` (20s) races the `requestLEScan()` call itself, since that promise can hang indefinitely on desktop Chrome (Windows/macOS/Linux) even after the user grants permission — the API is only reliable on ChromeOS/Android; a second watchdog at 7s after the scan actually starts blames Android Location permission when the scan runs but no adverts arrive.
- `pickOne()` → `requestDevice()` + `device.watchAdvertisements()` with a *per-device* listener. These records are `pinned: true`. This is the fallback when `requestLEScan` is missing — `checkSupport()` rewrites the scan button to route there.

Each path independently updates its record's EMA and, if that record is the current target, calls `feedTarget()`. Changes to signal handling usually need to be made in **both** listeners.

**Views.** `#viewList` and `#viewHunt` are sections toggled by the `.active` class via `swap()`. Only one target (`S.target`) is hunted at a time; `hunt()` enters, `leaveHunt()` exits.

**List rendering.** `renderList()` rebuilds `#list` via `innerHTML` on every advertisement plus a 1.5s interval. It also garbage-collects: any non-pinned, non-target device silent for >12s is dropped from `S.devices`. Device names and ids are attacker-controlled — always pass them through `esc()` before interpolation.

**Signal pipeline.** Raw RSSI → EMA (`ALPHA`) → `pct()` normalizes over `RSSI_MIN..RSSI_MAX` to 0..1. That single `p` drives the needle rotation, arc `stroke-dashoffset`, glow opacity, trace height, and — most importantly — the click cadence in `scheduleTick()` (1250ms far → 90ms close). Pace is the primary distance cue; the screen is secondary.

**Warmer/colder** is the slope of the smoothed line: compare `S.ema` against the oldest `S.history` entry within `TREND_WINDOW`, with `TREND_DEADBAND` dB of hysteresis. `S.history` also feeds the 60-second canvas strip (`drawTrace`, DPR-aware).

**Tuning constants** sit together near the top of the script (`ALPHA`, `TX_POWER`, `PATH_LOSS`, `RSSI_MIN/MAX`, `TREND_WINDOW`, `TREND_DEADBAND`). `roughDistance()` is a log-distance path-loss estimate that prefers the advertised `txPower` when present; it deliberately returns vague phrases rather than false precision.

**Platform lifecycle.** Audio must start from a user gesture (`startAudio()` on entering hunt); a screen wake lock is held while hunting; `visibilitychange` stops the tick timer when backgrounded and restarts it (plus re-requests the wake lock) on return.

## Coding Style & Naming Conventions

Use plain browser JavaScript—no modules or dependencies unless the project is deliberately restructured. Follow the existing style: two-space indentation, double-quoted strings, concise camelCase function and variable names, and `S` for shared mutable state. Keep tuning constants grouped near the top of `js/app.js` and use uppercase names such as `RSSI_MIN`.

Preserve the terminal-instrument design: styles use CSS custom properties, uppercase letter-spaced labels, amber-on-dark colours, and motion that respects `prefers-reduced-motion`.

Copy is plain and instructional — failure messages name the actual fix (which Android setting, which Chrome flag), not just the error. `checkSupport()` and the `startScan()` error map are where that lives; keep new failure modes there rather than throwing raw errors at the user.

## Testing Guidelines

Verify changes manually in Chromium. Check loading, filtering, picker fallback, hunt-mode controls, and responsive layout. Full advertisement scanning needs Chrome on Android, Bluetooth and Location permission, and may need `chrome://flags/#enable-experimental-web-platform-features`; desktop Chrome is useful for picker and UI checks. Exercise both acquisition paths after editing RSSI or device-list logic.

## Commit & Pull Request Guidelines

Use concise, imperative Conventional Commit-style subjects, as in `feat: add device filtering` or `chore: initial commit`. Keep commits focused. Pull requests should describe the behaviour changed, note browser/device verification, link relevant issues, and include screenshots for visual changes. Call out permission, secure-context, or Chrome-flag requirements explicitly.
