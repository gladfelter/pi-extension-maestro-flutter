/**
 * pi-extension-maestro-flutter
 *
 * Flutter build/run/hot-reload/inspect tools and device management
 * for the pi coding agent.
 *
 * Design: Extension tools handle process-bound ops (run, stop, hot reload,
 * inspect) and essential lifecycle (connect/disconnect). Everything else
 * (devices, build, logs, maestro) is handled via CLI + flutter-cli SKILL.md.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync, readdirSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { homedir } from "node:os";

interface SavedDevice {
  id: string;
  type: "ip" | "emulator";
  name?: string;
}

interface FlutterProject {
  name: string;
  path: string;
  relPath: string;
}

// Extend ChildProcess to carry vmServiceUrl
interface TrackedFlutterProcess extends ChildProcess {
  vmServiceUrl?: string;
}

export default function (pi: ExtensionAPI) {
  let flutterProcess: TrackedFlutterProcess | null = null;
  let flutterOutput = "";
  let deviceId: string | null = null;

  let savedDevice: SavedDevice | null = null;
  let launchedEmulator: string | null = null;

  // ── Device config file (.pi/device.json) ───────────────────────────
  function deviceConfigPath(cwd: string): string {
    return join(cwd, ".pi", "device.json");
  }

  function loadDeviceConfig(cwd: string): SavedDevice | null {
    try {
      const path = deviceConfigPath(cwd);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf-8")) as SavedDevice;
    } catch {
      return null;
    }
  }

  function saveDeviceConfig(cwd: string, device: SavedDevice | null) {
    const path = deviceConfigPath(cwd);
    if (device === null) {
      try {
        unlinkSync(path);
      } catch {
        /* didn't exist */
      }
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(device, null, 2) + "\n", "utf-8");
  }

  // ── Flutter project discovery ───────────────────────────────────────

  const SKIP_DIRS = new Set([
    ".git",
    "node_modules",
    "build",
    ".dart_tool",
    ".pi",
    "android",
    "ios",
    "linux",
    "macos",
    "windows",
    "web",
  ]);

  function findFlutterProjects(root: string, maxDepth = 4): FlutterProject[] {
    const results: FlutterProject[] = [];

    function scan(dir: string, depth: number) {
      if (depth > maxDepth) return;
      let entries: Array<ReturnType<typeof readdirSync>[number]>;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        if (!entry.isDirectory()) continue;
        const fullPath = join(dir, entry.name);
        if (existsSync(join(fullPath, "pubspec.yaml"))) {
          try {
            const content = readFileSync(join(fullPath, "pubspec.yaml"), "utf-8");
            const nameMatch = content.match(/^name:\s*(.+)$/m);
            results.push({
              name: nameMatch?.[1]?.trim() || entry.name,
              path: fullPath,
              relPath: relative(root, fullPath),
            });
          } catch {
            /* skip unreadable */
          }
        } else {
          scan(fullPath, depth + 1);
        }
      }
    }

    scan(root, 0);
    return results;
  }

  let selectedProject: FlutterProject | null = null;

  function projectConfigPath(cwd: string): string {
    return join(cwd, ".pi", "flutter-project.json");
  }

  function loadProjectConfig(cwd: string): FlutterProject | null {
    try {
      const path = projectConfigPath(cwd);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf-8")) as FlutterProject;
    } catch {
      return null;
    }
  }

  function saveProjectConfig(cwd: string, project: FlutterProject | null) {
    const path = projectConfigPath(cwd);
    if (project === null) {
      try {
        unlinkSync(path);
      } catch {
        /* didn't exist */
      }
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(project, null, 2) + "\n", "utf-8");
  }

  function resolveProject(cwd: string): FlutterProject {
    if (selectedProject && existsSync(join(selectedProject.path, "pubspec.yaml"))) {
      return selectedProject;
    }

    const all = findFlutterProjects(cwd);

    if (all.length === 0) {
      throw new Error(
        `No Flutter projects found under ${cwd}.\n` +
          `Create one with: flutter create my_app\n` +
          `Or use the bundled test app: cd test_app`,
      );
    }

    if (all.length === 1) {
      selectedProject = all[0];
      saveProjectConfig(cwd, selectedProject);
      return selectedProject;
    }

    throw new Error(
      `Multiple Flutter projects found. Select one with /flutter-project:\n` +
        all.map((p) => `  ${p.relPath}  (${p.name})`).join("\n") +
        `\n\nExample: /flutter-project ${all[0].name}`,
    );
  }

  // ── Session hooks ──────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const device = loadDeviceConfig(ctx.cwd);
    if (device) {
      savedDevice = device;
      if (device.type === "ip") {
        await pi.exec("adb", ["connect", device.id]);
      }
    }
    const project = loadProjectConfig(ctx.cwd);
    if (project && existsSync(join(project.path, "pubspec.yaml"))) {
      selectedProject = project;
    }
    // Re-detect running emulator after reload
    if (savedDevice?.type === "emulator") {
      try {
        const adbResult = await pi.exec("adb", ["devices"]);
        for (const line of adbResult.stdout.split("\n")) {
          if (line.startsWith("emulator-") && line.includes("device")) {
            const serial = line.split(/\s+/)[0];
            launchedEmulator = serial;
            break;
          }
        }
      } catch {
        /* adb not available */
      }
    }
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "reload" && flutterProcess) {
      flutterProcess = null;
      flutterOutput = "";
    } else if (event.reason !== "reload" && flutterProcess) {
      flutterProcess.kill();
      flutterProcess = null;
    }
    if (event.reason !== "reload" && launchedEmulator) {
      await pi.exec("adb", ["-s", launchedEmulator, "emu", "kill"]);
      launchedEmulator = null;
    }
    if (event.reason !== "reload" && savedDevice?.type === "ip") {
      await pi.exec("adb", ["disconnect", savedDevice.id]);
    }
  });

  // ── KVM pre-flight check ────────────────────────────────────────────
  async function checkKvm(): Promise<{ available: boolean; hint?: string }> {
    try {
      const kvmCheck = await pi.exec("sh", ["-c", "test -r /dev/kvm && test -w /dev/kvm && echo ok"]);
      if (kvmCheck.stdout.trim() === "ok") return { available: true };

      const groupCheck = await pi.exec("sh", ["-c", "grep '^kvm:' /etc/group"]);
      const kvmLine = groupCheck.stdout.trim();
      const username = process.env.USER || "";

      if (!kvmLine) {
        return {
          available: false,
          hint: `KVM group not found. Create it:\n  sudo groupadd -r kvm\n  sudo gpasswd -a ${username} kvm\nThen log out and back into WSL2.`,
        };
      }
      if (!kvmLine.includes(username)) {
        return {
          available: false,
          hint: `User "${username}" is not in the kvm group.\n  sudo gpasswd -a ${username} kvm\nThen log out and back into WSL2.`,
        };
      }
      return { available: false, hint: "/dev/kvm exists but is not accessible. Check: ls -la /dev/kvm" };
    } catch {
      return { available: true };
    }
  }

  // ── Slash commands (user-facing) ────────────────────────────────────

  pi.registerCommand("flutter-project", {
    description: "List or select the Flutter project to work with",
    handler: async (args, ctx) => {
      const projects = findFlutterProjects(ctx.cwd);

      if (args.trim()) {
        const match = projects.find((p) => p.name === args.trim() || p.relPath === args.trim());
        if (!match) {
          const list = projects.map((p) => `  ${p.relPath}  (${p.name})`).join("\n");
          ctx.ui.notify(`No project matching "${args.trim()}". Available:\n${list}`, "error");
          return;
        }
        selectedProject = match;
        saveProjectConfig(ctx.cwd, match);
        ctx.ui.notify(`Selected Flutter project: ${match.name} (${match.relPath})`, "info");
        return;
      }

      if (projects.length === 0) {
        ctx.ui.notify("No Flutter projects found in workspace.", "warning");
        return;
      }

      const current = selectedProject;
      const list = projects
        .map((p) => {
          const marker = current?.path === p.path ? " ▶ selected" : "";
          return `  ${p.relPath}  (${p.name})${marker}`;
        })
        .join("\n");
      ctx.ui.notify(`Flutter projects:\n${list}`, "info");
    },
  });

  pi.registerCommand("flutter-connect", {
    description: "Connect to a device by id (IP:port or AVD name)",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /flutter-connect <id>", "error");
        return;
      }

      const targetId = args.trim();

      if (targetId.startsWith("emulator-avd:") || !targetId.includes(":")) {
        const avdName = targetId.startsWith("emulator-avd:") ? targetId.replace("emulator-avd:", "") : targetId;
        if (process.platform === "linux") {
          const kvm = await checkKvm();
          if (!kvm.available) {
            ctx.ui.notify(`KVM not available: ${kvm.hint || "emulator will be extremely slow"}`, "error");
            return;
          }
        }

        ctx.ui.notify(`Launching emulator ${avdName}...`, "info");
        const result = await pi.exec("flutter", ["emulators", "--launch", avdName]);
        if (result.code !== 0) {
          const msg = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
          ctx.ui.notify(`Failed to launch: ${msg}`, "error");
          return;
        }
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const check = await pi.exec("adb", ["devices"]);
          for (const line of check.stdout.split("\n")) {
            if (line.startsWith("emulator-") && line.includes("device")) {
              const serial = line.split(/\s+/)[0];
              const booted = await pi.exec("adb", ["-s", serial, "shell", "getprop", "sys.boot_completed"]);
              if (booted.stdout.trim() === "1") {
                savedDevice = { id: serial, type: "emulator", name: avdName };
                launchedEmulator = serial;
                saveDeviceConfig(ctx.cwd, savedDevice);
                ctx.ui.notify(`✅ Emulator booted: ${serial}`, "info");
                return;
              }
            }
          }
        }
        ctx.ui.notify("Emulator did not boot within 2 minutes.", "error");
        return;
      }

      const result = await pi.exec("adb", ["connect", targetId]);
      if (result.code !== 0 || result.stdout.includes("failed")) {
        ctx.ui.notify(`Connection failed: ${result.stdout}`, "error");
        return;
      }
      savedDevice = { id: targetId, type: "ip" };
      saveDeviceConfig(ctx.cwd, savedDevice);
      ctx.ui.notify(`✅ Connected: ${targetId}`, "info");
    },
  });

  pi.registerCommand("flutter-disconnect", {
    description: "Disconnect from the current device",
    handler: async (_args, ctx) => {
      if (!savedDevice) {
        ctx.ui.notify("No device to disconnect.", "warning");
        return;
      }

      if (launchedEmulator) {
        await pi.exec("adb", ["-s", launchedEmulator, "emu", "kill"]);
        ctx.ui.notify(`Killed emulator ${launchedEmulator}`, "info");
        launchedEmulator = null;
      } else if (savedDevice.type === "ip") {
        await pi.exec("adb", ["disconnect", savedDevice.id]);
        ctx.ui.notify(`Disconnected ${savedDevice.id}`, "info");
      }

      savedDevice = null;
      saveDeviceConfig(ctx.cwd, null);
    },
  });

  // ── Agent Tools ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "flutter_connect",
    label: "Flutter Connect",
    description:
      "Connect to a Flutter/ADB device. For IP:port it runs adb connect. For emulator AVD it launches it. Saves as default device for future sessions.",
    parameters: Type.Object({
      id: Type.String({
        description: "Device id (e.g., emulator-5554, 192.168.1.100:5555, or emulator-avd:test_34)",
      }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const targetId = params.id;
      const cwd = ctx.cwd;

      if (targetId.startsWith("emulator-avd:")) {
        const avdName = targetId.replace("emulator-avd:", "");

        // Check if already running
        const adbResult = await pi.exec("adb", ["devices"]);
        for (const line of adbResult.stdout.split("\n")) {
          if (line.startsWith("emulator-") && line.includes("device")) {
            const serial = line.split(/\s+/)[0];
            savedDevice = { id: serial, type: "emulator", name: avdName };
            saveDeviceConfig(cwd, savedDevice);
            return {
              content: [{ type: "text", text: `Emulator already running: \`${serial}\`\nSaved as default device.` }],
              details: { device: serial, avd: avdName },
            };
          }
        }

        if (process.platform === "linux") {
          const kvm = await checkKvm();
          if (!kvm.available) {
            throw new Error(`KVM not available.\nThe emulator will be extremely slow without it.\n\n${kvm.hint || ""}`);
          }
        }

        const launchResult = await pi.exec("flutter", ["emulators", "--launch", avdName]);
        if (launchResult.code !== 0) {
          const output = [launchResult.stdout, launchResult.stderr].filter(Boolean).join("\n");
          throw new Error(`Failed to launch emulator ${avdName}:\n${output.trim()}`);
        }

        for (let i = 0; i < 60; i++) {
          if (signal?.aborted) throw new Error("Aborted while waiting for emulator.");
          await new Promise((r) => setTimeout(r, 2000));
          const check = await pi.exec("adb", ["devices"]);
          for (const line of check.stdout.split("\n")) {
            if (line.startsWith("emulator-") && line.includes("device")) {
              const serial = line.split(/\s+/)[0];
              const booted = await pi.exec("adb", ["-s", serial, "shell", "getprop", "sys.boot_completed"]);
              if (booted.stdout.trim() === "1") {
                savedDevice = { id: serial, type: "emulator", name: avdName };
                launchedEmulator = serial;
                saveDeviceConfig(cwd, savedDevice);
                return {
                  content: [
                    {
                      type: "text",
                      text: `✅ Emulator launched and booted: \`${serial}\`\nSaved as default device.`,
                    },
                  ],
                  details: { device: serial, avd: avdName },
                };
              }
            }
          }
        }
        throw new Error(`Emulator ${avdName} did not boot within 2 minutes.`);
      }

      const result = await pi.exec("adb", ["connect", targetId]);
      if (result.code !== 0 || result.stdout.includes("failed")) {
        throw new Error(`ADB connection failed:\n${result.stdout}`);
      }
      savedDevice = { id: targetId, type: "ip" };
      saveDeviceConfig(cwd, savedDevice);
      return {
        content: [{ type: "text", text: `✅ Connected: \`${targetId}\`\nSaved as default device.` }],
        details: { device: targetId },
      };
    },
  });

  pi.registerTool({
    name: "flutter_disconnect",
    label: "Flutter Disconnect",
    description:
      "Disconnect from the current ADB device. Kills launched emulators, disconnects network devices, clears saved preference.",
    parameters: Type.Object({}),
    async execute(_, __, ___, ____, ctx) {
      if (!savedDevice) {
        return { content: [{ type: "text", text: "No saved device to disconnect from." }], details: {} };
      }

      const device = savedDevice;
      const lines: string[] = [];

      if (launchedEmulator) {
        await pi.exec("adb", ["-s", launchedEmulator, "emu", "kill"]);
        lines.push(`✅ Killed emulator \`${launchedEmulator}\``);
        launchedEmulator = null;
      }

      if (device.type === "ip") {
        await pi.exec("adb", ["disconnect", device.id]);
        lines.push(`✅ Disconnected \`${device.id}\``);
      } else if (device.type === "emulator" && !launchedEmulator) {
        lines.push(`ℹ️ Emulator \`${device.id}\` was not launched by this session — left running.`);
      }

      savedDevice = null;
      saveDeviceConfig(ctx.cwd, null);

      return {
        content: [{ type: "text", text: lines.join("\n") || "Disconnected." }],
        details: { previous: device },
      };
    },
  });

  // ── Flutter Run ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "flutter_run",
    label: "Flutter Run",
    description: "Start the Flutter app. Keeps the process running in the background for hot reload.",
    parameters: Type.Object({
      device: Type.Optional(Type.String({ description: "Device ID to run on" })),
      args: Type.Optional(Type.Array(Type.String(), { description: "Additional arguments" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const project = resolveProject(ctx.cwd);
      const targetDevice = params.device || deviceId;
      if (flutterProcess) {
        throw new Error("Flutter is already running. Use flutter_hot_reload or flutter_stop first.");
      }

      // Check if Flutter is already running on device (e.g., from previous run killed by reload)
      const isAdbDevice =
        targetDevice && (targetDevice.startsWith("emulator-") || targetDevice.startsWith("127.0.0.1"));
      let useAttach = false;
      if (isAdbDevice) {
        try {
          const psResult = await pi.exec("adb", ["-s", targetDevice, "shell", "ps", "-A"]);
          useAttach = psResult.stdout.toLowerCase().includes("flutter");
        } catch {
          /* adb not available */
        }
      }

      const verb = useAttach ? "attach" : "run";
      const args = [verb, ...(targetDevice ? ["-d", targetDevice] : []), ...(params.args || [])];
      const commandLabel = `flutter ${args.join(" ")}`;

      flutterOutput = "";
      const proc = spawn("flutter", args, {
        cwd: project.path,
        stdio: ["pipe", "pipe", "pipe"],
      }) as TrackedFlutterProcess;
      flutterProcess = proc;
      let started = false;
      let lastProgressTime = Date.now();

      proc.stdout?.on("data", (data: Buffer) => {
        const str = data.toString();
        flutterOutput += str;
        if (flutterOutput.length > 200_000) flutterOutput = flutterOutput.slice(-100_000);

        if (!started) {
          const match = str.match(
            /(?:Dart VM Service.*?available at:|Connecting to VM Service at) (https?:\/\/[\S\/:]+\/)/,
          );
          if (match) {
            proc.vmServiceUrl = match[1];
            started = true;
            pi.sendMessage(
              {
                customType: "run_started",
                content: `✅ Flutter app is running!\n\nDevice: ${targetDevice || "default"}\nVM Service: ${proc.vmServiceUrl}\n\nHot reload and inspect tools are now available.`,
                display: true,
                details: { running: true, vmServiceUrl: proc.vmServiceUrl },
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          }
        }

        if (!started) {
          const now = Date.now();
          if (now - lastProgressTime >= 10_000) {
            lastProgressTime = now;
            pi.sendMessage(
              {
                customType: "run_progress",
                content: `App starting…\n\n${flutterOutput.slice(-2000)}`,
                display: true,
                details: { bytesOutput: flutterOutput.length },
              },
              { deliverAs: "steer" },
            );
          }
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        const str = data.toString();
        flutterOutput += str;
        if (flutterOutput.length > 200_000) flutterOutput = flutterOutput.slice(-100_000);
      });

      proc.on("exit", (code) => {
        flutterProcess = null;
        if (!started) {
          pi.sendMessage(
            {
              customType: "run_failed",
              content: `❌ Flutter run exited before app started (code ${code}).\n\n${flutterOutput.slice(-4000)}`,
              display: true,
              details: { exitCode: code, started: false },
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        } else {
          pi.sendMessage(
            {
              customType: "run_stopped",
              content: `Flutter app stopped (exit code ${code}).`,
              display: true,
              details: { exitCode: code, started: true },
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        }
      });

      signal?.addEventListener("abort", () => {
        flutterProcess?.kill();
        flutterProcess = null;
      });

      return {
        content: [
          {
            type: "text",
            text: `🚀 Starting app: ${commandLabel}\n\nThis command is **asynchronous** — the app is compiling and launching in the background.\n\n**Do not call other Flutter tools yet.** Wait for the follow-up message that says "✅ Flutter app is running" before proceeding. This typically takes 15-60 seconds for a cold start.\n\nIf you need to check progress, you can call flutter_app_status after ~20 seconds.`,
          },
        ],
        details: { background: true },
      };
    },
  });

  pi.registerTool({
    name: "flutter_stop",
    label: "Flutter Stop",
    description: "Stop the running Flutter app",
    parameters: Type.Object({}),
    async execute() {
      if (!flutterProcess) {
        return { content: [{ type: "text", text: "Flutter app is not running." }], details: {} };
      }
      flutterProcess.kill();
      flutterProcess = null;
      flutterOutput = "";
      return { content: [{ type: "text", text: "Stopped Flutter process." }], details: {} };
    },
  });

  pi.registerTool({
    name: "flutter_hot_reload",
    label: "Flutter Hot Reload",
    description: "Trigger a hot reload of the running Flutter app",
    parameters: Type.Object({}),
    async execute() {
      if (!flutterProcess || !flutterProcess.stdin) {
        throw new Error("Flutter app is not running.");
      }
      flutterProcess.stdin.write("r");
      return { content: [{ type: "text", text: "Sent hot reload command ('r') to Flutter process." }], details: {} };
    },
  });

  pi.registerTool({
    name: "flutter_hot_restart",
    label: "Flutter Hot Restart",
    description: "Trigger a hot restart of the running Flutter app",
    parameters: Type.Object({}),
    async execute() {
      if (!flutterProcess || !flutterProcess.stdin) {
        throw new Error("Flutter app is not running.");
      }
      flutterProcess.stdin.write("R");
      return { content: [{ type: "text", text: "Sent hot restart command ('R') to Flutter process." }], details: {} };
    },
  });

  // ── VM Service helper (for inspect tools) ──────────────────────────
  async function callVmService(
    method: string,
    callParams: Record<string, unknown> = {},
    cwd: string,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
    if (!flutterProcess?.vmServiceUrl) {
      throw new Error("VM Service URL not found. Is the app running?");
    }

    const script = `
const WebSocket = require('ws');
const url = '${flutterProcess.vmServiceUrl.replace("http", "ws")}ws';
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
      const result = await pi.exec("node", [tempFile]);
      if (result.code !== 0) {
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        throw new Error(`VM call failed (exit ${result.code}):\n${output.trim()}`);
      }
      return {
        content: [{ type: "text", text: result.stdout }],
        details: { code: result.code },
      };
    } finally {
      unlinkSync(tempFile);
    }
  }

  // ── Inspect & Debug Tools ───────────────────────────────────────────

  // @ts-ignore - TypeBox callback inference mismatch
  pi.registerTool({
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
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // Full tree via VM service — only when explicitly requested
      if (params.full) {
        return callVmService("ext.flutter.debugDumpApp", {}, ctx.cwd);
      }

      // Default: compact semantics labels via maestro hierarchy
      const maestroArgs: string[] = ["hierarchy"];
      // Pass device serial if available (adb-connected devices)
      const deviceSerial = savedDevice?.id || deviceId;
      if (deviceSerial && (deviceSerial.startsWith("emulator-") || deviceSerial.startsWith("127.0.0.1"))) {
        maestroArgs.push("--device", deviceSerial);
      }
      const result = await pi.exec("maestro", maestroArgs);
      if (result.code !== 0) {
        throw new Error(`maestro hierarchy failed (exit ${result.code}):\n${result.stdout}`);
      }

      let tree: Record<string, unknown>;
      try {
        tree = JSON.parse(result.stdout) as Record<string, unknown>;
      } catch {
        throw new Error("Failed to parse maestro hierarchy JSON.");
      }

      // Recursively extract leaf nodes with accessibility text
      const labels: Array<{ label: string; text?: string; clickable: boolean; bounds: string }> = [];
      function walk(node: unknown) {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const obj = node as Record<string, unknown>;
        const attrs = obj.attributes as Record<string, string> | undefined;
        if (attrs) {
          const accessibilityText = attrs.accessibilityText || "";
          const text = attrs.text || "";
          const clickable = attrs.clickable === "true";
          const bounds = attrs.bounds || "";
          // Include if it has meaningful text and is a leaf or clickable
          if ((accessibilityText || text) && (!obj.children || (obj.children as unknown[]).length === 0 || clickable)) {
            labels.push({ label: accessibilityText, text: text || undefined, clickable, bounds });
          }
        }
        if (Array.isArray(obj.children)) {
          for (const child of obj.children) walk(child);
        }
      }
      walk(tree);

      const searchQuery = params.search?.toLowerCase();
      const filtered = searchQuery
        ? labels.filter(
            (l) => l.label.toLowerCase().includes(searchQuery) || l.text?.toLowerCase().includes(searchQuery),
          )
        : labels;

      const lines = filtered.map((l) => {
        const click = l.clickable ? "👆" : "";
        return `${click} \`${l.label || l.text}\` — ${l.bounds}${l.text && l.text !== l.label ? ` [${l.text}]` : ""}`;
      });

      // Hard limit: truncate if output would be too large (>4KB)
      const MAX_OUTPUT_BYTES = 4096;
      const joined = lines.join("\n");
      const truncated = joined.length > MAX_OUTPUT_BYTES;
      const output = truncated
        ? joined.slice(0, MAX_OUTPUT_BYTES) + "\n... (truncated, use search to find specific labels)"
        : joined;

      return {
        content: [
          {
            type: "text",
            text: output,
          },
        ],
        details: { count: filtered.length, total: labels.length, truncated },
      };
    },
  });

  // @ts-ignore - TypeBox mixed content types
  pi.registerTool({
    name: "flutter_screenshot",
    label: "Flutter Screenshot",
    description: "Take a screenshot of the current device screen. Returns the image path.",
    parameters: Type.Object({}),
    async execute() {
      const tmpDir = join(".pi", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const filename = `screenshot_${Date.now()}.png`;
      const outputPath = join(tmpDir, filename);

      const result = await pi.exec("adb", ["exec-out", "screencap", "-p"]);
      if (result.code !== 0) {
        throw new Error(`Screenshot failed (exit ${result.code}):\n${result.stdout}`);
      }

      writeFileSync(outputPath, result.stdout, { flag: "w" });

      return {
        content: [
          { type: "text" as const, text: `Screenshot saved to \`${outputPath}\`` },
          { type: "image" as const, path: outputPath },
        ],
        details: { path: outputPath },
      };
    },
  });

  pi.registerTool({
    name: "flutter_current_screen",
    label: "Flutter Current Screen",
    description: "Get the current activity/screen visible on the device. Returns a single line with the activity name.",
    parameters: Type.Object({}),
    async execute() {
      const result = await pi.exec("adb", ["shell", "dumpsys", "activity", "top"]);
      if (result.code !== 0) {
        throw new Error(`dumpsys activity failed (exit ${result.code}):\n${result.stdout}`);
      }

      const match = result.stdout.match(/ACTIVITY\s+(.+?)\s+/);
      const activity = match?.[1] || "Unknown";

      return {
        content: [{ type: "text", text: `Current screen: \`${activity}\`` }],
        details: { activity },
      };
    },
  });

  // @ts-ignore - TypeBox union details
  pi.registerTool({
    name: "flutter_app_status",
    label: "Flutter App Status",
    description: "Check if the Flutter app is running, stopped, or crashed on the device. Returns compact status info.",
    parameters: Type.Object({}),
    async execute(_, __, ___, ____, ctx) {
      // Check 1: Is the tracked flutter process still alive with a valid VM Service URL?
      if (flutterProcess && flutterProcess.vmServiceUrl && !flutterProcess.killed) {
        // Verify VM Service is actually reachable (check from host)
        try {
          const vmHost = flutterProcess.vmServiceUrl.replace("http://", "").split(":")[0];
          const vmPort = flutterProcess.vmServiceUrl.replace("http://", "").split(":")[1]?.split("/")[0];
          if (vmHost && vmPort) {
            const pingResult = await pi.exec("curl", ["--max-time", "3", "-s", `http://${vmHost}:${vmPort}/json`]);
            if (pingResult.code === 0 && pingResult.stdout.includes("isolate")) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `✅ Flutter app is running\n\nVM Service: ${flutterProcess.vmServiceUrl}`,
                  },
                ],
                details: { running: true as const, vmServiceUrl: flutterProcess.vmServiceUrl },
              };
            }
          }
        } catch {
          /* VM service unreachable, fall through */
        }
      }

      // Check 2: Is the Flutter app process running on the device?
      // On modern Android (API 30+), ps output shows the app's package name, not "flutter".
      // So we check for the app's own package via pidof.
      try {
        const project = resolveProject(ctx.cwd);
        let packageName: string | null = null;

        // Try manifest first (older Flutter projects)
        const manifestPath = join(project.path, "android", "app", "src", "main", "AndroidManifest.xml");
        if (!packageName && existsSync(manifestPath)) {
          const manifest = readFileSync(manifestPath, "utf-8");
          const pkgMatch = manifest.match(/package="([^"]+)"/);
          if (pkgMatch) packageName = pkgMatch[1];
        }

        // Try build.gradle.kts (modern Flutter / Kotlin DSL)
        if (!packageName) {
          const gradleKtsPath = join(project.path, "android", "app", "build.gradle.kts");
          if (existsSync(gradleKtsPath)) {
            const gradleKts = readFileSync(gradleKtsPath, "utf-8");
            const appIdMatch = gradleKts.match(/applicationId\s*=\s*"([^"]+)"/);
            if (appIdMatch) packageName = appIdMatch[1];
          }
        }

        // Try build.gradle (Groovy DSL)
        if (!packageName) {
          const gradlePath = join(project.path, "android", "app", "build.gradle");
          if (existsSync(gradlePath)) {
            const gradle = readFileSync(gradlePath, "utf-8");
            const appIdMatch = gradle.match(/applicationId\s+["']?([^"'\n]+)["']?/);
            if (appIdMatch) packageName = appIdMatch[1];
          }
        }

        if (packageName) {
          const pidResult = await pi.exec("adb", ["shell", "pidof", packageName]);
          if (pidResult.stdout.trim()) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `✅ Flutter app is running (package: ${packageName})\n\nPID: ${pidResult.stdout.trim()}`,
                },
              ],
              details: { running: true as const, package: packageName, pid: pidResult.stdout.trim() },
            };
          }
        }
      } catch {
        /* Could not determine package or adb not available */
      }

      // Check 3: Crash log
      try {
        const crashResult = await pi.exec("adb", ["logcat", "-b", "crash", "-t", "10"]);
        const hasCrash = crashResult.stdout.includes("FATAL") || crashResult.stdout.includes("CRASH");
        if (hasCrash) {
          return {
            content: [
              { type: "text" as const, text: `❌ App has crashed recently\n\n${crashResult.stdout.slice(-500)}` },
            ],
            details: { running: false as const, crashed: true as const },
          };
        }
      } catch {
        /* logcat not available */
      }

      return {
        content: [{ type: "text" as const, text: "⏹️ Flutter app is not running on device." }],
        details: { running: false as const, crashed: false as const },
      };
    },
  });
}
