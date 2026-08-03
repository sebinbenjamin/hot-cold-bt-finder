# Web Bluetooth scanning support — state of play

**Researched:** 2026-08-04
**Chromium source checked at:** `main` (HEAD on this date), fetched from
`raw.githubusercontent.com/chromium/chromium/main/...`

> Platform support for these APIs changes. Every claim below is tied to a source URL. Before trusting
> this document more than a few months from now, re-check `runtime_enabled_features.json5` and the
> per-platform `bluetooth_adapter_*` files. Claims are labelled **spec says** / **Chromium
> implements** / **we observed** — do not collapse those categories.

---

## Summary (bottom line up front)

1. **Both advertisement APIs are still experimental.** `requestLEScan()` *and*
   `BluetoothDevice.watchAdvertisements()` are gated behind
   `chrome://flags/#enable-experimental-web-platform-features` at HEAD — on **every** platform,
   Android included. Neither has shipped.

2. **One choke point decides whether `advertisementreceived` ever fires**, shared by both APIs: the
   platform's `BluetoothAdapter` subclass must call
   `BluetoothAdapter::Observer::DeviceAdvertisementReceived(...)`. `WebBluetoothServiceImpl`
   implements exactly that method and fans events out to *both* `scanning_clients_` (requestLEScan)
   and `watch_advertisements_clients_` (watchAdvertisements).

3. **Every platform implements it.** Android, Windows (WinRT), macOS/iOS (CoreBluetooth via
   `BluetoothLowEnergyAdapterApple`), Linux/ChromeOS (BlueZ), ChromeOS (Floss) all call it. There is
   **no** platform where Chromium's Bluetooth backend fails to deliver advertisements by
   construction, and there are no `BUILDFLAG(IS_*)` guards anywhere in the scanning path.

4. **The "Chromium on Windows rides on Windows 8 APIs" explanation is dead.** It comes from a
   Chromium engineer's post in **March 2018**, before the WinRT migration. At HEAD,
   `BluetoothAdapter::CreateAdapter()` on Windows returns `BluetoothAdapterWinrt` unconditionally,
   which starts a `BluetoothLEAdvertisementWatcher` in *active* scanning mode and forwards every
   packet with RSSI and TX power.

