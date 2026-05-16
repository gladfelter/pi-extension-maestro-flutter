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
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const name = entry.name as string;
          if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
          if (!entry.isDirectory()) continue;
          const fullPath = join(dir, name);
          if (existsSync(join(fullPath, "pubspec.yaml"))) {
            try {
              const content = readFileSync(join(fullPath, "pubspec.yaml"), "utf-8");
              const nameMatch = content.match(/^name:\s*(.+)$/m);
              results.push({
                name: nameMatch?.[1]?.trim() || name,
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
      } catch {
        return;
      }
    }

    scan(root, 0);
    return results;
  }

  let selectedProject: FlutterProject | null = null;
  let activeSessionId: string | null = null;

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
  pi.on("session_start", async (event, ctx) => {
    activeSessionId = event.sessionId;
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
      const running = await findRunningEmulator(savedDevice.name || "");
      if (running) {
        launchedEmulator = running.serial;
        // Update savedDevice in case serial changed (e.g., emulator restarted on different port)
        savedDevice = { id: running.serial, type: "emulator", name: running.avdName };
      }
    }
  });

  pi.on("session_shutdown", async (event) => {
    activeSessionId = null;
    if (event.reason === "reload" && flutterProcess) {
      flutterProcess = null;
      flutterOutput = "";
    } else if (event.reason !== "reload" && flutterProcess) {
      flutterProcess.kill();
      flutterProcess = null;
    }
    if (event.reason !== "reload" && launchedEmulator) {
      try {
        await pi.exec("adb", ["-s", launchedEmulator, "emu", "kill"], { timeout: 5000 });
      } catch {
        /* ignore shutdown errors */
      }
      launchedEmulator = null;
    }
    if (event.reason !== "reload" && savedDevice?.type === "ip") {
      try {
        await pi.exec("adb", ["disconnect", savedDevice.id], { timeout: 5000 });
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
      for (const line of adbResult.stdout.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts[0]?.startsWith("emulator-") && parts[1] === "device") {
          const serial = parts[0];
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
      for (const line of adbResult.stdout.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === serial && parts[1] === "device") {
          return true;
        }
      }
      return false;
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
        const manifest = readFileSync(manifestPath, "utf-8");
        const pkgMatch = manifest.match(/package="([^"]+)"/);
        if (pkgMatch) return pkgMatch[1];
      }

      // Try build.gradle.kts (modern Flutter / Kotlin DSL)
      const gradleKtsPath = join(project.path, "android", "app", "build.gradle.kts");
      if (existsSync(gradleKtsPath)) {
        const gradleKts = readFileSync(gradleKtsPath, "utf-8");
        const appIdMatch = gradleKts.match(/applicationId\s*=\s*["']([^"']+)["']/);
        const namespaceMatch = gradleKts.match(/namespace\s*=\s*["']([^"']+)["']/);
        const name = appIdMatch?.[1] || namespaceMatch?.[1];
        if (name) return name;
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
          savedDevice = { id: targetId, type: "emulator", name: avdName };
          saveDeviceConfig(ctx.cwd, savedDevice);
          ctx.ui.notify(`✅ Emulator already connected: ${targetId}${avdName ? ` (${avdName})` : ""}`, "info");
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
          savedDevice = { id: alreadyRunning.serial, type: "emulator", name: alreadyRunning.avdName };
          launchedEmulator = alreadyRunning.serial;
          saveDeviceConfig(ctx.cwd, savedDevice);
          ctx.ui.notify(`✅ Emulator already running: ${alreadyRunning.serial} (${alreadyRunning.avdName})`, "info");
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
              savedDevice = { id: running.serial, type: "emulator", name: running.avdName };
              launchedEmulator = running.serial;
              saveDeviceConfig(ctx.cwd, savedDevice);
              ctx.ui.notify(`✅ Emulator booted: ${running.serial} (${running.avdName})`, "info");
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
        try {
          await pi.exec("adb", ["-s", launchedEmulator, "emu", "kill"], { timeout: 5000 });
        } catch {
          /* ignore error */
        }
        ctx.ui.notify(`Killed emulator ${launchedEmulator}`, "info");
        launchedEmulator = null;
      } else if (savedDevice.type === "ip") {
        try {
          await pi.exec("adb", ["disconnect", savedDevice.id], { timeout: 5000 });
        } catch {
          /* ignore error */
        }
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
          savedDevice = { id: targetId, type: "emulator", name: avdName };
          saveDeviceConfig(cwd, savedDevice);
          return {
            content: [
              {
                type: "text",
                text: `✅ Emulator already connected: \`${targetId}\`${avdName ? ` (${avdName})` : ""}\nSaved as default device.`,
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
          savedDevice = { id: alreadyRunning.serial, type: "emulator", name: alreadyRunning.avdName };
          saveDeviceConfig(cwd, savedDevice);
          return {
            content: [
              {
                type: "text",
                text: `✅ Emulator already running: \`${alreadyRunning.serial}\` (${alreadyRunning.avdName})\nSaved as default device.`,
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
              savedDevice = { id: running.serial, type: "emulator", name: running.avdName };
              launchedEmulator = running.serial;
              saveDeviceConfig(cwd, savedDevice);
              return {
                content: [
                  {
                    type: "text",
                    text: `✅ Emulator launched and booted: \`${running.serial}\` (${running.avdName})\nSaved as default device.`,
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
    async execute(_, __, signal, ____, ctx) {
      if (!savedDevice) {
        return { content: [{ type: "text", text: "No saved device to disconnect from." }], details: {} };
      }

      const device = savedDevice;
      const lines: string[] = [];

      if (launchedEmulator) {
        try {
          await pi.exec("adb", ["-s", launchedEmulator, "emu", "kill"], { timeout: 5000, signal });
          lines.push(`✅ Killed emulator \`${launchedEmulator}\``);
        } catch {
          lines.push(`⚠️ Failed to kill emulator \`${launchedEmulator}\` (already dead or ADB error).`);
        }
        launchedEmulator = null;
      }

      if (device.type === "ip") {
        try {
          await pi.exec("adb", ["disconnect", device.id], { timeout: 5000, signal });
          lines.push(`✅ Disconnected \`${device.id}\``);
        } catch {
          lines.push(`⚠️ Failed to disconnect \`${device.id}\` (ADB error).`);
        }
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
      const targetDevice = params.device || savedDevice?.id;
      const currentSessionId = activeSessionId;

      if (flutterProcess) {
        throw new Error("Flutter is already running. Use flutter_hot_reload or flutter_stop first.");
      }

      // Check if Flutter is already running on device (e.g., from previous run killed by reload)
      const isAdbDevice =
        targetDevice && (targetDevice.startsWith("emulator-") || targetDevice.startsWith("127.0.0.1"));
      let useAttach = false;
      if (isAdbDevice) {
        try {
          const psResult = await pi.exec("adb", ["-s", targetDevice, "shell", "ps", "-A"], {
            timeout: 5000,
            signal,
          });
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
      let buildFailed = false;
      let lastProgressTime = Date.now();

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
      ];

      proc.stdout?.on("data", (data: Buffer) => {
        if (activeSessionId !== currentSessionId || proc !== flutterProcess) return;
        const str = data.toString();
        flutterOutput += str;
        if (flutterOutput.length > 200_000) flutterOutput = flutterOutput.slice(-100_000);

        // Detect build failures before the app starts
        if (!started && !buildFailed) {
          for (const pattern of BUILD_FAILURE_PATTERNS) {
            if (pattern.test(str)) {
              buildFailed = true;
              pi.sendMessage(
                {
                  customType: "run_failed",
                  content: `❌ Flutter build failed\n\n${flutterOutput.slice(-4000)}`,
                  display: true,
                  details: { exitCode: 1, started: false, logs: flutterOutput.slice(-2000), stage: "build" },
                },
                { deliverAs: "followUp", triggerTurn: true },
              );
              break;
            }
          }
        }

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

        if (!started && !buildFailed) {
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
        if (activeSessionId !== currentSessionId || proc !== flutterProcess) return;
        const str = data.toString();
        flutterOutput += str;
        if (flutterOutput.length > 200_000) flutterOutput = flutterOutput.slice(-100_000);
      });

      proc.on("exit", (code) => {
        if (activeSessionId !== currentSessionId || proc !== flutterProcess) return;
        flutterProcess = null;
        if (!started) {
          // Don't send another run_failed if we already sent one for build failure
          if (!buildFailed) {
            pi.sendMessage(
              {
                customType: "run_failed",
                content: `❌ Flutter run exited before app started (code ${code}).\n\n${flutterOutput.slice(-4000)}`,
                display: true,
                details: { exitCode: code, started: false, logs: flutterOutput.slice(-1000) },
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          }
        } else {
          const isCrash = code !== 0 && code !== null;
          pi.sendMessage(
            {
              customType: "run_stopped",
              content: `${isCrash ? "❌" : "⏹️"} Flutter app stopped (exit code ${code}).${isCrash ? `\n\nLast logs:\n${flutterOutput.slice(-500)}` : ""}`,
              display: true,
              details: { exitCode: code, started: true, logs: flutterOutput.slice(-1000) },
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
            text: `🚀 Starting app: ${commandLabel}\n\nYou may do other work, but do not sleep or wait for this operation. End work if you have no other tasks. You will be notified when the app is running.\n\n`,
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
      const result = await pi.exec("node", [tempFile], { timeout: 20000 });
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

  // ── Maestro Temp File ───────────────────────────────────────────────

  pi.registerTool({
    name: "maestro_test_file",
    label: "Maestro Test File",
    description:
      "Create a temp YAML file for maestro test flows. Returns the path for writing. All maestro test ephemera lives in .pi/tmp/ so it stays together and is garbage-collectable. Use this instead of bare /tmp/ files or writing YAML to the project root.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Short name for the test (e.g. 'tap-increment', 'form-submit'). Used in filename: maestro-<name>.yaml",
      }),
      content: Type.Optional(
        Type.String({
          description: "YAML content. If provided, writes the file directly and skips the write-then-run pattern.",
        }),
      ),
    }),
    async execute(_, params, __, ___, ctx) {
      const sanitized =
        params.name
          .replace(/[^a-zA-Z0-9_-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "") || "flow";
      const filename = `maestro-${sanitized}.yaml`;
      const tmpDir = join(ctx.cwd, ".pi", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const filepath = join(tmpDir, filename);

      if (params.content) {
        writeFileSync(filepath, params.content, "utf-8");
        return {
          content: [
            { type: "text", text: `Wrote maestro test to \`${filepath}\`.\n\nRun: \`maestro test ${filepath}\`` },
          ],
          details: { path: filepath, written: true },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Temp file path: \`${filepath}\`\n\nWrite your YAML content here, then run \`maestro test ${filepath}\`."`,
          },
        ],
        details: { path: filepath, written: false },
      };
    },
  });

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
      // Truncate to last 50 lines (tail) — the head is Flutter framework plumbing
      // (MediaQuery, FocusScope, Theme, Navigator) while the tail has actual UI widgets.
      if (params.full) {
        const full = await callVmService("ext.flutter.debugDumpApp", {}, ctx.cwd);
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
      // Note: maestro hierarchy auto-detects the connected ADB device; --device is not supported
      const result = await pi.exec("maestro", ["hierarchy"], { timeout: 30000, signal });
      if (result.code !== 0) {
        throw new Error(`maestro hierarchy failed (exit ${result.code}):\n${result.stdout}`);
      }

      let tree: Record<string, unknown>;
      try {
        // Maestro prefixes output with "Running on <device>\n" before the JSON — strip it
        const jsonStart = result.stdout.indexOf("{");
        const jsonStr = jsonStart >= 0 ? result.stdout.slice(jsonStart) : result.stdout;
        tree = JSON.parse(jsonStr) as Record<string, unknown>;
      } catch {
        throw new Error(`Failed to parse maestro hierarchy JSON:\n${result.stdout.slice(0, 500)}`);
      }

      // Recursively extract leaf nodes with accessibility text
      // Also detects TextField semantics issues where Semantics.label ends up in hintText
      // instead of accessibilityText (a common Flutter+Android accessibility quirk).
      const labels: Array<{ label: string; text?: string; hintText?: string; clickable: boolean; bounds: string }> = [];
      const textFieldIssues: Array<{ hintTextLabel: string; bounds: string; className: string }> = [];
      function walk(node: unknown) {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const obj = node as Record<string, unknown>;
        const attrs = obj.attributes as Record<string, string> | undefined;
        if (attrs) {
          const accessibilityText = attrs.accessibilityText || "";
          const text = attrs.text || "";
          const hintText = attrs.hintText || "";
          const clickable = attrs.clickable === "true";
          const bounds = attrs.bounds || "";
          const className = attrs.class || "";
          // Include if it has meaningful text/hint and is a leaf or clickable
          if (
            (accessibilityText || text || hintText) &&
            (!obj.children || (obj.children as unknown[]).length === 0 || clickable)
          ) {
            labels.push({
              label: accessibilityText,
              text: text || undefined,
              hintText: hintText || undefined,
              clickable,
              bounds,
            });
          }
          // Detect TextField semantics issue: label present in hintText but not in accessibilityText
          // This happens when Semantics(label: "...") wraps a TextField — Android places it in hintText.
          if (hintText && !accessibilityText && className === "android.widget.EditText") {
            // Extract the first line of hintText (usually the Semantics label)
            const firstLine = hintText.split("\n")[0].trim();
            if (firstLine) {
              textFieldIssues.push({ hintTextLabel: firstLine, bounds, className });
            }
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
            (l) =>
              l.label.toLowerCase().includes(searchQuery) ||
              l.text?.toLowerCase().includes(searchQuery) ||
              l.hintText?.toLowerCase().includes(searchQuery),
          )
        : labels;

      const lines = filtered.map((l) => {
        const click = l.clickable ? "👆" : "";
        const hint = l.hintText && !l.label ? ` ⚠️ hint-only: \`${l.hintText.split("\n")[0]}\`` : "";
        const extra = l.text && l.text !== l.label ? ` [${l.text}]` : "";
        return `${click} \`${l.label || l.text}\` — ${l.bounds}${extra}${hint}`;
      });

      // Hard limit: truncate if output would be too large (>4KB)
      const MAX_OUTPUT_BYTES = 4096;
      const joined = lines.join("\n");
      const truncated = joined.length > MAX_OUTPUT_BYTES;
      let output = truncated
        ? joined.slice(0, MAX_OUTPUT_BYTES) + "\n... (truncated, use search to find specific labels)"
        : joined;

      // Append TextField semantics warning if detected
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

      return {
        content: [
          {
            type: "text",
            text: output,
          },
        ],
        details: { count: filtered.length, total: labels.length, truncated, textFieldIssues: textFieldIssues.length },
      };
    },
  });

  // @ts-ignore - TypeBox mixed content types
  pi.registerTool({
    name: "flutter_screenshot",
    label: "Flutter Screenshot",
    description: "Take a screenshot of the current device screen. Returns the image path.",
    parameters: Type.Object({
      timeoutMs: Type.Optional(
        Type.Number({
          description:
            "Maximum time in milliseconds to wait for the screenshot. Default 10000. Increase for remote devices over slow links.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const screenshotTimeout = params.timeoutMs || 10000;
      const tmpDir = join(ctx.cwd, ".pi", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const filename = `screenshot_${Date.now()}.png`;
      const outputPath = join(tmpDir, filename);

      const targetDevice = savedDevice?.id;
      const adbArgs = targetDevice
        ? ["-s", targetDevice, "exec-out", "screencap", "-p"]
        : ["exec-out", "screencap", "-p"];

      return new Promise((resolve, reject) => {
        const proc = spawn("adb", adbArgs);
        const chunks: Buffer[] = [];
        let stderr = "";

        const timeout = setTimeout(() => {
          proc.kill();
          reject(new Error(`Screenshot timed out after ${Math.round(screenshotTimeout / 1000)} seconds.`));
        }, screenshotTimeout);

        proc.stdout.on("data", (chunk) => {
          chunks.push(chunk);
        });

        proc.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        proc.on("close", (code) => {
          clearTimeout(timeout);
          if (code !== 0) {
            reject(new Error(`Screenshot failed (exit ${code}):\n${stderr}`));
            return;
          }
          try {
            const buffer = Buffer.concat(chunks);
            if (buffer.length === 0) {
              reject(new Error("Screenshot failed: received empty output from adb"));
              return;
            }
            writeFileSync(outputPath, buffer);
            resolve({
              content: [
                {
                  type: "text" as const,
                  text: `Screenshot saved to \`${relative(ctx.cwd, outputPath)}\`. Use the \`read\` tool to analyze it.`,
                },
              ],
              details: { path: outputPath },
            });
          } catch (err) {
            reject(err);
          }
        });

        proc.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        if (signal) {
          signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            proc.kill();
          });
        }
      });
    },
  });

  pi.registerTool({
    name: "flutter_current_screen",
    label: "Flutter Current Screen",
    description: "Get the current activity/screen visible on the device. Returns a single line with the activity name.",
    parameters: Type.Object({}),
    async execute(_, __, signal) {
      const result = await pi.exec("adb", ["shell", "dumpsys", "activity", "top"], { timeout: 10000, signal });
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

      // Pre-flight: check if device is connected
      if (savedDevice) {
        const connected = await isAdbDeviceConnected(savedDevice.id);
        if (!connected) {
          return {
            content: [{ type: "text" as const, text: `⚠️ Device \`${savedDevice.id}\` is disconnected.` }],
            details: { running: false as const, connected: false as const },
          };
        }
      }

      // Check 1: Is the tracked flutter process still alive with a valid VM Service URL?
      if (flutterProcess && flutterProcess.vmServiceUrl && !flutterProcess.killed) {
        // Verify VM Service is actually reachable (check from host)
        try {
          const vmHost = flutterProcess.vmServiceUrl.replace("http://", "").split(":")[0];
          const vmPort = flutterProcess.vmServiceUrl.replace("http://", "").split(":")[1]?.split("/")[0];
          if (vmHost && vmPort) {
            const pingResult = await pi.exec("curl", ["--max-time", "3", "-s", `http://${vmHost}:${vmPort}/json`], {
              timeout: budget(0.2),
              signal,
            });
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
      const packageName = getPackageName(ctx.cwd);
      if (packageName) {
        try {
          const pidResult = await pi.exec("adb", ["shell", "pidof", packageName], {
            timeout: budget(0.15),
            signal,
          });
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
        } catch {
          /* pidof failed, likely not running */
        }
      }

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

      // Check 4: General logcat for recent death of the package — also parse OOM info
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
