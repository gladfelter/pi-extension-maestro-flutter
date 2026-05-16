/**
 * Parse ADB output for emulator/device detection.
 * Pure functions — no I/O, no Pi API.
 */

/**
 * Parse `adb devices` output into an array of serial/status pairs.
 */
export function parseAdbDevices(output: string): Array<{ serial: string; status: string }> {
  const devices: Array<{ serial: string; status: string }> = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("List of")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && parts[1]) {
      devices.push({ serial: parts[0], status: parts[1] });
    }
  }
  return devices;
}

/**
 * Check if a serial string represents an emulator (starts with "emulator-").
 */
export function isEmulatorSerial(serial: string): boolean {
  return serial.startsWith("emulator-");
}

/**
 * Filter connected emulator devices from adb output.
 */
export function getConnectedEmulators(output: string): Array<{ serial: string; avdName: string }> {
  const devices = parseAdbDevices(output);
  return devices
    .filter((d) => d.status === "device" && isEmulatorSerial(d.serial))
    .map((d) => ({
      serial: d.serial,
      // Derive a rough AVD name hint from serial (e.g. emulator-5554)
      avdName: "",
    }));
}
