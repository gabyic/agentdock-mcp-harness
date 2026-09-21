import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  resolveExistingTaskPath,
  taskRelativePath,
} from "./workspace-paths.js";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function listFiles(rootDir) {
  const files = [];

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.isSymbolicLink()) {
        continue;
      }
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  await walk(rootDir);
  files.sort();
  return files;
}

export class FileQueryService {
  #tasks;

  constructor({ taskService }) {
    this.#tasks = taskService;
  }

  async read({ taskId, filePath }) {
    const { root, resolved } = await resolveExistingTaskPath(
      this.#tasks,
      taskId,
      filePath,
    );
    const buffer = await readFile(resolved);
    return {
      task_id: taskId,
      path: taskRelativePath(root, resolved),
      size_bytes: buffer.length,
      sha256: sha256(buffer),
      content: buffer.toString("utf8"),
    };
  }

  async search({
    taskId,
    query,
    searchPath = ".",
    glob = "**/*",
    maxResults = 200,
  }) {
    const { root, resolved } = await resolveExistingTaskPath(
      this.#tasks,
      taskId,
      searchPath,
    );
    const targetStat = await stat(resolved);
    const candidates = targetStat.isFile()
      ? [resolved]
      : await listFiles(resolved);
    const matches = [];

    for (const absolutePath of candidates) {
      const relativePath = taskRelativePath(root, absolutePath);
      if (!path.matchesGlob(relativePath, glob)) {
        continue;
      }

      let content;
      try {
        content = await readFile(absolutePath, "utf8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        let fromIndex = 0;
        while (fromIndex <= lines[lineIndex].length) {
          const columnIndex = lines[lineIndex].indexOf(query, fromIndex);
          if (columnIndex === -1) {
            break;
          }

          matches.push({
            path: relativePath,
            line: lineIndex + 1,
            column: columnIndex + 1,
            text: lines[lineIndex],
          });

          if (matches.length >= maxResults) {
            return {
              task_id: taskId,
              query,
              glob,
              matches,
              truncated: true,
            };
          }

          fromIndex = columnIndex + Math.max(query.length, 1);
        }
      }
    }

    return {
      task_id: taskId,
      query,
      glob,
      matches,
      truncated: false,
    };
  }
}
