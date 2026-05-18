# Common Scenarios

## "App won't launch"

1. Check device: `adb devices` (CLI)
2. Check tracked state: `flutter_app_status` (tool)
3. If stuck, `flutter_stop()` (tool)
4. Try again: `flutter_run()` (tool)

## "Need to find a widget's semantics label"

**Always use the tool**: `flutter_inspect_tree()` or `flutter_inspect_tree(search: "button")`

If `flutter_inspect_tree()` shows `resource-id` but no `accessibilityText` (or label), Maestro `tapOn` will fail because it cannot match `resource-id`.
**Fix**: Add a `label` to the `Semantics` widget or use `explicitChildNodes: true` to merge the identifier into the accessibility tree.

See **[references/accessibility-fixes.md](references/accessibility-fixes.md)** for common Flutter semantics→Maestro mismatches and their fixes.

## "Which screen is currently visible?"

**Use the tool**: `flutter_current_screen()`

CLI fallback: `adb shell dumpsys activity top | grep ACTIVITY`

## "App crashed — why?"

1. **Use the tool**: `flutter_app_status()` (quick check)
2. Get logs: `flutter_get_log_file()` (tool) and `tail <filepath>` (CLI) to view in real time
3. **Use the tool**: `flutter_hot_restart()` (tool) to recover from crash.

## "Build is failing / stuck"

```bash
flutter clean
flutter pub get
flutter build apk --debug
```

## "Take a screenshot (for human review or CI artifact)"

**Use the tool**: `flutter_screenshot()` — returns a file path. The agent cannot view or interpret the image content. Use `flutter_inspect_tree()` and `flutter_current_screen()` to programmatically verify UI state.