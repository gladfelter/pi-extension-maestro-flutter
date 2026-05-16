---
name: flutter-cli
description: Flutter, ADB, and Maestro CLI reference. Use for device management, building, logging, UI testing, and any task not covered by extension tools.
---

# Flutter CLI Reference

## Quick Reference: Tools vs CLI

| Task | How | Example |
|---|---|---|
| Run app | `flutter_run` tool | — |
| Stop app | `flutter_stop` tool | — |
| Hot reload / restart | `flutter_hot_reload` / `flutter_hot_restart` | — |
| Connect device / emulator | `flutter_connect` tool | — |
| Disconnect | `flutter_disconnect` tool | — |
| Inspect widget tree | `flutter_inspect_tree` tool | `flat: true` for compact label list |
| Search widgets by label | `flutter_inspect_tree` with `search` | `search: "login-button"` |
| Screenshot | `flutter_screenshot` tool | — |
| Current screen | `flutter_current_screen` tool | — |
| App status | `flutter_app_status` tool | — |
| List devices | CLI | `flutter devices` |
| List emulators | CLI | `flutter emulators` |
| Build APK / IPA / bundle | CLI | `flutter build apk` |
| View logs | CLI | `flutter log` or `adb logcat` |
| Raw VM Service calls | CLI (node script) | See VM Service section |
| Focus tree dump | CLI (node script) | `ext.flutter.debugDumpFocusTree` |
| Maestro hierarchy | CLI | `maestro hierarchy` |
| Run Maestro test flows | CLI | `maestro test flow.yaml` |
| Single Maestro action | CLI | `maestro test temp.yaml` |

## Device & Emulator Management

```bash
# List connected devices
flutter devices

# List available emulators (show ID in first column)
flutter emulators

# Launch emulator by AVD name
flutter emulators --launch test_34

# Check if emulator is fully booted
adb shell getprop sys.boot_completed   # "1" = ready

# Check KVM access (Linux — required for fast emulation)
cat /dev/kvm > /dev/null 2>&1 && echo "KVM OK" || echo "No KVM"

# If no KVM: add your user to the kvm group, then log out + back in
sudo gpasswd -a $USER kvm
```

## Building

```bash
# Debug APK (fastest, includes debug symbols)
flutter build apk --debug

# Release APK
flutter build apk

# iOS archive
flutter build ios --release

# Web bundle
flutter build web

# Android App Bundle (for Play Store)
flutter build appbundle

# Clean build cache (if build is broken)
flutter clean && flutter build apk
```

## Logs

```bash
# Flutter framework logs (most useful for debugging UI issues)
flutter log

# Flutter logs + device system logs
flutter log -v

# ADB logcat — filter by tag or level
adb logcat --pid=$(adb shell pidof app.$PACKAGE) -s Flutter:V

# Crash logs only
adb logcat -b crash -t 50

# Dart error stream
adb logcat -s FlutterRun:E
```

## VM Service (WebSocket)

The extension tracks the VM Service URL when `flutter_run` starts. For raw VM Service calls (focus tree, custom queries), write a node script:

```javascript
const WebSocket = require("ws");

// Get URL from flutter_run output or:
// adb shell dumpsys activity top | grep "ACTIVITY" then find the PID
const url = "ws://127.0.0.1:36319/:ws";  // replace http with ws, add /:ws

const ws = new WebSocket(url);
ws.on("open", () => {
  // 1. Get isolate ID
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "getVM" }));
});
ws.on("message", (data) => {
  const resp = JSON.parse(data.toString());
  if (resp.id === "1") {
    const isolateId = resp.result.isolates[0].id;
    // 2. Call extension method (e.g. focus tree)
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

## Maestro UI Testing

```bash
# Get current accessibility hierarchy (JSON)
maestro hierarchy

# Run a test flow
maestro test maestro/login_flow.yaml

# Run with environment variables
MASTERO_ENV=staging maestro test maestro/flow.yaml

# Single action (write a temp YAML and run it)
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
# Tap by text or accessibility label
- tapOn: "Sign In"

# Tap by coordinates
- tapOn: { point: "50%,50%" }

# Type text into a field
- tapOn: "username-field"
- inputText: "alice"

# Scroll (vertical)
- scroll
- scroll: { direction: "down", amount: 500 }

# Assert visibility
- assertVisible: "Welcome"
- assertNotVisible: "Error"

# Wait for element
- waitFor: "loading-spinner"
- tapOn: "loading-spinner"
- assertNotVisible: "loading-spinner"

# Swipe
- swipe: { start: "50%,80%", end: "50%,20%" }
```

## Common Scenarios

### "App won't launch"

```bash
# Check if device is connected
adb devices

# Check if Flutter is already running on the device
adb shell ps -A | grep -i flutter

# If stuck, kill the flutter process on device
adb shell pkill -f flutter
# Then use flutter_run tool again (it will auto-detect and attach vs run)
```

### "Need to find a widget's semantics label"

Use the `flutter_inspect_tree` tool with `flat: true` for a compact list:
```
flutter_inspect_tree(flat: true)
```
Or search by keyword:
```
flutter_inspect_tree(search: "button")
```

### "Which screen is currently visible?"

Use the `flutter_current_screen` tool (returns the Android activity name). Or via CLI:
```bash
adb shell dumpsys activity top | grep ACTIVITY
```

### "App crashed — why?"

```bash
# Use flutter_app_status tool for a quick check
# Or get crash logs directly:
adb logcat -b crash -t 20
```

### "Build is failing / stuck"

```bash
# Clean and rebuild
flutter clean
flutter pub get
flutter build apk --debug
```

### "Need more verbose output from flutter run"

```bash
flutter run -v   # verbose mode, shows all internal steps
```

### "Take a screenshot and inspect it"

Use the `flutter_screenshot` tool — it returns both a text path and the image. Or via CLI:
```bash
adb exec-out screencap -p > /tmp/screen.png
```

## Non-Obvious Tips

- **Hot reload after crash**: If the app crashed, hot reload won't work. Use `flutter_hot_restart` or kill and re-run.
- **Emulator slow on Linux**: Almost always a KVM issue. Run `cat /dev/kvm > /dev/null 2>&1 || echo "NO KVM"` to check.
- **VM Service URL changes on hot restart**: The extension re-detects it automatically via stdout parsing.
- **Maestro on emulator**: The `assertVisible` command can sometimes fail due to Maestro driver connection timeouts on emulators — this is a Maestro limitation, not a test issue. Retry the test if it fails intermittently.
- **Multiple Flutter projects in workspace**: Use `/flutter-project <name>` to select which one the extension tools target.
