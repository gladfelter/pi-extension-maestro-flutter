import { Type } from "typebox";
import type { ExtensionState } from "../state.js";

export function createFlutterStopTool(state: ExtensionState) {
  return {
    name: "flutter_stop",
    label: "Flutter Stop",
    description: "Stop the running Flutter app",
    parameters: Type.Object({}),
    async execute() {
      if (!state.flutterProcess) {
        return { content: [{ type: "text" as const, text: "Flutter app is not running." }], details: {} };
      }
      state.flutterProcess.kill();
      state.flutterProcess = null;
      state.flutterOutput = "";
      return { content: [{ type: "text", text: "Stopped Flutter process." }], details: {} };
    },
  };
}
