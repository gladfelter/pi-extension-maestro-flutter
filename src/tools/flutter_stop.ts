import { Type } from "typebox";
import type { ExtensionState } from "../state.js";

/**
 * Get the package name from the current project.
 * Duplicated here because we don't want to export it from index.ts or move it yet.
 * Actually index.ts has it, maybe we should pass it or export it.
 * For now, we'll assume we can't easily reach it without moving things.
 * Let's just use a simple shell command to find it if needed, or better,
 * just pass a 'killDeviceApp' function to the tool.
 */

export function createFlutterStopTool(state: ExtensionState, killDeviceApp?: (ctx: any) => Promise<void>) {
  return {
    name: "flutter_stop",
    label: "Flutter Stop",
    description: "Stop the running Flutter app and clean up state.",
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: any,
      _signal: AbortSignal,
      _onUpdate: any,
      ctx: any,
    ): Promise<{ content: { type: "text"; text: string }[]; details: { stoppedProcess: boolean } }> {
      const lines: string[] = [];

      if (state.flutterProcess) {
        state.flutterProcess.kill();
        state.flutterProcess = null;
        state.flutterOutput = "";
        lines.push("✅ Stopped background Flutter process.");
      } else {
        lines.push("ℹ️ No background Flutter process was running.");
      }

      if (killDeviceApp) {
        try {
          await killDeviceApp(ctx);
          lines.push("✅ Force-stopped app on device.");
        } catch (e: any) {
          lines.push(`⚠️ Failed to force-stop app on device: ${e.message}`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { stoppedProcess: !!state.flutterProcess },
      };
    },
  };
}
