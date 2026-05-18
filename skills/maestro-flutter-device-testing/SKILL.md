---
   name: maestro-flutter-device-testing
   description: MANDATORY for Flutter/Maestro development. Contains the stateful workflow for flutter_run, connecting devices, and fixing common Flutter semantics-to-Maestro mismatches. READ THIS before building, starting, or testing the app.
---

# ⚠️ MANDATORY PROTOCOL: MUST READ

1. **USE WRAPPER SCRIPTS**: You **MUST** use the provided wrapper scripts for `maestro` and `adb` to prevent accidental connection breakage they prevent forbidden commands and configurations, and provide critical debugging information on failure.
   - These scripts are located in the `scripts/` directory relative to this skill:
     - Maestro: `scripts/maestro`
     - ADB: `scripts/adb`

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

1. `bash(command: "adb devices")` or `bash(command: "flutter emulators")` to find device ID or emulator name. See **[references/emulators.md](references/emulators.md)** for emulator-specific guidance.
2. `flutter_connect(id: "emulator-5554")`
3. `flutter_run()` — **ALWAYS use the tool** (not bash tool `flutter run`)
4. **END YOUR TURN** — `flutter_run()` returns immediately while the app builds in the background and it will notify you when the app is ready or if there's an error. You may use unrelated tools like read() or edit() while waiting, but do NOT use any Maestro, ADB, or Flutter tools until you get the follow-up message that the app is ready.
5. `flutter_app_status()` — verify connection and check which screen is visible
6. `flutter_inspect_tree()` — verify semantics labels and screen content
7.  `maestro_test_file(name: "tap-login", content: "appId: com.example.myapp\n---\n- tapOn: \"login-button\"\n- assertVisible: \"Welcome\"\n")` — define a Maestro test flow.
8. `bash(command: "flutter test [testfile]")` - Run the Maestro test flow.
8. Inspect results and make code edits.
7. `flutter_hot_reload()` / `flutter_hot_restart()` — interact with the app and recover from crashes without restarting the app. See **[references/tv-quirks.md](references/tv-quirks.md)** for Fire TV-specific hot reload gotchas. 
8. Got to step 5 and repeat the cycle or `flutter_stop()`.

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