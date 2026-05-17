---
   name: maestro-flutter-device-testing
   description: MANDATORY for Flutter/Maestro development. Contains the stateful workflow for flutter_run, connecting devices, and fixing common Flutter semantics-to-Maestro mismatches. READ THIS before building, starting, or testing the app.
---

# Flutter CLI Reference

## ⚠️ USE EXTENSION TOOLS FIRST — CLI IS FALLBACK ONLY

The extension provides stateful tools that track device connections, VM Service URLs, and running processes. **Always prefer extension tools over raw CLI.** Bypassing them breaks the agent's state tracking.

### ⚠️ NO "FUCKERY" — Don't Bypas the Extension

"Fuckery" refers to any agent action that manipulates the app state outside of the provided tools. Bypassing the extension breaks state tracking and makes debugging impossible.

**DO NOT:**
- Run `flutter run` in the terminal. Use `flutter_run()`.
- Use `adb shell am start ...` to launch the app. Use `flutter_run()`.
- Use `adb shell am force-stop ...` to stop the app. Use `flutter_stop()`.
- Use `adb shell pkill -f ...` to kill the app. Use `flutter_stop()`.

**WHY:**
The extension tracks the background `flutter` process, its VM Service URL (required for hot reload/restart and tree inspection), and its connection to the device. If you start/stop the app manually:
1. `flutter_hot_reload` and `flutter_hot_restart` will fail or do nothing.
2. `flutter_inspect_tree` will return stale or no data.
3. `flutter_app_status` will report "FUCKERY DETECTED".

**FIX:** If you find yourself in a "Fuckery" state (detected by `flutter_app_status`), run `flutter_stop()` followed by `flutter_run()` to reset the connection.

### Extension Tools (ALWAYS use these)

| Task                           | Tool                                   | Notes                                                |
| ------------------------------ | -------------------------------------- | ---------------------------------------------------- |
| **Connect to device/emulator** | `flutter_connect(id: "emulator-5554")` | Saves device preference; required before running     |
| **Disconnect**                 | `flutter_disconnect()`                 | Cleans up emulator/network device                    |
| **Launch the app**             | `flutter_run()`                        | Fire-and-forget — go idle, follow-up wakes you       |
| **Stop the app**               | `flutter_stop()`                       | Cleans up tracked state                              |
| **Hot reload**                 | `flutter_hot_reload()`                 | Sends `r` to running flutter process                 |
| **Hot restart**                | `flutter_hot_restart()`                | Sends `R`; recovers VM Service URL                   |
| **Widget tree**                | `flutter_inspect_tree()`               | Compact label list; use `search: "button"` to filter |
| **Screenshot**                 | `flutter_screenshot()`                 | Returns image path only (agent cannot view images)   |
| **Current screen**             | `flutter_current_screen()`             | Returns visible activity name                        |
| **App status**                 | `flutter_app_status()`                 | Running / stopped / crashed                          |

## ⚠️ TIMEOUTS — Critical for Physical Devices

**Emulators are fast. Physical devices (especially Fire TV / Android TV sticks)
are very slow.** Every `maestro` and `adb` CLI command that touches a real
device MUST use generous `timeout=` values or it will hang mid-test.

| Device Type | `maestro test` timeout | `maestro hierarchy` timeout | `flutter_screenshot` | D-pad press latency |
|------------|----------------------|---------------------------|---------------------|-------------------|
| Emulator   | 30s (default fine)   | 15s                       | 10s                 | < 1s              |
| Fire TV / physical Android TV | **120s minimum** | **60s** | `timeoutMs: 30000` | 3–10s each |
| Other physical Android | 60s | 30s | `timeoutMs: 15000` | 1–3s each |

```bash
# WRONG — will hang on physical device
maestro test flow.yaml

# CORRECT — generous timeout for physical device
maestro test flow.yaml  # bash timeout=120s

# CORRECT — hierarchy dump with timeout
maestro hierarchy | sed '1d' > /tmp/h.json  # bash timeout=60s
```

**Rule of thumb**: If you're testing on a physical device, add at least 10s
of timeout per D-pad key press in your Maestro flow, plus 30s overhead.

