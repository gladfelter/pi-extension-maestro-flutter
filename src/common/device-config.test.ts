import { describe, it, expect, beforeEach } from "vitest";
import { loadDeviceConfig, saveDeviceConfig } from "./device-config.js";
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

describe("device config", () => {
  let fs: ReturnType<typeof makeMockFs>;

  beforeEach(() => {
    fs = makeMockFs();
  });

  describe("loadDeviceConfig", () => {
    it("returns null when no config exists", () => {
      expect(loadDeviceConfig("/project", fs)).toBeNull();
    });

    it("returns null when file is invalid JSON", () => {
      fs.writeFileSync("/project/.pi/device.json", "not json");
      expect(loadDeviceConfig("/project", fs)).toBeNull();
    });

    it("loads an IP device", () => {
      fs.writeFileSync("/project/.pi/device.json", JSON.stringify({ id: "192.168.1.100:5555", type: "ip" }));
      const device = loadDeviceConfig("/project", fs);
      expect(device).toEqual({ id: "192.168.1.100:5555", type: "ip" });
    });

    it("loads an emulator device with name", () => {
      fs.writeFileSync(
        "/project/.pi/device.json",
        JSON.stringify({ id: "emulator-5554", type: "emulator", name: "test_34" }),
      );
      const device = loadDeviceConfig("/project", fs);
      expect(device).toEqual({ id: "emulator-5554", type: "emulator", name: "test_34" });
    });
  });

  describe("saveDeviceConfig", () => {
    it("writes config for an IP device", () => {
      saveDeviceConfig("/project", { id: "10.0.0.1:5555", type: "ip" }, fs);
      const content = fs.readFileSync("/project/.pi/device.json");
      expect(JSON.parse(content)).toEqual({ id: "10.0.0.1:5555", type: "ip" });
    });

    it("writes config for an emulator device", () => {
      saveDeviceConfig("/project", { id: "emulator-5554", type: "emulator", name: "test_34" }, fs);
      const content = fs.readFileSync("/project/.pi/device.json");
      expect(JSON.parse(content)).toEqual({ id: "emulator-5554", type: "emulator", name: "test_34" });
    });

    it("deletes config when passed null", () => {
      fs.writeFileSync("/project/.pi/device.json", "{}");
      saveDeviceConfig("/project", null, fs);
      expect(fs.existsSync("/project/.pi/device.json")).toBe(false);
    });

    it("does not throw when deleting nonexistent config", () => {
      expect(() => saveDeviceConfig("/project", null, fs)).not.toThrow();
    });
  });

  describe("roundtrip", () => {
    it("save then load returns the same device", () => {
      const device = { id: "emulator-5554", type: "emulator", name: "test_34" };
      saveDeviceConfig("/project", device, fs);
      expect(loadDeviceConfig("/project", fs)).toEqual(device);
    });
  });
});
