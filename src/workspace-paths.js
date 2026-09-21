import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { AgentDockError } from "./errors.js";

function ensureInside(root, candidate) {
  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw new AgentDockError(
      "PATH_OUTSIDE_WORKTREE",
      "Resolved path escapes Task worktree.",
    );
  }
}

function lexicalTaskPath(taskService, taskId, inputPath) {
  const task = taskService.get(taskId);

  if (path.isAbsolute(inputPath)) {
    throw new AgentDockError(
      "HOST_PATH_NOT_IMPLEMENTED",
      "Ticket 02 only resolves paths inside the Task worktree.",
    );
  }

  const root = path.resolve(task.worktree_path);
  const resolved = path.resolve(root, inputPath || ".");
  ensureInside(root, resolved);
  return { task, root, resolved };
}

export async function resolveExistingTaskPath(
  taskService,
  taskId,
  inputPath,
) {
  const lexical = lexicalTaskPath(taskService, taskId, inputPath);
  const root = await realpath(lexical.root);
  const resolved = await realpath(lexical.resolved);
  ensureInside(root, resolved);
  return { task: lexical.task, root, resolved };
}

export async function resolveWritableTaskPath(
  taskService,
  taskId,
  inputPath,
) {
  const lexical = lexicalTaskPath(taskService, taskId, inputPath);
  const root = await realpath(lexical.root);
  const relativeParent = path.relative(
    lexical.root,
    path.dirname(lexical.resolved),
  );
  const segments = relativeParent
    .split(path.sep)
    .filter((segment) => segment && segment !== ".");

  let safeParent = root;
  for (const segment of segments) {
    let next = path.join(safeParent, segment);

    try {
      const info = await lstat(next);
      if (info.isSymbolicLink()) {
        next = await realpath(next);
        ensureInside(root, next);
      } else if (!info.isDirectory()) {
        throw new AgentDockError(
          "INVALID_PARENT",
          "A parent path component is not a directory.",
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await mkdir(next);
      next = await realpath(next);
      ensureInside(root, next);
    }

    safeParent = next;
  }

  let resolved = path.join(safeParent, path.basename(lexical.resolved));
  try {
    const existing = await realpath(resolved);
    ensureInside(root, existing);
    resolved = existing;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  return { task: lexical.task, root, resolved };
}

export function taskRelativePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}
