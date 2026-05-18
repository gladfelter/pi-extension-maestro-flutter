import { describe, it, expect } from "vitest";
import {
  walkAccessibilityTree,
  detectTextFieldIssues,
  filterLabels,
  formatLabelLine,
  formatLabelsOutput,
} from "./semantics.js";

// Minimal maestro hierarchy-like tree fixture
function makeTree(root: Record<string, unknown>): unknown {
  return { attributes: { class: "android.widget.FrameLayout" }, children: [root] };
}

function makeNode(attrs: Record<string, string>, children: unknown[] = []): Record<string, unknown> {
  const focused = attrs.focused || "false";
  return { attributes: { ...attrs, focused }, children };
}

describe("walkAccessibilityTree", () => {
  it("extracts labels from leaf nodes with accessibilityText", () => {
    const tree = makeTree(
      makeNode(
        {
          accessibilityText: "counter-display",
          text: "Count: 0",
          clickable: "false",
          bounds: "0,0-100,50",
        },
        [],
      ),
    );
    const labels = walkAccessibilityTree(tree);
    expect(labels).toEqual([
      {
        label: "counter-display",
        type: "accessibilityText",
        text: "Count: 0",
        clickable: false,
        bounds: "0,0-100,50",
        focused: false,
      },
    ]);
  });

  it("extracts clickable buttons", () => {
    const tree = makeTree(
      makeNode(
        {
          accessibilityText: "increment-button",
          clickable: "true",
          bounds: "100,0-200,50",
        },
        [],
      ),
    );
    const labels = walkAccessibilityTree(tree);
    expect(labels[0].clickable).toBe(true);
    expect(labels[0].label).toBe("increment-button");
    expect(labels[0].type).toBe("accessibilityText");
    expect(labels[0].focused).toBe(false);
  });

  it("extracts nodes with only text (no accessibilityText)", () => {
    const tree = makeTree(makeNode({ text: "Some text", clickable: "false", bounds: "0,0-50,20" }));
    const labels = walkAccessibilityTree(tree);
    expect(labels[0].label).toBe("");
    expect(labels[0].type).toBe("");
    expect(labels[0].text).toBe("Some text");
    expect(labels[0].focused).toBe(false);
  });

  it("skips nodes with no text/accessibility/hint", () => {
    const tree = makeTree(makeNode({ class: "android.widget.FrameLayout", clickable: "false", bounds: "0,0-300,500" }));
    expect(walkAccessibilityTree(tree)).toEqual([]);
  });

  it("identifies the deepest-nested focused element", () => {
    const tree = makeTree(
      makeNode({ class: "parent", focused: "true" }, [
        makeNode({ class: "child", focused: "true", accessibilityText: "child-label" }, []),
      ]),
    );
    const labels = walkAccessibilityTree(tree);
    
    // Parent doesn't have a label in this test, child does.
    // Wait, walkAccessibilityTree filters by meaningful text.
    // Let's add label to parent.
    const treeWithLabels = makeTree(
        makeNode({ class: "parent", focused: "true", accessibilityText: "parent-label" }, [
          makeNode({ class: "child", focused: "true", accessibilityText: "child-label" }, []),
        ]),
      );
    const labels2 = walkAccessibilityTree(treeWithLabels);
    
    expect(labels2.find(l => l.label === "parent-label")?.isDeepestFocused).toBeFalsy();
    expect(labels2.find(l => l.label === "child-label")?.isDeepestFocused).toBe(true);
  });

  it("includes clickable nodes even when they have children", () => {
    const tree = makeTree(
      makeNode(
        {
          accessibilityText: "nav-to-form",
          clickable: "true",
          bounds: "0,0-100,50",
        },
        [
          {
            attributes: { text: "Go to form", clickable: "false", bounds: "10,10-90,40" },
            children: [],
          },
        ],
      ),
    );
    const labels = walkAccessibilityTree(tree);
    // Should include both the parent (clickable) and the child (leaf with text)
    expect(labels.length).toBe(2);
  });
});

