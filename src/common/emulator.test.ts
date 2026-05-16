import { describe, it, expect } from "vitest";
import { parseAdbDevices, isEmulatorSerial, getConnectedEmulators } from "./emulator.js";

describe("parseAdbDevices", () => {
  it("parses a typical adb devices output", () => {
    const output = `List of devices attached
emulator-5554	device
192.168.1.100:5555	device
A2B3C4D5E6	offline`;
    const devices = parseAdbDevices(output);
    expect(devices).toEqual([
      { serial: "emulator-5554", status: "device" },
      { serial: "192.168.1.100:5555", status: "device" },
      { serial: "A2B3C4D5E6", status: "offline" },
    ]);
  });

  it("handles empty output", () => {
    const devices = parseAdbDevices("List of devices attached\n");
    expect(devices).toEqual([]);
  });

  it("handles device with unauthorized status", () => {
    const output = `List of devices attached
emulator-5554	unauthorized`;
    const devices = parseAdbDevices(output);
    expect(devices).toEqual([{ serial: "emulator-5554", status: "unauthorized" }]);
  });
});

describe("isEmulatorSerial", () => {
  it("returns true for emulator serials", () => {
    expect(isEmulatorSerial("emulator-5554")).toBe(true);
    expect(isEmulatorSerial("emulator-6123")).toBe(true);
    expect(isEmulatorSerial("emulator-avd:test_34")).toBe(true);
  });

  it("returns false for physical devices", () => {
    expect(isEmulatorSerial("A2B3C4D5E6")).toBe(false);
    expect(isEmulatorSerial("192.168.1.100:5555")).toBe(false);
  });
});

describe("getConnectedEmulators", () => {
  it("returns only connected emulators", () => {
    const output = `List of devices attached
emulator-5554	device
192.168.1.100:5555	device
emulator-5556	offline`;
    const emulators = getConnectedEmulators(output);
    expect(emulators).toEqual([{ serial: "emulator-5554", avdName: "" }]);
  });

  it("returns empty array when no emulators connected", () => {
    const output = `List of devices attached
A2B3C4D5E6	device`;
    expect(getConnectedEmulators(output)).toEqual([]);
  });
});
