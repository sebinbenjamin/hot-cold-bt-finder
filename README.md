# hot-cold-bt-finder

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

For the best experience, use Chrome on Android. Full scanning may require enabling experimental Web Platform features in Chrome.

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

- index.html — main app UI and logic
