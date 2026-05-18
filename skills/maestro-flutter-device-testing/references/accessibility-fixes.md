# Accessibility Fixes

When `flutter_inspect_tree()` or Maestro `hierarchy` report issues (labels missing, `hint-only` warnings, or unable to find elements), use these common fixes:

1.  **Label Missing**: Add a `Semantics` widget around your component.
    ```dart
    Semantics(
      label: "my-button",
      child: MyButton(...),
    )
    ```

2.  **TextFields (Label in hintText)**: Flutter wraps `TextField` with `Semantics` by default, often placing the label in `hintText`.
    *   **Option A**: Use `InputDecoration(semanticLabel: "...")`.
    *   **Option B**: Wrap with `Semantics(label: "...", explicitChildNodes: true)`.

3.  **Merge Children**: If a widget contains multiple sub-widgets that should be tapped together:
    ```dart
    Semantics(
      container: true,
      button: true,
      label: "Combined Button",
      child: Row(...),
    )
    ```
