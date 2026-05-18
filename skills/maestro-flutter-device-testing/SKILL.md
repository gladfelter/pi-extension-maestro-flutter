---
   name: maestro-flutter-device-testing
   description: MANDATORY for Flutter/Maestro development. Contains the stateful workflow for flutter_run, connecting devices, and fixing common Flutter semantics-to-Maestro mismatches. READ THIS before building, starting, or testing the app.
---

# ⚠️ MANDATORY PROTOCOL: MUST READ

1. **USE WRAPPER SCRIPTS**: You **MUST** use the provided wrapper scripts for `maestro`, `adb`, and `flutter` to prevent accidental connection breakage.
   - These scripts are located in the `scripts/` directory relative to this skill:
     - Maestro: `scripts/maestro`
     - ADB: `scripts/adb`
     - Flutter: `scripts/flutter`
   - These scripts automatically:
     - Detect forbidden commands and YAML configurations.
     - Provide **AGENT INSTRUCTIONS** on stderr with log/screenshot locations if a `maestro` command fails.
     - Output a **SUMMARY OF FINAL STATE** in the format `[AttributeSource] 'Value' — bounds: [...]`.
       - Use the `AttributeSource` to construct the Maestro selector:
         - `accessibilityText` maps to `tapOn: 'Value'`
         - `resource-id` maps to `tapOn: { id: 'Value' }`
       - Icons: 👆 (clickable), 🎯 (focused), 🔘 (focused-but-not-deepest).
     - Block direct usage of `flutter run` unless `--force` is used.
   - To bypass checks for advanced debugging, use the `--force` flag.

2. **⚠️ FORBIDDEN MAESTRO COMMANDS**:
   - **DO NOT USE `launchApp`** or `pressKey: "Home"` or anything that might restart the app since that kills the active Flutter connection.
   - **Navigation MUST be via Remote Dpad keys**: Use `pressKey: "Remote Dpad ..."` for all navigation.
3.  **End your turn after `flutter_run()`**:
   - The extension will notify you when the app is ready.
   - Do NOT perform any Maestro, ADB, or Flutter operations until then.

---

# ⚠️ NO "STATE MISMATCH" — Don't Bypass the Extension

If you use the wrapper scripts you shouldn't encounter "State mismatch" errors. They happen when Flutter loses the connection to the device. This can also happen for network reasons, so it's not foolproof.

**DETECTION:**

If you encounter errors or unexplained behavior, use the `flutter_app_status` tool to verify that flutter is still connected.

**FIX:** If you find yourself in a "State Mismatch" state (detected by `flutter_app_status`), run `flutter_stop()` followed by `flutter_run()` to reset the connection.

# ⚠️ TIMEOUTS — Critical for Physical Devices

**Emulators are fast. Physical devices (especially Fire TV / Android TV sticks)
can be very slow due to network latency.** Every `maestro` and `adb` CLI command that touches a real device MUST use generous `timeout=` values or it will hang mid-test.

| Device Type                   | `maestro test` timeout | `maestro hierarchy` timeout | `flutter_screenshot` | D-pad press latency |
| ----------------------------- | ---------------------- | --------------------------- | -------------------- | ------------------- |
| Emulator                      | 30s (default fine)     | 15s                         | 10s                  | < 1s                |
| Fire TV / physical Android TV | **120s minimum**       | **60s**                     | `timeoutMs: 30000`   | 3–10s each          |
| Other physical Android        | 60s                    | 30s                         | `timeoutMs: 15000`   | 1–3s each           |

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

# Emulator management

See **[references/emulators.md](references/emulators.md)** for common commands and troubleshooting tips related to Android emulators, including KVM access on Linux.

# Example Session

1.  **Prepare**: `bash(command: "adb devices")` or `flutter emulators` to find a device ID.
2.  **Connect**: `flutter_connect(id: "<device-id>")`
3.  **Run**: `flutter_run()` (Fire-and-forget; wait for follow-up message).
4.  **Inspect**: Once ready, `flutter_app_status()` and `flutter_inspect_tree()`.
5.  **Test**: 
    - `maestro_test_file(...)` to create a test file.
    - `bash(command: "./skills/maestro-flutter-device-testing/scripts/maestro test <path-to-test>")`
6.  **Debug (if needed)**:
    - `get_logcat_path()` to find the log file.
    - `bash(command: 'grep "Error" $(get_logcat_path())')` to analyze logs.
7.  **Iterate**: `flutter_hot_reload()` or `flutter_hot_restart()` after code edits.
8.  **Shutdown**: `flutter_stop()` when finished.

## Inspecting using the VM Service (CLI — raw WebSocket access)

For queries beyond `flutter_inspect_tree()`, see how to use the [VM Service](https://dart.dev/tools/dartdev#vm-service).

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

## Common Problems

If the app is misbehaving, crashing or not responding, look for a matching solution in **[references/common-problems.md](references/common-problems.md)**.

## Accessibility Tree Issues

When `flutter_inspect_tree()` reports `⚠️ hint-only` warnings, `undefined` widgets, or Maestro `tapOn` can't find an element that's clearly on screen, see the reference doc: **[references/accessibility-fixes.md](references/accessibility-fixes.md)**. It catalogs common Flutter semantics→Maestro mismatches with before/after code examples and the Maestro selector changes needed.

## Non-Obvious Tips

- **Hot reload after crash**: Won't work. Use `flutter_hot_restart()` or stop and re-run.
- **Emulator slow on Linux**: Almost always KVM. Check: `cat /dev/kvm > /dev/null 2>&1 || echo "NO KVM"`
- **VM Service URL changes on hot restart**: The `flutter_hot_restart()` tool re-detects it automatically.
- **Maestro on emulator**: `assertVisible` can fail due to driver timeouts — this is a Maestro limitation, retry if needed.
- **Multiple Flutter projects in workspace**: Use `/flutter-project <name>` to select the target project.

## Fire TV / Android TV Quirks

If you're working with Fire TV or Android TV, see the dedicated reference doc for platform-specific quirks and best practices: **[references/tv-quirks.md](references/tv-quirks.md)**.

**Critical rules:**

- **`assertVisible` uses accessibility text, not widget text**: Flutter `Text` widgets with `Semantics` wrappers expose text that Maestro can match. Plain `Text()` widgets without semantics may not be matchable.
- **`Semantics(identifier:)` does NOT produce a `resource-id`**: On Fire TV, the identifier appears in `accessibilityText` — Maestro cannot match it with `id:` selector. Use text matching instead.
- **Screenshot verification is essential**: Many UI bugs are visual-only (focus highlights, layout overflow, subtitle rendering). A screenshot-capable model is needed for end-to-end TV testing because Maestro's `assertVisible` can't verify visual quality.