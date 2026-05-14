import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export default function (pi: ExtensionAPI) {
  let flutterProcess: ChildProcess | null = null;
  let flutterOutput = "";
  let appId: string | null = null;
  let deviceId: string | null = null;
  let vmServiceUrl: string | null = null;

  pi.on("session_shutdown", async () => {
    if (flutterProcess) {
      flutterProcess.kill();
      flutterProcess = null;
    }
  });

  pi.registerCommand("maestro-config", {
    description: "Configure Maestro and Flutter extension",
    handler: async (args, ctx) => {
      const parts = args.split(" ");
      if (parts[0] === "appId") {
        appId = parts[1];
        ctx.ui.notify(`Set appId to ${appId}`, "info");
      } else if (parts[0] === "device") {
        deviceId = parts[1];
        ctx.ui.notify(`Set deviceId to ${deviceId}`, "info");
      } else {
        ctx.ui.notify("Usage: /maestro-config appId <id> OR /maestro-config device <id>", "error");
      }
    },
  });

  // --- Flutter Tools ---

  pi.registerTool({
    name: "flutter_build",
    label: "Flutter Build",
    description: "Build the Flutter app",
    parameters: Type.Object({
      target: Type.String({ description: "Platform to build for (e.g., ios, apk, bundle)" }),
      args: Type.Optional(Type.Array(Type.String(), { description: "Additional arguments" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const args = ["build", params.target, ...(params.args || [])];
      onUpdate?.({ content: [{ type: "text", text: `Running: flutter ${args.join(" ")}` }] });
      
      const result = await ctx.exec("flutter", args);
      return {
        content: [{ type: "text", text: result.output }],
        details: { exitCode: result.exitCode },
        isError: result.exitCode !== 0,
      };
    },
  });

  pi.registerTool({
    name: "flutter_run",
    label: "Flutter Run",
    description: "Start the Flutter app. Keeps the process running in the background for hot reload.",
    parameters: Type.Object({
      device: Type.Optional(Type.String({ description: "Device ID to run on" })),
      args: Type.Optional(Type.Array(Type.String(), { description: "Additional arguments" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const targetDevice = params.device || deviceId;
      if (flutterProcess) {
        return {
          content: [{ type: "text", text: "Flutter is already running. Use flutter_hot_reload or flutter_stop first." }],
          isError: true,
        };
      }

      const args = ["run", ...(targetDevice ? ["-d", targetDevice] : []), ...(params.args || [])];
      onUpdate?.({ content: [{ type: "text", text: `Starting: flutter ${args.join(" ")}` }] });

      flutterProcess = spawn("flutter", args, {
        cwd: ctx.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      flutterProcess.stdout?.on("data", (data) => {
        const str = data.toString();
        flutterOutput += str;

        // Try to capture VM Service URL
        const match = str.match(/Dart VM Service.*?available at: (https?:\/\/[^\s\/]+:\d+\/[^\s]+)/);
        if (match) {
          vmServiceUrl = match[1];
        }

        if (flutterOutput.length > 100000) {
          flutterOutput = flutterOutput.slice(-50000);
        }
      });

      flutterProcess.stderr?.on("data", (data) => {
        const str = data.toString();
        flutterOutput += str;
        if (flutterOutput.length > 100000) {
          flutterOutput = flutterOutput.slice(-50000);
        }
      });

      flutterProcess.on("exit", (code) => {
        flutterProcess = null;
      });

      // Wait a bit to see if it starts successfully or fails immediately
      await new Promise((resolve) => setTimeout(resolve, 5000));

      return {
        content: [{ type: "text", text: `Flutter run started in background.\n\nRecent output:\n${flutterOutput.slice(-1000)}` }],
        details: { running: !!flutterProcess },
      };
    },
  });

  pi.registerTool({
    name: "flutter_hot_reload",
    label: "Flutter Hot Reload",
    description: "Trigger a hot reload of the running Flutter app",
    parameters: Type.Object({}),
    async execute() {
      if (!flutterProcess || !flutterProcess.stdin) {
        return { content: [{ type: "text", text: "Flutter app is not running." }], isError: true };
      }
      flutterProcess.stdin.write("r");
      return { content: [{ type: "text", text: "Sent hot reload command ('r') to Flutter process." }] };
    },
  });

  pi.registerTool({
    name: "flutter_hot_restart",
    label: "Flutter Hot Restart",
    description: "Trigger a hot restart of the running Flutter app",
    parameters: Type.Object({}),
    async execute() {
      if (!flutterProcess || !flutterProcess.stdin) {
        return { content: [{ type: "text", text: "Flutter app is not running." }], isError: true };
      }
      flutterProcess.stdin.write("R");
      return { content: [{ type: "text", text: "Sent hot restart command ('R') to Flutter process." }] };
    },
  });

  pi.registerTool({
    name: "flutter_stop",
    label: "Flutter Stop",
    description: "Stop the running Flutter app",
    parameters: Type.Object({}),
    async execute() {
      if (!flutterProcess) {
        return { content: [{ type: "text", text: "Flutter app is not running." }] };
      }
      flutterProcess.kill();
      flutterProcess = null;
      return { content: [{ type: "text", text: "Stopped Flutter process." }] };
    },
  });

  pi.registerTool({
    name: "flutter_log",
    label: "Flutter Log",
    description: "Get recent logs from the running Flutter app",
    parameters: Type.Object({
      lines: Type.Optional(Type.Number({ description: "Number of lines to return", default: 100 })),
    }),
    async execute(toolCallId, params) {
      if (!flutterProcess) {
        return { content: [{ type: "text", text: "Flutter app is not running." }], isError: true };
      }
      // Since we are capturing output in a variable in the closure
      // We need to make sure we are actually storing it.
      // I'll update the stdout handler to keep a buffer.
      return { content: [{ type: "text", text: `Recent logs:\n${flutterOutput.slice(-(params.lines || 100) * 100)}` }] };
    },
  });

  pi.registerTool({
    name: "flutter_vm_call",
    label: "Flutter VM Call",
    description: "Call a Flutter VM Service extension (e.g., ext.flutter.debugDumpApp)",
    parameters: Type.Object({
      method: Type.String({ description: "Service extension method name" }),
      params: Type.Optional(Type.Any({ description: "Method parameters" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!vmServiceUrl) {
        return { content: [{ type: "text", text: "VM Service URL not found. Is the app running and log capturing working?" }], isError: true };
      }

      const script = `
const WebSocket = require('ws');
const url = '${vmServiceUrl.replace('http', 'ws')}ws';
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
      method: '${params.method}',
      params: { isolateId, ...${JSON.stringify(params.params || {})} }
    }));
  } else if (resp.id === '2') {
    if (resp.result && resp.result.result) {
        console.log(resp.result.result);
    } else {
        console.log(JSON.stringify(resp.result || resp.error));
    }
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => { console.error(e); process.exit(1); });
setTimeout(() => process.exit(1), 5000);
      `;

      const tempFile = join(tmpdir(), \`vm_call_\${Date.now()}.js\`);
      writeFileSync(tempFile, script);
      try {
        const result = await ctx.exec("node", [tempFile]);
        return {
          content: [{ type: "text", text: result.output }],
          details: { exitCode: result.exitCode },
          isError: result.exitCode !== 0,
        };
      } finally {
        unlinkSync(tempFile);
      }
    },
  });

  pi.registerTool({
    name: "flutter_inspect_focus",
    label: "Flutter Inspect Focus",
    description: "Dump the Flutter focus tree",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await (pi as any).tools.flutter_vm_call.execute(toolCallId, { method: "ext.flutter.debugDumpFocusTree" }, signal, onUpdate, ctx);
      return result;
    },
  });

  pi.registerTool({
    name: "flutter_inspect_tree",
    label: "Flutter Inspect Tree",
    description: "Dump the Flutter widget tree",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await (pi as any).tools.flutter_vm_call.execute(toolCallId, { method: "ext.flutter.debugDumpApp" }, signal, onUpdate, ctx);
      return result;
    },
  });

  // --- Maestro Tools ---

  pi.registerTool({
    name: "maestro_hierarchy",
    label: "Maestro Hierarchy",
    description: "Get the current UI hierarchy of the app",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await ctx.exec("maestro", ["hierarchy"]);
      return {
        content: [{ type: "text", text: result.output }],
        details: { exitCode: result.exitCode },
        isError: result.exitCode !== 0,
      };
    },
  });

  pi.registerTool({
    name: "maestro_test",
    label: "Maestro Test",
    description: "Run a Maestro test flow (YAML file)",
    parameters: Type.Object({
      flowFile: Type.String({ description: "Path to the Maestro YAML flow file" }),
      args: Type.Optional(Type.Array(Type.String(), { description: "Additional arguments" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await ctx.exec("maestro", ["test", params.flowFile, ...(params.args || [])]);
      return {
        content: [{ type: "text", text: result.output }],
        details: { exitCode: result.exitCode },
        isError: result.exitCode !== 0,
      };
    },
  });

  pi.registerTool({
    name: "maestro_action",
    label: "Maestro Action",
    description: "Execute a single Maestro action (e.g., tap, input, scroll)",
    parameters: Type.Object({
      action: Type.String({ description: "The Maestro YAML action (e.g., - tapOn: 'Login')" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const tempFile = join(tmpdir(), `maestro_action_${Date.now()}.yaml`);
      const currentAppId = appId || process.env.APP_ID || "com.example.app";
      const flowContent = `appId: ${currentAppId}\n---\n${params.action.startsWith("-") ? params.action : "- " + params.action}`;
      
      writeFileSync(tempFile, flowContent);
      try {
        const result = await ctx.exec("maestro", ["test", tempFile]);
        return {
          content: [{ type: "text", text: result.output }],
          details: { exitCode: result.exitCode },
          isError: result.exitCode !== 0,
        };
      } finally {
        unlinkSync(tempFile);
      }
    },
  });
}
