import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createAgentDockRuntime } from "../src/server.js";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "AgentDock Test",
      GIT_AUTHOR_EMAIL: "agentdock@example.invalid",
      GIT_COMMITTER_NAME: "AgentDock Test",
      GIT_COMMITTER_EMAIL: "agentdock@example.invalid",
    },
  });
}

async function writeSkill(repo, name, description, extraFiles = {}) {
  const dir = path.join(repo, "skills", "engineering", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    [
      "---",
      "name: " + name,
      "description: \"" + description.replaceAll("\"", "\\\"") + "\"",
      "disable-model-invocation: true",
      "---",
      "",
      "# " + name,
      "",
      "Instructions for " + name + ".",
      "",
    ].join("\n"),
  );
  for (const [relative, content] of Object.entries(extraFiles)) {
    const target = path.join(dir, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function createFixtureSkillRepo(root) {
  const repo = path.join(root, "skills-source");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);

  await writeSkill(repo, "ask-matt", "Router over the engineering workflow.", {
    "PHASE-BOUNDARIES.md": "# Phase boundaries\nContinue, clear, handoff, compact.\n",
  });
  await writeSkill(
    repo,
    "setup-matt-pocock-skills",
    "Configure issue tracker and domain-document conventions.",
  );
  await writeSkill(repo, "grill-with-docs", "Interview and persist decisions.");
  await writeSkill(repo, "wayfinder", "Map a huge multi-session foggy effort.");
  await writeSkill(repo, "prototype", "Build a throwaway runnable answer.");
  await writeSkill(repo, "to-spec", "Synthesize settled decisions into a spec.");
  await writeSkill(repo, "to-tickets", "Split a spec into tracer-bullet tickets.");
  await writeSkill(repo, "implement", "Build one vertical slice with TDD.");
  await writeSkill(repo, "code-review", "Review Standards and Spec axes.");
  await writeSkill(repo, "triage", "Classify and label incoming work.");

  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-m", "fixture skills"]);
  return repo;
}

async function configureMattProject(project) {
  const agentDocs = path.join(project, "docs", "agents");
  await mkdir(agentDocs, { recursive: true });
  await writeFile(path.join(agentDocs, "issue-tracker.md"), "# Issue tracker\n");
  await writeFile(path.join(agentDocs, "domain.md"), "# Domain docs\n");
  await writeFile(path.join(agentDocs, "triage-labels.md"), "# Triage labels\n");
  await writeFile(
    path.join(project, "AGENTS.md"),
    "# Agent instructions\n\n## Agent skills\n\nConfigured for tests.\n",
  );
}

test("v0.3-01: skill resource layer installs, searches and reads Git-backed skills without executing them", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v03-skills-"));
  const stateDir = path.join(tempRoot, "state");
  const skillRepo = await createFixtureSkillRepo(tempRoot);
  const runtime = createAgentDockRuntime({ stateDir });

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const installed = await runtime.skillService.install({
    sourceId: "mattpocock",
    repoUrl: "file://" + skillRepo,
    ref: "main",
  });

  assert.equal(installed.source_id, "mattpocock");
  assert.equal(installed.skill_count, 10);
  assert.match(installed.commit, /^[0-9a-f]{40}$/);

  const listed = await runtime.skillService.list();
  assert.equal(listed.skill_count, 10);
  assert.equal(
    listed.skills.some((skill) => skill.name === "ask-matt"),
    true,
  );
  assert.equal(
    listed.skills.every((skill) => skill.category === "skills"),
    false,
  );
  const askMatt = listed.skills.find((skill) => skill.name === "ask-matt");
  assert.equal(askMatt.source_commit, installed.commit);
  assert.equal(askMatt.source_ref, "main");

  const searched = await runtime.skillService.search({
    query: "router",
    limit: 3,
  });
  assert.equal(searched.results[0].name, "ask-matt");

  const main = await runtime.skillService.read({
    skillName: "ask-matt",
    sourceId: "mattpocock",
  });
  assert.equal(main.resource_path, "SKILL.md");
  assert.match(main.content, /Router over the engineering workflow/);
  assert.equal(main.available_files.includes("PHASE-BOUNDARIES.md"), true);

  const supporting = await runtime.skillService.read({
    skillName: "ask-matt",
    sourceId: "mattpocock",
    resourcePath: "PHASE-BOUNDARIES.md",
  });
  assert.match(supporting.content, /Phase boundaries/);

  await assert.rejects(
    runtime.skillService.read({
      skillName: "ask-matt",
      sourceId: "mattpocock",
      resourcePath: "../wayfinder/SKILL.md",
    }),
    (error) => error?.code === "SKILL_RESOURCE_OUTSIDE_ROOT",
  );

  const updated = await runtime.skillService.update({
    sourceId: "mattpocock",
  });
  assert.equal(updated.changed, false);
  assert.equal(updated.commit, installed.commit);
});

test("v0.3-02: guided workflow follows Matt-style single-session, multi-session and prototype boundaries durably", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v03-flow-"));
  const stateDir = path.join(tempRoot, "state");
  const skillRepo = await createFixtureSkillRepo(tempRoot);
  const project = path.join(tempRoot, "project");
  await mkdir(project);

  const runtime = createAgentDockRuntime({ stateDir });
  await runtime.skillService.install({
    sourceId: "mattpocock",
    repoUrl: "file://" + skillRepo,
    ref: "main",
  });

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  let guided = await runtime.workflowService.start({
    repoPath: project,
    goal: "Build a guided development capability.",
    sessionSpan: "multi",
    routeClarity: "foggy",
  });
  assert.equal(guided.workflow.phase, "SETUP");
  assert.equal(guided.recommendation.skill, "setup-matt-pocock-skills");
  assert.equal(guided.recommendation.skill_available, true);

  assert.equal(
    guided.setup_status.missing.includes("docs/agents/triage-labels.md"),
    true,
  );
  assert.equal(
    guided.setup_status.missing.includes("AGENTS.md or CLAUDE.md"),
    true,
  );

  await configureMattProject(project);

  guided = await runtime.workflowService.advance({
    repoPath: project,
    event: "setup_complete",
  });
  assert.equal(guided.workflow.phase, "WAYFINDING");
  assert.equal(guided.recommendation.skill, "wayfinder");

  guided = await runtime.workflowService.advance({
    repoPath: project,
    event: "map_clear",
  });
  assert.equal(guided.workflow.phase, "SPEC");
  assert.equal(guided.recommendation.skill, "to-spec");

  guided = await runtime.workflowService.advance({
    repoPath: project,
    event: "spec_complete",
  });
  assert.equal(guided.workflow.phase, "TICKETS");

  guided = await runtime.workflowService.advance({
    repoPath: project,
    event: "tickets_complete",
  });
  assert.equal(guided.workflow.phase, "IMPLEMENT");
  assert.equal(guided.recommendation.skill, "implement");
  assert.match(
    guided.recommendation.handoff_instruction,
    /use \/code-review.*implementation_complete/i,
  );

  guided = await runtime.workflowService.advance({
    repoPath: project,
    event: "implementation_complete",
  });
  assert.equal(guided.workflow.phase, "REVIEW");

  guided = await runtime.workflowService.advance({
    repoPath: project,
    event: "review_passed",
  });
  assert.equal(guided.workflow.phase, "DONE");
  assert.equal(guided.recommendation.skill, null);

  const activeAfterDone = await runtime.workflowService.list();
  assert.equal(activeAfterDone.workflow_count, 0);
  const includingDone = await runtime.workflowService.list({ includeDone: true });
  assert.equal(includingDone.workflow_count, 1);
  assert.equal(includingDone.workflows[0].phase, "DONE");

  await assert.rejects(
    runtime.workflowService.start({
      repoPath: project,
      goal: "Accidental replacement.",
      sessionSpan: "single",
      routeClarity: "clear",
    }),
    (error) => error?.code === "WORKFLOW_EXISTS",
  );

  guided = await runtime.workflowService.start({
    repoPath: project,
    goal: "A small change.",
    sessionSpan: "single",
    routeClarity: "clear",
    replace: true,
  });
  assert.equal(guided.workflow.phase, "GRILLING");
  assert.equal(guided.recommendation.skill, "grill-with-docs");

  guided = await runtime.workflowService.advance({
    repoPath: project,
    event: "prototype_needed",
  });
  assert.equal(guided.workflow.phase, "PROTOTYPE");
  assert.equal(guided.recommendation.skill, "prototype");

  guided = await runtime.workflowService.advance({
    repoPath: project,
    event: "prototype_complete",
  });
  assert.equal(guided.workflow.phase, "GRILLING");

  guided = await runtime.workflowService.advance({
    repoPath: project,
    event: "grilling_complete",
  });
  assert.equal(guided.workflow.phase, "IMPLEMENT");

  const restartedRuntime = createAgentDockRuntime({ stateDir });
  const afterRestart = await restartedRuntime.workflowService.guide({
    repoPath: project,
  });
  assert.equal(afterRestart.workflow.phase, "IMPLEMENT");
  assert.equal(afterRestart.recommendation.skill, "implement");

  await assert.rejects(
    restartedRuntime.workflowService.advance({
      repoPath: project,
      event: "map_clear",
    }),
    (error) => error?.code === "INVALID_WORKFLOW_TRANSITION",
  );
});

