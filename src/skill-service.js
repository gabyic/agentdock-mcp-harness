import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AgentDockError } from "./errors.js";

const execFileAsync = promisify(execFile);
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_SKILL_BYTES = 512 * 1024;
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
const SKILL_INVOCATION_MODES = new Set(["user", "model"]);

function safeSourceId(value) {
  const sourceId = String(value ?? "").trim().toLowerCase();
  if (!SOURCE_ID_PATTERN.test(sourceId)) {
    throw new AgentDockError(
      "INVALID_SKILL_SOURCE_ID",
      "Skill source_id must match " + SOURCE_ID_PATTERN.source + ".",
    );
  }
  return sourceId;
}

function validateRepoUrl(value) {
  const repoUrl = String(value ?? "").trim();
  if (
    repoUrl.startsWith("https://") ||
    repoUrl.startsWith("file://") ||
    path.isAbsolute(repoUrl)
  ) {
    return repoUrl;
  }
  throw new AgentDockError(
    "INVALID_SKILL_REPO_URL",
    "Skill repo_url must be an https:// URL, file:// URL, or absolute local path.",
  );
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function parseSkillDocument(content) {
  const normalized = String(content ?? "").replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) {
    return { metadata: {}, body: normalized };
  }

  const closing = normalized.indexOf("\n---\n", 4);
  if (closing === -1) {
    return { metadata: {}, body: normalized };
  }

  const metadata = {};
  for (const line of normalized.slice(4, closing).split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    metadata[match[1]] = parseScalar(match[2]);
  }

  return {
    metadata,
    body: normalized.slice(closing + 5),
  };
}

async function walkFiles(root, relative = "") {
  const absolute = path.join(root, relative);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const childRelative = relative
      ? path.join(relative, entry.name)
      : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, childRelative)));
    } else if (entry.isFile()) {
      files.push(childRelative.split(path.sep).join("/"));
    }
  }

  return files.sort();
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function atomicJsonWrite(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temp =
    filePath +
    ".tmp-" +
    process.pid +
    "-" +
    Date.now() +
    "-" +
    Math.random().toString(16).slice(2);
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temp, filePath);
}

function scoreSkill(skill, query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 0;
  const tokens = normalized.split(/[^a-z0-9_-]+/).filter(Boolean);
  const name = skill.name.toLowerCase();
  const description = String(skill.description ?? "").toLowerCase();
  const category = skill.category.toLowerCase();
  let score = 0;

  if (name === normalized) score += 100;
  if (name.includes(normalized)) score += 50;
  if (description.includes(normalized)) score += 30;
  if (category.includes(normalized)) score += 10;

  for (const token of tokens) {
    if (name === token) score += 30;
    else if (name.includes(token)) score += 15;
    if (description.includes(token)) score += 8;
    if (category.includes(token)) score += 3;
  }

  return score;
}

export class SkillService {
  #skillsDir;
  #sourcesDir;
  #metadataDir;

  constructor({ stateStore }) {
    this.#skillsDir = path.join(stateStore.stateDir, "skills");
    this.#sourcesDir = path.join(this.#skillsDir, "sources");
    this.#metadataDir = path.join(this.#skillsDir, "metadata");
  }

  async #ensureDirs() {
    await mkdir(this.#sourcesDir, { recursive: true, mode: 0o700 });
    await mkdir(this.#metadataDir, { recursive: true, mode: 0o700 });
  }

  #sourcePath(sourceId) {
    return path.join(this.#sourcesDir, safeSourceId(sourceId));
  }

  #metadataPath(sourceId) {
    return path.join(this.#metadataDir, safeSourceId(sourceId) + ".json");
  }

  async #git(cwd, args) {
    try {
      const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      return stdout.trim();
    } catch (error) {
      const detail =
        typeof error?.stderr === "string" && error.stderr.trim()
          ? error.stderr.trim()
          : error?.message ?? String(error);
      throw new AgentDockError(
        "SKILL_GIT_FAILED",
        "Git operation for skill source failed.",
        { detail },
      );
    }
  }

