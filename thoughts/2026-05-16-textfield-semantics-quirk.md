---
title: TextField Semantics Label Quirk on Android
date: 2026-05-16
status: known-issue
tags: [flutter, semantics, maestro, android, accessibility, textfield]
---

# TextField Semantics Label Quirk on Android

## Summary

When `Semantics(label: "…")` wraps a `TextField` (or `FormField<…>`) in Flutter, the label does **not** appear in the `accessibilityText` attribute on Android. Instead, Android's accessibility framework places it in `hintText`, where Maestro's `tapOn` action cannot find it.

## What happens

### Source code (what the developer writes)

```dart
Semantics(
  label: "name-field",
  child: TextField(
    decoration: InputDecoration(labelText: "Name", border: OutlineInputBorder()),
  ),
)
```

### Expected (what the developer expects)

The accessibility tree should expose `accessibilityText: "name-field"` so `maestro tapOn: "name-field"` works.

### Actual (what Android produces)

The `TextField` renders as `android.widget.EditText` and produces its own semantics node. The parent `Semantics` label gets merged into `hintText` rather than `accessibilityText`:

```
hintText: "name-field\nName"
accessibilityText: ""        ← EMPTY
text: ""                      ← EMPTY
class: "android.widget.EditText"
```

Maestro's `tapOn` searches `accessibilityText` and `text` — it does **not** search `hintText`. So `tapOn: "name-field"` fails with "Element not found".

## Why it happens

Flutter's `TextField` on Android uses the platform's `EditText` widget, which has built-in semantics support. When a `Semantics` widget wraps it:

1. Flutter sends the label to the Android accessibility system
2. Android maps `Semantics.label` to the EditText's `hint` property (not `contentDescription`)
3. The Maestro driver reads `hintText` (not `accessibilityText/contentDescription`)

This is a known interaction between Flutter's semantics layer and Android's native EditText accessibility contract. It does **not** happen with other widgets (ElevatedButton, ListTile, Text, etc.) because they don't have this platform-level semantics override.

## Affected widgets

Any Flutter widget that maps to a native text input on Android:
- `TextField` → `android.widget.EditText`
- `TextFormField` → `android.widget.EditText`
- `CupertinoTextField` → `android.widget.EditText` (when running on Android)

## Fixes

### Option 1: `explicitChildNodes: true` (recommended for simple cases)

```dart
Semantics(
  label: "name-field",
  explicitChildNodes: true,  // ← forces the label into its own accessibility node
  child: TextField(...),
)
```

This tells Flutter to create a separate accessibility node for the `Semantics` widget rather than merging it into the child. The label appears in `accessibilityText`.

**Caveat:** This creates an extra (invisible) accessibility node. Screen readers may announce it separately.

### Option 2: `InputDecoration.semanticLabel` (most Android-native)

```dart
TextField(
  decoration: InputDecoration(
    labelText: "Name",
    semanticLabel: "name-field",  // ← goes directly into accessibilityText
    border: OutlineInputBorder(),
  ),
)
```

This sets the label at the InputDecoration level, which Flutter passes to the Android EditText's `contentDescription` — the attribute Maestro searches.

**Caveat:** If you also have a `Semantics` wrapper, both labels may appear (merged). Use one or the other, not both.

### Option 3: `ExcludeSemantics` + `Semantics` (full override)

```dart
ExcludeSemantics(
  child: TextField(decoration: InputDecoration(labelText: "Name")),
),
Semantics(
  label: "name-field",
  child: ExcludeSemantics(
    child: TextField(
      controller: _controller,
      decoration: InputDecoration(labelText: "Name", border: OutlineInputBorder()),
    ),
  ),
)
```

This strips the TextField's default semantics and replaces them entirely with a custom `Semantics` node.

**Caveat:** More verbose. Required when you need fine-grained control over the accessibility tree structure.

## Extension handling

The `flutter_inspect_tree` tool now:

1. Parses `hintText` alongside `accessibilityText` and `text`
2. Detects the pattern: `hintText has content AND accessibilityText is empty AND class is android.widget.EditText`
3. Reports a warning with the affected labels and fix suggestions

Output when the issue is detected:

```
⚠️ TextField semantics issue detected (2 fields)
These Semantics labels are in `hintText` (not `accessibilityText`) and won't be found by maestro tapOn:
  - `name-field`
  - `email-field`

This is a known Flutter+Android quirk: Semantics(label) wrapping TextField places the label in hintText.
Fix options:
  1. Use Semantics(label: "...", explicitChildNodes: true) to force the label into accessibilityText
  2. Use InputDecoration(semanticLabel: "...") on the TextField directly
  3. Wrap with ExcludeSemantics() + Semantics() to override the TextField's default semantics
```

## Related

- [Flutter issue #45709](https://github.com/flutter/flutter/issues/45709) — TextField semantics on Android
- [Flutter docs: Semantics widget](https://api.flutter.dev/flutter/widgets/Semantics-class.html)
- [Maestro tapOn docs](https://maestro.mobile.dev/reference/actions/tapOn) — searches accessibilityText and text only