test("v0.3-03: missing skills are reported as a routing prerequisite instead of silently executing another flow", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v03-missing-"));
  const stateDir = path.join(tempRoot, "state");
  const project = path.join(tempRoot, "project");
  await mkdir(project);
  await configureMattProject(project);
  const runtime = createAgentDockRuntime({ stateDir });

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const guided = await runtime.workflowService.start({
    repoPath: project,
    goal: "Unknown project.",
    sessionSpan: "single",
    routeClarity: "unknown",
  });

  assert.equal(guided.workflow.phase, "GRILLING");
  assert.equal(guided.recommendation.skill, "grill-with-docs");
  assert.equal(guided.recommendation.skill_available, false);
  assert.match(guided.recommendation.user_prompt, /Install a skill source/);
});

test("v0.3-04: guided workflow fails closed instead of guessing or skipping phase boundaries", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentdock-v03-guardrails-"));
  const stateDir = path.join(tempRoot, "state");
  const skillRepo = await createFixtureSkillRepo(tempRoot);
  const project = path.join(tempRoot, "project");
  await mkdir(project);
  await configureMattProject(project);

  const runtime = createAgentDockRuntime({ stateDir });
  await runtime.skillService.install({
    sourceId: "mattpocock",
    repoUrl: "file://" + skillRepo,
    ref: "main",
  });

  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  await assert.rejects(
    runtime.workflowService.start({
      repoPath: project,
      goal: "Already-decided work with unknown size.",
      sessionSpan: "unknown",
      routeClarity: "clear",
      decisionsSettled: true,
    }),
    (error) => error?.code === "WORKFLOW_SESSION_SPAN_REQUIRED",
  );

  let guided = await runtime.workflowService.start({
    repoPath: project,
    goal: "Small known change.",
    sessionSpan: "single",
    routeClarity: "clear",
  });
  guided = await runtime.workflowService.update({
    repoPath: project,
    openDecisions: ["Which public API should own the behavior?"],
    artifacts: { context: "CONTEXT.md" },
    note: "Grilling found one unresolved product decision.",
  });
  assert.deepEqual(guided.workflow.open_decisions, [
    "Which public API should own the behavior?",
  ]);
  assert.equal(guided.workflow.artifacts.context, "CONTEXT.md");

  const restartedWithDecision = createAgentDockRuntime({ stateDir });
  const recoveredDecision = await restartedWithDecision.workflowService.guide({
    repoPath: project,
  });
  assert.equal(recoveredDecision.workflow.open_decisions.length, 1);

  await assert.rejects(
    runtime.workflowService.advance({
      repoPath: project,
      event: "grilling_complete",
    }),
    (error) => error?.code === "WORKFLOW_OPEN_DECISIONS",
  );

  guided = await runtime.workflowService.update({
    repoPath: project,
    openDecisions: [],
    note: "The product decision is resolved.",
  });
  guided = await runtime.workflowService.advance({
    repoPath: project,
    event: "grilling_complete",
  });
  assert.equal(guided.workflow.phase, "IMPLEMENT");

  await assert.rejects(
    runtime.workflowService.advance({
      repoPath: project,
      event: "prototype_needed",
    }),
    (error) => error?.code === "INVALID_WORKFLOW_TRANSITION",
  );

  guided = await runtime.workflowService.advance({
    repoPath: project,
    event: "implementation_complete",
  });
  guided = await runtime.workflowService.advance({
    repoPath: project,
    event: "review_passed",
  });
  assert.equal(guided.workflow.phase, "DONE");

  await assert.rejects(
    runtime.workflowService.advance({
      repoPath: project,
      event: "blocked",
    }),
    (error) => error?.code === "INVALID_WORKFLOW_TRANSITION",
  );
});
