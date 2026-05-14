# pi-extension-maestro-flutter

A `pi.dev` extension for using the Maestro UI Automation system with Flutter for app building, hot reload, and app driving/inspection.

## Features

- **Flutter Management**: Build, run, hot reload, hot restart, and stop Flutter apps.
- **Maestro Integration**: Run Maestro test flows, execute single actions, and inspect UI hierarchy.
- **Background Execution**: Flutter runs in the background, allowing the agent to perform actions while the app is live.
- **UI Inspection**: Use `maestro_hierarchy` to let the agent "see" the app state.

## Installation

1. Clone this repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Load the extension in `pi`:
   ```bash
   pi -e ./src/index.ts
   ```
   Or add it to your project's `.pi/extensions/` directory.

## Tools

### Flutter
- `flutter_build`: Build the app.
- `flutter_run`: Start the app and keep it running for hot reload.
- `flutter_hot_reload`: Trigger 'r' in the Flutter process.
- `flutter_hot_restart`: Trigger 'R' in the Flutter process.
- `flutter_stop`: Terminate the Flutter process.
- `flutter_log`: Get recent logs.

### Maestro
- `maestro_hierarchy`: Get the current UI hierarchy.
- `maestro_test`: Run a YAML flow.
- `maestro_action`: Run a single Maestro action (e.g., `tapOn: "Login"`).

## Configuration

Use the `/maestro-config` command to set the `appId` and `deviceId`:

```
/maestro-config appId com.example.myapp
/maestro-config device emulator-5554
```

Alternatively, set the `APP_ID` environment variable.

## Development

The extension is written in TypeScript and uses `node:child_process` to manage external tools. It leverages the `pi` Extension API for tool registration and command handling.
