/**
 * Parse maestro hierarchy output into accessible widget labels.
 * Pure functions — no I/O, no Pi API.
 */

export interface AccessibilityLabel {
  label: string;
  type: string; // Added to distinguish accessibilityText vs resource-id
  text?: string;
  hintText?: string;
  clickable: boolean;
  bounds: string;
  focused?: boolean;
  isDeepestFocused?: boolean;
}

export interface TextFieldIssue {
  hintTextLabel: string;
  bounds: string;
  className: string;
}

type TreeNode = Record<string, unknown> | unknown[];

interface NodeAttributes {
  accessibilityText?: string;
  text?: string;
  hintText?: string;
  clickable?: string;
  bounds?: string;
  class?: string;
  'resource-id'?: string;
  focused?: string;
}

/**
 * Recursively walk a maestro hierarchy tree and extract leaf nodes
 * with accessibility text, display text, or hintText.
 */
export function walkAccessibilityTree(root: unknown): AccessibilityLabel[] {
  const labels: AccessibilityLabel[] = [];
  let deepestFocusedDepth = -1;
  let deepestFocusedLabel: AccessibilityLabel | undefined;

  walk(root, labels, 0, (label, depth) => {
    if (label.focused && depth > deepestFocusedDepth) {
      deepestFocusedDepth = depth;
      deepestFocusedLabel = label;
    }
  });

  if (deepestFocusedLabel) {
    deepestFocusedLabel.isDeepestFocused = true;
  }
  return labels;
}

function walk(
  node: unknown,
  labels: AccessibilityLabel[],
  depth: number,
  onLabel: (label: AccessibilityLabel, depth: number) => void,
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  const attrs = obj.attributes as NodeAttributes | undefined;

  if (attrs) {
    let label = "";
    let type = "";
    
    // Explicitly prioritize and identify the source attribute
    if (attrs.accessibilityText) {
      label = attrs.accessibilityText;
      type = "accessibilityText";
    } else if (attrs['resource-id']) {
      label = attrs['resource-id'];
      type = "resource-id";
    }
    
    const text = attrs.text || "";
    const hintText = attrs.hintText || "";
    const clickable = attrs.clickable === "true";
    const bounds = attrs.bounds || "";
    const focused = attrs.focused === "true";

    const children = obj.children as unknown[] | undefined;
    const hasChildren = Array.isArray(children) && children.length > 0;

    // Include if it has meaningful text/hint and is a leaf or clickable
    if ((label || text || hintText) && (!hasChildren || clickable)) {
      const labelObj: AccessibilityLabel = {
        label,
        type,
        text: text || undefined,
        hintText: hintText || undefined,
        clickable,
        bounds,
        focused,
      };
      labels.push(labelObj);
      onLabel(labelObj, depth);
    }
  }

  if (Array.isArray(obj.children)) {
    for (const child of obj.children) walk(child, labels, depth + 1, onLabel);
  }
}

/**
 * Detect TextField semantics issues where Semantics.label ends up in
 * hintText instead of accessibilityText (Flutter+Android accessibility quirk).
 */
export function detectTextFieldIssues(root: unknown): TextFieldIssue[] {
  const issues: TextFieldIssue[] = [];
  detect(root, issues);
  return issues;
}

function detect(node: unknown, issues: TextFieldIssue[]): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  const attrs = obj.attributes as NodeAttributes | undefined;

  if (attrs) {
    const hintText = attrs.hintText || "";
    const accessibilityText = attrs.accessibilityText || "";
    const className = attrs.class || "";
    const bounds = attrs.bounds || "";

    // Semantics.label wrapping TextField places the label in hintText, not accessibilityText
    if (hintText && !accessibilityText && className === "android.widget.EditText") {
      const firstLine = hintText.split("\n")[0].trim();
      if (firstLine) {
        issues.push({ hintTextLabel: firstLine, bounds, className });
      }
    }
  }

  if (Array.isArray(obj.children)) {
    for (const child of obj.children) detect(child, issues);
  }
}

/**
 * Filter labels by a search query (case-insensitive).
 */
export function filterLabels(labels: AccessibilityLabel[], query: string): AccessibilityLabel[] {
  if (!query) return labels;
  const q = query.toLowerCase();
  return labels.filter(
    (l) =>
      l.label.toLowerCase().includes(q) || l.text?.toLowerCase().includes(q) || l.hintText?.toLowerCase().includes(q),
  );
}

/**
 * Format a single AccessibilityLabel into a display line.
 */
export function formatLabelLine(label: AccessibilityLabel): string {
  const click = label.clickable ? "👆" : "";
  const focus = label.isDeepestFocused ? "🎯" : label.focused ? "🔘" : "";
  const hint = label.hintText && !label.label ? ` ⚠️ hint-only: \`${label.hintText.split("\n")[0]}\`` : "";
  const extra = label.text && label.text !== label.label ? ` [${label.text}]` : "";
  return `${click}${focus} [${label.type || 'unknown'}] '${label.label || label.text}' — ${label.bounds}${extra}${hint}`;
}

/**
 * Format all labels into a complete output string, with truncation and TextField issue warnings.
 */
export function formatLabelsOutput(
  labels: AccessibilityLabel[],
  total: number,
  textFieldIssues: TextFieldIssue[],
  maxBytes = 4096,
): string {
  const lines = labels.map(formatLabelLine);
  const joined = lines.join("\n");
  const truncated = joined.length > maxBytes;
  let output = truncated ? joined.slice(0, maxBytes) + "\n... (truncated, use search to find specific labels)" : joined;

  if (textFieldIssues.length > 0) {
    const issueLabels = textFieldIssues.map((i) => `  - \`${i.hintTextLabel}\``).join("\n");
    output += `\n\n⚠️ TextField semantics issue detected (${textFieldIssues.length} field${textFieldIssues.length > 1 ? "s" : ""})\n`;
    output += `These Semantics labels are in \`hintText\` (not \`accessibilityText\`) and won't be found by maestro tapOn:\n${issueLabels}\n\n`;
    output += `This is a known Flutter+Android quirk: Semantics(label) wrapping TextField places the label in hintText.\n`;
    output += `Fix options:\n`;
    output += `  1. Use Semantics(label: "...", explicitChildNodes: true) to force the label into accessibilityText\n`;
    output += `  2. Use InputDecoration(semanticLabel: "...") on the TextField directly\n`;
    output += `  3. Wrap with ExcludeSemantics() + Semantics() to override the TextField's default semantics\n`;
  }

  return output;
}