5. **Our Windows failure is real but misdiagnosed.** Worse, the observable facts *prove* the Windows
   backend started a real BLE scan: the scanning prompt is only shown from the
   `StartDiscoverySession` **success** callback. See
   [§2](#2-is-the-windows-limitation-still-true-in-2026) for the deduction chain and the two
   surviving hypotheses — one of which is our own 20-second watchdog.

6. **The most actionable correction for this app:** on Android 12+, `requestLEScan()` failing has
   nothing to do with Location. It needs the **Nearby devices** permission, it will **never prompt**
   for it, and it rejects with the maximally unhelpful `NotFoundError: "Bluetooth adapter not
   available."`. The `requestDevice()` picker *does* run the full OS permission flow — so sending
   the user through the picker once fixes scanning. See [§3](#3-what-chrome-for-android-actually-requires).

---

## Platform support table

Both APIs deliver advertisements through the same observer call, so this table applies to
`requestLEScan()` **and** `watchAdvertisements()` equally.

| Platform | Adapter class | Calls `Observer::DeviceAdvertisementReceived`? | Verdict |
|---|---|---|---|
| **Android** | `BluetoothAdapterAndroid` | ✅ [`bluetooth_adapter_android.cc:287`](https://raw.githubusercontent.com/chromium/chromium/main/device/bluetooth/bluetooth_adapter_android.cc) | Implemented; gated on OS permissions (§3). **We observed** the picker path working on Chrome for Android. |
| **Windows** | `BluetoothAdapterWinrt` | ✅ [`bluetooth_adapter_winrt.cc:1366`](https://raw.githubusercontent.com/chromium/chromium/main/device/bluetooth/bluetooth_adapter_winrt.cc) | Implemented. **We observed** failure in practice — unexplained (§2). |
| **macOS** | `BluetoothAdapterMac` → `BluetoothLowEnergyAdapterApple` | ✅ [`bluetooth_low_energy_adapter_apple.mm:479`](https://raw.githubusercontent.com/chromium/chromium/main/device/bluetooth/bluetooth_low_energy_adapter_apple.mm) | Implemented (CoreBluetooth). Corroborated by the CG status table. Untested by us. |
| **iOS** | `BluetoothAdapterIOS` → `BluetoothLowEnergyAdapterApple` | ✅ same file | Implemented in the Blink-on-iOS build only. Untested; ignore for now. |
| **ChromeOS / Linux (BlueZ)** | `BluetoothAdapterBlueZ` | ✅ [`bluez/bluetooth_adapter_bluez.cc:1403`](https://raw.githubusercontent.com/chromium/chromium/main/device/bluetooth/bluez/bluetooth_adapter_bluez.cc) | Implemented. Untested by us. |
| **ChromeOS (Floss)** | `BluetoothAdapterFloss` | ✅ [`floss/bluetooth_adapter_floss.cc:1627-1629`](https://raw.githubusercontent.com/chromium/chromium/main/device/bluetooth/floss/bluetooth_adapter_floss.cc) | Implemented. Untested by us. |

### A conflicting primary source, and how to weigh it

The WebBluetoothCG's hand-maintained status table disagrees:

```
## Scanning API
Partial development.  chrome://flags/#enable-experimental-web-platform-features 🚩 flag required.

Feature/Platform          | Chrome OS | Android | Mac | Linux | Windows |
------------------------- | :-------: | :-----: | :-: | :---: | :-----: |
Advertisements Scanning   |           | 🚩      | 🚩  |       |         |
```
— [`implementation-status.md`](https://raw.githubusercontent.com/WebBluetoothCG/web-bluetooth/main/implementation-status.md)
(same file, `watchAdvertisements()` row: ChromeOS blank, Android 85🚩, Mac 85🚩, Linux blank,
**Windows 85🚩**)

Notes on weighing this:

- It says scanning works on **Android and Mac only** — and specifically **not ChromeOS**, which is
  half of the claim in our own `AGENTS.md`.
- It is internally inconsistent with the code: it marks `watchAdvertisements` as working on Windows
  but scanning as not, even though both funnel through the identical `StartDiscoverySession` +
  `DeviceAdvertisementReceived` path in `WebBluetoothServiceImpl`.
- The scanning row carries **no version numbers** (just 🚩) while every other row carries a Chrome
  milestone, which is what a stale, never-revisited row looks like. The file's last substantive
  edits were 2023 (`exclusionFilters shipped in Chrome 114`) and 2025-02 (link cleanup);
  [commit history](https://api.github.com/repos/WebBluetoothCG/web-bluetooth/commits?path=implementation-status.md).

**Interpretation:** treat the CG table as an out-of-date hand-maintained summary, but note that it
independently agrees with our Windows observation. It is the only primary source that does.

---

## 1. Platform support matrix and flag status for `requestLEScan`

### Exposed only behind the experimental flag — everywhere

The IDL gates both the method and the event handler on a runtime feature:

```webidl
// https://webbluetoothcg.github.io/web-bluetooth/scanning.html#scanning
[RuntimeEnabled=WebBluetoothScanning, CallWith=ScriptState, RaisesException, MeasureAs=WebBluetoothRequestScan]
Promise<BluetoothLEScan> requestLEScan (optional BluetoothLEScanOptions options = {});

[RuntimeEnabled=WebBluetoothScanning] attribute EventHandler onadvertisementreceived;
```
— [`third_party/blink/renderer/modules/bluetooth/bluetooth.idl`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/bluetooth/bluetooth.idl)

That feature is `experimental` with **no per-platform override** — note the contrast with the entry
immediately above it, which *does* use a per-platform dict:

```json5
// WebBluetooth is enabled by default on Android, ChromeOS, iOS, macOS and Windows.
{
  name: "WebBluetooth",
  public: true,
  status: {
    "Android": "stable", "ChromeOS": "stable", "iOS": "stable",
    "Mac": "stable", "Win": "stable", "default": "experimental",
  },
  base_feature: "none",
},
{
  name: "WebBluetoothGetDevices",
  public: true,
  status: "experimental",
  base_feature: "none",
},
{
  name: "WebBluetoothScanning",
  status: "experimental",
},
{
  name: "WebBluetoothWatchAdvertisements",
  public: true,
  status: "experimental",
  base_feature: "none",
},
```
— [`runtime_enabled_features.json5`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/runtime_enabled_features.json5)

The same file defines what `experimental` means, verbatim:

> `// * status=experimental: In-progress features, Web Developers might play with, but are not on by`
> `//   default in stable. These features may be turned on using the "Experimental Web Platform`
> `//   features" flag in chrome://flags/#enable-experimental-web-platform-features.`

Two side notes:

- Because the `WebBluetoothScanning` entry omits `base_feature: "none"`, a disabled-by-default
  `base::Feature` is auto-generated, so `--enable-features=WebBluetoothScanning` /
  `--enable-blink-features=WebBluetoothScanning` are equivalent command-line routes (useful over
  `adb` on Android). There is **no** dedicated entry in
  [`chrome/browser/about_flags.cc`](https://github.com/chromium/chromium/blob/main/chrome/browser/about_flags.cc) —
  the umbrella flag is the only `chrome://flags` route.
- The `"iOS": "stable"` entry for base Web Bluetooth applies to Blink-on-iOS builds, not to
  WebKit-backed Chrome for iOS. **Unverified**; do not act on it.

### Chrome Platform Status contradicts the source — trust the source

> **Name:** "Web Bluetooth requestLEScan for surrounding devices"
> **Chrome status text:** "Enabled by default" — **Milestone 79** (desktop 79, Android 79)
> **Flag name:** null · **feature_notes:** "Partially implemented"
> Last updated 2025-08-22

— [chromestatus feature 5346724402954240](https://chromestatus.com/feature/5346724402954240)
(fetched via [the JSON API](https://chromestatus.com/api/v0/features/5346724402954240); the HTML
page renders client-side and WebFetch returns an empty shell)

"Enabled by default / M79" **conflicts with `runtime_enabled_features.json5`**, which is what
actually generates the Blink build configuration. Google's own developer documentation also still
lists scanning as unshipped:

> "Scanning for nearby BLE advertisements will happen with `navigator.bluetooth.requestLEScan()`."
> — under the **"What's next"** heading, [developer.chrome.com/docs/capabilities/bluetooth](https://developer.chrome.com/docs/capabilities/bluetooth)

That page gives no version, flag, or permission guidance for scanning at all. It is not a usable
source for scanning requirements; its support sentence is about the GATT API:

> "A subset of the Web Bluetooth API is available in ChromeOS, Chrome for Android 6.0, Mac
> (Chrome 56) and Windows 10 (Chrome 70)."

**Rule of thumb: if someone cites chromestatus to argue scanning has shipped, check
`runtime_enabled_features.json5` first.**

### Blink-side preconditions (all platforms)

`Bluetooth::requestLEScan` throws synchronously unless all of:

- the `bluetooth` **permissions policy** feature is enabled —
  `SecurityError: Access to the feature "bluetooth" is disallowed by permissions policy.`
- the window is a **secure context** — `CHECK(window->IsSecureContext())`
- there is **transient user activation** —
  `SecurityError: Must be handling a user gesture to show a permission request.`
- not in a fenced frame — `NotAllowedError: Web Bluetooth is not allowed in a fenced frame tree.`
- the top-level document does not have an opaque origin.

— [`bluetooth.cc`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/bluetooth/bluetooth.cc) lines 62-98, 530-560

**Spec says** the same about the first two, and predicts the third:

> "Because this could show a prompt, it requires a secure context. Additionally, UAs are likely to
> require a transient user activation on its relevant global object when `requestLEScan` is called."
> — [Web Bluetooth Scanning spec](https://webbluetoothcg.github.io/web-bluetooth/scanning.html)

### Browser-side flow — this is what explains the prompt

`RequestScanningStart` → (acquire adapter) → `RequestScanningStartImpl` → `StartDiscoverySession` →
`OnStartDiscoverySessionForScanning` → prompt (unless the filters are already allowed) →
`OnBluetoothScanningPromptEvent` → `client->RunCallback(result)`.

```cpp
// TODO(crbug.com/40630111): Since scanning without a filter wastes
// resources, we need use StartDiscoverySessionWithFilter() instead of
// StartDiscoverySession() here.
adapter->StartDiscoverySession(
    kScanClientNameRequestLeScan,
    base::BindOnce(&WebBluetoothServiceImpl::OnStartDiscoverySessionForScanning, ...),
    base::BindOnce(&WebBluetoothServiceImpl::OnDiscoverySessionErrorForScanning, ...));
```
— [`web_bluetooth_service_impl.cc`](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/bluetooth/web_bluetooth_service_impl.cc)
(`RequestScanningStart` ~1556, `RequestScanningStartImpl` ~1674, `AreScanFiltersAllowed` ~2480,
`OnBluetoothScanningPromptEvent` ~494)

Three consequences worth internalising:

- **With `acceptAllAdvertisements: true` the promise cannot resolve before the user answers the
  prompt** — `accept_all_advertisements_` starts `false` and `filters` has no value, so
  `AreScanFiltersAllowed()` is false on the first call.
- **The prompt is only reached from the discovery-session *success* callback.** If the platform
  could not start a scan, you get `OnDiscoverySessionErrorForScanning` →
  `NotFoundError: "Bluetooth adapter not available."` and **no prompt at all**. This is the load-bearing
  fact in §2 and §3.
- Chrome supplies the prompt on both desktop and Android:
  ```cpp
  #if BUILDFLAG(IS_ANDROID)
    return std::make_unique<permissions::BluetoothScanningPromptAndroid>(...);
  #else
    return std::make_unique<permissions::BluetoothScanningPromptDesktop>(...);
  #endif
  ```
  — [`chrome/browser/bluetooth/chrome_bluetooth_delegate_impl_client.cc`](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/bluetooth/chrome_bluetooth_delegate_impl_client.cc)
  (embedders such as Electron must implement it themselves, which is why the promise hangs there —
  that is an embedder bug, not a platform limitation.)

---

## 2. Is the Windows limitation still true in 2026?

**Short answer: the symptom may be; the explanation we wrote down is wrong and eight years out of
date.**

### Where our claim came from

The "Windows 8 APIs" wording traces to one Chromium engineer post on the official `web-bluetooth`
Google Group, dated **26 March 2018**:

> "Our implementation of Web Bluetooth on Windows is currently based on the Windows 8 APIs. There
> was no API for scanning on Windows 8 so we can't initiate the scanning ourselves."
> — Giovanni Ortuño, [groups.google.com/a/chromium.org/g/web-bluetooth — "Scanning not working on Windows"](https://groups.google.com/a/chromium.org/g/web-bluetooth/c/zjXVbs7_6Ro)

with a follow-up from Conley Owens (29 March 2018):

> "We are essentially continually asking Windows for newly paired devices...which, admittedly isn't
> well-communicated by the word 'scanning'."

Accurate **for 2018**, when Windows used the classic Win32 `BluetoothAdapterWin`. Superseded since.

### What the current source says

**a) Windows uses the WinRT adapter, unconditionally, with no feature flag:**

```cpp
scoped_refptr<BluetoothAdapter> BluetoothAdapter::CreateAdapter() {
  return BluetoothAdapterWin::CreateAdapter();
}

// static
scoped_refptr<BluetoothAdapter> BluetoothAdapterWin::CreateAdapter() {
  return base::WrapRefCounted(new BluetoothAdapterWinrt());
}

// static
scoped_refptr<BluetoothAdapter> BluetoothAdapterWin::CreateClassicAdapter() {
  return base::WrapRefCounted(new BluetoothAdapterWin());
}
```
— [`device/bluetooth/bluetooth_adapter_win.cc`](https://raw.githubusercontent.com/chromium/chromium/main/device/bluetooth/bluetooth_adapter_win.cc)

The legacy `BluetoothAdapterWin` survives only as the separate *classic* adapter
(`BluetoothAdapterFactory::GetClassicAdapter()`), which Web Bluetooth does not use.
— [`bluetooth_adapter_factory.cc`](https://raw.githubusercontent.com/chromium/chromium/main/device/bluetooth/bluetooth_adapter_factory.cc)

**b) The WinRT adapter starts a real LE advertisement watcher in active scanning mode:**

```cpp
void BluetoothAdapterWinrt::StartScanWithFilter(
    std::unique_ptr<BluetoothDiscoveryFilter> discovery_filter,
    DiscoverySessionResultCallback callback) {
  ...
  HRESULT hr = ActivateBluetoothAdvertisementLEWatcherInstance(&ble_advertisement_watcher_);
  ...
  hr = ble_advertisement_watcher_->put_ScanningMode(BluetoothLEScanningMode_Active);
  ...
  advertisement_received_token_ = AddTypedEventHandler(
      ble_advertisement_watcher_.Get(),
      &IBluetoothLEAdvertisementWatcher::add_Received,
      base::BindRepeating(&BluetoothAdapterWinrt::OnAdvertisementReceived, ...));
  ...
  hr = ble_advertisement_watcher_->Start();
```

**c) …and forwards every packet, RSSI and TX power included, to the exact observer Web Bluetooth
listens on:**

```cpp
int16_t rssi = 0;
hr = received->get_RawSignalStrengthInDBm(&rssi);
...
std::optional<int8_t> tx_power = ExtractTxPower(advertisement.Get());
...
for (auto& observer : observers_) {
  observer.DeviceAdvertisementReceived(
      bluetooth_address, device->GetName(),
      /*advertisement_name=*/device_name, rssi, tx_power,
      device->GetAppearance(), advertised_uuids, service_data_map,
      manufacturer_data_map);
```
— both from [`device/bluetooth/bluetooth_adapter_winrt.cc`](https://raw.githubusercontent.com/chromium/chromium/main/device/bluetooth/bluetooth_adapter_winrt.cc)
(`StartScanWithFilter` ~908, `OnAdvertisementReceived` ~1316-1372)

**Conclusion: Windows advertisement scanning is implemented in Chromium's Bluetooth backend today.**
There is no `NOTIMPLEMENTED()` and no `BUILDFLAG(IS_WIN)` guard in the scanning path — the
`NOTIMPLEMENTED()` calls in `bluetooth_adapter_winrt.cc` are for unrelated features (`SetName`,
`SetDiscoverable`, `GetUUIDs`, `CreateRfcommService`, local GATT server).

### What our own observations actually prove

**We observed** (Windows 11, desktop Chrome, experimental flag on): the scanning prompt appears →
Allow → promise never settles → no `advertisementreceived`; and
[Google's scanning sample](https://googlechrome.github.io/samples/web-bluetooth/scan.html) behaves
identically on the same machine. Reading that against the source:

1. `checkSupport()` awaits `navigator.bluetooth.getAvailability()` and only enables the Scan button
   afterwards (`js/app.js:74-94`). `GetAvailability` goes through
   `BluetoothAdapterFactoryWrapper::AcquireAdapter` and resolves `adapter->IsPresent()`
   ([`web_bluetooth_service_impl.cc:759-786`](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/bluetooth/web_bluetooth_service_impl.cc)).
   Since the button became clickable, **the adapter initialised and reported present.**
2. The scanning prompt is shown **only** from `OnStartDiscoverySessionForScanning` — the
   *success* callback of `StartDiscoverySession`. Since the prompt appeared,
   **`BluetoothAdapterWinrt::StartScanWithFilter` returned success**: the watcher was activated,
   `put_ScanningMode(Active)` succeeded, `Start()` succeeded, and the status was not `Aborted`.

**So the Windows backend did start a real BLE scan on our machine.** Whatever is wrong, "Windows has
no scanning API" is not it, and neither is "the adapter never came up".

### Surviving hypotheses

1. **Our own watchdog manufactured the "never settles" symptom.** `js/app.js:32` sets
   `SCAN_PERMISSION_TIMEOUT = 20000` and lines 118-128 race it against `requestLEScan()`. Because
   the promise *cannot* resolve until the prompt is answered (§1), any hesitation over 20 s produces
   a synthetic `PermissionTimeout` rejection that is indistinguishable from a hung promise. This is
   the cheapest hypothesis to rule out and it should be ruled out first.
2. **The watcher started, then silently stopped.** `OnAdvertisementWatcherStopped` calls
   `MarkDiscoverySessionsAsInactive()`, and `WebBluetoothServiceImpl::DeviceAdvertisementReceived`
   opens with `if (!HasActiveDiscoverySession()) return;`. A watcher that aborts moments after a
   successful `Start()` — a plausible driver/radio behaviour — yields exactly "prompt shown, then
   total silence". This would also explain why the CG status table still lists Windows as
   unsupported.

### Diagnostics that would settle it (none of these have been run)

- **`chrome://bluetooth-internals` → Devices → Start Scan** on the same machine. Same
  `BluetoothAdapter` layer. Nearby *unpaired* devices with live RSSI ⇒ the WinRT watcher is
  delivering, and the fault is above the adapter (hypothesis 1). Nothing ⇒ hypothesis 2.
- **The `requestDevice()` picker on Windows.** It is populated from a discovery session
  (`StartDiscoverySessionWithFilter` in
  [`bluetooth_device_chooser_controller.cc`](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/bluetooth/bluetooth_device_chooser_controller.cc))
  and its device list comes from the identical `for (auto& observer : observers_)` loop in
  `OnAdvertisementReceived` that fires `DeviceAdded`. **If the picker lists nearby unpaired BLE
  devices on Windows, advertisements are flowing at the adapter layer.** Cheapest signal available.
- **`chrome://device-log`** for `BLUETOOTH_LOG` lines such as *"Starting the Advertisement Watcher
  failed"*, *"Getting the Watcher Status failed"*, *"Starting Advertisement Watcher failed, it is in
  the Aborted state."* or *"OnAdvertisementWatcherStopped() error=…"*.
- Re-run with `SCAN_PERMISSION_TIMEOUT` temporarily raised to, say, 5 minutes, and answer the prompt
  instantly.

### The claim that should replace ours

> Advertisement scanning is implemented in Chromium's Bluetooth backend on every desktop and mobile
> platform, Windows included. In practice we have only got it working on Android; on our Windows
> machine the scan starts but no advertisements arrive, for reasons not yet identified. The
> WebBluetoothCG's status table also lists Windows scanning as unsupported, so we are not alone —
> but "Windows has no scanning API" is not the reason.

---

## 3. What Chrome for Android actually requires

### The flag is still required on Android

Same `WebBluetoothScanning: status: "experimental"` entry as §1, a plain string with no per-platform
override — while the `WebBluetooth` entry directly above it *does* carry `"Android": "stable"`. Web
Bluetooth is stable on Android; **scanning is not**.
— [`runtime_enabled_features.json5`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/runtime_enabled_features.json5)

### Android 12+ (API 31+): Nearby devices, **not** Location

Chrome declares `BLUETOOTH_SCAN` **with `neverForLocation`**:

```xml
<!--
  Bluetooth scanning is used to implement the Web Bluetooth API, which is
  not intended to allow sites to derive location and so can accept a
  filtered view of devices.
-->
<uses-permission-sdk-23 android:name="android.permission.BLUETOOTH_SCAN"
                        android:usesPermissionFlags="neverForLocation"/>
```
— [`chrome/android/java/AndroidManifest.xml`](https://github.com/chromium/chromium/blob/main/chrome/android/java/AndroidManifest.xml) L57-63

and the runtime gate short-circuits before Location is ever consulted:

```java
private boolean hasPermissionToScan() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        Context context = mAdapter.getContext();
        return context.checkCallingOrSelfPermission(Manifest.permission.BLUETOOTH_SCAN)
                        == PermissionGranted
                && context.checkCallingOrSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)
                        == PermissionGranted;
    }

    LocationUtils locationUtils = LocationUtils.getInstance();
    if (!locationUtils.isSystemLocationSettingEnabled()) return false;
    ...
```
— [`ChromeBluetoothAdapter.java`](https://github.com/chromium/chromium/blob/main/device/bluetooth/android/java/src/org/chromium/device/bluetooth/ChromeBluetoothAdapter.java) L275-297

Chromium states the rule explicitly:

```java
public static boolean needsLocationServicesForBluetooth() {
    // Location services are not required on Android S+ to use Bluetooth if the application has
    // Nearby Devices permission and has set the neverForLocation flag on the BLUETOOTH_SCAN
    // permission in its manifest.
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.S
            && !LocationUtils.getInstance().isSystemLocationSettingEnabled();
}
```
— [`PermissionUtil.java`](https://github.com/chromium/chromium/blob/main/components/permissions/android/java/src/org/chromium/components/permissions/PermissionUtil.java) L237-244

**On Android 12+: Location permission is not required and system Location Services need not be on.
What is required is that Chrome holds both `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT` — the user-facing
"Nearby devices" permission.**

**Android docs say** there is a price for `neverForLocation`, and it lands squarely on this app:

> **Note:** If you include `neverForLocation` in your `android:usesPermissionFlags`, some BLE beacons
> are filtered from the scan results.
> — [Bluetooth permissions](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions)

So on Android 12+, iBeacon/Eddystone-style beacon advertisements may never reach
`advertisementreceived` at all. "My tag shows up in another app but not here" can be this, not a bug.

### Android 11 and earlier: yes, `ACCESS_FINE_LOCATION` **and** Location Services on

```java
    LocationUtils locationUtils = LocationUtils.getInstance();
    if (!locationUtils.isSystemLocationSettingEnabled()) return false;

    Context context = mAdapter.getContext();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        return context.checkCallingOrSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }
    return (…ACCESS_FINE_LOCATION…) || (…ACCESS_COARSE_LOCATION…);
```
— `ChromeBluetoothAdapter.java` L284-296

The system Location **toggle** must be on, and on API 29-30 `ACCESS_FINE_LOCATION` specifically
(coarse is accepted only below API 29 — dead code now, since Chrome's
`default_min_sdk_version = 29`,
[`build/config/android/config.gni`](https://github.com/chromium/chromium/blob/main/build/config/android/config.gni) L72).

**Android docs say:** *"`ACCESS_FINE_LOCATION` is necessary because, on Android 11 and lower, a
Bluetooth scan could potentially be used to gather information about the location of the user."*
— [same page](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions)

### The asymmetry that matters: the picker prompts, `requestLEScan` does not

**The `requestDevice()` picker runs the full OS-permission flow.**
[`BluetoothChooserDialog.java`](https://github.com/chromium/chromium/blob/main/components/permissions/android/java/src/org/chromium/components/permissions/BluetoothChooserDialog.java)
L309-376 has `checkLocationServicesAndPermission()`, in-dialog error strings
(`bluetooth_need_nearby_devices_permission`, `bluetooth_need_location_services_on`,
`bluetooth_need_location_permission_and_services_on`), a `LocationManager.MODE_CHANGED_ACTION`
receiver that re-checks when the user flips the toggle, and a link that opens system Location
settings. It requests the right permissions per API level:

```java
public static void requestSystemPermissionsForBluetooth(
        WindowAndroid windowAndroid, PermissionCallback callback) {
    String[] requiredPermissions;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        requiredPermissions = new String[] {
                    Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT
                };
    } else {
        requiredPermissions = new String[] {Manifest.permission.ACCESS_FINE_LOCATION};
    }
    ...
    windowAndroid.requestPermissions(requiredPermissions, callback);
}
```
— `PermissionUtil.java` L256-274

**The `requestLEScan()` path does not.**
[`BluetoothScanningPermissionDialog.java`](https://github.com/chromium/chromium/blob/main/components/permissions/android/java/src/org/chromium/components/permissions/BluetoothScanningPermissionDialog.java)
contains zero references to `Manifest.permission`, `LocationUtils`, `PermissionUtil`,
`requestPermissions` or `SDK_INT` — it is purely the site-level allow/block prompt. Nor is there a
gate upstream: `RequestScanningStart` checks only the site content setting and option validity, and
never calls `GetOsPermissionStatus()` or `RequestSystemPermission()`.

### The end-to-end failure, and the error string to special-case

`ChromeBluetoothAdapter.startScan()` → `if (!isPresent() || !hasPermissionToScan()) return false;`
→ `BluetoothAdapterAndroid::StartScanWithFilter` leaves `session_added = false` → error callback →
`WebBluetoothServiceImpl::OnDiscoverySessionErrorForScanning` → `NO_BLUETOOTH_ADAPTER` →

```cpp
MAP_ERROR(NO_BLUETOOTH_ADAPTER, DOMExceptionCode::kNotFoundError,
          "Bluetooth adapter not available.");
```
— [`bluetooth_error.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/bluetooth/bluetooth_error.cc)

**Missing Nearby-devices permission surfaces as `NotFoundError: "Bluetooth adapter not available."`,
with no prompt and no hint at the real fix.** Note also that this path produces **no scanning
prompt at all** — so "prompt appeared" positively rules out an Android permission problem.

For contrast: `SCANNING_BLOCKED` → `NotAllowedError: "requestLEScan() call is blocked by user."`;
`PROMPT_CANCELED` → `InvalidStateError: "User canceled the permission prompt."` (also returned for a
concurrent duplicate `requestLEScan()` call).

**Practical workaround worth putting in the UI:** send the user through *"Add a device by hand"*
once. The picker triggers the OS permission request; once Nearby devices is granted, `requestLEScan`
starts working.

### Minimum versions

- Chrome's own `minSdkVersion` is **29 (Android 10)**, so only two branches are reachable: Android
  10-11 (Location) and Android 12+ (Nearby devices).
- Web Bluetooth (GATT) on Android since Chrome 6.0-era per developer.chrome.com; superseded in
  practice by the minSdk above.
- **Scanning: no primary source pins a milestone**, because it has not shipped. Nothing in `main`
  suggests it is close.

---

## 4. `watchAdvertisements()` support

### Flag status: also experimental — the correction that matters most for this app

```webidl
[
  RuntimeEnabled=WebBluetoothWatchAdvertisements,
  CallWith=ScriptState, RaisesException, MeasureAs=WebBluetoothWatchAdvertisements
] Promise<undefined> watchAdvertisements(optional WatchAdvertisementsOptions options = {});
...
[RuntimeEnabled=WebBluetoothWatchAdvertisements] readonly attribute boolean watchingAdvertisements;
[RuntimeEnabled=WebBluetoothWatchAdvertisements] attribute EventHandler onadvertisementreceived;
```
— [`bluetooth_device.idl`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/bluetooth/bluetooth_device.idl),
with `WebBluetoothWatchAdvertisements: status: "experimental"` in
[`runtime_enabled_features.json5`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/runtime_enabled_features.json5)

Corroborated by two other primary sources:

- Chrome Platform Status: *"Web Bluetooth BluetoothDevice.watchAdvertisements()"* (id 5180688812736512),
  status **"No longer pursuing"**, desktop 85 / Android 85 —
  [chromestatus API](https://chromestatus.com/api/v0/features?q=watchAdvertisements). The shipping
  intent was abandoned; the implementation stayed behind the flag.
- The CG status file: *"The `getDevices()` and `watchAdvertisements()` APIs are behind the
  `chrome://flags/#enable-experimental-web-platform-features` 🚩 flag."* —
  [`implementation-status.md`](https://raw.githubusercontent.com/WebBluetoothCG/web-bluetooth/main/implementation-status.md)

> ⚠️ This contradicts `AGENTS.md` ("the picker path is not [behind the flag]"). `requestDevice()` is
> not flag-gated, but `watchAdvertisements()` — without which the picker path produces **no RSSI at
> all** — is. See [Corrections](#corrections-to-repo-claims).

### Platform matrix: identical to `requestLEScan`

`WatchAdvertisementsForDevice` starts its own discovery session and relies on the same observer:

```cpp
// TODO(crbug.com/40630111): Use StartDiscoverySessionWithFilter() to ...
adapter->StartDiscoverySession(kScanClientNameWatchAdvertisements, ...
```
```cpp
for (const auto& scanning_client : scanning_clients_)
  scanning_client->SendEvent(*result);

for (const auto& watch_advertisements_client : watch_advertisements_clients_)
  watch_advertisements_client->SendEvent(*result);
```
— [`web_bluetooth_service_impl.cc`](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/bluetooth/web_bluetooth_service_impl.cc)

So the platform table applies verbatim: implemented on Android, Windows, macOS, Linux and ChromeOS.
The CG table agrees for Windows (85🚩), Android (85🚩) and Mac (85🚩), and leaves ChromeOS and Linux
blank.

**We observed** the picker path working on Chrome for Android. **Windows is untested by us** —
source says it should deliver RSSI, and the CG table explicitly says Windows works. Given the app's
desktop fallback depends on it, this is worth five minutes of verification.

Unlike `requestLEScan`, this path shows **no scanning permission prompt** (the device was already
granted by the chooser), so the "hangs waiting for a prompt event" failure mode does not apply.

Also note `optionalManufacturerData` on `RequestDeviceOptions` carries
`[RuntimeEnabled=WebBluetoothWatchAdvertisements]` — it is flag-gated too.
— [`request_device_options.idl`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/bluetooth/request_device_options.idl)

---

## 5. `requestDevice` filters

### Supported keys

**Spec says** ([`BluetoothLEScanFilterInit`](https://webbluetoothcg.github.io/web-bluetooth/#dictdef-bluetoothlescanfilterinit)):

```webidl
dictionary BluetoothLEScanFilterInit {
  sequence<BluetoothServiceUUID> services;
  DOMString name;
  DOMString namePrefix;
  sequence<BluetoothManufacturerDataFilterInit> manufacturerData;
  sequence<BluetoothServiceDataFilterInit> serviceData;
};
```

**Chromium implements** ([`bluetooth_le_scan_filter_init.idl`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/bluetooth/bluetooth_le_scan_filter_init.idl)):

```webidl
dictionary BluetoothLEScanFilterInit {
    sequence<BluetoothServiceUUID> services;
    DOMString name;
    DOMString namePrefix;
    sequence<BluetoothManufacturerDataFilterInit> manufacturerData;
    // TODO(crbug.com/707635): Support serviceData filter.
};
```

**`serviceData` is not implemented.** It is absent from Blink's IDL, so WebIDL silently discards it
and a filter containing only `serviceData` throws
`TypeError: A filter must restrict the devices in some way.` MDN documents `serviceData` as if it
worked — [MDN `Bluetooth.requestDevice`](https://developer.mozilla.org/en-US/docs/Web/API/Bluetooth/requestDevice)
— which Chromium's IDL contradicts. (MDN has no `requestLEScan` page at all.)

`exclusionFilters` **is** implemented and **not** flag-gated: no `RuntimeEnabled` attribute on the
IDL line, no corresponding entry in `runtime_enabled_features.json5`, and the CG status file lists
it as shipped in Chrome 114 on all five platforms unflagged
([spec PR #600](https://github.com/WebBluetoothCG/web-bluetooth/pull/600),
[status PR #607](https://github.com/WebBluetoothCG/web-bluetooth/pull/607)). It is **not** available
on `requestLEScan` — `BluetoothLEScanOptions` has no such member in spec or Chromium.

### `namePrefix` is case-SENSITIVE, and excludes unnamed devices

**requestDevice** — `MatchesFilter` in
[`bluetooth_device_chooser_controller.cc`](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/bluetooth/bluetooth_device_chooser_controller.cc):

```cpp
if (filter->name) {
  if (device_name == nullptr)
    return false;
  if (filter->name.value() != *device_name)
    return false;
}

if (filter->name_prefix && filter->name_prefix->size()) {
  if (device_name == nullptr)
    return false;
  if (!base::StartsWith(*device_name, filter->name_prefix.value(),
                        base::CompareCase::SENSITIVE))
    return false;
}
```

**requestLEScan** — `ScanningClient::SendEvent` in
[`advertisement_client.cc`](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/bluetooth/advertisement_client.cc) uses the same
`base::CompareCase::SENSITIVE` and the same `!name.has_value() → continue`.

**Spec says** only "doesn't start with filter.namePrefix" / "isn't present" without stating a case
rule ([matches a filter](https://webbluetoothcg.github.io/web-bluetooth/#matches-a-filter)), so
case sensitivity is Chromium's (reasonable) reading. On the exclusion of unnamed devices, spec and
implementation agree.

**The two paths match against different names.** In
`WebBluetoothServiceImpl::DeviceAdvertisementReceived`, `device->name = device_name` (the cached
device name) but `result->name = advertisement_name` (the advertisement's Local Name).
`requestDevice` filters on the former; `requestLEScan` filters on the latter. The scanning spec
explicitly allows a *Shortened* Local Name to satisfy a `name` filter, whereas the core spec requires
a complete name; Chromium does a plain string compare in both cases and does not distinguish.

### Validation errors a caller can trigger

All `TypeError`, thrown **synchronously** from
[`bluetooth.cc`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/bluetooth/bluetooth.cc)
(not promise rejections):

```
"'filters' member must be present if 'exclusionFilters' is present."
"Either 'filters' should be present or 'acceptAllDevices' should be true, but not both."
"'filters' member must be non-empty to find any devices."
"'exclusionFilters' member must be non-empty to exclude any device."
"A filter must restrict the devices in some way."
"'services', if present, must contain at least one service."
"A device name can't be longer than 248 bytes."
"'namePrefix', if present, must be non-empty."
"'manufacturerData', if present, must be non-empty."
"'dataPrefix' must be non-empty when 'mask' is present."
"'mask' size must be equal to 'dataPrefix' size."
"'dataPrefix', if present, must be non-empty."
"'companyIdentifier' must be unique."
```

Directly relevant to the `namePrefix` text box we just shipped:

- **`namePrefix: ""` throws `TypeError`** — an empty search box must fall back to
  `acceptAllDevices: true`, never to `{ namePrefix: "" }`. (`name: ""` is legal; only `namePrefix`
  has the non-empty rule, matching the spec.)
- **The 248-byte limit is on UTF-8 length**, so a long emoji-heavy query can throw.
- Matching is **case-sensitive** and **drops unnamed devices** — worth saying in the UI, because a
  user typing `tile` will not find `Tile`.

A blocklisted service UUID or manufacturer data in `filters` rejects the promise with
`SecurityError: "requestDevice() called with a filter containing a blocklisted UUID or manufacturer
data. https://goo.gl/4NeimX"`
([`bluetooth_error.cc`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/bluetooth/bluetooth_error.cc)).
The blocklist check is applied to `filters` only, not to `exclusionFilters`. The browser process
re-validates everything as a compromised-renderer check; failure there kills the renderer
(`BDH_INVALID_OPTIONS`) rather than surfacing a JS error.

### `requestLEScan` options — and where it diverges from `requestDevice`

```webidl
dictionary BluetoothLEScanOptions {
  sequence<BluetoothLEScanFilterInit> filters;
  boolean keepRepeatedDevices = false;
  boolean acceptAllAdvertisements = false;
};
```
Identical in [spec](https://webbluetoothcg.github.io/web-bluetooth/scanning.html#dom-bluetooth-requestlescan)
and Chromium, reusing the same filter dictionary and the same validation. Options-level error:
`TypeError: Either 'filters' should be present or 'acceptAllAdvertisements' should be true, but not both.`

Two divergences in Chromium's scan-side matching (`ScanningClient::SendEvent`), both of which would
bite if we ever filter scans:

- **`services` is OR, not AND.** The scanning path passes if *any* listed service matches
  (`std::ranges::none_of(...) → continue`), while `requestDevice`'s `MatchesFilter` requires *all*.
  Both specs mandate AND, so the scanning path is **more permissive than spec**.
- **`manufacturerData` is ignored entirely**: `// TODO(crbug.com/41310835): Support manufacturerData
  and serviceData filters.` A scan filter whose only member is `manufacturerData` therefore matches
  **every** advertisement.

**`keepRepeatedDevices` is currently a no-op in Chromium.** It is plumbed through mojo and echoed
back on the `BluetoothLEScan` object, but nothing in `content/browser/bluetooth/` ever reads it and
`SendEvent` has no dedup logic — you receive every advertisement regardless. Spec-conformant, since
dedup is a MAY. Our `keepRepeatedDevices: true` is harmless but currently redundant.

**Prompting and the grant cache.** `StoreAllowedScanOptions` sets `accept_all_advertisements_ = true`
when a filterless scan is allowed; `AreScanFiltersAllowed` then auto-approves any later filtered
scan. The reverse is not true: an `acceptAllAdvertisements` scan always needs its own prompt and can
never ride on a previously granted filtered scan. The cache is per-document and cleared by
`ClearAdvertisementClients()`.

---

## 6. Secure context, permissions policy, and GitHub Pages

**Secure context.** Both `Bluetooth` and `BluetoothDevice` are `[SecureContext]`, and `bluetooth.cc`
additionally `CHECK`s `window->IsSecureContext()` in each entry point. GitHub Pages serves over
HTTPS, so `https://sebinbenjamin.github.io/hot-cold-bt-finder/` qualifies; `file://` does not.

**Permissions policy.** There is a `bluetooth` feature with default allowlist `self`:

```json5
{
  name: "Bluetooth",
  permissions_policy_name: "bluetooth",
  depends_on: ["WebBluetooth"],
  privacy_sensitive: true,
},
```
with the file-level default `feature_default: { default: "EnableForSelf", ... }`.
— [`services/network/public/cpp/permissions_policy/permissions_policy_features.json5`](https://raw.githubusercontent.com/chromium/chromium/main/services/network/public/cpp/permissions_policy/permissions_policy_features.json5)
(this file moved out of `third_party/blink/renderer/core/permissions_policy/` into the network
service; older links 404).

Consequences:

- A top-level GitHub Pages document needs **no** `Permissions-Policy` header — `self` is the default
  and GitHub Pages sends nothing restrictive.
- **Cross-origin iframes are blocked by default.** Embedding requires `<iframe allow="bluetooth">`
  on the embedder, which we cannot set from GitHub Pages. Blink throws
  `SecurityError: Access to the feature "bluetooth" is disallowed by permissions policy.`
- **Fenced frames** throw `NotAllowedError: Web Bluetooth is not allowed in a fenced frame tree.`,
  and `WebBluetoothServiceImpl` additionally asserts
  `DCHECK(!render_frame_host().IsNestedWithinFencedFrame())`.
- **Opaque top-level origins** (a sandboxed iframe without `allow-same-origin`) throw
  `SecurityError: Access to the Web Bluetooth API is denied from contexts where the top-level
  document has an opaque origin.`
— [`bluetooth.cc`](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/modules/bluetooth/bluetooth.cc) lines 62-98

`AGENTS.md`'s "do not test from `file://` or in an iframe" is therefore correct; the iframe half is
more precisely "not from a cross-origin or sandboxed iframe without `allow=\"bluetooth\"`".

---

## Corrections to repo claims

| Where | Current text | Correction |
|---|---|---|
| `AGENTS.md` §Build/Test; `README.md`; `js/app.js` lines 36-39 | "Chromium's Windows Web Bluetooth backend rides on Windows 8 APIs that have no scanning support" | **Wrong and 8 years out of date.** Sourced to a March 2018 chromium `web-bluetooth` group post that predates the WinRT migration. At HEAD, Windows uses `BluetoothAdapterWinrt`, which runs a `BluetoothLEAdvertisementWatcher` in active mode and forwards RSSI/TX power to the same observer Web Bluetooth consumes. Our Windows *symptom* is real; the *stated cause* is not. |
| `AGENTS.md`: "**Full scanning only works on Android and ChromeOS.**" / `README.md`: "**Scanning is Android/ChromeOS only.**" | | **Not supported by any source.** Chromium implements advertisement delivery on *every* platform. The one primary source that lists platform support (the CG status table) says **Android and Mac**, and specifically leaves **ChromeOS blank** — so "and ChromeOS" is the least defensible part of the claim. Suggested rewording: "We have only got scanning working on Android. Chromium implements it on all platforms, but the WebBluetoothCG status table lists only Android and macOS, and it does not work on our Windows machine." |
| `AGENTS.md`: "`requestLEScan` is behind `…#enable-experimental-web-platform-features`; **the picker path is not.**" | | **Half wrong.** `requestDevice()` is not flag-gated, but `watchAdvertisements()` — which the picker path calls, and without which it yields no RSSI — **is** (`WebBluetoothWatchAdvertisements`, `status: "experimental"`; chromestatus "No longer pursuing"). The picker path only produces signal strength with the same flag on. |
| `AGENTS.md` §Testing: "may need `chrome://flags/#enable-experimental-web-platform-features`" | | Not "may" — **always**, on every platform including Android. No per-platform override exists. |
| `AGENTS.md` §Architecture: "a second watchdog at 7s … **blames Android Location permission**" | | **Wrong on Android 12+**, which is most devices. Location is irrelevant there; the requirement is the **Nearby devices** permission (`BLUETOOTH_SCAN` + `BLUETOOTH_CONNECT`, declared `neverForLocation`). Only Android 10-11 needs `ACCESS_FINE_LOCATION` plus the system Location toggle. |
| `AGENTS.md` §Architecture: "`SCAN_PERMISSION_TIMEOUT` (20s) races the `requestLEScan()` call itself, since that promise can hang indefinitely" | | The premise is shaky. With `acceptAllAdvertisements`, the promise is *designed* not to settle until the user answers the prompt, so a 20 s race will fire on any hesitation and is indistinguishable from a real hang. This watchdog may be the source of our "never settles" evidence. |
| `AGENTS.md` §Coding Style: failure copy should "name the actual fix" | | Two concrete additions: (a) an Android permission failure arrives as `NotFoundError: "Bluetooth adapter not available."` **with no prompt shown** — special-case that string and point at Nearby devices; (b) routing the user through the picker once triggers the OS permission request and thereby fixes scanning. |
| `README.md`: "This is a Chrome limitation, not a setting you can change." | | Not established for any platform. macOS and Linux are implemented upstream; Windows is implemented and, on our machine, starts a real scan. |
| `js/app.js` `scanningActuallyWorks()` (true only for android/chromeos) | | The conservative gate is a defensible product decision given we have only verified Android, but the justifying comment is wrong, and per the CG table **ChromeOS is a false positive** and **macOS a false negative**. |
| New: `namePrefix` filter feature | `q ? { filters: [{ namePrefix: q }], … }` (`js/app.js:198`) | Matching is **case-sensitive**, **excludes devices with no name**, and **`namePrefix: ""` throws `TypeError`** — make sure an empty/whitespace-only box falls through to `acceptAllDevices`. Names over 248 UTF-8 bytes also throw. |
| `README.md` §Project files: "index.html — main app UI and logic" | | Stale (logic is in `js/app.js`, styles in `css/styles.css`). Noted in passing; unrelated to this research. |

---

## Open questions / unverified

1. **Why does Windows actually fail?** Unresolved. Two surviving hypotheses in §2 (our own watchdog;
   a watcher that stops right after a successful start). Run the `chrome://bluetooth-internals` /
   `chrome://device-log` / picker checks before writing any new explanation into the repo.
2. **Was "the promise never settles" real, or our 20 s watchdog?** Re-test with
   `SCAN_PERMISSION_TIMEOUT` raised and the prompt answered immediately. This is the single highest-value
   experiment on the list.
3. **Does `watchAdvertisements()` deliver RSSI on Windows?** Source and the CG table both say yes.
   Never tested by us. It is the desktop fallback, so it matters.
4. **Was the experimental flag already on for the Android device where the picker worked?** Per
   source it must have been, since `WebBluetoothWatchAdvertisements` is experimental. Check with the
   flag off: `'watchAdvertisements' in BluetoothDevice.prototype` should be `false`. If it is `true`
   with the flag off, shipping Chrome for Android differs from `main` and §4 needs revisiting.
5. **Do beacon-format tags survive `neverForLocation` on Android 12+?** Android's docs say "some BLE
   beacons are filtered from the scan results". Untested, and it may be the difference between this
   app working and not for a whole class of tag.
6. **macOS, Linux and ChromeOS are inferred from source only.** Untested by us. The CG table
   disagrees for ChromeOS and Linux.
7. **`"iOS": "stable"` for base Web Bluetooth** — presumably the Blink-on-iOS build, not WebKit-backed
   Chrome for iOS. Unverified; ignore.
8. **Chrome Platform Status is unreliable for these features** ("Enabled by default", M79 for
   scanning). Always check `runtime_enabled_features.json5` first.
9. **`serviceData` filters** are documented by MDN but absent from Blink's IDL. If we ever want them,
   they do not exist — [crbug.com/707635](https://crbug.com/707635).
