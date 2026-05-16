---
name: flutter-cli
description: Flutter CLI fallback reference. Extension tools handle run/connect/reload/screenshot/inspect. Use this skill ONLY for tasks the extension tools don't cover (build, logs, raw VM Service, Maestro, device discovery before connecting).
---

# Flutter CLI Reference

## ⚠️ USE EXTENSION TOOLS FIRST — CLI IS FALLBACK ONLY

The extension provides stateful tools that track device connections, VM Service URLs, and running processes. **Always prefer extension tools over raw CLI.** Bypassing them breaks the agent's state tracking.

### Extension Tools (ALWAYS use these)

| Task | Tool | Notes |
|---|---|---|
| **Connect to device/emulator** | `flutter_connect(id: "emulator-5554")` | Saves device preference; required before running |
| **Disconnect** | `flutter_disconnect()` | Cleans up emulator/network device |
| **Launch the app** | `flutter_run()` | Tracks VM Service URL, process handle, log stream |
| **Stop the app** | `flutter_stop()` | Cleans up tracked state |
| **Hot reload** | `flutter_hot_reload()` | Sends `r` to running flutter process |
| **Hot restart** | `flutter_hot_restart()` | Sends `R`; recovers VM Service URL |
| **Widget tree** | `flutter_inspect_tree(flat: true)` | Compact label list; use `search: "button"` to filter |
| **Screenshot** | `flutter_screenshot()` | Returns image path + attachment |
| **Current screen** | `flutter_current_screen()` | Returns visible activity name |
| **App status** | `flutter_app_status()` | Running / stopped / crashed |

### CLI Fallback (ONLY when no extension tool exists)

| Task | Command | When to use |
|---|---|---|
| List available emulators | `flutter emulators` | Before `flutter_connect` to find AVD names |
| Check ADB devices | `adb devices` | Diagnosing connection issues |
| Build APK/bundle | `flutter build apk` | Extension doesn't have a build tool |
| View logs | `flutter log` or `adb logcat` | Debugging crashes, rendering issues |
| Maestro testing | `maestro hierarchy` / `maestro test flow.yaml` | UI test automation |
| Raw VM Service | Node script with `ws` | Focus tree, custom isolate queries |
| Launch emulator (WSL2) | `sg kvm -c "emulator -avd test_34 ..."` | Before `flutter_connect` if no device |

## Workflow: Starting an App

1. **Discover devices**: `adb devices` (CLI) or `flutter emulators` (CLI) — extension has no "list" tool
2. **Launch emulator if needed**: CLI only — see below
3. **Connect**: `flutter_connect(id: "emulator-5554")` — **ALWAYS use the tool**
4. **Run app**: `flutter_run()` — **ALWAYS use the tool** (not `flutter run`)
5. **Take screenshot**: `flutter_screenshot()` — verify the app launched
6. **Inspect**: `flutter_inspect_tree(flat: true)` — verify semantics labels
7. **Interact**: Hot reload/restart via `flutter_hot_reload()` / `flutter_hot_restart()`

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

# Single action (write temp YAML)
cat > /tmp/action.yaml << 'EOF'
appId: com.example.myapp
---
- tapOn: "login-button"
- assertVisible: "Welcome"
EOF
maestro test /tmp/action.yaml
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

**Always use the tool**: `flutter_inspect_tree(flat: true)` or `flutter_inspect_tree(search: "button")`

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

### "Take a screenshot and inspect it"

**Always use the tool**: `flutter_screenshot()` — returns image + path.

CLI fallback: `adb exec-out screencap -p > /tmp/screen.png`

## Non-Obvious Tips

- **Hot reload after crash**: Won't work. Use `flutter_hot_restart()` or stop and re-run.
- **Emulator slow on Linux**: Almost always KVM. Check: `cat /dev/kvm > /dev/null 2>&1 || echo "NO KVM"`
- **VM Service URL changes on hot restart**: The `flutter_hot_restart()` tool re-detects it automatically.
- **Maestro on emulator**: `assertVisible` can fail due to driver timeouts — this is a Maestro limitation, retry if needed.
- **Multiple Flutter projects in workspace**: Use `/flutter-project <name>` to select the target project.
- **Never run `flutter run` from CLI**: The `flutter_run()` tool wraps it and tracks the VM Service URL, process handle, and device state. Running CLI directly means the extension loses track of the running app.
