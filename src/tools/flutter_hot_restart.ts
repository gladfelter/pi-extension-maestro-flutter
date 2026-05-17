import { Type } from "typebox";
import type { ExtensionState } from "../state.js";

export function createFlutterHotRestartTool(state: ExtensionState) {
  return {
    name: "flutter_hot_restart",
    label: "Flutter Hot Restart",
    description: "Trigger a hot restart of the running Flutter app",
    parameters: Type.Object({}),
    async execute() {
      if (!state.flutterProcess || !state.flutterProcess.stdin) {
        throw new Error("Flutter app is not running.");
      }
      state.flutterProcess.stdin.write("R");
      return {
        content: [{ type: "text", text: "Sent hot restart command ('R') to Flutter process." }],
        details: {},
      };
    },
  };
}
