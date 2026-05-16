import { describe, it, expect, beforeEach } from "vitest";
import { loadProjectConfig, saveProjectConfig } from "./project-config.js";
import { FsAdapter } from "./config.js";

function makeMockFs(): FsAdapter & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  return {
    files,
    readFileSync: (path) => {
      if (!(path in files)) throw new Error("ENOENT");
      return files[path];
    },
    writeFileSync: (path, content) => {
      files[path] = content;
    },
    unlinkSync: (path) => {
      delete files[path];
    },
    existsSync: (path) => path in files,
    mkdirSync: () => {},
  };
}

describe("project config", () => {
  let fs: ReturnType<typeof makeMockFs>;

  beforeEach(() => {
    fs = makeMockFs();
  });

  describe("loadProjectConfig", () => {
    it("returns null when no config exists", () => {
      expect(loadProjectConfig("/project", fs)).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      fs.writeFileSync("/project/.pi/flutter-project.json", "broken");
      expect(loadProjectConfig("/project", fs)).toBeNull();
    });

    it("loads a saved project", () => {
      fs.writeFileSync(
        "/project/.pi/flutter-project.json",
        JSON.stringify({ name: "my_app", path: "/project/my_app", relPath: "my_app" }),
      );
      const project = loadProjectConfig("/project", fs);
      expect(project).toEqual({ name: "my_app", path: "/project/my_app", relPath: "my_app" });
    });
  });

  describe("saveProjectConfig", () => {
    it("writes project config", () => {
      saveProjectConfig("/project", { name: "my_app", path: "/project/my_app", relPath: "my_app" }, fs);
      const content = fs.readFileSync("/project/.pi/flutter-project.json");
      expect(JSON.parse(content)).toEqual({
        name: "my_app",
        path: "/project/my_app",
        relPath: "my_app",
      });
    });

    it("deletes config when passed null", () => {
      fs.writeFileSync("/project/.pi/flutter-project.json", "{}");
      saveProjectConfig("/project", null, fs);
      expect(fs.existsSync("/project/.pi/flutter-project.json")).toBe(false);
    });

    it("does not throw when deleting nonexistent config", () => {
      expect(() => saveProjectConfig("/project", null, fs)).not.toThrow();
    });
  });

  describe("roundtrip", () => {
    it("save then load returns the same project", () => {
      const project = { name: "my_app", path: "/project/my_app", relPath: "my_app" };
      saveProjectConfig("/project", project, fs);
      expect(loadProjectConfig("/project", fs)).toEqual(project);
    });
  });
});
