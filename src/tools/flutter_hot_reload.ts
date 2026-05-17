import { Type } from "typebox";
import type { ExtensionState } from "../state.js";

export function createFlutterHotReloadTool(state: ExtensionState) {
  return {
    name: "flutter_hot_reload",
    label: "Flutter Hot Reload",
    description: "Trigger a hot reload of the running Flutter app",
    parameters: Type.Object({}),
    async execute() {
      if (!state.flutterProcess || !state.flutterProcess.stdin) {
        throw new Error("Flutter app is not running.");
      }
      state.flutterProcess.stdin.write("r");
      return {
        content: [{ type: "text", text: "Sent hot reload command ('r') to Flutter process." }],
        details: {},
      };
    },
  };
}
