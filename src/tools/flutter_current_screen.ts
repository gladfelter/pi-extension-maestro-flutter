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
      // Fire TV and Android TV devices keep the launcher activity visible
      // above the app in the task stack. dumpsys activity top returns the
      // launcher first, which is wrong. Query mResumedActivity instead —
      // this is the activity that actually holds input focus.
      const result = await state.pi.exec("adb", ["shell", "dumpsys", "activity", "activities"], {
        timeout: 10000,
        signal,
      });
      if (result.code !== 0) {
        throw new Error(`dumpsys activity failed (exit ${result.code}):\n${result.stdout}`);
      }

      // Preferred: mResumedActivity is the true foreground activity, even
      // on Fire TV where a launcher overlay sits on top in the task stack.
      let match = result.stdout.match(/mResumedActivity:\s*\S+\s+\S+\s+(\S+)\s/);
      if (match?.[1]) {
        const activity = match[1];
        return {
          content: [{ type: "text", text: `Current screen: \`${activity}\`` }],
          details: { activity },
        };
      }

      // Fallback: parse dumpsys activity top (works on standard Android).
      // Grab the LAST ACTIVITY line — on Fire TV the launcher appears first,
      // but our app is the last one in the list.
      const topResult = await state.pi.exec("adb", ["shell", "dumpsys", "activity", "top"], {
        timeout: 10000,
        signal,
      });
      if (topResult.code === 0) {
        const topMatch = topResult.stdout.match(/ACTIVITY\s+(.+?)\s+/g);
        if (topMatch && topMatch.length > 0) {
          // Last ACTIVITY line is the deepest (most likely our app on Fire TV)
          const lastMatch = topMatch[topMatch.length - 1].match(/ACTIVITY\s+(.+?)\s/);
          const activity = lastMatch?.[1] || "Unknown";
          return {
            content: [{ type: "text", text: `Current screen: \`${activity}\`` }],
            details: { activity },
          };
        }
      }

      return {
        content: [{ type: "text", text: "Current screen: `Unknown`" }],
        details: { activity: "Unknown" },
      };
    },
  };
}
