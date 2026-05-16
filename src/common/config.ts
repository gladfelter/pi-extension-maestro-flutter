/**
 * Minimal filesystem adapter for config I/O.
 * Allows mocking in tests while using real fs in production.
 */
export interface FsAdapter {
  readFileSync(path: string): string;
  writeFileSync(path: string, content: string): void;
  unlinkSync(path: string): void;
  existsSync(path: string): boolean;
  mkdirSync(path: string, opts: { recursive: boolean }): void;
}

/** Real filesystem implementation using Node.js fs. */
export const realFs: FsAdapter = {
  readFileSync: (path) => require("node:fs").readFileSync(path, "utf-8"),
  writeFileSync: (path, content) => require("node:fs").writeFileSync(path, content, "utf-8"),
  unlinkSync: (path) => require("node:fs").unlinkSync(path),
  existsSync: (path) => require("node:fs").existsSync(path),
  mkdirSync: (path, opts) => require("node:fs").mkdirSync(path, opts),
};
