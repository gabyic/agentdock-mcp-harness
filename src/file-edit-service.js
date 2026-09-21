import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  resolveExistingTaskPath,
  resolveWritableTaskPath,
  taskRelativePath,
} from "./workspace-paths.js";
import { AgentDockError } from "./errors.js";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export class FileEditService {
  #tasks;

  constructor({ taskService }) {
    this.#tasks = taskService;
  }

  async patch({
    taskId,
    filePath,
    expectedSha256,
    oldText,
    newText,
  }) {
    const { root, resolved } = await resolveExistingTaskPath(
      this.#tasks,
      taskId,
      filePath,
    );
    const before = await readFile(resolved);
    const actualSha256 = sha256(before);

    if (actualSha256 !== expectedSha256) {
      throw new AgentDockError(
        "PATCH_CONFLICT",
        "File changed after it was read; read it again before patching.",
        {
          expected_sha256: expectedSha256,
          actual_sha256: actualSha256,
        },
      );
    }

    const current = before.toString("utf8");
    const firstIndex = current.indexOf(oldText);
    const nextIndex =
      firstIndex === -1
        ? -1
        : current.indexOf(oldText, firstIndex + Math.max(oldText.length, 1));

    if (oldText.length === 0 || firstIndex === -1 || nextIndex !== -1) {
      throw new AgentDockError(
        "PATCH_CONFLICT",
        firstIndex === -1
          ? "Patch context was not found in the current file."
          : "Patch context is empty or ambiguous; provide unique context.",
      );
    }

    const updated =
      current.slice(0, firstIndex) +
      newText +
      current.slice(firstIndex + oldText.length);

    await writeFile(resolved, updated, "utf8");
    const after = Buffer.from(updated, "utf8");

    return {
      task_id: taskId,
      path: taskRelativePath(root, resolved),
      previous_sha256: actualSha256,
      sha256: sha256(after),
      size_bytes: after.length,
    };
  }

  async write({ taskId, filePath, content, overwrite = false }) {
    const { root, resolved } = await resolveWritableTaskPath(
      this.#tasks,
      taskId,
      filePath,
    );

    try {
      await writeFile(resolved, content, {
        encoding: "utf8",
        flag: overwrite ? "w" : "wx",
      });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new AgentDockError(
          "FILE_EXISTS",
          "Target already exists; set overwrite=true for explicit replacement.",
        );
      }
      throw error;
    }

    const buffer = Buffer.from(content, "utf8");
    return {
      task_id: taskId,
      path: taskRelativePath(root, resolved),
      sha256: sha256(buffer),
      size_bytes: buffer.length,
      overwrite,
    };
  }
}