describe("detectTextFieldIssues", () => {
  it("detects TextField with label in hintText but no accessibilityText", () => {
    const tree = makeTree(
      makeNode({
        class: "android.widget.EditText",
        hintText: "name-field",
        accessibilityText: "",
        clickable: "true",
        bounds: "0,0-200,40",
      }),
    );
    const issues = detectTextFieldIssues(tree);
    expect(issues).toEqual([
      { hintTextLabel: "name-field", bounds: "0,0-200,40", className: "android.widget.EditText" },
    ]);
  });

  it("does not flag EditText with proper accessibilityText", () => {
    const tree = makeTree(
      makeNode({
        class: "android.widget.EditText",
        hintText: "Enter name",
        accessibilityText: "name-field",
        clickable: "true",
        bounds: "0,0-200,40",
      }),
    );
    expect(detectTextFieldIssues(tree)).toEqual([]);
  });

  it("does not flag non-EditText widgets", () => {
    const tree = makeTree(
      makeNode({
        class: "android.widget.TextView",
        hintText: "name-field",
        accessibilityText: "",
        bounds: "0,0-200,40",
      }),
    );
    expect(detectTextFieldIssues(tree)).toEqual([]);
  });

  it("extracts first line of multi-line hintText", () => {
    const tree = makeTree(
      makeNode({
        class: "android.widget.EditText",
        hintText: "email-field\noptional",
        accessibilityText: "",
        clickable: "true",
        bounds: "0,0-200,40",
      }),
    );
    const issues = detectTextFieldIssues(tree);
    expect(issues[0].hintTextLabel).toBe("email-field");
  });
});

describe("filterLabels", () => {
  const labels: AccessibilityLabel[] = [
    { label: "counter-display", type: "accessibilityText", text: "Count: 0", clickable: false, bounds: "0,0-100,50", focused: false },
    { label: "increment-button", type: "accessibilityText", clickable: true, bounds: "100,0-200,50", focused: false },
    { label: "", type: "", text: "Count: 0", clickable: false, bounds: "0,0-100,50", focused: false },
    { label: "name-field", type: "accessibilityText", hintText: "Enter name", clickable: true, bounds: "0,0-200,40", focused: false },
  ];

  it("returns all labels when query is empty", () => {
    expect(filterLabels(labels, "")).toBe(labels); // same reference
  });

  it("filters by label text (case-insensitive)", () => {
    const results = filterLabels(labels, "INCREMENT");
    expect(results.length).toBe(1);
    expect(results[0].label).toBe("increment-button");
  });

  it("filters by text content", () => {
    const results = filterLabels(labels, "count: 0");
    expect(results.length).toBe(2);
  });

  it("filters by hintText", () => {
    const results = filterLabels(labels, "enter name");
    expect(results.length).toBe(1);
    expect(results[0].label).toBe("name-field");
  });

  it("returns empty when no matches", () => {
    expect(filterLabels(labels, "nonexistent")).toEqual([]);
  });
});

describe("formatLabelLine", () => {
  it("formats a basic label with extra text in brackets", () => {
    const label: AccessibilityLabel = { label: "counter-display", type: "accessibilityText", text: "Count: 0", clickable: false, bounds: "0,0-100,50", focused: false };
    const line = formatLabelLine(label);
    expect(line).not.toContain("👆"); // not clickable
    expect(line).toContain("[Count: 0]"); // extra text shown
  });

  it("adds clickable emoji", () => {
    const label: AccessibilityLabel = { label: "increment-button", type: "accessibilityText", clickable: true, bounds: "100,0-200,50", focused: false };
    const line = formatLabelLine(label);
    expect(line).toContain("👆");
  });

  it("shows hint-only warning", () => {
    const label: AccessibilityLabel = { label: "", type: "", hintText: "name-field", clickable: false, bounds: "0,0-200,40", focused: false };
    const line = formatLabelLine(label);
    expect(line).toContain("⚠️ hint-only");
  });

  it("shows extra text in brackets", () => {
    const label: AccessibilityLabel = { label: "counter-display", type: "accessibilityText", text: "Count: 0", clickable: false, bounds: "0,0-100,50", focused: false };
    const line = formatLabelLine(label);
    expect(line).toContain("[Count: 0]");
  });
});

describe("formatLabelsOutput", () => {
  it("produces output with TextField warnings", () => {
    const labels: AccessibilityLabel[] = [{ label: "counter-display", type: "accessibilityText", text: "Count: 0", clickable: false, bounds: "0,0-100,50", focused: false }];
    const issues = [{ hintTextLabel: "name-field", bounds: "0,0-200,40", className: "android.widget.EditText" }];
    const output = formatLabelsOutput(labels, 1, issues);
    expect(output).toContain("⚠️ TextField semantics issue detected (1 field)");
    expect(output).toContain("name-field");
    expect(output).toContain("Fix options");
  });

  it("produces clean output with no issues", () => {
    const labels: AccessibilityLabel[] = [{ label: "counter-display", type: "accessibilityText", clickable: false, bounds: "0,0-100,50", focused: false }];
    const output = formatLabelsOutput(labels, 1, []);
    expect(output).not.toContain("⚠️");
  });
});