### CLI Fallback (ONLY when no extension tool exists)

| Task                     | Command                                        | When to use                                |
| ------------------------ | ---------------------------------------------- | ------------------------------------------ |
| List available emulators | `flutter emulators`                            | Before `flutter_connect` to find AVD names |
| Check ADB devices        | `adb devices`                                  | Diagnosing connection issues               |
| Build APK/bundle         | `flutter build apk`                            | Extension doesn't have a build tool        |
| View logs                | `flutter log` or `adb logcat`                  | Debugging crashes, rendering issues        |
| Maestro testing          | `maestro hierarchy` / `maestro test flow.yaml` | UI test automation                         |
| Raw VM Service           | Node script with `ws`                          | Focus tree, custom isolate queries         |
| Launch emulator (WSL2)   | `sg kvm -c "emulator -avd test_34 ..."`        | Before `flutter_connect` if no device      |

## Workflow: Starting an App

1. **Discover devices**: `adb devices` (CLI) or `flutter emulators` (CLI) — extension has no "list" tool
2. **Launch emulator if needed**: CLI only — see below
3. **Connect**: `flutter_connect(id: "emulator-5554")` — **ALWAYS use the tool**
4. **Run app**: `flutter_run()` — **ALWAYS use the tool** (not `flutter run`)
5. **END YOUR TURN** — `flutter_run()` returns immediately while the app builds in the background. **DO NOT perform any ADB, Maestro, or Flutter operations while the app is starting up.** Do NOT call any further tools (no polling with `flutter_app_status`, `flutter_inspect_tree`, etc). Just end your response without invoking a tool call — that's how the agent yields and waits. The extension will send you a follow-up message when the app is ready (or if it failed).

### After the app is ready (you'll be woken by a follow-up message)

- **Inspect**: `flutter_inspect_tree()` — verify semantics labels and screen content
- **Check activity**: `flutter_current_screen()` — confirm which screen is visible
- **Interact**: Hot reload/restart via `flutter_hot_reload()` / `flutter_hot_restart()`

## Device & Emulator Management (CLI — pre-connect only)

```bash
# List available emulators (pick an ID for flutter_connect)
flutter emulators

# Check connected devices
adb devices

# Launch emulator (WSL2 with KVM) — do this BEFORE flutter_connect
sg kvm -c "
  /home/gladfelter/android-sdk/emulator/emulator \
    -avd test_34 \
    -no-boot-anim \
    -netdelay none \
    -netspeed full \
    -memory 2048 \
    -cores 4 \
    > /tmp/emulator.log 2>&1 &
"

# Wait for boot completion
adb shell getprop sys.boot_completed   # "1" = ready

# Check KVM access
cat /dev/kvm > /dev/null 2>&1 && echo "KVM OK" || echo "No KVM"
```

## Building (CLI — no extension tool)

```bash
# Debug APK (fastest)
flutter build apk --debug

# Release APK
flutter build apk

# iOS archive
flutter build ios --release

# Web bundle
flutter build web

# Clean if build is broken
flutter clean && flutter pub get && flutter build apk --debug
```

## Logs (CLI — debugging only)

```bash
# Flutter framework logs
flutter log

# Flutter + system logs
flutter log -v

# ADB logcat filtered by app PID
adb logcat --pid=$(adb shell pidof app.$PACKAGE) -s Flutter:V

# Crash logs
adb logcat -b crash -t 50

# Dart error stream
adb logcat -s FlutterRun:E
```

## VM Service (CLI — raw WebSocket access)

The extension tracks the VM Service URL automatically when `flutter_run` starts. For queries beyond `flutter_inspect_tree`, use a node script:

```javascript
const WebSocket = require("ws");

// Replace with actual URL from flutter_run output
const url = "ws://127.0.0.1:36319/:ws";

const ws = new WebSocket(url);
ws.on("open", () => {
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "getVM" }));
});
ws.on("message", (data) => {
  const resp = JSON.parse(data.toString());
  if (resp.id === "1") {
    const isolateId = resp.result.isolates[0].id;
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "2",
        method: "ext.flutter.debugDumpFocusTree",
        params: { isolateId },
      }),
    );
  } else if (resp.id === "2") {
    console.log(resp.result.data || JSON.stringify(resp.result));
    ws.close();
    process.exit(0);
  }
});
```

