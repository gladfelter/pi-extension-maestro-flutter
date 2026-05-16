---
name: flutter-cli
description: Flutter, ADB, and Maestro CLI reference for device management, app debugging, and UI testing. Use when extension tools are too limited (need filtering, searching, or composing output) or for tasks not covered by extension tools.
---

# Flutter CLI Reference

Extension tools handle the **90% case**: `flutter_run`, `flutter_stop`, `flutter_hot_reload`, `flutter_inspect_tree`, `flutter_screenshot`, `flutter_current_screen`, `flutter_app_status`.

Use CLI for everything else — filtering, searching, composing, and edge cases.

### Removed tools (use CLI instead)
| Removed tool | CLI equivalent |
|---|---|
| `flutter_devices` | `flutter devices` / `flutter emulators` / `adb devices` |
| `flutter_build` | `flutter build <target>` (see below) |
| `flutter_log` | `flutter log` / `adb logcat` (see below) |
| `flutter_vm_call` | See VM Service section — write a node script using `ws` |
| `flutter_inspect_focus` | See `flutter_inspect_tree` with `flat: true` or CLI VM Service call |
| `maestro_hierarchy` | `maestro hierarchy` (see below) |
| `maestro_test` | `maestro test <flow.yaml>` (see below) |
| `maestro_action` | Write a temp YAML flow and run `maestro test` |

## Device & Emulator Management

```bash
# List devices (extension flutter_devices wraps this)
flutter devices

# List available emulators
flutter emulators

# Launch emulator (extension flutter_connect wraps this)
flutter emulators --launch <id>

# Check if emulator is booted
adb shell getprop sys.boot_completed   # "1" = ready

# Check KVM access (Linux)
ls -la /dev/kvm                        # exists + readable = OK
cat /dev/kvm > /dev/null 2>&1 && echo "KVM OK" || echo "No KVM access"

# Fix KVM (one-time)
sudo gpasswd -a $USER kvm
```

## App Process Debugging

```bash
# Find running Flutter processes on device
adb shell ps | grep flutter

# Get Dart VM service port
adb shell ps | grep flutter | awk '{print $NF}'   # last field has --dart-define or port info

# Forward VM service port to host
adb forward tcp:<host-port> tcp:<device-port>

# Screenshot
adb exec-out screencap -p > screenshot.png

# Screen record (30s)
adb shell screenrecord /sdcard/recording.mp4 &
sleep 30 && adb pull /sdcard/recording.mp4
```

## Logs

```bash
# Flutter logs (cleaner than logcat)
flutter logs

# ADB logcat filtered for Flutter
adb logcat | grep -E "Flutter|I/ActivityManager|E/AndroidRuntime"

# Follow logs in real-time
adb logcat -s FlutterActivity:V FlutterMain:V

# Clear logcat buffer
adb logcat -c

# Recent crashes only
adb logcat -b crash -t 50
```

## Package & APK

```bash
# Find APK location
adb shell pm path com.pi.extension.test_app

# Pull APK from device
adb pull <path-from-pm-path> ./app.apk

# List build artifacts
find build/ -name "*.apk" -o -name "*.appbundle" | sort

# Check app is installed
adb shell pm list packages | grep test_app
```

## VM Service (Direct Access)

When extension `flutter_vm_call` doesn't fit:

```bash
# Get VM service URL from running app
adb shell ps | grep flutter   # look for ws:// or http:// in command line

# Or from flutter run output
flutter attach --machine | grep vmService

# Call VM service directly (e.g., get heap info)
curl "http://127.0.0.1:<port>/json" | jq .

# Widget tree via HTTP (alternative to WebSocket)
curl "http://127.0.0.1:<port>/_dumpApp"
```

## Maestro CLI

```bash
# Full UI hierarchy (extension wraps this)
maestro hierarchy

# Filter hierarchy for semantics labels only
maestro hierarchy | jq '.. | .attributes? // empty | select(.accessibilityText != "") | .accessibilityText'

# Run a test flow
maestro test maestro/home_counter.yaml

# Run with recording
maestro test maestro/home_counter.yaml --format mp4

# Start interactive Maestro CLI (tap/click in terminal)
maestro interactive

# Check if Maestro is installed
maestro doctor
```

## When to Use CLI vs Extension Tools

| Task | Use |
|------|-----|
| Run app, hot reload, stop | Extension (`flutter_run`, `flutter_hot_reload`, `flutter_stop`) |
| VM service calls (inspect tree, focus) | Extension (`flutter_inspect_tree`, `flutter_inspect_focus`) |
| Search/filter widget tree | CLI (`maestro hierarchy \| jq ...`) |
| Read recent logs | Extension (`flutter_log`) |
| Debug crashes, filter logcat | CLI (`adb logcat \| grep ...`) |
| Launch/connect device | Extension (`flutter_connect`) |
| Advanced device/emulator ops | CLI (`adb shell ps`, `screencap`) |
| Run maestro test flow | Extension (`maestro_test`) |
| Compose/transform hierarchy | CLI (`maestro hierarchy \| jq ...`) |
| Build APK | Extension (`flutter_build`) |
| Find APK on disk | CLI (`find build/`) |

## Common Patterns

**Check if app is already running before flutter_run:**
```bash
adb shell ps | grep com.pi.extension.test_app
# If found, use flutter attach instead
```

**Get just semantics labels from hierarchy:**
```bash
maestro hierarchy | jq -r '.. | .attributes? // empty | select(.accessibilityText != "") | "\(.accessibilityText)"'
```

**Find clickable widgets with bounds:**
```bash
maestro hierarchy | jq '[.. | objects | select(.clickable == true and .attributes.text != "") | {label: .attributes.accessibilityText, bounds: .attributes.bounds}]'
```

**Quick app state check:**
```bash
adb shell dumpsys activity top | grep ACTIVITY   # current screen
adb shell content query --uri content://com.android.shell.settings/system | grep currentPackageName
```
