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
import { writeFileSync, unlinkSync, readdirSync, existsSync, readFileSync, mkdirSync, openSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { homedir } from "node:os";
import { loadDeviceConfig, saveDeviceConfig } from "./common/device-config.js";
import type { SavedDevice } from "./common/device-config.js";
import { loadProjectConfig, saveProjectConfig } from "./common/project-config.js";
import type { FlutterProject } from "./common/project-config.js";
import {
  extractPackageFromManifest,
  extractPackageFromGradleKts,
  extractPackageFromGradle,
} from "./common/package-name.js";
import { parseAdbDevices, isEmulatorSerial } from "./common/emulator.js";
import { walkAccessibilityTree, detectTextFieldIssues, filterLabels, formatLabelsOutput } from "./common/semantics.js";
import { findFlutterProjects } from "./common/project-discovery.js";
import { TrackedFlutterProcess, type ExtensionState } from "./state.js";
import { createFlutterStopTool } from "./tools/flutter_stop.js";
import { createFlutterHotReloadTool } from "./tools/flutter_hot_reload.js";
import { createFlutterHotRestartTool } from "./tools/flutter_hot_restart.js";
import { createMaestroTestFileTool } from "./tools/maestro_test_file.js";
import { createFlutterInspectTreeTool } from "./tools/flutter_inspect_tree.js";
import { createFlutterScreenshotTool } from "./tools/flutter_screenshot.js";
import { createFlutterCurrentScreenTool } from "./tools/flutter_current_screen.js";

// TrackedFlutterProcess imported from ./state.js

function createStateBridge(
  pi: ExtensionAPI,
  s: {
    flutterProcess: TrackedFlutterProcess | null;
    flutterOutput: string;
    savedDevice: SavedDevice | null;
    launchedEmulator: string | null;
    selectedProject: FlutterProject | null;
    activeSessionId: string | null;
  },
): ExtensionState {
  return new Proxy(s, {
    get(_target, prop) {
      if (prop === "pi") return pi;
      return (s as any)[prop];
    },
    set(target, prop, value) {
      (target as any)[prop] = value;
      return true;
    },
  }) as ExtensionState;
}

export default function (pi: ExtensionAPI) {
  const s = {
    flutterProcess: null as TrackedFlutterProcess | null,
    flutterOutput: "",
    savedDevice: null as SavedDevice | null,
    launchedEmulator: null as string | null,
    selectedProject: null as FlutterProject | null,
    activeSessionId: null as string | null,
  };
  const state = createStateBridge(pi, s);

  function resolveProject(cwd: string): FlutterProject {
    if (s.selectedProject && existsSync(join(s.selectedProject.path, "pubspec.yaml"))) {
      return s.selectedProject;
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
      s.selectedProject = all[0];
      saveProjectConfig(cwd, s.selectedProject);
      return s.selectedProject;
    }

    throw new Error(
      `Multiple Flutter projects found. Select one with /flutter-project:\n` +
        all.map((p) => `  ${p.relPath}  (${p.name})`).join("\n") +
        `\n\nExample: /flutter-project ${all[0].name}`,
    );
  }

  // ── Session hooks ──────────────────────────────────────────────────
  pi.on("session_start", async (event, ctx) => {
    // @ts-ignore - sessionId exists at runtime
    s.activeSessionId = event.sessionId;
    const device = loadDeviceConfig(ctx.cwd);
    if (device) {
      s.savedDevice = device;
      if (device.type === "ip") {
        await pi.exec("adb", ["connect", device.id]);
      }
    }
    const project = loadProjectConfig(ctx.cwd);
    if (project && existsSync(join(project.path, "pubspec.yaml"))) {
      s.selectedProject = project;
    }
    // Re-detect running emulator after reload
    if (s.savedDevice?.type === "emulator") {
      const running = await findRunningEmulator(s.savedDevice.name || "");
      if (running) {
        s.launchedEmulator = running.serial;
        // Update savedDevice in case serial changed (e.g., emulator restarted on different port)
        s.savedDevice = { id: running.serial, type: "emulator", name: running.avdName };
      }
    }
  });

  pi.on("session_shutdown", async (event) => {
    s.activeSessionId = null;
    if (s.logcatProcess) {
      s.logcatProcess.kill();
      s.logcatProcess = null;
      s.logcatPath = null;
    }
    if (event.reason === "reload" && s.flutterProcess) {
      s.flutterProcess = null;
      s.flutterOutput = "";
    } else if (event.reason !== "reload" && s.flutterProcess) {
      s.flutterProcess.kill();
      s.flutterProcess = null;
    }
    if (event.reason !== "reload" && s.launchedEmulator) {
      try {
        await pi.exec("adb", ["-s", s.launchedEmulator, "emu", "kill"], { timeout: 5000 });
      } catch {
        /* ignore shutdown errors */
      }
      s.launchedEmulator = null;
    }
    if (event.reason !== "reload" && s.savedDevice?.type === "ip") {
      try {
        await pi.exec("adb", ["disconnect", s.savedDevice.id], { timeout: 5000 });
      } catch {
        /* ignore shutdown errors */
      }
    }
  });

  // ── Running emulator detection ─────────────────────────────────────

  /**
   * Get all running emulators from ADB, mapping serial → AVD name.
   * Uses `adb shell getprop ro.kernel.qemu.avd_name` which is available
   * on all modern emulator images (API 21+).
   */
  async function getRunningEmulators(): Promise<Array<{ serial: string; avdName: string }>> {
    const emulators: Array<{ serial: string; avdName: string }> = [];
    try {
      const adbResult = await pi.exec("adb", ["devices"], { timeout: 5000 });
      const devices = parseAdbDevices(adbResult.stdout);
      for (const { serial, status } of devices) {
        if (!isEmulatorSerial(serial) || status !== "device") continue;
        // Get the AVD name via system property
        try {
          const avdResult = await pi.exec("adb", ["-s", serial, "shell", "getprop", "ro.kernel.qemu.avd_name"], {
            timeout: 2000,
          });
          const avdName = avdResult.stdout.trim();
          if (avdName) {
            emulators.push({ serial, avdName });
            continue;
          }
        } catch {
          /* getprop not available on this device */
        }
        // Fallback: try adb emu command
        try {
          const emuResult = await pi.exec("adb", ["-s", serial, "emu", "avd", "name"], { timeout: 2000 });
          const avdName = emuResult.stdout
            .trim()
            .replace(/^OK\s*\n?/i, "")
            .trim();
          if (avdName) {
            emulators.push({ serial, avdName });
            continue;
          }
        } catch {
          /* emu command not available */
        }
        // Last resort: just include the serial with empty AVD name
        emulators.push({ serial, avdName: "" });
      }
    } catch {
      /* adb not available */
    }
    return emulators;
  }

  /**
   * Find a running emulator by AVD name. Returns null if not found.
   */
  async function findRunningEmulator(avdName: string): Promise<{ serial: string; avdName: string } | null> {
    const emulators = await getRunningEmulators();
    return emulators.find((e) => e.avdName === avdName) || null;
  }

  /**
   * Verify a device serial is connected via ADB.
   */
  async function isAdbDeviceConnected(serial: string): Promise<boolean> {
    try {
      const adbResult = await pi.exec("adb", ["devices"], { timeout: 5000 });
      const devices = parseAdbDevices(adbResult.stdout);
      return devices.some((d) => d.serial === serial && d.status === "device");
    } catch {
      return false;
    }
  }

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

  function getPackageName(cwd: string): string | null {
    try {
      const project = resolveProject(cwd);
      // Try manifest first (older Flutter projects)
      const manifestPath = join(project.path, "android", "app", "src", "main", "AndroidManifest.xml");
      if (existsSync(manifestPath)) {
        const pkg = extractPackageFromManifest(readFileSync(manifestPath, "utf-8"));
        if (pkg) return pkg;
      }

      // Try build.gradle.kts (modern Flutter / Kotlin DSL)
      const gradleKtsPath = join(project.path, "android", "app", "build.gradle.kts");
      if (existsSync(gradleKtsPath)) {
        const pkg = extractPackageFromGradleKts(readFileSync(gradleKtsPath, "utf-8"));
        if (pkg) return pkg;
      }

      // Try build.gradle (Groovy DSL)
      const gradlePath = join(project.path, "android", "app", "build.gradle");
      if (existsSync(gradlePath)) {
        const gradle = readFileSync(gradlePath, "utf-8");
        const appIdMatch = gradle.match(/applicationId\s+["']?([^"'\n]+)["']?/);
        const namespaceMatch = gradle.match(/namespace\s+["']?([^"'\n]+)["']?/);
        const name = appIdMatch?.[1] || namespaceMatch?.[1];
        if (name) return name;
      }
    } catch {
      /* ignore */
    }
    return null;
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
        s.selectedProject = match;
        saveProjectConfig(ctx.cwd, match);
        ctx.ui.notify(`Selected Flutter project: ${match.name} (${match.relPath})`, "info");
        return;
      }

      if (projects.length === 0) {
        ctx.ui.notify("No Flutter projects found in workspace.", "warning");
        return;
      }

      const current = s.selectedProject;
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

      // Handle emulator-XXXX serial directly
      if (targetId.startsWith("emulator-") && !targetId.startsWith("emulator-avd:")) {
        const connected = await isAdbDeviceConnected(targetId);
        if (connected) {
          let avdName: string | undefined;
          try {
            const avdResult = await pi.exec("adb", ["-s", targetId, "shell", "getprop", "ro.kernel.qemu.avd_name"], {
              timeout: 2000,
            });
            avdName = avdResult.stdout.trim() || undefined;
          } catch {
            /* couldn't read AVD name */
          }
          s.savedDevice = { id: targetId, type: "emulator", name: avdName };
          saveDeviceConfig(ctx.cwd, s.savedDevice);
          ctx.ui.notify(`✅ Emulator already connected: ${targetId}${avdName ? ` (${avdName})` : ""}\nTip: Read the maestro-flutter-device-testing skill for mandatory protocols.`, "info");
          return;
        }
        ctx.ui.notify(`Emulator ${targetId} is not connected. Check with: adb devices`, "error");
        return;
      }

      // AVD name or emulator-avd:<name>
      if (targetId.startsWith("emulator-avd:") || !targetId.includes(":")) {
        const avdName = targetId.startsWith("emulator-avd:") ? targetId.replace("emulator-avd:", "") : targetId;

        // Check if this AVD is already running
        const alreadyRunning = await findRunningEmulator(avdName);
        if (alreadyRunning) {
          s.savedDevice = { id: alreadyRunning.serial, type: "emulator", name: alreadyRunning.avdName };
          s.launchedEmulator = alreadyRunning.serial;
          saveDeviceConfig(ctx.cwd, s.savedDevice);
          ctx.ui.notify(`✅ Emulator already running: ${alreadyRunning.serial} (${alreadyRunning.avdName})\nTip: Read the maestro-flutter-device-testing skill for mandatory protocols.`, "info");
          return;
        }

        if (process.platform === "linux") {
          const kvm = await checkKvm();
          if (!kvm.available) {
            ctx.ui.notify(`KVM not available: ${kvm.hint || "emulator will be extremely slow"}`, "error");
            return;
          }
        }

        ctx.ui.notify(`Launching emulator ${avdName}...`, "info");
        const result = await pi.exec("flutter", ["emulators", "--launch", avdName], { timeout: 60000 });
        if (result.code !== 0) {
          const msg = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
          ctx.ui.notify(`Failed to launch: ${msg}`, "error");
          return;
        }
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          // Find the specific AVD we launched (not just any emulator)
          const running = await findRunningEmulator(avdName);
          if (running) {
            const booted = await pi.exec("adb", ["-s", running.serial, "shell", "getprop", "sys.boot_completed"], {
              timeout: 5000,
            });
            if (booted.stdout.trim() === "1") {
              s.savedDevice = { id: running.serial, type: "emulator", name: running.avdName };
              s.launchedEmulator = running.serial;
              saveDeviceConfig(ctx.cwd, s.savedDevice);
              ctx.ui.notify(`✅ Emulator booted: ${running.serial} (${running.avdName})\nTip: Read the maestro-flutter-device-testing skill for mandatory protocols.`, "info");
              return;
            }
          }
        }
        ctx.ui.notify("Emulator did not boot within 2 minutes.", "error");
        return;
      }

      const result = await pi.exec("adb", ["connect", targetId], { timeout: 10000 });
      if (result.code !== 0 || result.stdout.includes("failed")) {
        ctx.ui.notify(`Connection failed: ${result.stdout}`, "error");
        return;
      }
      s.savedDevice = { id: targetId, type: "ip" };
      saveDeviceConfig(ctx.cwd, s.savedDevice);
      ctx.ui.notify(`✅ Connected: ${targetId}\nTip: Read the maestro-flutter-device-testing skill for mandatory protocols.`, "info");
    },
  });

  pi.registerCommand("flutter-disconnect", {
    description: "Disconnect from the current device",
    handler: async (_args, ctx) => {
      if (!s.savedDevice) {
        ctx.ui.notify("No device to disconnect.", "warning");
        return;
      }

      if (s.launchedEmulator) {
        try {
          await pi.exec("adb", ["-s", s.launchedEmulator, "emu", "kill"], { timeout: 5000 });
        } catch {
          /* ignore error */
        }
        ctx.ui.notify(`Killed emulator ${s.launchedEmulator}`, "info");
        s.launchedEmulator = null;
      } else if (s.savedDevice.type === "ip") {
        try {
          await pi.exec("adb", ["disconnect", s.savedDevice.id], { timeout: 5000 });
        } catch {
          /* ignore error */
        }
        ctx.ui.notify(`Disconnected ${s.savedDevice.id}`, "info");
      }

      s.savedDevice = null;
      saveDeviceConfig(ctx.cwd, null);
    },
  });

  // ── Agent Tools ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "flutter_connect",
    label: "Flutter Connect",
    description:
      "Connect to a Flutter/ADB device. For IP:port it runs adb connect. For emulator-avd:<name> it launches or reuses an existing emulator. For emulator-XXXX it connects to an already-running emulator. Saves as default device for future sessions.",
    parameters: Type.Object({
      id: Type.String({
        description:
          "Device id: emulator-avd:<AVD_NAME> to launch/reuse, emulator-5554 to connect to running emulator, or IP:port for network device",
      }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const targetId = params.id;
      const cwd = ctx.cwd;

      // ── Case 1: emulator-XXXX serial passed directly ──────────────
      if (targetId.startsWith("emulator-") && !targetId.startsWith("emulator-avd:")) {
        const connected = await isAdbDeviceConnected(targetId);
        if (connected) {
          let avdName: string | undefined;
          try {
            const avdResult = await pi.exec("adb", ["-s", targetId, "shell", "getprop", "ro.kernel.qemu.avd_name"], {
              timeout: 2000,
              signal,
            });
            avdName = avdResult.stdout.trim() || undefined;
          } catch {
            /* couldn't read AVD name */
          }
          s.savedDevice = { id: targetId, type: "emulator", name: avdName };
          saveDeviceConfig(cwd, s.savedDevice);
          return {
            content: [
              {
                type: "text",
                text: `✅ Emulator already connected: \`${targetId}\`${avdName ? ` (${avdName})` : ""}\nSaved as default device.\nTip: Read the maestro-flutter-device-testing skill for mandatory protocols.`,
              },
            ],
            details: { device: targetId, avd: avdName, existing: true },
          };
        }
        throw new Error(`Emulator \`${targetId}\` is not connected via ADB.\nCheck with: adb devices`);
      }

      // ── Case 2: emulator-avd:<AVD_NAME> — launch or reuse ────────
      if (targetId.startsWith("emulator-avd:")) {
        const avdName = targetId.replace("emulator-avd:", "");

        // Check if this specific AVD is already running
        const alreadyRunning = await findRunningEmulator(avdName);
        if (alreadyRunning) {
          s.savedDevice = { id: alreadyRunning.serial, type: "emulator", name: alreadyRunning.avdName };
          saveDeviceConfig(cwd, s.savedDevice);
          return {
            content: [
              {
                type: "text",
                text: `✅ Emulator already running: \`${alreadyRunning.serial}\` (${alreadyRunning.avdName})\nSaved as default device.\nTip: Read the maestro-flutter-device-testing skill for mandatory protocols.`,
              },
            ],
            details: { device: alreadyRunning.serial, avd: alreadyRunning.avdName, existing: true },
          };
        }

        // Collect running emulators for hint on failure
        const allRunning = await getRunningEmulators();

        if (process.platform === "linux") {
          const kvm = await checkKvm();
          if (!kvm.available) {
            throw new Error(`KVM not available.\nThe emulator will be extremely slow without it.\n\n${kvm.hint || ""}`);
          }
        }

        const launchResult = await pi.exec("flutter", ["emulators", "--launch", avdName], { timeout: 60000, signal });
        if (launchResult.code !== 0) {
          const output = [launchResult.stdout, launchResult.stderr].filter(Boolean).join("\n");
          let errorMsg = `Failed to launch emulator ${avdName}:\n${output.trim()}`;
          if (allRunning.length > 0) {
            errorMsg += `\n\nNote: These emulators are already running:\n${allRunning.map((e) => `  \`${e.serial}\` ${e.avdName ? `(${e.avdName})` : ""}`).join("\n")}`;
          }
          throw new Error(errorMsg);
        }

        for (let i = 0; i < 60; i++) {
          if (signal?.aborted) throw new Error("Aborted while waiting for emulator.");
          await new Promise((r) => setTimeout(r, 2000));
          // Find the specific AVD we launched (not just any emulator)
          const running = await findRunningEmulator(avdName);
          if (running) {
            const booted = await pi.exec("adb", ["-s", running.serial, "shell", "getprop", "sys.boot_completed"], {
              timeout: 5000,
              signal,
            });
            if (booted.stdout.trim() === "1") {
              s.savedDevice = { id: running.serial, type: "emulator", name: running.avdName };
              s.launchedEmulator = running.serial;
              saveDeviceConfig(cwd, s.savedDevice);
              return {
                content: [
                  {
                    type: "text",
                    text: `✅ Emulator launched and booted: \`${running.serial}\` (${running.avdName})\nSaved as default device.\nTip: Read the maestro-flutter-device-testing skill for mandatory protocols.`,
                  },
                ],
                details: { device: running.serial, avd: running.avdName },
              };
            }
          }
        }
        throw new Error(`Emulator ${avdName} did not boot within 2 minutes.`);
      }

      // ── Case 3: IP:port — ADB network device ──────────────────────
      const result = await pi.exec("adb", ["connect", targetId], { timeout: 10000, signal });
      if (result.code !== 0 || result.stdout.includes("failed")) {
        throw new Error(`ADB connection failed:\n${result.stdout}`);
      }
      s.savedDevice = { id: targetId, type: "ip" };
      saveDeviceConfig(cwd, s.savedDevice);
      return {
        content: [{ type: "text", text: `✅ Connected: \`${targetId}\`\nSaved as default device.\nTip: Read the maestro-flutter-device-testing skill for mandatory protocols.` }],
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
    async execute(_, __, signal, ____, ctx) {
      if (!s.savedDevice) {
        return { content: [{ type: "text", text: "No saved device to disconnect from." }], details: {} };
      }

      const device = s.savedDevice;
      const lines: string[] = [];

      if (s.launchedEmulator) {
        try {
          await pi.exec("adb", ["-s", s.launchedEmulator, "emu", "kill"], { timeout: 5000, signal });
          lines.push(`✅ Killed emulator \`${s.launchedEmulator}\``);
        } catch {
          lines.push(`⚠️ Failed to kill emulator \`${s.launchedEmulator}\` (already dead or ADB error).`);
        }
        s.launchedEmulator = null;
      }

      if (device.type === "ip") {
        try {
          await pi.exec("adb", ["disconnect", device.id], { timeout: 5000, signal });
          lines.push(`✅ Disconnected \`${device.id}\``);
        } catch {
          lines.push(`⚠️ Failed to disconnect \`${device.id}\` (ADB error).`);
        }
      } else if (device.type === "emulator" && !s.launchedEmulator) {
        lines.push(`ℹ️ Emulator \`${device.id}\` was not launched by this session — left running.`);
      }

      s.savedDevice = null;
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
      const targetDevice = params.device || s.savedDevice?.id;
      const currentSessionId = s.activeSessionId;

      if (s.flutterProcess) {
        throw new Error("Flutter is already running. Use flutter_hot_reload or flutter_stop first.");
      }

      // Check if Flutter is already running on device (e.g., from previous run killed by reload)
      const isAdbDevice =
        targetDevice && (targetDevice.startsWith("emulator-") || targetDevice.startsWith("127.0.0.1"));
      let useAttach = false;
      const packageName = getPackageName(ctx.cwd);

      if (isAdbDevice) {
        try {
          const pidResult = await pi.exec("adb", ["-s", targetDevice, "shell", "pidof", packageName || "NO_PKG"], {
            timeout: 2000,
            signal,
          });
          if (pidResult.stdout.trim()) {
            useAttach = true;
          } else {
            const psResult = await pi.exec("adb", ["-s", targetDevice, "shell", "ps", "-A"], {
              timeout: 5000,
              signal,
            });
            useAttach = psResult.stdout.toLowerCase().includes("flutter");
          }
        } catch {
          /* adb not available or pidof failed */
        }
      }

      const verb = useAttach ? "attach" : "run";
      const args = [verb, ...(targetDevice ? ["-d", targetDevice] : []), ...(params.args || [])];
      const commandLabel = `flutter ${args.join(" ")}`;

      // Start logcat
      const logPath = join(homedir(), ".pi", "tmp", `logcat-${Date.now()}.log`);
      try {
        const logFd = openSync(logPath, "w");
        s.logcatProcess = spawn("adb", ["logcat"], {
          stdio: ["ignore", logFd, "ignore"],
          detached: true,
        });
        s.logcatPath = logPath;
      } catch (e) {
        console.error("Failed to start logcat:", e);
      }

      s.flutterOutput = "";
      const proc = spawn("flutter", args, {
        cwd: project.path,
        stdio: ["pipe", "pipe", "pipe"],
      }) as TrackedFlutterProcess;
      s.flutterProcess = proc;
      let started = false;
      let buildFailed = false;
      let lastProgressTime = Date.now();
      let lastCheckedOutputIndex = 0;

      // Patterns that indicate a build failure (not transient warnings)
      const BUILD_FAILURE_PATTERNS = [
        /BUILD FAILED/,
        /FAILURE: Build failed/,
        /Execution failed for task/,
        /Could not resolve all files/,
        /Could not resolve all dependencies/,
        /Could not find (?:the )?correct provider/,
        /Unsupported class file major version/,
        /A problem occurred configuring/,
        /A problem occurred evaluating/,
        /Could not get unknown property/,
        /Compilation failed/,
        /compileDebugKotlin FAILED/,
        /compileDebugJavaWithJavac FAILED/,
        /Reloading\.\.\. failed/,
        /Hot reload failed/,
        /Restarting\.\.\. failed/,
        /Hot restart failed/,
        /Unhandled exception:/,
      ];

      const checkOutputForFailures = () => {
        if (buildFailed) return;
        const newContent = s.flutterOutput.slice(lastCheckedOutputIndex);
        if (!newContent) return;

        for (const pattern of BUILD_FAILURE_PATTERNS) {
          if (pattern.test(newContent)) {
            // For initial build, we treat it as a terminal failure for the 'run' command
            if (!started) {
              buildFailed = true;
              pi.sendMessage(
                {
                  customType: "run_failed",
                  content: `❌ Flutter build failed\n\n${s.flutterOutput.slice(-4000)}`,
                  display: true,
                  details: { exitCode: 1, started: false, logs: s.flutterOutput.slice(-2000), stage: "build" },
                },
                { deliverAs: "followUp", triggerTurn: true },
              );
            } else {
              // For hot reload/restart, we just notify the agent so they can fix the code
              pi.sendMessage(
                {
                  customType: "reload_failed",
                  content: `⚠️ Flutter reload/restart failed. Check the logs for compilation errors.\n\n${newContent.slice(-2000)}`,
                  display: true,
                  details: { running: true, logs: newContent.slice(-1000) },
                },
                { deliverAs: "steer" },
              );
            }
            break;
          }
        }
        lastCheckedOutputIndex = s.flutterOutput.length;
      };

      proc.stdout?.on("data", (data: Buffer) => {
        if (s.activeSessionId !== currentSessionId || proc !== s.flutterProcess) return;
        const str = data.toString();
        s.flutterOutput += str;
        if (s.flutterOutput.length > 200_000) {
          s.flutterOutput = s.flutterOutput.slice(-100_000);
          lastCheckedOutputIndex = Math.max(0, lastCheckedOutputIndex - 100_000);
        }

        checkOutputForFailures();

        const urlMatches = Array.from(
          s.flutterOutput.matchAll(
            /(?:Dart VM Service.*?available at:|Connecting to VM Service at|The Dart VM service is listening on) (https?:\/\/[\S\/:]+\/?)/g,
          ),
        );
        if (urlMatches.length > 0) {
          const lastUrl = urlMatches[urlMatches.length - 1][1];
          if (proc.vmServiceUrl !== lastUrl) {
            proc.vmServiceUrl = lastUrl;
            if (!started) {
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
        }

        if (!started && !buildFailed) {
          const now = Date.now();
          if (now - lastProgressTime >= 10_000) {
            lastProgressTime = now;
            pi.sendMessage(
              {
                customType: "run_progress",
                content: `App starting…\n\n${s.flutterOutput.slice(-2000)}`,
                display: true,
                details: { bytesOutput: s.flutterOutput.length },
              },
              { deliverAs: "steer" },
            );
          }
        }
      });

      proc.stderr?.on("data", (data: Buffer) => {
        if (s.activeSessionId !== currentSessionId || proc !== s.flutterProcess) return;
        const str = data.toString();
        s.flutterOutput += str;
        if (s.flutterOutput.length > 200_000) {
          s.flutterOutput = s.flutterOutput.slice(-100_000);
          lastCheckedOutputIndex = Math.max(0, lastCheckedOutputIndex - 100_000);
        }
        checkOutputForFailures();
      });

      proc.on("exit", (code) => {
        if (s.activeSessionId !== currentSessionId || proc !== s.flutterProcess) return;
        s.flutterProcess = null;
        if (!started) {
          // Don't send another run_failed if we already sent one for build failure
          if (!buildFailed) {
            pi.sendMessage(
              {
                customType: "run_failed",
                content: `❌ Flutter run exited before app started (code ${code}).\n\n${s.flutterOutput.slice(-4000)}`,
                display: true,
                details: { exitCode: code, started: false, logs: s.flutterOutput.slice(-1000) },
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          }
        } else {
          const isCrash = code !== 0 && code !== null;
          pi.sendMessage(
            {
              customType: "run_stopped",
              content: `${isCrash ? "❌" : "⏹️"} Flutter app stopped (exit code ${code}).${isCrash ? `\n\nLast logs:\n${s.flutterOutput.slice(-500)}` : ""}`,
              display: true,
              details: { exitCode: code, started: true, logs: s.flutterOutput.slice(-1000) },
            },
            { deliverAs: "followUp", triggerTurn: true },
          );
        }
      });

      signal?.addEventListener("abort", () => {
        s.flutterProcess?.kill();
        s.flutterProcess = null;
      });

      return {
        content: [
          {
            type: "text",
            text: `🚀 Starting app: ${commandLabel}\n\n` +
              `**DO NOT use ADB, Maestro, or other Flutter tools while the build is in progress.** ` +
              `Doing so can corrupt the process and cause state tracking to fail.\n\n` +
              `You may work on code or other files, but do not sleep or wait for this operation. ` +
              `End your turn now; you will be notified when the app is running.`,
          },
        ],
        details: { background: true },
      };
    },
  });

  // @ts-ignore - extracted tool type inference
  pi.registerTool(
    createFlutterStopTool(state, async (ctx) => {
      if (s.logcatProcess) {
        s.logcatProcess.kill();
        s.logcatProcess = null;
        s.logcatPath = null;
      }
      const pkg = getPackageName(ctx.cwd);
      const device = s.savedDevice?.id;
      if (pkg && device) {
        await pi.exec("adb", ["-s", device, "shell", "am", "force-stop", pkg], { timeout: 5000 });
      }
    }),
  );

  // @ts-ignore - extracted tool type inference
  pi.registerTool(createFlutterHotReloadTool(state));

  // @ts-ignore - extracted tool type inference
  pi.registerTool({
    name: "get_logcat_path",
    label: "Get Logcat Path",
    description: "Get the path to the currently active logcat log file.",
    parameters: Type.Object({}),
    async execute() {
      if (!s.logcatPath) {
        throw new Error("No active logcat process is running.");
      }
      return {
        content: [{ type: "text", text: s.logcatPath }],
        details: { path: s.logcatPath },
      };
    },
  });

  // @ts-ignore - extracted tool type inference
  pi.registerTool(createFlutterHotRestartTool(state));

  // ── Maestro Temp File ───────────────────────────────────────────────

  // @ts-ignore - extracted tool type inference
  pi.registerTool(createMaestroTestFileTool(state));

  // ── Inspect & Debug Tools ───────────────────────────────────────────

  // @ts-ignore - extracted tool type inference
  pi.registerTool(createFlutterInspectTreeTool(state));
  // @ts-ignore - extracted tool type inference
  pi.registerTool(createFlutterScreenshotTool(state));

  // @ts-ignore - extracted tool type inference
  pi.registerTool(createFlutterCurrentScreenTool(state));

  // @ts-ignore - TypeBox union details
  pi.registerTool({
    name: "flutter_app_status",
    label: "Flutter App Status",
    description:
      "Check if the Flutter app is running, stopped, or crashed on the device. Returns compact status info with death reason when possible (crash, OOM kill, or normal exit).",
    parameters: Type.Object({
      timeoutMs: Type.Optional(
        Type.Number({
          description:
            "Maximum time in milliseconds to spend checking status across all checks. Default 30000. Each pi.exec call gets a proportional share of the remaining budget.",
        }),
      ),
    }),
    async execute(_, params, signal, ____, ctx) {
      const totalTimeout = params.timeoutMs || 30000;
      const startedAt = Date.now();
      function budget(share: number): number {
        return Math.max(500, Math.floor((totalTimeout - (Date.now() - startedAt)) * share));
      }

      const device = s.savedDevice;
      const packageName = getPackageName(ctx.cwd);

      // Pre-flight: check if device is connected
      if (device) {
        const connected = await isAdbDeviceConnected(device.id);
        if (!connected) {
          return {
            content: [{ type: "text" as const, text: `⚠️ Device \`${device.id}\` is disconnected.` }],
            details: { running: false as const, connected: false as const },
          };
        }
      }

      // Check 1: Is the tracked flutter process still alive with a valid VM Service URL?
      let trackedProcessHealthy = false;
      if (s.flutterProcess && s.flutterProcess.vmServiceUrl && !s.flutterProcess.killed) {
        // Verify VM Service is actually reachable (check from host)
        try {
          const url = new URL(s.flutterProcess.vmServiceUrl);
          const vmHost = url.hostname;
          const vmPort = url.port;
          if (vmHost && vmPort) {
            const pingResult = await pi.exec("curl", ["--max-time", "3", "-s", `http://${vmHost}:${vmPort}/json`], {
              timeout: budget(0.2),
              signal,
            });
            if (pingResult.code === 0 && pingResult.stdout.includes("isolate")) {
              trackedProcessHealthy = true;
            }
          }
        } catch {
          /* VM service unreachable, fall through */
        }
      }

      // Check 2: Is the Flutter app process running on the device?
      let devicePid: string | null = null;
      if (packageName && device) {
        try {
          const pidResult = await pi.exec("adb", ["-s", device.id, "shell", "pidof", packageName], {
            timeout: budget(0.15),
            signal,
          });
          devicePid = pidResult.stdout.trim() || null;
        } catch {
          /* pidof failed, likely not running */
        }
      }

      // ── STATE MISMATCH DETECTION ──────────────────────────────────────

      // Case A: App is running on device, but extension has no tracked process
      if (devicePid && !s.flutterProcess) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `⚠️ STATE MISMATCH DETECTED: App \`${packageName}\` is running on device (PID ${devicePid}), but it is NOT connected to the Flutter tool.\n\n` +
                `This happens if the app was started outside of the extension (e.g., \`adb shell am start\`). ` +
                `Hot reload and hot restart will NOT work.\n\n` +
                `FIX: Use \`flutter_stop\` then \`flutter_run\` to restart the app properly.\n` +
                `⚠️ REMINDER: Always use the provided wrapper scripts (scripts/maestro, scripts/adb) for CLI operations to avoid state corruption. Read the maestro-flutter-device-testing skill if you are unsure of the protocol.`,
            },
          ],
          details: { running: true as const, connected: false as const, pid: devicePid, stateMismatch: "zombie_app" },
        };
      }

      // Case B: Tracked process exists but VM Service is unreachable, yet app is still on device
      if (s.flutterProcess && !trackedProcessHealthy && devicePid) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `⚠️ DISCONNECTION DETECTED: The Flutter tool is running, but it lost contact with the app on the device (PID ${devicePid}).\n\n` +
                `This often happens if the app crashed and was restarted manually, or if ADB was manipulated directly.\n\n` +
                `FIX: Use \`flutter_stop\` then \`flutter_run\`.\n` +
                `⚠️ REMINDER: Always use the provided wrapper scripts (scripts/maestro, scripts/adb) for CLI operations to avoid state corruption. Read the maestro-flutter-device-testing skill if you are unsure of the protocol.`,
            },
          ],
          details: {
            running: true as const,
            connected: false as const,
            pid: devicePid,
            stateMismatch: "disconnected_process",
          },
        };
      }

      // Case C: Healthy tracked process
      if (trackedProcessHealthy) {
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Flutter app is running\n\nVM Service: ${s.flutterProcess!.vmServiceUrl}\nPID on device: ${devicePid || "unknown"}`,
            },
          ],
          details: { running: true as const, vmServiceUrl: s.flutterProcess!.vmServiceUrl, pid: devicePid },
        };
      }

      // ── END STATE MISMATCH DETECTION ──────────────────────────────────

      // Check 3: Crash log
      try {
        const crashResult = await pi.exec("adb", ["logcat", "-b", "crash", "-t", "20"], {
          timeout: budget(0.15),
          signal,
        });
        const hasCrash = crashResult.stdout.includes("FATAL") || crashResult.stdout.includes("CRASH");
        if (hasCrash) {
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ App has crashed recently (system crash log)\n\n${crashResult.stdout.slice(-1000)}`,
              },
            ],
            details: { running: false as const, crashed: true as const, source: "logcat-crash" },
          };
        }
      } catch {
        /* logcat not available */
      }

      // Check 4: General logcat for recent death of the package
      if (packageName) {
        try {
          const deathResult = await pi.exec(
            "sh",
            ["-c", `adb logcat -d -t 2000 | grep -E "Process ${packageName}|ActivityTaskManager.*${packageName}"`],
            { timeout: budget(0.4), signal },
          );
          if (deathResult.stdout.trim()) {
            // Parse the death reason from the "Process ... has died:" line
            // Format: Process <pkg> (pid <pid>) has died: <reason>
            // Common reasons:
            //   fg TOP  — foreground, top activity (crash or user-triggered exit)
            //   cch+<n> CEM  — cached, killed by LMK (low memory killer / OOM)
            //   vis  — visible but not top
            //   svc  — service
            //   prev — previous process
            const deathMatch = deathResult.stdout.match(/Process\s+\S+\s+\(pid\s+\d+\)\s+has died:\s+(.+)/);
            let deathReason = "unknown";
            let deathCategory: "crash" | "oom" | "normal" = "normal";

            if (deathMatch) {
              const reason = deathMatch[1].trim();
              deathReason = reason;
              if (/cch\+\d+/.test(reason)) {
                deathCategory = "oom";
              } else if (/fg\s/.test(reason) || /vis/.test(reason)) {
                deathCategory = "crash";
              }
            }

            const categoryEmoji = deathCategory === "oom" ? "🧠" : deathCategory === "crash" ? "💥" : "";
            const categoryLabel =
              deathCategory === "oom"
                ? " (likely killed by low memory)"
                : deathCategory === "crash"
                  ? " (died in foreground — likely crashed)"
                  : "";

            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `⏹️ Flutter app is not running.${categoryEmoji}${categoryLabel}\n\n` +
                    `Death reason: \`${deathReason}\`\n\n` +
                    `Recent logs for \`${packageName}\`:\n\n${deathResult.stdout.slice(-1000)}`,
                },
              ],
              details: {
                running: false as const,
                package: packageName,
                deathReason,
                deathCategory,
                recentLogs: deathResult.stdout,
              },
            };
          }
        } catch {
          /* ignore */
        }
      }

      return {
        content: [{ type: "text" as const, text: "⏹️ Flutter app is not running on device." }],
        details: { running: false as const, crashed: false as const },
      };
    },
  });
}