  async #clone({ repoUrl, ref, destination }) {
    const args = ["clone", "--depth", "1"];
    if (ref) {
      args.push("--branch", ref);
    }
    args.push("--", repoUrl, destination);

    try {
      await execFileAsync("git", args, {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
        },
      });
    } catch (error) {
      const detail =
        typeof error?.stderr === "string" && error.stderr.trim()
          ? error.stderr.trim()
          : error?.message ?? String(error);
      throw new AgentDockError(
        "SKILL_INSTALL_FAILED",
        "Unable to clone skill source.",
        { detail },
      );
    }
  }

  async #scanSource(sourceId) {
    const sourcePath = this.#sourcePath(sourceId);
    if (!(await exists(sourcePath))) {
      throw new AgentDockError(
        "SKILL_SOURCE_NOT_FOUND",
        "Skill source is not installed.",
        { source_id: sourceId },
      );
    }

    const allFiles = await walkFiles(sourcePath);
    const skillFiles = allFiles.filter((entry) => entry.endsWith("/SKILL.md") || entry === "SKILL.md");
    const skills = [];

    for (const relativeSkillFile of skillFiles) {
      const absoluteSkillFile = path.join(sourcePath, relativeSkillFile);
      const info = await stat(absoluteSkillFile);
      if (info.size > MAX_SKILL_BYTES) continue;
      const content = await readFile(absoluteSkillFile, "utf8");
      const parsed = parseSkillDocument(content);
      const relativeDir = path.posix.dirname(relativeSkillFile);
      const segments = relativeDir === "." ? [] : relativeDir.split("/");
      const fallbackName = segments.at(-1) ?? sourceId;
      const name = String(parsed.metadata.name ?? fallbackName).trim();
      if (!name) continue;

      skills.push({
        source_id: sourceId,
        name,
        description: String(parsed.metadata.description ?? "").trim(),
        disable_model_invocation:
          parsed.metadata["disable-model-invocation"] === true,
        category: segments.length > 1 ? segments.at(-2) : "root",
        relative_dir: relativeDir,
        skill_file: relativeSkillFile,
      });
    }

    return skills.sort((a, b) =>
      a.name.localeCompare(b.name) || a.relative_dir.localeCompare(b.relative_dir),
    );
  }

  async list({ sourceId } = {}) {
    await this.#ensureDirs();
    const sourceIds = sourceId
      ? [safeSourceId(sourceId)]
      : (await readdir(this.#sourcesDir, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();

    const skills = [];
    for (const id of sourceIds) {
      const metadata = await this.#readMetadata(id);
      const scanned = await this.#scanSource(id);
      skills.push(
        ...scanned.map((skill) => ({
          ...skill,
          source_ref: metadata?.ref ?? null,
          source_commit: metadata?.commit ?? null,
        })),
      );
    }
    return {
      skill_count: skills.length,
      skills,
    };
  }

  async search({ query, sourceId, limit = 10 }) {
    const listed = await this.list({ sourceId });
    const results = listed.skills
      .map((skill) => ({ ...skill, score: scoreSkill(skill, query) }))
      .filter((skill) => skill.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);

    return {
      query,
      result_count: results.length,
      results,
    };
  }

  async #findSkill({ skillName, sourceId }) {
    const normalizedName = String(skillName ?? "").trim();
    if (!normalizedName) {
      throw new AgentDockError(
        "INVALID_SKILL_NAME",
        "skill_name is required.",
      );
    }

    const listed = await this.list({ sourceId });
    const matches = listed.skills.filter((skill) => skill.name === normalizedName);
    if (matches.length === 0) {
      throw new AgentDockError(
        "SKILL_NOT_FOUND",
        "Skill is not installed.",
        { skill_name: normalizedName, source_id: sourceId },
      );
    }
    if (matches.length > 1) {
      throw new AgentDockError(
        "SKILL_AMBIGUOUS",
        "Multiple installed sources provide this skill; specify source_id.",
        {
          skill_name: normalizedName,
          sources: [...new Set(matches.map((match) => match.source_id))],
        },
      );
    }
    return matches[0];
  }

  async has({ skillName, sourceId }) {
    try {
      await this.#findSkill({ skillName, sourceId });
      return true;
    } catch (error) {
      if (error instanceof AgentDockError && error.code === "SKILL_NOT_FOUND") {
        return false;
      }
      throw error;
    }
  }

  async read({ skillName, sourceId, resourcePath }) {
    const skill = await this.#findSkill({ skillName, sourceId });
    const sourceRoot = await realpath(this.#sourcePath(skill.source_id));
    const skillRoot = await realpath(path.join(sourceRoot, skill.relative_dir));
    const requested = resourcePath
      ? String(resourcePath)
      : "SKILL.md";
    const candidate = path.resolve(skillRoot, requested);

    if (candidate !== skillRoot && !candidate.startsWith(skillRoot + path.sep)) {
      throw new AgentDockError(
        "SKILL_RESOURCE_OUTSIDE_ROOT",
        "resource_path escapes the skill directory.",
      );
    }

    let resolved;
    try {
      resolved = await realpath(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new AgentDockError(
          "SKILL_RESOURCE_NOT_FOUND",
          "Skill resource does not exist.",
          { skill_name: skill.name, resource_path: requested },
        );
      }
      throw error;
    }

    if (resolved !== skillRoot && !resolved.startsWith(skillRoot + path.sep)) {
      throw new AgentDockError(
        "SKILL_RESOURCE_OUTSIDE_ROOT",
        "Resolved skill resource escapes the skill directory.",
      );
    }

    const info = await stat(resolved);
    if (!info.isFile()) {
      throw new AgentDockError(
        "SKILL_RESOURCE_NOT_FILE",
        "Skill resource must be a regular file.",
      );
    }
    if (info.size > MAX_RESOURCE_BYTES) {
      throw new AgentDockError(
        "SKILL_RESOURCE_TOO_LARGE",
        "Skill resource exceeds the 2 MiB read limit.",
        { size_bytes: info.size },
      );
    }

    const content = await readFile(resolved, "utf8");
    const availableFiles = await walkFiles(skillRoot);
    return {
      ...skill,
      resource_path: path.relative(skillRoot, resolved).split(path.sep).join("/"),
      content,
      available_files: availableFiles,
    };
  }

  async invoke({
    skillName,
    sourceId,
    invocationMode = "model",
    request,
  }) {
    const mode = String(invocationMode ?? "model").trim().toLowerCase();
    if (!SKILL_INVOCATION_MODES.has(mode)) {
      throw new AgentDockError(
        "INVALID_SKILL_INVOCATION_MODE",
        "invocation_mode must be one of: user, model.",
        { invocation_mode: invocationMode },
      );
    }

    const userRequest = String(request ?? "").trim();
    if (!userRequest) {
      throw new AgentDockError(
        "INVALID_SKILL_INVOCATION_REQUEST",
        "request is required when invoking a skill.",
      );
    }

    const skill = await this.#findSkill({ skillName, sourceId });
    if (skill.disable_model_invocation && mode !== "user") {
      throw new AgentDockError(
        "SKILL_USER_INVOCATION_REQUIRED",
        "This skill is user-invoked and may run only when the human explicitly selected or named it.",
        {
          skill_name: skill.name,
          source_id: skill.source_id,
          disable_model_invocation: true,
        },
      );
    }

    const resource = await this.read({
      skillName: skill.name,
      sourceId: skill.source_id,
    });

    return {
      invocation_version: 1,
      invocation_mode: mode,
      skill: {
        source_id: resource.source_id,
        source_ref: resource.source_ref,
        source_commit: resource.source_commit,
        name: resource.name,
        description: resource.description,
        category: resource.category,
        disable_model_invocation: resource.disable_model_invocation,
      },
      user_request: userRequest,
      resource_path: resource.resource_path,
      instructions: resource.content,
      available_files: resource.available_files,
      execution_contract: {
        reasoning_agent: "chat_model",
        execution_harness: "AgentDock",
        server_side_llm: false,
        executes_skill_server_side: false,
        skill_repository_trust: "user_supplied_instructions",
      },
    };
  }

  async install({ sourceId, repoUrl, ref, replace = false }) {
    await this.#ensureDirs();
    const id = safeSourceId(sourceId);
    const url = validateRepoUrl(repoUrl);
    const target = this.#sourcePath(id);
    if ((await exists(target)) && !replace) {
      throw new AgentDockError(
        "SKILL_SOURCE_EXISTS",
        "Skill source is already installed; use skill.update or replace=true.",
        { source_id: id },
      );
    }

    const staging =
      target +
      ".staging-" +
      process.pid +
      "-" +
      Date.now() +
      "-" +
      createHash("sha256").update(url + Math.random()).digest("hex").slice(0, 8);
    const backup = target + ".backup-" + process.pid + "-" + Date.now();

    try {
      await this.#clone({ repoUrl: url, ref, destination: staging });
      const commit = await this.#git(staging, ["rev-parse", "HEAD"]);
      const scanned = await this.#scanPathForInstall(staging, id);
      if (scanned.length === 0) {
        throw new AgentDockError(
          "SKILL_SOURCE_EMPTY",
          "Installed repository contains no SKILL.md files.",
          { source_id: id },
        );
      }

      const now = new Date().toISOString();
      const previous = await this.#readMetadata(id);
      const metadata = {
        source_id: id,
        repo_url: url,
        ref,
        commit,
        installed_at: previous?.installed_at ?? now,
        updated_at: now,
      };

      const hadTarget = await exists(target);
      if (hadTarget) {
        await rename(target, backup);
      }

      let targetSwapped = false;
      try {
        await rename(staging, target);
        targetSwapped = true;

        // The source tree and its provenance metadata form one managed unit.
        // Do not discard the previous source until the new metadata is durable.
        await atomicJsonWrite(this.#metadataPath(id), metadata);

        if (await exists(backup)) {
          await rm(backup, { recursive: true, force: true });
        }
      } catch (error) {
        // Best-effort rollback keeps the last known-good source usable if
        // metadata persistence or the directory swap fails.
        if (targetSwapped && (await exists(target))) {
          await rm(target, { recursive: true, force: true }).catch(() => {});
        }
        if (hadTarget && (await exists(backup))) {
          await rename(backup, target).catch(() => {});
        }
        throw error;
      }

      return {
        ...metadata,
        skill_count: scanned.length,
        skills: scanned.map((skill) => skill.name),
      };
    } finally {
      if (await exists(staging)) {
        await rm(staging, { recursive: true, force: true });
      }
    }
  }

  async #scanPathForInstall(root, sourceId) {
    const allFiles = await walkFiles(root);
    const skills = [];
    for (const relativeSkillFile of allFiles.filter(
      (entry) => entry.endsWith("/SKILL.md") || entry === "SKILL.md",
    )) {
      const skillPath = path.join(root, relativeSkillFile);
      const info = await stat(skillPath);
      if (info.size > MAX_SKILL_BYTES) continue;
      const content = await readFile(skillPath, "utf8");
      const parsed = parseSkillDocument(content);
      const relativeDir = path.posix.dirname(relativeSkillFile);
      const segments = relativeDir === "." ? [] : relativeDir.split("/");
      const name = String(
        parsed.metadata.name ?? segments.at(-1) ?? sourceId,
      ).trim();
      if (!name) continue;
      skills.push({
        source_id: sourceId,
        name,
        relative_dir: relativeDir,
      });
    }
    return skills;
  }

  async #readMetadata(sourceId) {
    try {
      return JSON.parse(await readFile(this.#metadataPath(sourceId), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async update({ sourceId }) {
    const id = safeSourceId(sourceId);
    const metadata = await this.#readMetadata(id);
    if (!metadata) {
      throw new AgentDockError(
        "SKILL_SOURCE_NOT_FOUND",
        "Skill source metadata is missing.",
        { source_id: id },
      );
    }
    const before = metadata.commit;
    const result = await this.install({
      sourceId: id,
      repoUrl: metadata.repo_url,
      ref: metadata.ref,
      replace: true,
    });
    return {
      ...result,
      previous_commit: before,
      changed: before !== result.commit,
    };
  }
}
