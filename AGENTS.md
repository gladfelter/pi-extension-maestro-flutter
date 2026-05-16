# pi-extension-maestro-flutter

Pi extension providing Flutter build/run/hot-reload/inspect tools, Maestro UI testing tools, and device management.

## Device management

Three tools handle device discovery, connection, and cleanup. Device preference is stored in `.pi/device.json` (workspace-level, survives `/new`).

| Tool / Command | Purpose | User-facing? |
|---|---|---|
| `flutter_devices` | Lists connected ADB devices, on-disk AVDs, mDNS-discovered network devices, and saved preference | Agent tool |
| `flutter_connect` | Connects to a device by id: IP:port via `adb connect`, AVD name via `flutter emulators --launch`. Saves to `.pi/device.json`. | Agent tool |
| `flutter_disconnect` | Kills launched emulator, runs `adb disconnect` for network devices, clears `.pi/device.json`. | Agent tool |
| `/flutter-devices` | Same as flutter_devices but displayed directly in the TUI | User command |
| `/flutter-connect <id>` | Connect to a device directly | User command |
| `/flutter-disconnect` | Disconnect from current device directly | User command |

## Flutter project selection

Projects are discovered by scanning the workspace for `pubspec.yaml` files (up to 4 levels deep). Config is stored in `.pi/flutter-project.json`.

| Command | Purpose |
|---|---|
| `/flutter-project` | List available projects; current selection marked with ▶ |
| `/flutter-project <name>` | Select a project by name or relative path |

**Auto-selection**: If only one project is found, it's selected silently. If multiple exist, tools throw with instructions to use `/flutter-project`.

**Auto-restore**: On session start, the saved project from `.pi/flutter-project.json` is reloaded.

## Code cleanup

This project uses **[Prettier](https://prettier.io/)** for code formatting. No ESLint is configured — Prettier alone handles formatting.

```bash
npm run format         # format in place
npm run format:check   # verify (CI / pre-commit)
```

### VSCode (WSL + Prettier extension)

The Prettier VSCode extension picks up `.prettierrc` automatically:

```jsonc
// .vscode/settings.json
{
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.formatOnSave": true,
  "[typescript]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode"
  }
}
```

Workflow: make changes → `npm run format` → commit.

---

## Test app (`test_app/`)

A minimal Flutter app that **exports every contract** the extension depends on.

### Run / build

```bash
cd test_app
flutter run -d <device-id>   # launch on device/emulator
flutter build apk --debug    # build debug APK (fast)
flutter build apk            # build release APK
flutter test                 # run widget tests
flutter analyze              # static analysis
```

### Android emulator (WSL2-native, zero Windows steps)

KVM must be enabled (one-time):

```bash
sudo gpasswd -a $USER kvm
# Log out and back into WSL2 for group membership to take effect
```

Start the emulator (WSLg provides the display window):

```bash
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
```

Wait for boot (~25s with KVM), then verify:

```bash
adb devices                         # should show emulator-5554
adb -e shell getprop sys.boot_completed  # should be "1"
```

The emulator window appears via WSLg automatically (no X server config needed).

### Contract surface

Each screen and widget exposes a specific contract that the extension (Flutter VM calls or Maestro) depends on.

| Screen | Widget | Semantics label / ID | Contract |
|--------|--------|--------------------|----------|
| Home | Counter text | `counter-display` | Text readout, changes on tap |
| Home | Increment button | `increment-button` | `tapOn` via Maestro |
| Home | Decrement button | `decrement-button` | `tapOn` via Maestro |
| Home | Nav button | `nav-to-form` | Navigation push, hierarchy change |
| Home | Nav button | `nav-to-list` | Navigation push, hierarchy change |
| Form | Name field | `name-field` (ID) | `inputText` via Maestro |
| Form | Email field | `email-field` (ID) | `inputText`, keyboard type |
| Form | Submit button | `submit-button` | `tapOn`, triggers state change |
| Form | Result text | `result-text` | Text readout after submit |
| List | 100 list items | `list-item-0` … `list-item-99` | Scroll, tap, hierarchy depth |

### Contracts the extension relies on

**Flutter VM Service (WebSocket)**
- `ext.flutter.debugDumpApp` — full widget tree; returns `{type: "Extension", method: "...", data: "<tree string>"}`
- `ext.flutter.debugDumpFocusTree` — focus tree; same response format
- **Verified 2026-05-16**: All 10 Semantics labels/identifiers visible in widget tree on API 34 emulator. Note: TextFields require `Semantics(identifier:)` to be discoverable by Maestro.

**Maestro CLI**
- `maestro hierarchy` — returns accessibility tree; depends on `Semantics` widgets
- `maestro test <flow.yaml>` — runs YAML flow; depends on `appId`, tap targets
- Single actions via temp YAML files — `tapOn`, `inputText`, `scroll`
- **Verified 2026-05-16**: Hierarchy shows all 10 labels; taps succeed. TextFields must be targeted using the `id:` selector in Maestro flows to match the `Semantics.identifier`. `assertVisible` can fail on emulator due to Maestro driver connection timeouts — this is a Maestro/emulator limitation, not a contract issue.

**Flutter CLI**
- `flutter build <target>` — apk, ios, bundle (used by `flutter_build`)
- `flutter run -d <device>` — emits VM Service URL on stdout (used by `flutter_run`)
- stdin `r` / `R` — hot reload / hot restart (used by `flutter_hot_reload`, `flutter_hot_restart`)
- stdout/stderr capture — log output (used by `flutter_log`)

### Maestro flow examples

Test flows for the toy app. Drop these in `test_app/maestro/` and run with `maestro test`.

**`home_counter.yaml`** — tap increment twice, verify counter:
```yaml
appId: com.pi.extension.test_app
---
- tapOn: "increment-button"
- tapOn: "increment-button"
- assertVisible: "Count: 2"
```

**`form_submit.yaml`** — fill and submit the form:
```yaml
appId: com.pi.extension.test_app
---
- tapOn: "nav-to-form"
- tapOn: "name-field"
- inputText: "Alice"
- tapOn: "email-field"
- inputText: "alice@example.com"
- tapOn: "submit-button"
- assertVisible: "Submitted: Alice <alice@example.com>"
```

---

## Architecture notes

### Tool return contract

`AgentToolResult<T>` requires `content` and `details`. **`isError` is not a return field** — the agent runtime determines errors by whether `execute()` throws. Always `throw new Error(...)` for failures, never `return { ..., isError: true }`.

### Fire-and-forget pattern

Long-running operations (`flutter_build`, `flutter_run`) use spawn + immediate return:
- **Progress**: periodic `pi.sendMessage(..., { deliverAs: "steer" })` — queued, doesn't interrupt
- **Completion**: `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })` — wakes agent
- **Abort**: `signal?.addEventListener("abort", ...)` — kills process on ESC/cancel
