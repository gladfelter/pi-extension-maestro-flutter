import { Type } from "typebox";
import type { ExtensionState } from "../state.js";

export function createFlutterCurrentScreenTool(state: ExtensionState) {
  return {
    name: "flutter_current_screen",
    label: "Flutter Current Screen",
    description: "Get the current activity/screen visible on the device. Returns a single line with the activity name.",
    parameters: Type.Object({}),
    // @ts-ignore - execute parameter types inferred by registerTool
    async execute(_toolCallId, _params, signal) {
      const result = await state.pi.exec("adb", ["shell", "dumpsys", "activity", "top"], {
        timeout: 10000,
        signal,
      });
      if (result.code !== 0) {
        throw new Error(`dumpsys activity failed (exit ${result.code}):\n${result.stdout}`);
      }

      const match = result.stdout.match(/ACTIVITY\s+(.+?)\s+/);
      const activity = match?.[1] || "Unknown";

      return {
        content: [{ type: "text", text: `Current screen: \`${activity}\`` }],
        details: { activity },
      };
    },
  };
}
