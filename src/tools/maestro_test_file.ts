import { Type } from "typebox";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionState } from "../state.js";

export function createMaestroTestFileTool(state: ExtensionState) {
  return {
    name: "maestro_test_file",
    label: "Maestro Test File",
    description:
      "Create a temp YAML file for maestro test flows. Returns the path for writing. All maestro test ephemera lives in .pi/tmp/ so it stays together and is garbage-collectable. Use this instead of bare /tmp/ files or writing YAML to the project root.",
    parameters: Type.Object({
      name: Type.String({
        description:
          "Short name for the test (e.g. 'tap-increment', 'form-submit'). Used in filename: maestro-<name>.yaml",
      }),
      content: Type.Optional(
        Type.String({
          description: "YAML content. If provided, writes the file directly and skips the write-then-run pattern.",
        }),
      ),
    }),
    // @ts-ignore - execute parameter types inferred by registerTool
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sanitized =
        params.name
          .replace(/[^a-zA-Z0-9_-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "") || "flow";
      const filename = `maestro-${sanitized}.yaml`;
      const tmpDir = join(ctx.cwd, ".pi", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const filepath = join(tmpDir, filename);

      if (params.content) {
        writeFileSync(filepath, params.content, "utf-8");
        return {
          content: [
            {
              type: "text",
              text: `Wrote maestro test to \`${filepath}\`.\n\nRun: \`maestro test ${filepath}\``,
            },
          ],
          details: { path: filepath, written: true },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Temp file path: \`${filepath}\`\n\nWrite your YAML content here, then run \`maestro test ${filepath}\`."`,
          },
        ],
        details: { path: filepath, written: false },
      };
    },
  };
}
