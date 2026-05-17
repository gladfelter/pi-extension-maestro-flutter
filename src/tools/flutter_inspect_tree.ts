import { Type } from "typebox";
import type { ExtensionState } from "../state.js";
import { walkAccessibilityTree, detectTextFieldIssues, filterLabels, formatLabelsOutput } from "../common/semantics.js";

export function createFlutterInspectTreeTool(state: ExtensionState) {
  return {
    name: "flutter_inspect_tree",
    label: "Flutter Inspect Tree",
    description:
      "Inspect Flutter widget tree. Default: compact list of semantics labels (safe for context). Use search to filter by label text. Use full=true for raw VM service tree dump (very large, use only when needed).",
    parameters: Type.Object({
      search: Type.Optional(Type.String({ description: "Filter to widgets whose semantics label contains this text" })),
      full: Type.Optional(
        Type.Boolean({
          description:
            "Get the raw VM service widget tree dump. WARNING: this produces kilobytes of output. Only use when you need internal Flutter widget details, not for finding labels or testing.",
        }),
      ),
    }),
    // @ts-ignore - execute parameter types inferred by registerTool
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Full tree via VM service — only when explicitly requested
      if (params.full) {
        const full = await callVmService(state, "ext.flutter.debugDumpApp", {}, ctx.cwd);
        const allLines = full.content[0].text.split("\n");
        const totalLines = allLines.length;
        const MAX_LINES = 50;
        if (allLines.length > MAX_LINES) {
          const tail = allLines.slice(-MAX_LINES).join("\n");
          full.content[0].text = `... (showing last ${MAX_LINES} of ${totalLines} lines; head is Flutter framework plumbing)\n${tail}`;
          full.details.totalLines = totalLines;
        }
        return full;
      }

      // Default: compact semantics labels via maestro hierarchy
      const result = await state.pi.exec("maestro", ["hierarchy"], { timeout: 120000, signal });
      if (result.code !== 0) {
        throw new Error(`maestro hierarchy failed (exit ${result.code}):\n${result.stdout}`);
      }

      let tree: Record<string, unknown>;
      try {
        // Maestro prefixes output with "Running on <device>\n" before the JSON
        const jsonStart = result.stdout.indexOf("{");
        const jsonStr = jsonStart >= 0 ? result.stdout.slice(jsonStart) : result.stdout;
        tree = JSON.parse(jsonStr) as Record<string, unknown>;
      } catch {
        throw new Error(`Failed to parse maestro hierarchy JSON:\n${result.stdout.slice(0, 500)}`);
      }

      // Use extracted semantics parsing (tested in common/semantics.test.ts)
      const labels = walkAccessibilityTree(tree);
      const textFieldIssues = detectTextFieldIssues(tree);

      const filtered = filterLabels(labels, params.search || "");

      const output = formatLabelsOutput(filtered, labels.length, textFieldIssues);

      return {
        content: [{ type: "text", text: output }],
        details: { count: filtered.length, total: labels.length, textFieldIssues: textFieldIssues.length },
      };
    },
  };
}

// ── VM Service helper (used by inspect_tree full mode) ──────────────

async function callVmService(
  state: ExtensionState,
  method: string,
  callParams: Record<string, unknown> = {},
  cwd: string,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  if (!state.flutterProcess?.vmServiceUrl) {
    throw new Error("VM Service URL not found. Is the app running?");
  }

  const { writeFileSync, unlinkSync, mkdirSync } = require("node:fs");
  const { join } = require("node:path");

  const script = `
const WebSocket = require('ws');
const url = '${state.flutterProcess.vmServiceUrl.replace("http", "ws")}ws';
let retries = 0;
const maxRetries = 10;
function connect() {
  const ws = new WebSocket(url);
  ws.on('open', () => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'getVM' }));
  });
  ws.on('message', (data) => {
    const resp = JSON.parse(data.toString());
    if (resp.id === '1') {
      const isolateId = resp.result.isolates[0].id;
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: '2',
        method: '${method}',
        params: { isolateId, ...${JSON.stringify(callParams)} }
      }));
    } else if (resp.id === '2') {
      if (resp.result && resp.result.data !== undefined) {
          console.log(resp.result.data);
      } else if (resp.result && resp.result.result) {
          console.log(resp.result.result);
      } else {
          console.log(JSON.stringify(resp.result || resp.error));
      }
      ws.close();
      process.exit(0);
    }
  });
  ws.on('error', (e) => {
    retries++;
    if (retries < maxRetries) {
      console.error('Retry ' + retries + '/' + maxRetries + ': ' + e.message);
      setTimeout(connect, 1000);
    } else {
      console.error('Connection failed after ' + maxRetries + ' retries: ' + e.message);
      process.exit(1);
    }
  });
}
connect();
setTimeout(() => { console.error('Timeout'); process.exit(1); }, 15000);
      `;

  const tempFile = join(cwd, `.pi`, `vm_call_${Date.now()}.js`);
  mkdirSync(join(cwd, `.pi`), { recursive: true });
  writeFileSync(tempFile, script);
  try {
    const result = await state.pi.exec("node", [tempFile], { timeout: 20000 });
    if (result.code !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      throw new Error(`VM call failed (exit ${result.code}):\n${output.trim()}`);
    }
    return {
      content: [{ type: "text", text: result.stdout }],
      details: { code: result.code },
    };
  } finally {
    try {
      unlinkSync(tempFile);
    } catch {
      /* ignore */
    }
  }
}
