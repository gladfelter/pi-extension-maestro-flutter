import { Type } from "typebox";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExtensionState } from "../state.js";

export function createFlutterScreenshotTool(state: ExtensionState) {
  return {
    name: "flutter_screenshot",
    label: "Flutter Screenshot",
    description: "Take a screenshot of the current device screen. Returns the image path.",
    parameters: Type.Object({
      timeoutMs: Type.Optional(
        Type.Number({
          description:
            "Maximum time in milliseconds to wait for the screenshot. Default 10000. Increase for remote devices over slow links.",
        }),
      ),
    }),
    // @ts-ignore - execute parameter types inferred by registerTool
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const screenshotTimeout = params.timeoutMs || 10000;
      const tmpDir = join(ctx.cwd, ".pi", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const filename = `screenshot_${Date.now()}.png`;
      const outputPath = join(tmpDir, filename);

      const targetDevice = state.savedDevice?.id;
      const adbArgs = targetDevice
        ? ["-s", targetDevice, "exec-out", "screencap", "-p"]
        : ["exec-out", "screencap", "-p"];

      return new Promise((resolve, reject) => {
        const proc = spawn("adb", adbArgs);
        const chunks: Buffer[] = [];
        let stderr = "";

        const timeout = setTimeout(() => {
          proc.kill();
          reject(new Error(`Screenshot timed out after ${Math.round(screenshotTimeout / 1000)} seconds.`));
        }, screenshotTimeout);

        proc.stdout.on("data", (chunk) => {
          chunks.push(chunk);
        });

        proc.stderr.on("data", (data) => {
          stderr += data.toString();
        });

        proc.on("close", (code) => {
          clearTimeout(timeout);
          if (code !== 0) {
            reject(new Error(`Screenshot failed (exit ${code}):\n${stderr}`));
            return;
          }
          try {
            const buffer = Buffer.concat(chunks);
            if (buffer.length === 0) {
              reject(new Error("Screenshot failed: received empty output from adb"));
              return;
            }
            writeFileSync(outputPath, buffer);
            resolve({
              content: [
                {
                  type: "text" as const,
                  text: `Screenshot saved to \`${relative(ctx.cwd, outputPath)}\`. Use the \`read\` tool to analyze it.`,
                },
              ],
              details: { path: outputPath },
            });
          } catch (err) {
            reject(err);
          }
        });

        proc.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });

        if (signal) {
          signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            proc.kill();
          });
        }
      });
    },
  };
}
