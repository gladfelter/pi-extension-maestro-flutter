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
        // @ts-ignore - type literal inferred by registerTool
        return { content: [{ type: "text", text: "Flutter app is not running." }], details: {} };
      }
      state.flutterProcess.kill();
      state.flutterProcess = null;
      state.flutterOutput = "";
      // @ts-ignore - type literal inferred by registerTool
      return { content: [{ type: "text", text: "Stopped Flutter process." }], details: {} };
    },
  };
}
