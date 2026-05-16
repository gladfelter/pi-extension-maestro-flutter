import { describe, it, expect } from "vitest";
import { parseProjectName, parseScanEntries } from "./project-discovery.js";

describe("parseProjectName", () => {
  it("extracts name from pubspec.yaml", () => {
    const yaml = `name: my_flutter_app
version: 1.0.0
environment:
  sdk: '>=3.0.0'`;
    expect(parseProjectName(yaml, "dir_name")).toBe("my_flutter_app");
  });

  it("falls back to dir name when name field is missing", () => {
    const yaml = `version: 1.0.0
environment:
  sdk: '>=3.0.0'`;
    expect(parseProjectName(yaml, "my_dir")).toBe("my_dir");
  });

  it("handles name with trailing whitespace", () => {
    const yaml = "name:   my_app   \nversion: 1.0.0";
    expect(parseProjectName(yaml, "dir")).toBe("my_app");
  });
});

describe("parseScanEntries", () => {
  it("finds projects with pubspec.yaml", () => {
    const entries = [
      { name: "my_app", isDir: true, hasPubspec: true, pubspecName: "my_app" },
      { name: "lib", isDir: true },
      { name: "main.dart", isDir: false },
    ];
    const projects = parseScanEntries("/project", entries);
    expect(projects).toEqual([{ name: "my_app", path: "/project/my_app", relPath: "my_app" }]);
  });

  it("skips hidden directories", () => {
    const entries = [
      { name: ".git", isDir: true, hasPubspec: true },
      { name: ".dart_tool", isDir: true, hasPubspec: true },
      { name: "my_app", isDir: true, hasPubspec: true },
    ];
    const projects = parseScanEntries("/project", entries);
    expect(projects.length).toBe(1);
    expect(projects[0].name).toBe("my_app");
  });

  it("skips skip_dirs (node_modules, build, android, ios, etc.)", () => {
    const entries = [
      { name: "node_modules", isDir: true, hasPubspec: true },
      { name: "build", isDir: true, hasPubspec: true },
      { name: "android", isDir: true, hasPubspec: true },
      { name: "ios", isDir: true, hasPubspec: true },
      { name: "my_app", isDir: true, hasPubspec: true },
    ];
    const projects = parseScanEntries("/project", entries);
    expect(projects.length).toBe(1);
  });

  it("skips non-directory entries", () => {
    const entries = [
      { name: "pubspec.yaml", isDir: false },
      { name: "README.md", isDir: false },
    ];
    expect(parseScanEntries("/project", entries)).toEqual([]);
  });

  it("uses dir name as fallback when pubspecName is not provided", () => {
    const entries = [{ name: "some_app", isDir: true, hasPubspec: true }];
    const projects = parseScanEntries("/project", entries);
    expect(projects[0].name).toBe("some_app");
  });

  it("uses pubspecName when provided", () => {
    const entries = [{ name: "some_dir", isDir: true, hasPubspec: true, pubspecName: "actual_name" }];
    const projects = parseScanEntries("/project", entries);
    expect(projects[0].name).toBe("actual_name");
  });
});
