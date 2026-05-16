/**
 * Flutter project discovery — scan directories for pubspec.yaml files.
 */
import { FsAdapter, realFs } from "./config.js";
import { join, relative } from "node:path";

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

/**
 * Extract the `name:` field from a pubspec.yaml content string.
 * Falls back to the directory name if the field is missing.
 */
export function parseProjectName(yamlContent: string, dirName: string): string {
  const nameMatch = yamlContent.match(/^name:\s*(.+)$/m);
  return nameMatch?.[1]?.trim() || dirName;
}

export interface FlutterProject {
  name: string;
  path: string;
  relPath: string;
}

interface Dirent {
  name: string;
  isDirectory: () => boolean;
}

/**
 * Scan a directory tree for Flutter projects (directories containing pubspec.yaml).
 */
export function findFlutterProjects(root: string, maxDepth = 4, fs: FsAdapter = realFs): FlutterProject[] {
  const results: FlutterProject[] = [];
  // We use the real readdirSync from node:fs since the FsAdapter doesn't cover directory listing
  // (it's only for config file I/O). For testing, we'd need a different approach.
  const { readdirSync: realReaddir } = require("node:fs");

  function scan(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    try {
      const entries = realReaddir(dir, { withFileTypes: true }) as Dirent[];
      for (const entry of entries) {
        const name = entry.name;
        if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
        if (!entry.isDirectory()) continue;
        const fullPath = join(dir, name);
        if (fs.existsSync(join(fullPath, "pubspec.yaml"))) {
          try {
            const content = fs.readFileSync(join(fullPath, "pubspec.yaml"));
            results.push({
              name: parseProjectName(content, name),
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

/**
 * Parse directory entries for testing. Given an array of { name, isDir, hasPubspec } objects,
 * return the list of project paths that would match.
 * Used by tests to verify scan logic without real filesystem.
 */
export function parseScanEntries(
  root: string,
  entries: Array<{ name: string; isDir: boolean; hasPubspec?: boolean; pubspecName?: string }>,
): FlutterProject[] {
  const results: FlutterProject[] = [];
  for (const entry of entries) {
    if (!entry.isDir) continue;
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(root, entry.name);
    if (entry.hasPubspec) {
      results.push({
        name: entry.pubspecName || entry.name,
        path: fullPath,
        relPath: relative(root, fullPath),
      });
    }
  }
  return results;
}
