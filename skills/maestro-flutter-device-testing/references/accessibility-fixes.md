# Flutter Accessibility Fixes for Maestro Testing

Common issues where Flutter's semantics tree doesn't expose widgets the way Maestro expects, and how to fix them.

---

## 1. TextField wrapped in `Semantics(label:)` — label lands in `hintText`, not `accessibilityText`

### Problem

Wrapping a `TextField` with `Semantics(label: "name-field")` causes the label to appear in the semantics tree's `hintText` property rather than `accessibilityText`. Maestro's `tapOn: "name-field"` looks for the label in `accessibilityText` and **fails to find the element**.

This is a known Flutter+Android quirk — the internal editable text node's semantics take priority over the parent `Semantics` widget's label.

### Detection

Run `flutter_inspect_tree()`. If the output shows:

```
👆 `undefined` — [...] ⚠️ hint-only: `Name`
```

with a warning like:

```
⚠️ TextField semantics issue detected:
These Semantics labels are in `hintText` (not `accessibilityText`) and won't be found by maestro tapOn
```

…the fix below applies.

### Fix: Use `Semantics.identifier` + Maestro `id:` selector

Flutter 3.19+ exposes `Semantics.identifier`, which maps to the platform accessibility identifier — accessible to Maestro via the `id:` selector but **not** read aloud by screen readers.

**Before (broken):**

```dart
Semantics(
  label: "name-field",
  child: TextField(
    controller: _nameController,
    decoration: const InputDecoration(labelText: "Name", border: OutlineInputBorder()),
  ),
),
```

**After (fixed):**

```dart
Semantics(
  identifier: "name-field",
  child: TextField(
    controller: _nameController,
    decoration: const InputDecoration(labelText: "Name", border: OutlineInputBorder()),
  ),
),
```

**Maestro flow (must use `id:` selector, not bare string):**

```yaml
# BROKEN — still fails because identifier ≠ label text
- tapOn: "name-field"

# CORRECT — targets the semantics identifier
- tapOn:
    id: "name-field"
- inputText: "Alice"
```

### Alternatives

If you can't use `Semantics.identifier` (e.g., pre-Flutter 3.19), two other options exist:

1. **Use `InputDecoration(semanticLabel:)`** — puts the label directly in `accessibilityText`:
   ```dart
   TextField(
     decoration: const InputDecoration(
       labelText: "Name",
       semanticLabel: "name-field",
       border: OutlineInputBorder(),
     ),
   ),
   ```
   Maestro: `tapOn: "name-field"` (plain text match works here).

2. **Use `explicitChildNodes: true` + `ExcludeSemantics`** — force the label into `accessibilityText` by breaking the TextField's default semantics merge:
   ```dart
   Semantics(
     label: "name-field",
     explicitChildNodes: true,
     child: ExcludeSemantics(
       excluding: true,
       child: TextField(
         decoration: const InputDecoration(labelText: "Name", border: OutlineInputBorder()),
       ),
     ),
   ),
   ```
   ⚠️ Downside: strips the TextField's editable-text semantics, hurting real accessibility. Prefer `identifier`.

### Why `identifier` is preferred

- `identifier` doesn't interfere with screen readers (it's for automation only)
- `identifier` is stable across locales (unlike text labels that change with i18n)
- `identifier` survives A/B test copy changes
- It's the pattern officially recommended by the Maestro team for Flutter

---

## General Debugging Workflow

When a Maestro `tapOn` or `assertVisible` can't find an element:

1. **Inspect the semantics tree**: `flutter_inspect_tree()`
2. **Check the warning section** — the tree output flags common issues inline
3. **If the widget shows `undefined` with `⚠️ hint-only`**: the label is in `hintText` → apply Fix #1 above.
    *   *Note*: The `⚠️ hint-only` warning in `flutter_inspect_tree()` might persist even after using `identifier`. Verify the fix by running `maestro hierarchy` and checking for `resource-id`.
4. **If the widget is completely missing**: it likely has no `Semantics` wrapper → add one with `identifier` or `label`
5. **For icon-only buttons**: add `semanticLabel` to the `Icon` widget directly:
   ```dart
   Icon(Icons.add, semanticLabel: "fab-add")
   ```
6. **Test the fix**: write a temp YAML flow and run `maestro test /tmp/flow.yaml`
