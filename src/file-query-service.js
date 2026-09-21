import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  auditAccess,
  presentedPath,
  resolveExistingTaskPath,
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
  #audit;

  constructor({ taskService, auditService }) {
    this.#tasks = taskService;
    this.#audit = auditService;
  }

  async read({ taskId, filePath }) {
    const location = await resolveExistingTaskPath(
      this.#tasks,
      taskId,
      filePath,
    );
    const buffer = await readFile(location.resolved);
    const result = {
      task_id: taskId,
      path: presentedPath(location),
      access: auditAccess(location.scope, "READ"),
      size_bytes: buffer.length,
      sha256: sha256(buffer),
      content: buffer.toString("utf8"),
    };

    this.#audit?.append(taskId, {
      event: "FILE_READ",
      access: result.access,
      path: result.path,
      size_bytes: result.size_bytes,
      sha256: result.sha256,
    });

    return result;
  }

  async search({
    taskId,
    query,
    searchPath = ".",
    glob = "**/*",
    maxResults = 200,
  }) {
    const location = await resolveExistingTaskPath(
      this.#tasks,
      taskId,
      searchPath,
    );
    const targetStat = await stat(location.resolved);
    const candidates = targetStat.isFile()
      ? [location.resolved]
      : await listFiles(location.resolved);
    const matches = [];

    for (const absolutePath of candidates) {
      const globPath =
        location.scope === "HOST" && targetStat.isDirectory()
          ? path.relative(location.resolved, absolutePath).split(path.sep).join("/")
          : path.relative(location.root, absolutePath).split(path.sep).join("/");

      if (!path.matchesGlob(globPath || path.basename(absolutePath), glob)) {
        continue;
      }

      let content;
      try {
        content = await readFile(absolutePath, "utf8");
      } catch {
        continue;
      }

      const resultPath =
        location.scope === "HOST"
          ? absolutePath
          : path.relative(location.root, absolutePath).split(path.sep).join("/");

      const lines = content.split("\n");
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        let fromIndex = 0;
        while (fromIndex <= lines[lineIndex].length) {
          const columnIndex = lines[lineIndex].indexOf(query, fromIndex);
          if (columnIndex === -1) {
            break;
          }

          matches.push({
            path: resultPath,
            line: lineIndex + 1,
            column: columnIndex + 1,
            text: lines[lineIndex],
          });

          if (matches.length >= maxResults) {
            const result = {
              task_id: taskId,
              query,
              path: presentedPath(location),
              access: auditAccess(location.scope, "READ"),
              glob,
              matches,
              truncated: true,
            };
            this.#audit?.append(taskId, {
              event: "FILE_SEARCH",
              access: result.access,
              path: result.path,
              query,
              glob,
              match_count: matches.length,
              truncated: true,
            });
            return result;
          }

          fromIndex = columnIndex + Math.max(query.length, 1);
        }
      }
    }

    const result = {
      task_id: taskId,
      query,
      path: presentedPath(location),
      access: auditAccess(location.scope, "READ"),
      glob,
      matches,
      truncated: false,
    };
    this.#audit?.append(taskId, {
      event: "FILE_SEARCH",
      access: result.access,
      path: result.path,
      query,
      glob,
      match_count: matches.length,
      truncated: false,
    });
    return result;
  }
}
