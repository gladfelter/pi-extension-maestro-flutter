/**
 * pi-extension-maestro-flutter
 *
 * Flutter build/run/hot-reload/inspect tools, Maestro UI testing tools,
 * and device management for the pi coding agent.
 *
 * TODO: Break up index.ts into focused modules:
 *   - device-manager.ts   (discover, connect, disconnect, state)
 *   - project-finder.ts   (findFlutterProjects, resolveProject, config)
 *   - flutter-tools.ts    (build, run, hot_reload, stop, log)
 *   - vm-service.ts       (vm_call, inspect_focus, inspect_tree)
 *   - maestro-tools.ts    (hierarchy, test, action)
 *   - commands.ts         (slash command registrations)
 *
 * TODO: Unit tests for internal state transitions:
 *   - Project auto-selection: 0, 1, 2+ projects
 *   - Device connect/disconnect lifecycle
 *   - Emulator launch vs already-running tracking
 *   - Config file load/save/clear round-trips
 *   - resolveProject error messages for each scenario
 *
 * TODO: Exploratory testing by installing the extension and using it
 *   with test_app/ to drive the full Flutter + Maestro workflows.
 *
 * TODO: After exploratory + unit testing fixes, mock out stateful deps
 *   (flutter CLI, adb, emulator, maestro) to create regression tests
 *   for the interactions with those complex external dependencies.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn, ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync, readdirSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir, homedir } from "node:os";

interface DeviceInfo {
  id: string;
  type: "usb" | "emulator" | "network" | "avd";
  model?: string;
  status: "connected" | "available" | "offline" | "unauthorized";
}

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

export default function (pi: ExtensionAPI) {
  let flutterProcess: ChildProcess | null = null;
  let flutterOutput = "";
  let appId: string | null = null;
  let deviceId: string | null = null;
  let vmServiceUrl: string | null = null;
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

  // ── Flutter project validation ──────────────────────────────────────

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
      let entries: ReturnType<typeof readdirSync>;
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

  // ── Restore saved device and project on session start ──────────────
  pi.on("session_start", async (_event, ctx) => {
    // Restore device
    const device = loadDeviceConfig(ctx.cwd);
    if (device) {
      savedDevice = device;
      if (device.type === "ip") {
        await pi.exec("adb", ["connect", device.id]);
      }
    }
    // Restore project
    const project = loadProjectConfig(ctx.cwd);
    if (project && existsSync(join(project.path, "pubspec.yaml"))) {
      selectedProject = project;
    }
  });

  // ── Cleanup on shutdown ─────────────────────────────────────────────
  pi.on("session_shutdown", async (event) => {
    // On reload, skip killing the emulator — it's an external process that
    // persists beyond the extension runtime. We'll re-detect it on startup.
    if (event.reason !== "reload" && flutterProcess) {
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

  // ── Re-detect external state on reload ────────────────────────────────
  pi.on("session_start", async (event) => {
    if (event.reason === "reload" && savedDevice?.type === "emulator") {
      // Check if the emulator we launched is still running
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
        // adb not available, ignore
      }
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

  // ── Slash commands (user-facing) ────────────────────────────────────

  pi.registerCommand("flutter-project", {
    description: "List or select the Flutter project to work with",
    handler: async (args, ctx) => {
      const projects = findFlutterProjects(ctx.cwd);

      if (args.trim()) {
        // Select a specific project by name or relPath
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

      // List all projects
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

  pi.registerCommand("flutter-devices", {
    description: "List available ADB devices and emulators",
    handler: async (_args, ctx) => {
      const devices = await discoverDevices();
      if (devices.length === 0) {
        ctx.ui.notify("No devices found.", "warning");
        return;
      }
      const lines = devices.map((d) => {
        const icon = d.status === "connected" ? "🟢" : d.status === "offline" ? "🔴" : "⚪";
        const saved = savedDevice?.id === d.id ? " 💾" : "";
        return `${icon} ${d.id}  ${d.model || ""}  (${d.type}, ${d.status})${saved}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("flutter-connect", {
    description: "Connect to a device by id (IP:port or AVD name)",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /flutter-connect <id>  (from /flutter-devices list)", "error");
        return;
      }

      const targetId = args.trim();

      if (targetId.startsWith("emulator-avd:") || !targetId.includes(":")) {
        // Treat as AVD name
        const avdName = targetId.startsWith("emulator-avd:") ? targetId.replace("emulator-avd:", "") : targetId;
        // Pre-flight: check KVM on Linux
        if (process.platform === "linux") {
          const kvm = await checkKvm();
          if (!kvm.available) {
            ctx.ui.notify(`KVM not available: ${kvm.hint || "emulator will be extremely slow"}`, "error");
            return;
          }
        }

        // Shell out to flutter emulators --launch (non-blocking notify first)
        ctx.ui.notify(`Launching emulator ${avdName}...`, "info");
        const result = await pi.exec("flutter", ["emulators", "--launch", avdName]);
        if (result.code !== 0) {
          const msg = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
          ctx.ui.notify(`Failed to launch: ${msg}`, "error");
          return;
        }
        // Wait for boot and find serial (up to 120s)
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

      // IP:port
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

  // ── Device Discovery & Connection ───────────────────────────────────

  /** Collect all discoverable Flutter/ADB devices into DeviceInfo list. */
  /** Check KVM availability and return a status string. */
  async function checkKvm(): Promise<{ available: boolean; hint?: string }> {
    try {
      // Check if /dev/kvm exists and is accessible
      const kvmCheck = await pi.exec("sh", ["-c", "test -r /dev/kvm && test -w /dev/kvm && echo ok"]);
      if (kvmCheck.stdout.trim() === "ok") return { available: true };

      // Check if user is in kvm group
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
          hint: `User "${username}" is not in the kvm group (current: "${kvmLine}").\n  sudo gpasswd -a ${username} kvm\nThen log out and back into WSL2.`,
        };
      }
      return {
        available: false,
        hint: "/dev/kvm exists but is not accessible. Check permissions:\n  ls -la /dev/kvm",
      };
    } catch {
      // Can't check KVM (e.g., macOS where KVM doesn't apply)
      return { available: true };
    }
  }

  async function discoverDevices(): Promise<DeviceInfo[]> {
    const devices: DeviceInfo[] = [];
    const seen = new Set<string>();

    // 1. Connected ADB devices
    const adbResult = await pi.exec("adb", ["devices", "-l"]);
    for (const line of adbResult.stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("List of")) continue;
      const parts = trimmed.split(/\s+/);
      const serial = parts[0];
      if (!serial) continue;
      seen.add(serial);

      const rest = parts.slice(1).join(" ");
      const status = rest.startsWith("offline")
        ? "offline"
        : rest.startsWith("unauthorized")
          ? "unauthorized"
          : "connected";
      const modelMatch = rest.match(/model:(\S+)/);
      const type = serial.startsWith("emulator-") ? "emulator" : serial.includes(":") ? "network" : "usb";

      devices.push({ id: serial, type, model: modelMatch?.[1], status });
    }

    // 2. Available AVDs (on-disk emulators)
    try {
      const emuResult = await pi.exec("flutter", ["emulators"]);
      for (const line of emuResult.stdout.split("\n")) {
        const nameMatch = line.match(/^([^•]+)\s+•\s+(.+)$/);
        if (!nameMatch) continue;
        const name = nameMatch[1].trim();
        if (name === "Id" || !name) continue; // skip header row
        const id = `emulator-avd:${name}`;
        if (seen.has(id)) continue;
        seen.add(id);
        devices.push({ id, type: "avd", model: nameMatch[2].trim(), status: "available" });
      }
    } catch {
      // flutter emulators may fail if no AVDs exist
    }

    // 3. AVDs from filesystem (catch any flutter emulators misses)
    const avdHome = join(homedir(), ".android", "avd");
    if (existsSync(avdHome)) {
      try {
        for (const entry of readdirSync(avdHome)) {
          if (!entry.endsWith(".avd")) continue;
          const name = entry.replace(/\.avd$/, "");
          const id = `emulator-avd:${name}`;
          if (seen.has(id)) continue;
          seen.add(id);

          // Try to read the config for more info
          let model = "";
          try {
            const configPath = join(avdHome, `${name}.ini`);
            const config = readFileSync(configPath, "utf-8");
            const targetMatch = config.match(/target=(.+)/);
            if (targetMatch) model = targetMatch[1];
          } catch {
            // ignore parse errors
          }
          devices.push({ id, type: "avd", model, status: "available" });
        }
      } catch {
        // can't read AVD directory
      }
    }

    // 4. mDNS-advertised ADB devices (Android 11+ wireless debugging)
    try {
      const mdnsResult = await pi.exec("adb", ["mdns", "services"]);
      for (const line of mdnsResult.stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("List of")) continue;
        const parts = trimmed.split(/\s+/);
        const addr = parts[0];
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        devices.push({ id: addr, type: "network", status: "available" });
      }
    } catch {
      // adb mdns check may not be supported or no devices
    }

    return devices;
  }

  pi.registerTool({
    name: "flutter_devices",
    label: "Flutter Devices",
    description:
      "List all available Flutter/ADB devices: connected devices, on-disk emulators (AVDs), and network devices found via mDNS.",
    parameters: Type.Object({}),
    async execute() {
      const devices = await discoverDevices();

      if (devices.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "No devices found.\n\n" +
                "• Connect a phone via USB with debugging enabled\n" +
                "• Start an emulator: flutter emulators --launch <name>\n" +
                "• Connect to a network device: adb connect <ip>:5555",
            },
          ],
          details: { count: 0, saved: savedDevice },
        };
      }

      const lines: string[] = [];
      lines.push(`Found ${devices.length} device(s):\n`);

      const emoji: Record<string, string> = {
        connected: "🟢",
        available: "⚪",
        offline: "🔴",
        unauthorized: "🟡",
      };

      for (const d of devices) {
        const saved = savedDevice?.id === d.id ? " 💾 saved" : "";
        const label = `${emoji[d.status] || "❓"} \`${d.id}\`${d.model ? ` — ${d.model}` : ""} (${d.type}, ${d.status})${saved}`;
        lines.push(label);
      }

      if (savedDevice) {
        lines.push(`\n💾 Saved preference: \`${savedDevice.id}\` (${savedDevice.type})`);
      }

      lines.push(`\nUse \`flutter_connect\` to connect to one of these devices.`);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: devices.length, saved: savedDevice, devices },
      };
    },
  });

  pi.registerTool({
    name: "flutter_connect",
    label: "Flutter Connect",
    description:
      "Connect to a Flutter/ADB device by id (from flutter_devices). For IP:port it runs adb connect. For an emulator AVD it launches it. Saves this device as the default for future sessions.",
    parameters: Type.Object({
      id: Type.String({
        description:
          "Device id from flutter_devices (e.g., emulator-5554, 192.168.1.100:5555, or emulator-avd:test_34)",
      }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const targetId = params.id;
      const cwd = ctx.cwd;

      // AVD emulator — launch it
      if (targetId.startsWith("emulator-avd:")) {
        const avdName = targetId.replace("emulator-avd:", "");

        // Check if already running
        const adbResult = await pi.exec("adb", ["devices"]);
        const alreadyRunning = adbResult.stdout.includes(`emulator-`);
        if (alreadyRunning) {
          // Find the emulator serial
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
        }

        // Pre-flight: check KVM on Linux (emulator will be unusably slow without it)
        const platform = process.platform;
        if (platform === "linux") {
          const kvm = await checkKvm();
          if (!kvm.available) {
            throw new Error(
              `KVM hardware acceleration is not available.\n` +
                `The emulator will be extremely slow without it.\n\n` +
                (kvm.hint || ""),
            );
          }
        }

        // Launch via flutter emulators --launch (handles KVM, snapshots, etc.)
        const launchResult = await pi.exec("flutter", ["emulators", "--launch", avdName]);
        if (launchResult.code !== 0) {
          const output = [launchResult.stdout, launchResult.stderr].filter(Boolean).join("\n");
          throw new Error(`Failed to launch emulator ${avdName}:\n${output.trim()}`);
        }

        // Wait for emulator to appear in adb and finish booting
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

      // IP:port — adb connect
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
      "Disconnect from the current ADB device. If an emulator was launched, it is killed. If it was a network connection, adb disconnect is called. The saved device preference is cleared.",
    parameters: Type.Object({}),
    async execute(_, __, ___, ____, ctx) {
      if (!savedDevice) {
        return { content: [{ type: "text", text: "No saved device to disconnect from." }], details: {} };
      }

      const device = savedDevice;
      const lines: string[] = [];

      // Kill launched emulator
      if (launchedEmulator) {
        await pi.exec("adb", ["-s", launchedEmulator, "emu", "kill"]);
        lines.push(`✅ Killed emulator \`${launchedEmulator}\``);
        launchedEmulator = null;
      }

      // Disconnect network ADB
      if (device.type === "ip") {
        await pi.exec("adb", ["disconnect", device.id]);
        lines.push(`✅ Disconnected \`${device.id}\``);
      } else if (device.type === "emulator" && !launchedEmulator) {
        lines.push(`ℹ️ Emulator \`${device.id}\` was not launched by this session — left running.`);
      }

      // Clear config
      savedDevice = null;
      saveDeviceConfig(ctx.cwd, null);

      return {
        content: [{ type: "text", text: lines.join("\n") || "Disconnected." }],
        details: { previous: device },
      };
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
      const project = resolveProject(ctx.cwd);
      const args = ["build", params.target, ...(params.args || [])];
      const commandLabel = `flutter ${args.join(" ")}`;

      // Fire-and-forget: spawn in background, return immediately.
      // Progress is streamed via pi.sendMessage(). Completion is signaled
      // via a follow-up message that triggers a new agent turn.
      const buildProcess = spawn("flutter", args, { cwd: project.path });
      let buildOutput = "";
      let lastProgressTime = Date.now();
      const PROGRESS_INTERVAL_MS = 10_000; // throttle progress updates

      buildProcess.stdout?.on("data", (data: Buffer) => {
        const str = data.toString();
        buildOutput += str;
        if (buildOutput.length > 200_000) buildOutput = buildOutput.slice(-100_000);

        const now = Date.now();
        if (now - lastProgressTime >= PROGRESS_INTERVAL_MS) {
          lastProgressTime = now;
          pi.sendMessage(
            {
              customType: "build_progress",
              content: `Build ${params.target} in progress…\n\n${buildOutput.slice(-3000)}`,
              display: true,
              details: { target: params.target, bytesOutput: buildOutput.length },
            },
            { deliverAs: "steer" },
          );
        }
      });

      buildProcess.stderr?.on("data", (data: Buffer) => {
        buildOutput += data.toString();
        if (buildOutput.length > 200_000) buildOutput = buildOutput.slice(-100_000);
      });

      buildProcess.on("exit", (code) => {
        const ok = code === 0;
        pi.sendMessage(
          {
            customType: "build_result",
            content: `Flutter build ${params.target} ${ok ? "✅ succeeded" : `❌ failed (exit ${code})`}.\n\n${buildOutput.slice(-4000)}`,
            display: true,
            details: { exitCode: code, target: params.target },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      });

      // Handle early termination via AbortSignal
      signal?.addEventListener("abort", () => {
        buildProcess.kill();
      });

      return {
        content: [
          {
            type: "text",
            text:
              `🚀 Build started in background: ${commandLabel}\n\n` +
              `The agent will be notified when complete. You can continue with other tasks ` +
              `while the build runs (first builds can take 30+ minutes).`,
          },
        ],
        details: { background: true, target: params.target },
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
      const project = resolveProject(ctx.cwd);
      const targetDevice = params.device || deviceId;
      if (flutterProcess) {
        throw new Error("Flutter is already running. Use flutter_hot_reload or flutter_stop first.");
      }

      const args = ["run", ...(targetDevice ? ["-d", targetDevice] : []), ...(params.args || [])];
      const commandLabel = `flutter ${args.join(" ")}`;

      // Fire-and-forget: spawn, return immediately, stream progress.
      // Notify the agent when the VM service URL is captured (app started)
      // or when the process exits unexpectedly.
      flutterProcess = spawn("flutter", args, {
        cwd: project.path,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let started = false;
      let lastProgressTime = Date.now();
      const PROGRESS_INTERVAL_MS = 10_000;

      flutterProcess.stdout?.on("data", (data: Buffer) => {
        const str = data.toString();
        flutterOutput += str;
        if (flutterOutput.length > 200_000) flutterOutput = flutterOutput.slice(-100_000);

        // Capture VM Service URL on first match
        if (!started) {
          const match = str.match(/Dart VM Service.*?available at: (https?:\/\/[^\s\/]+:\d+\/[^\s]+)/);
          if (match) {
            vmServiceUrl = match[1];
            started = true;
            pi.sendMessage(
              {
                customType: "run_started",
                content: `✅ Flutter app is running!\n\nDevice: ${targetDevice || "default"}\nVM Service: ${vmServiceUrl}\n\nHot reload and inspect tools are now available.`,
                display: true,
                details: { running: true, vmServiceUrl },
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          }
        }

        // Periodic progress while app hasn't started yet
        if (!started) {
          const now = Date.now();
          if (now - lastProgressTime >= PROGRESS_INTERVAL_MS) {
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

      flutterProcess.stderr?.on("data", (data: Buffer) => {
        const str = data.toString();
        flutterOutput += str;
        if (flutterOutput.length > 200_000) flutterOutput = flutterOutput.slice(-100_000);
      });

      flutterProcess.on("exit", (code) => {
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
            text:
              `🚀 Starting app: ${commandLabel}\n\n` +
              `The agent will be notified when the app is running. You can continue ` +
              `with other tasks while it starts.`,
          },
        ],
        details: { background: true },
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
      return { content: [{ type: "text", text: "Stopped Flutter process." }], details: {} };
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
        throw new Error("Flutter app is not running.");
      }
      // Since we are capturing output in a variable in the closure
      // We need to make sure we are actually storing it.
      // I'll update the stdout handler to keep a buffer.
      return {
        content: [{ type: "text", text: `Recent logs:\n${flutterOutput.slice(-(params.lines || 100) * 100)}` }],
        details: {},
      };
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
        throw new Error("VM Service URL not found. Is the app running and log capturing working?");
      }

      const script = `
const WebSocket = require('ws');
const url = '${vmServiceUrl.replace("http", "ws")}ws';
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
ws.on('error', (e) => { console.error(e); process.exit(1); });
setTimeout(() => process.exit(1), 5000);
      `;

      const tempFile = join(tmpdir(), `vm_call_${Date.now()}.js`);
      writeFileSync(tempFile, script);
      try {
        const result = await ctx.exec("node", [tempFile]);
        if (result.code !== 0) {
          throw new Error(`VM call failed (exit ${result.code}):\n${result.stdout}`);
        }
        return {
          content: [{ type: "text", text: result.stdout }],
          details: { code: result.code },
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
      const result = await (pi as any).tools.flutter_vm_call.execute(
        toolCallId,
        { method: "ext.flutter.debugDumpFocusTree" },
        signal,
        onUpdate,
        ctx,
      );
      return result;
    },
  });

  pi.registerTool({
    name: "flutter_inspect_tree",
    label: "Flutter Inspect Tree",
    description: "Dump the Flutter widget tree",
    parameters: Type.Object({}),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const result = await (pi as any).tools.flutter_vm_call.execute(
        toolCallId,
        { method: "ext.flutter.debugDumpApp" },
        signal,
        onUpdate,
        ctx,
      );
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
      if (result.code !== 0) {
        throw new Error(`maestro hierarchy failed (exit ${result.code}):\n${result.stdout}`);
      }
      return {
        content: [{ type: "text", text: result.stdout }],
        details: { code: result.code },
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
      if (result.code !== 0) {
        throw new Error(`maestro test failed (exit ${result.code}):\n${result.stdout}`);
      }
      return {
        content: [{ type: "text", text: result.stdout }],
        details: { code: result.code },
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
        if (result.code !== 0) {
          throw new Error(`maestro action failed (exit ${result.code}):\n${result.stdout}`);
        }
        return {
          content: [{ type: "text", text: result.stdout }],
          details: { code: result.code },
        };
      } finally {
        unlinkSync(tempFile);
      }
    },
  });
}
