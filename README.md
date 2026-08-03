# hot-cold-bt-finder

**Live: https://sebinbenjamin.github.io/hot-cold-bt-finder/**

hot-cold-bt-finder is a small single-page web app that helps you locate nearby Bluetooth devices by watching their signal strength. It is designed for quick, hands-on hunting: scan for nearby advertisements, select a target, and use the live meter to tell whether you are getting warmer or colder.

## What it does

- Scans for nearby Bluetooth advertisements
- Lets you pick a specific device to watch
- Shows a live signal-strength gauge and rough distance estimate
- Gives warm/cold feedback based on recent signal trends
- Offers optional sound and vibration cues while hunting

## Requirements

- A modern Chromium-based browser with Web Bluetooth support
- A device with Bluetooth enabled
- A secure context (HTTPS or localhost)

Use Chrome on Android. Scanning is experimental in Chrome and needs `chrome://flags/#enable-experimental-web-platform-features` turned on, on every platform — including Android.

On Android you also need to grant Chrome the **Nearby devices** permission. Chrome won't ask for it when you start a scan; it just fails. Tapping **Add a device by hand** once does trigger the request, which then unblocks scanning.

**Scanning may not work on desktop.** Chrome exposes the API there, but on our Windows machine the permission prompt appears, you allow it, and no devices ever arrive — Google's own scanning sample behaves the same way, so it isn't this app. The cause isn't pinned down. On desktop, use **Add a device by hand**, which uses Chrome's device picker.

## Run locally

From the project folder, start a simple local server:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

If the browser prompts for Bluetooth or location permissions, allow them.

## Notes

- Opening the page directly from disk is likely to fail because Web Bluetooth requires a secure context.
- If full scanning is unavailable in your browser, you can still use the device picker option.
- Signal strength is approximate and can be affected by walls, furniture, and body position.

## Project files

- `index.html` — markup
- `css/styles.css` — styling
- `js/app.js` — application logic
- `docs/research/web-bluetooth-scanning-support.md` — sourced notes on what Chrome actually supports