## Maestro UI Testing (CLI — no extension tool)

```bash
# Accessibility hierarchy
maestro hierarchy

# Run a test flow
maestro test maestro/flow.yaml

# Single action (use maestro_test_file tool)
# The tool returns a path in .pi/tmp/ — all test ephemera stays together.
# Option 1: Tool writes content directly
maestro_test_file(name: "tap-login", content: "appId: com.example.myapp\n---\n- tapOn: \"login-button\"\n- assertVisible: \"Welcome\"\n")
maestro test .pi/tmp/maestro-tap-login.yaml

# Option 2: Get path, then write with heredoc (bash)
maestro_test_file(name: "tap-login")
# → returns .pi/tmp/maestro-tap-login.yaml — then:
cat > .pi/tmp/maestro-tap-login.yaml << 'EOF'
appId: com.example.myapp
---
- tapOn: "login-button"
- assertVisible: "Welcome"
EOF
maestro test .pi/tmp/maestro-tap-login.yaml
```

### Common Maestro actions

```yaml
- tapOn: "button-label"
- tapOn: { point: "50%,50%" }
- tapOn: "username-field"
- inputText: "alice"
- scroll
- scroll: { direction: "down", amount: 500 }
- assertVisible: "Welcome"
- assertNotVisible: "Error"
- waitFor: "loading-spinner"
- swipe: { start: "50%,80%", end: "50%,20%" }
```

## Common Scenarios

### "App won't launch"

1. Check device: `adb devices` (CLI)
2. Check tracked state: `flutter_app_status` (tool)
3. If stuck, kill on device: `adb shell pkill -f flutter` (CLI)
4. Try again: `flutter_run()` (tool)

### "Need to find a widget's semantics label"

**Always use the tool**: `flutter_inspect_tree()` or `flutter_inspect_tree(search: "button")`

If the tree output shows `⚠️ hint-only` warnings or `undefined` widgets, or Maestro can't find elements you know exist, consult **[accessibility-fixes.md](references/accessibility-fixes.md)** for common Flutter semantics→Maestro mismatches and their fixes.

### "Which screen is currently visible?"

**Use the tool**: `flutter_current_screen()`

CLI fallback: `adb shell dumpsys activity top | grep ACTIVITY`

### "App crashed — why?"

1. **Use the tool**: `flutter_app_status()` (quick check)
2. Get logs: `adb logcat -b crash -t 20` (CLI)
3. **Use the tool**: `flutter_hot_restart()` (recover from crash)

### "Build is failing / stuck"

```bash
flutter clean
flutter pub get
flutter build apk --debug
```

### "Take a screenshot (for human review or CI artifact)"

**Use the tool**: `flutter_screenshot()` — returns a file path. The agent cannot view or interpret the image content. Use `flutter_inspect_tree()` and `flutter_current_screen()` to programmatically verify UI state.

CLI fallback: `adb exec-out screencap -p > /tmp/screen.png`

## Accessibility Tree Issues

When `flutter_inspect_tree()` reports `⚠️ hint-only` warnings, `undefined` widgets, or Maestro `tapOn` can't find an element that's clearly on screen, see the reference doc: **[accessibility-fixes.md](references/accessibility-fixes.md)**. It catalogs common Flutter semantics→Maestro mismatches with before/after code examples and the Maestro selector changes needed.

## Non-Obvious Tips

