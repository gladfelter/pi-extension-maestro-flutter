# Fire TV / Android TV Quirks

### Maestro Test Flow Pattern (Fire TV)
Do NOT use `tapOn` with text or `id:` selectors. Use `pressKey` for D-pad navigation.

```yaml
appId: com.lansite.firetv
---
- pressKey: "Remote Dpad Right"
- pressKey: "Remote Dpad Down"
- pressKey: "Remote Dpad Center"
- assertVisible: "Welcome, dev"
- pressKey: back
```

### Critical Rules for TV
- **Use `pressKey: "Remote Dpad ..."`** for all navigation.
- **`assertVisible` matches accessibility text**, not widget text.
- **`Semantics(identifier:)` doesn't produce `resource-id`** on TV; use text matching instead.
- **Screenshot verification is essential** for visual quality checks (subtitles, focus highlights).

### ADB / Device Quirks
- **`flutter_current_screen()` on Fire TV**: Queries `mResumedActivity` from `dumpsys activity activities`.
- **ADB can drop silently**: If `flutter_run` exits, check `flutter_app_status` for state mismatches, then `flutter_stop` + `flutter_run`.
- **Structural changes need rebuild**: Hot reload ignores structural changes. Use `flutter_hot_restart` or `flutter_stop` + `flutter_run`.
- **`maestro hierarchy` JSON prefix**: First line is `Running on <ip>:<port>`. Strip it with `sed '1d'` before JSON parsing.

### Flutter Widget Quirks on Fire TV
- **`KeyDownEvent` on hold**: Remotes may skip `KeyDownEvent` and only emit `KeyRepeatEvent`.
- **`GestureDetector.onTap` vs D-pad**: `onTap` doesn't fire on select. Handle `LogicalKeyboardKey.select` in `Focus.onKeyEvent`.
- **`Focus` location**: Place `Focus` widget as the outer wrapper, with `Container` inside to avoid stale focus highlights.
- **`showDialog` focus**: Parent screens must check `ModalRoute.of(context)?.isCurrent` before calling `requestFocus()`.
