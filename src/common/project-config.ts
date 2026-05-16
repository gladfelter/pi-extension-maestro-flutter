/**
 * Flutter project configuration persistence (.pi/flutter-project.json).
 */
import { FsAdapter, realFs } from "./config.js";
import { join, dirname, relative } from "node:path";

export interface FlutterProject {
  name: string;
  path: string;
  relPath: string;
}

function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "flutter-project.json");
}

/**
 * Load saved project config. Returns null if not found or invalid.
 */
export function loadProjectConfig(cwd: string, fs: FsAdapter = realFs): FlutterProject | null {
  try {
    const path = projectConfigPath(cwd);
    if (!fs.existsSync(path)) return null;
    return JSON.parse(fs.readFileSync(path)) as FlutterProject;
  } catch {
    return null;
  }
}

/**
 * Save project config. Pass null to delete the config file.
 */
export function saveProjectConfig(cwd: string, project: FlutterProject | null, fs: FsAdapter = realFs): void {
  const path = projectConfigPath(cwd);
  if (project === null) {
    try {
      fs.unlinkSync(path);
    } catch {
      /* didn't exist */
    }
    return;
  }
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, JSON.stringify(project, null, 2) + "\n");
}