- **Hot reload after crash**: Won't work. Use `flutter_hot_restart()` or stop and re-run.
- **Emulator slow on Linux**: Almost always KVM. Check: `cat /dev/kvm > /dev/null 2>&1 || echo "NO KVM"`
- **VM Service URL changes on hot restart**: The `flutter_hot_restart()` tool re-detects it automatically.
- **Maestro on emulator**: `assertVisible` can fail due to driver timeouts — this is a Maestro limitation, retry if needed.
- **Multiple Flutter projects in workspace**: Use `/flutter-project <name>` to select the target project.
- **Never run `flutter run` from CLI**: The `flutter_run()` tool wraps it and tracks the VM Service URL, process handle, and device state. Running CLI directly means the extension loses track of the running app.
- **`flutter_run()` is fire-and-forget**: It returns immediately. The app builds in the background. The extension will send a follow-up message when it's ready or if it crashed. After calling `flutter_run()`, end your turn without invoking any further tool calls — that yields control and lets the follow-up message resume you. Progress updates arrive as steer messages (informational, don't act on them).

## Fire TV / Android TV Quirks

### Maestro Test Flow Pattern (Fire TV)

Maestro tests on Fire TV follow this pattern — do NOT use `tapOn` with text or `id:` selectors:

```yaml
appId: com.lansite.firetv
---
# Navigate with Remote Dpad keys
- pressKey: "Remote Dpad Right"
- pressKey: "Remote Dpad Down"
- pressKey: "Remote Dpad Center"

# Assert with plain text matching
- assertVisible: "Welcome, dev"
- assertVisible: "Search movies and shows"

# Use back key for navigation
- pressKey: back
```

**Critical rules:**
- **ALWAYS use `pressKey: "Remote Dpad ..."` for navigation** — never `tapOn` for D-pad movement. Remote Dpad keys are slow (3–10s each) but reliable.
- **`assertVisible` uses accessibility text, not widget text**: Flutter `Text` widgets with `Semantics` wrappers expose text that Maestro can match. Plain `Text()` widgets without semantics may not be matchable.
- **`Semantics(identifier:)` does NOT produce a `resource-id`**: On Fire TV, the identifier appears in `accessibilityText` — Maestro cannot match it with `id:` selector. Use text matching instead.
- **Maestro test timeout on physical devices**: Use minimum 120s for `bash timeout=` on full flows.
- **Screenshot verification is essential**: Many UI bugs are visual-only (focus highlights, layout overflow, subtitle rendering). A screenshot-capable model is needed for end-to-end TV testing because Maestro's `assertVisible` can't verify visual quality.

### ADB / Device Quirks

- **`flutter_current_screen()` on Fire TV**: The tool now queries `mResumedActivity` from `dumpsys activity activities`, which correctly reports the Flutter app even when the Fire TV launcher sits on top in the task stack. Falls back to `dumpsys activity top` (last ACTIVITY line) on older Android.
- **ADB connection can drop silently**: On physical Fire TV devices over network ADB, the debug connection can drop during builds. If `flutter_run` exits with code 1 but the app appears running (check `flutter_app_status` for FUCKERY), do `flutter_stop` then `flutter_run` again.
- **StatefulWidget / constructor changes need full rebuild**: Hot reload silently ignores structural changes like adding fields to classes or changing constructor signatures. Use `flutter_hot_restart` or full `flutter_stop` + `flutter_run`.
- **`maestro hierarchy` output has a non-JSON prefix**: The first line is `Running on <ip>:<port>`. Strip it with `sed '1d'` before JSON parsing.

### Flutter Widget Quirks on Fire TV

- **`KeyDownEvent` NOT always emitted on hold**: Fire TV remotes may skip `KeyDownEvent` and emit only `KeyRepeatEvent` when a button is held. Event handlers must check for both `KeyDownEvent` and `KeyRepeatEvent`.
- **`GestureDetector.onTap` does NOT fire on D-pad select**: D-pad Center button goes through `Focus.onKeyEvent`, not `GestureDetector`. For D-pad-friendly widgets, handle `LogicalKeyboardKey.select` in `Focus.onKeyEvent`.
- **`Focus` must be outside visual styling**: Place `Focus` widget as the outer wrapper, with `Container`/`BoxDecoration` inside. Swapping them causes stale focus highlights.
- **`showDialog` creates a new `FocusScope`**: Parent screens must check `ModalRoute.of(context)?.isCurrent` before calling `requestFocus()` or they will steal focus from the dialog.
