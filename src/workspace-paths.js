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

function lexicalWorkspacePath(taskService, taskId, inputPath) {
  const task = taskService.get(taskId);
  const root = path.resolve(task.worktree_path);
  const resolved = path.resolve(root, inputPath || ".");
  ensureInside(root, resolved);
  return { task, root, resolved, scope: "WORKSPACE" };
}

async function existingHostPath(taskService, taskId, inputPath) {
  const task = taskService.get(taskId);
  const root = await realpath(task.worktree_path);
  const resolved = await realpath(path.resolve(inputPath));
  return { task, root, resolved, scope: "HOST" };
}

export async function resolveExistingTaskPath(
  taskService,
  taskId,
  inputPath,
) {
  if (path.isAbsolute(inputPath)) {
    return existingHostPath(taskService, taskId, inputPath);
  }

  const lexical = lexicalWorkspacePath(taskService, taskId, inputPath);
  const root = await realpath(lexical.root);
  const resolved = await realpath(lexical.resolved);
  ensureInside(root, resolved);
  return { task: lexical.task, root, resolved, scope: "WORKSPACE" };
}

async function writableWorkspacePath(taskService, taskId, inputPath) {
  const lexical = lexicalWorkspacePath(taskService, taskId, inputPath);
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

  return { task: lexical.task, root, resolved, scope: "WORKSPACE" };
}

async function writableHostPath(taskService, taskId, inputPath) {
  const task = taskService.get(taskId);
  const root = await realpath(task.worktree_path);
  const absolute = path.resolve(inputPath);
  await mkdir(path.dirname(absolute), { recursive: true });

  const parent = await realpath(path.dirname(absolute));
  let resolved = path.join(parent, path.basename(absolute));

  try {
    resolved = await realpath(resolved);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  return { task, root, resolved, scope: "HOST" };
}

export async function resolveWritableTaskPath(
  taskService,
  taskId,
  inputPath,
) {
  if (path.isAbsolute(inputPath)) {
    return writableHostPath(taskService, taskId, inputPath);
  }
  return writableWorkspacePath(taskService, taskId, inputPath);
}

export function taskRelativePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

export function presentedPath({ root, resolved, scope }) {
  return scope === "HOST" ? resolved : taskRelativePath(root, resolved);
}

export function auditAccess(scope, operation) {
  return scope + "_" + operation;
}
