/**
 * Shared mutable state for the extension.
 * All tools and commands share this single state object.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ChildProcess, spawn } from "node:child_process";
import type { SavedDevice } from "./common/device-config.js";
import type { FlutterProject } from "./common/project-config.js";

export interface TrackedFlutterProcess extends ChildProcess {
  vmServiceUrl?: string;
}

export interface ExtensionState {
  pi: ExtensionAPI;

  // Flutter process
  flutterProcess: TrackedFlutterProcess | null;
  flutterOutput: string;

  // Device
  savedDevice: SavedDevice | null;
  launchedEmulator: string | null;

  // Project
  selectedProject: FlutterProject | null;
  activeSessionId: string | null;
}

export function createExtensionState(pi: ExtensionAPI): ExtensionState {
  return {
    pi,
    flutterProcess: null,
    flutterOutput: "",
    savedDevice: null,
    launchedEmulator: null,
    selectedProject: null,
    activeSessionId: null,
  };
}
