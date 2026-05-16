/**
 * Device configuration persistence (.pi/device.json).
 */
import { FsAdapter, realFs } from "./config.js";
import { join, dirname } from "node:path";

export interface SavedDevice {
  id: string;
  type: "ip" | "emulator";
  name?: string;
}

function deviceConfigPath(cwd: string): string {
  return join(cwd, ".pi", "device.json");
}

/**
 * Load saved device config. Returns null if not found or invalid.
 */
export function loadDeviceConfig(cwd: string, fs: FsAdapter = realFs): SavedDevice | null {
  try {
    const path = deviceConfigPath(cwd);
    if (!fs.existsSync(path)) return null;
    return JSON.parse(fs.readFileSync(path)) as SavedDevice;
  } catch {
    return null;
  }
}

/**
 * Save device config. Pass null to delete the config file.
 */
export function saveDeviceConfig(cwd: string, device: SavedDevice | null, fs: FsAdapter = realFs): void {
  const path = deviceConfigPath(cwd);
  if (device === null) {
    try {
      fs.unlinkSync(path);
    } catch {
      /* didn't exist */
    }
    return;
  }
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(device, null, 2) + "\n");
}
