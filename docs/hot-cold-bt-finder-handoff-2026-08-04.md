# Handoff — hot-cold-bt-finder

**Date:** 2026-08-04
**Repo:** `C:\Users\sebin\workspace\hot-cold-bt-finder` · branch `develop` · remote `github.com/sebinbenjamin/hot-cold-bt-finder` (public)
**Live:** https://sebinbenjamin.github.io/hot-cold-bt-finder/
**HEAD:** `ea4550f` (in sync with `origin/develop`)

## Where things stand

A dependency-free single-page Web Bluetooth "hot/cold" finder. Architecture, conventions, and the acquisition-path model are documented in `AGENTS.md` (imported by `CLAUDE.md`) — **read that first**, don't re-derive it.

This session: split the single-file app into `index.html` / `css/styles.css` / `js/app.js`, cleaned up user-facing copy, added picker `namePrefix` filtering, deployed to GitHub Pages, ran primary-source research, and corrected a wrong diagnosis. All captured in commits `50ca2e6..ea4550f` and in the files below — read them rather than trusting this summary.

## The blocking task

**Waiting on the user's hardware test results.** They are running steps A–F on an Android 12+ phone plus this Windows desktop. The step list and what each answers is in the plan file:

`C:\Users\sebin\.claude\plans\binary-herding-pearl.md`

Short form: A = flag-off `?debug=1` reading, B = flag-on reading, C = picker grants Nearby devices + check RSSI, D = full scan, E = failure text if D empty, F = Windows picker + instant-prompt scan.

When results arrive: interpret each against the research doc's predictions, then update `AGENTS.md` / `README.md` from "only ever worked on Android for us" to a verified statement, and resolve open questions 3, 4, 5 in the research doc with what was actually observed.

## Critical context — do not regress this

`docs/research/web-bluetooth-scanning-support.md` is a primary-source investigation (Chromium at HEAD, W3C spec, chromestatus). Key findings that overturned earlier assumptions:

- **The "Chromium on Windows rides on Windows 8 APIs with no scanning support" explanation is wrong** and traces to a March 2018 post predating the WinRT migration. It was written into the repo and has since been retracted (`ff8c923`). Windows uses `BluetoothAdapterWinrt` and does start a real scan. **Do not reintroduce this claim.** The Windows failure is real but *unexplained*; diagnostics that would settle it are listed in the doc's §2.
- Scanning is implemented on **every** platform; it is flag-gated on every platform including Android.
- `watchAdvertisements()` is flag-gated too — the picker path yields no RSSI without the flag.
- Android 12+ needs **Nearby devices**, not Location. `requestLEScan` never prompts for it and fails as `NotFoundError: "Bluetooth adapter not available."`. The `requestDevice()` picker *does* run the OS permission flow, so it doubles as the fix.

The doc also contains **two false statements** ("We observed the picker path working on Chrome for Android", §platform table and §4) — Android has never been tested. Its open question #4 rests on that false premise. Fix when the real Android data lands.

## Gotchas

- **Native OS dialogs cannot be automated.** The Bluetooth permission prompt and device chooser are OS-level; browser tooling can neither see nor click them. Any test crossing one needs the user. This is why the `?debug=1` panel + "Copy diagnostics" button exists — it is the only practical way to get state off a phone.
- **This Windows desktop already has the experimental flag ON** (`REQUESTLESCAN`/`WATCHADVERTS` both `true`). Step A's flag-*off* reading must come from the phone.
- **GitHub Pages deploys on any push to `develop`** (source `develop` `/root`, legacy build, ~30-60s). No Actions workflow. Verify with `gh api repos/sebinbenjamin/hot-cold-bt-finder/pages/builds/latest`. Note the build API has been observed lagging behind actual served content — confirm by `curl`-ing the asset, not just the API.
- **A prior cloud session wrote `app.js`/`styles.css` to the repo root** while `index.html` loads `js/app.js`/`css/styles.css`, so the feature shipped dead. Already repaired, root duplicates deleted (they 404 live). Watch for this pattern if another remote session runs — verify asset paths after any teleported change.
- `js/app.js` wires events at top level and relies on `defer`; don't move the script tag or drop `defer`.
- Device names/ids are attacker-controlled — always `esc()` before interpolation.
- Both acquisition paths update `S.devices` independently; signal-handling changes usually need editing in both listeners.

## Suggested skills

- **`diagnosing-bugs`** — if step D or F fails in a way that isn't explained by the research doc. Note its Phase 1 insistence on a tight feedback loop; with native dialogs in the path, the honest answer is a HITL loop, not an automated one.
- **`research`** — if a new claim about Chrome/Chromium behaviour needs settling. Constrain it to primary sources (Chromium source, W3C spec, chromestatus); secondary write-ups produced the wrong answer last time.
- **`claude-in-chrome`** — for any browser verification. Load the MCP tools in one batched `ToolSearch` call.
- **`code-review`** — before merging any remote/cloud-session output, given the root-path incident.
- **`simplify`** — the copy has been through several passes; worth a quality sweep once the platform story is settled.

## Standing user preferences observed

- Wants unnecessary detail kept out of the UI — no debug counters, raw error names, or device IDs in normal (non-`?debug=1`) view.
- Prefers being told plainly when a previous conclusion was wrong, with the correction propagated into the repo rather than only into chat.


## Last message
One thing that changes your step A, though. This desktop already has the experimental flag on — REQUESTLESCAN and WATCHADVERTS both read true here. Step A asks for a flag-off reading, and that has to come from the phone, whose flag state is independent. So:

- If your phone's flag is already on, A won't give you the false reading that answers open q#4 — you'd need to turn it off, read, then back on.
- If it's untouched, you'll get the clean false → true transition as designed.

Worth knowing before you start, since A-before-flag is the whole point of that ordering.

Two practical notes for the phone: append ?debug=1 to the URL manually (it's not linked from anywhere), and if the panel looks stale after relaunching Chrome for the flag, pull-to-refresh — Pages sets caching headers and you want to be sure you're reading the current build, not a cached one.

Send the pasted diagnostics as you go and I'll interpret each step against what the research predicted.