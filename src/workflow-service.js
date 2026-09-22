import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { AgentDockError } from "./errors.js";

const PHASES = new Set([
  "SETUP",
  "GRILLING",
  "WAYFINDING",
  "PROTOTYPE",
  "SPEC",
  "TICKETS",
  "IMPLEMENT",
  "REVIEW",
  "BLOCKED",
  "DONE",
]);

const PHASE_SKILL = {
  SETUP: "setup-matt-pocock-skills",
  GRILLING: "grill-with-docs",
  WAYFINDING: "wayfinder",
  PROTOTYPE: "prototype",
  SPEC: "to-spec",
  TICKETS: "to-tickets",
  IMPLEMENT: "implement",
  REVIEW: "code-review",
  BLOCKED: "ask-matt",
  DONE: null,
};

const HUMAN_BOUNDARY = {
  SETUP:
    "Confirm the repository's issue tracker and agent-document layout before the first engineering flow.",
  GRILLING:
    "Answer product/domain decisions; do not start implementation until shared understanding is confirmed.",
  WAYFINDING:
    "Resolve the decision map; wayfinder produces decisions, not destination code.",
  PROTOTYPE:
    "React to the runnable answer, then carry the learned decision back to planning.",
  SPEC:
    "Review testing seams and out-of-scope boundaries before implementation planning proceeds.",
  TICKETS:
    "Review tracer-bullet slices and blocking edges; each implementation should start from one self-contained ticket.",
  IMPLEMENT:
    "Do not invent unresolved product decisions. Build the current vertical slice and verify it.",
  REVIEW:
    "Resolve Standards and Spec review findings before declaring the work done.",
  BLOCKED:
    "A human or upstream decision is required before the workflow can advance.",
  DONE: "No action required; start a new workflow for the next change.",
};

const PHASE_HANDOFF = {
  SETUP:
    "After the setup skill has written and the user has approved all required repo configuration, call workflow.advance with setup_complete.",
  GRILLING:
    "Persist unresolved questions with workflow.update. If a runnable prototype is required, call prototype_needed. Only when shared understanding is explicit and open_decisions is empty, call grilling_complete.",
  WAYFINDING:
    "Persist the decision map with workflow.update. When the map is clear and open_decisions is empty, call map_clear before reading to-spec.",
  PROTOTYPE:
    "Use the prototype only to answer the decision question. When that answer is captured, call prototype_complete and return to the prior planning phase.",
  SPEC:
    "When the specification is approved and open_decisions is empty, call spec_complete before moving to tickets or implementation.",
  TICKETS:
    "After the user approves the tracer-bullet breakdown and tickets are published, call tickets_complete.",
  IMPLEMENT:
    "Follow implement and its TDD delegation. When upstream implement reaches its 'use /code-review' handoff, call implementation_complete instead of recursively running code-review; the workflow will enter REVIEW and recommend code-review exactly once.",
  REVIEW:
    "Follow code-review as two separate Standards and Spec axes. If the host cannot spawn parallel sub-agents, perform two explicit passes and report that context isolation was unavailable; never merge or rerank the axes. Use review_passed only when blocking findings are resolved, otherwise review_changes_requested.",
  BLOCKED:
    "Record the blocking decision in workflow.update or the conversation. Call resume only after the blocker is actually resolved.",
  DONE: "Start a new workflow only for a new goal.",
};

const EVENTS = new Set([
  "setup_complete",
  "grilling_complete",
  "prototype_needed",
  "prototype_complete",
  "map_clear",
  "spec_complete",
  "tickets_complete",
  "implementation_complete",
  "review_passed",
  "review_changes_requested",
  "blocked",
  "resume",
]);

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

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function validateEnum(value, allowed, code, field) {
  if (!allowed.includes(value)) {
    throw new AgentDockError(
      code,
      field + " must be one of: " + allowed.join(", ") + ".",
    );
  }
  return value;
}

export class WorkflowService {
  #workflowsDir;
  #skillService;

  constructor({ stateStore, skillService }) {
    this.#workflowsDir = path.join(stateStore.stateDir, "workflows");
    this.#skillService = skillService;
  }

  async #identity(repoPath) {
    let resolved;
    try {
      resolved = await realpath(path.resolve(repoPath));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new AgentDockError(
          "WORKFLOW_REPO_NOT_FOUND",
          "Workflow repo_path does not exist.",
          { repo_path: repoPath },
        );
      }
      throw error;
    }
    const id = createHash("sha256").update(resolved).digest("hex");
    return { id, repoPath: resolved };
  }

  async #path(repoPath) {
    const identity = await this.#identity(repoPath);
    return {
      ...identity,
      filePath: path.join(this.#workflowsDir, identity.id + ".json"),
    };
  }

  async #load(repoPath) {
    const identity = await this.#path(repoPath);
    try {
      const workflow = JSON.parse(await readFile(identity.filePath, "utf8"));
      return { identity, workflow };
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new AgentDockError(
          "WORKFLOW_NOT_FOUND",
          "No guided-development workflow exists for this repository.",
          { repo_path: identity.repoPath },
        );
      }
      throw error;
    }
  }

  async #setupStatus(repoPath) {
    const issueTracker = path.join(
      repoPath,
      "docs",
      "agents",
      "issue-tracker.md",
    );
    const domain = path.join(repoPath, "docs", "agents", "domain.md");
    const triageLabels = path.join(
      repoPath,
      "docs",
      "agents",
      "triage-labels.md",
    );
    const claude = path.join(repoPath, "CLAUDE.md");
    const agents = path.join(repoPath, "AGENTS.md");

    const instructionFile = (await exists(claude))
      ? claude
      : (await exists(agents))
        ? agents
        : null;
    let agentSkillsBlock = false;
    if (instructionFile) {
      const content = await readFile(instructionFile, "utf8");
      agentSkillsBlock = /^## Agent skills\s*$/m.test(content);
    }

    const triageRequired = await this.#skillService.has({
      skillName: "triage",
    });
    const status = {
      issue_tracker: await exists(issueTracker),
      domain: await exists(domain),
      agent_instructions_file: instructionFile,
      agent_skills_block: agentSkillsBlock,
      triage_required: triageRequired,
      triage_labels: triageRequired ? await exists(triageLabels) : true,
    };
    const missing = [];
    if (!status.issue_tracker) missing.push("docs/agents/issue-tracker.md");
    if (!status.domain) missing.push("docs/agents/domain.md");
    if (!status.agent_instructions_file) {
      missing.push("AGENTS.md or CLAUDE.md");
    } else if (!status.agent_skills_block) {
      missing.push(
        path.basename(status.agent_instructions_file) + " ## Agent skills",
      );
    }
    if (!status.triage_labels) {
      missing.push("docs/agents/triage-labels.md");
    }

    return {
      ...status,
      configured: missing.length === 0,
      missing,
    };
  }

  async #setupConfigured(repoPath) {
    return (await this.#setupStatus(repoPath)).configured;
  }

  #routeForStart({ sessionSpan, routeClarity, decisionsSettled }) {
    if (decisionsSettled) {
      return sessionSpan === "multi"
        ? { phase: "SPEC", route: "main" }
        : { phase: "IMPLEMENT", route: "main" };
    }

    if (sessionSpan === "multi" && routeClarity === "foggy") {
      return { phase: "WAYFINDING", route: "wayfinder" };
    }

    return { phase: "GRILLING", route: "main" };
  }

  async start({
    repoPath,
    goal,
    sessionSpan = "unknown",
    routeClarity = "unknown",
    decisionsSettled = false,
    replace = false,
  }) {
    validateEnum(
      sessionSpan,
      ["single", "multi", "unknown"],
      "INVALID_WORKFLOW_SESSION_SPAN",
      "session_span",
    );
    validateEnum(
      routeClarity,
      ["clear", "foggy", "unknown"],
      "INVALID_WORKFLOW_ROUTE_CLARITY",
      "route_clarity",
    );
    if (decisionsSettled && sessionSpan === "unknown") {
      throw new AgentDockError(
        "WORKFLOW_SESSION_SPAN_REQUIRED",
        "Settled work must be classified as single-session or multi-session before routing.",
      );
    }

    const identity = await this.#path(repoPath);
    if ((await exists(identity.filePath)) && !replace) {
      throw new AgentDockError(
        "WORKFLOW_EXISTS",
        "A guided-development workflow already exists for this repository; use workflow.guide or set replace=true to start a new goal.",
        { repo_path: identity.repoPath },
      );
    }

    const routed = this.#routeForStart({
      sessionSpan,
      routeClarity,
      decisionsSettled,
    });
    const setupConfigured = await this.#setupConfigured(identity.repoPath);
    const initialPhase = setupConfigured ? routed.phase : "SETUP";
    const now = new Date().toISOString();
    const workflow = {
      workflow_version: 1,
      repo_path: identity.repoPath,
      goal: String(goal ?? "").trim(),
      phase: initialPhase,
      route: routed.route,
      session_span: sessionSpan,
      route_clarity: routeClarity,
      decisions_settled: Boolean(decisionsSettled),
      setup_configured: setupConfigured,
      after_setup_phase: setupConfigured ? null : routed.phase,
      open_decisions: [],
      return_phase: null,
      last_event: "start",
      artifacts: {},
      history: [
        {
          at: now,
          event: "start",
          phase: initialPhase,
          note: null,
        },
      ],
      created_at: now,
      updated_at: now,
    };

    if (!workflow.goal) {
      throw new AgentDockError(
        "INVALID_WORKFLOW_GOAL",
        "Workflow goal is required.",
      );
    }

    await atomicJsonWrite(identity.filePath, workflow);
    return this.guide({ repoPath: identity.repoPath });
  }

  async get({ repoPath }) {
    const { workflow } = await this.#load(repoPath);
    return workflow;
  }

  async list({ includeDone = false } = {}) {
    await mkdir(this.#workflowsDir, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.#workflowsDir, { withFileTypes: true });
    const workflows = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;

      let workflow;
      try {
        workflow = JSON.parse(
          await readFile(path.join(this.#workflowsDir, entry.name), "utf8"),
        );
      } catch (error) {
        throw new AgentDockError(
          "INVALID_WORKFLOW_STATE",
          "A persisted guided-development workflow cannot be read.",
          { file: entry.name, detail: error?.message ?? String(error) },
        );
      }

      if (!PHASES.has(workflow.phase)) {
        throw new AgentDockError(
          "INVALID_WORKFLOW_PHASE",
          "Persisted workflow has an invalid phase.",
          { file: entry.name, phase: workflow.phase },
        );
      }
      if (!includeDone && workflow.phase === "DONE") continue;

      const skill = PHASE_SKILL[workflow.phase] ?? null;
      workflows.push({
        repo_path: workflow.repo_path,
        goal: workflow.goal,
        phase: workflow.phase,
        route: workflow.route,
        session_span: workflow.session_span,
        route_clarity: workflow.route_clarity,
        open_decisions: workflow.open_decisions ?? [],
        recommended_skill: skill,
        skill_available: await this.#skillAvailability(skill),
        updated_at: workflow.updated_at,
      });
    }

    workflows.sort((a, b) =>
      String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")),
    );

    return {
      workflow_count: workflows.length,
      workflows,
    };
  }

  async update({
    repoPath,
    sessionSpan,
    routeClarity,
    openDecisions,
    artifacts,
    note,
  }) {
    const { identity, workflow } = await this.#load(repoPath);
    if (!PHASES.has(workflow.phase)) {
      throw new AgentDockError(
        "INVALID_WORKFLOW_PHASE",
        "Persisted workflow has an invalid phase.",
        { phase: workflow.phase },
      );
    }
    if (workflow.phase === "DONE") {
      throw new AgentDockError(
        "WORKFLOW_COMPLETE",
        "Completed workflows are immutable; start a new workflow for the next goal.",
        { repo_path: workflow.repo_path },
      );
    }

    let changed = false;
    if (sessionSpan !== undefined) {
      workflow.session_span = validateEnum(
        sessionSpan,
        ["single", "multi", "unknown"],
        "INVALID_WORKFLOW_SESSION_SPAN",
        "session_span",
      );
      changed = true;
    }
    if (routeClarity !== undefined) {
      workflow.route_clarity = validateEnum(
        routeClarity,
        ["clear", "foggy", "unknown"],
        "INVALID_WORKFLOW_ROUTE_CLARITY",
        "route_clarity",
      );
      changed = true;
    }
    if (openDecisions !== undefined) {
      workflow.open_decisions = [
        ...new Set(
          openDecisions
            .map((value) => String(value).trim())
            .filter(Boolean),
        ),
      ];
      if (workflow.open_decisions.length > 0) {
        workflow.decisions_settled = false;
      }
      changed = true;
    }
    if (artifacts !== undefined) {
      const nextArtifacts = { ...(workflow.artifacts ?? {}) };
      for (const [key, value] of Object.entries(artifacts)) {
        const cleanKey = String(key).trim();
        const cleanValue = String(value).trim();
        if (!cleanKey || !cleanValue) continue;
        nextArtifacts[cleanKey] = cleanValue;
      }
      workflow.artifacts = nextArtifacts;
      changed = true;
    }

    const cleanNote = note === undefined ? "" : String(note).trim();
    if (!changed && !cleanNote) {
      throw new AgentDockError(
        "WORKFLOW_UPDATE_EMPTY",
        "workflow.update requires at least one state change or note.",
      );
    }

    workflow.last_event = "progress";
    workflow.updated_at = new Date().toISOString();
    workflow.history.push({
      at: workflow.updated_at,
      event: "progress",
      from_phase: workflow.phase,
      phase: workflow.phase,
      note: cleanNote || null,
    });
    if (workflow.history.length > 200) {
      workflow.history = workflow.history.slice(-200);
    }

    await atomicJsonWrite(identity.filePath, workflow);
    return this.guide({ repoPath: identity.repoPath });
  }

  async #skillAvailability(skillName) {
    if (!skillName) return true;
    return this.#skillService.has({ skillName });
  }

  async guide({ repoPath }) {
    const { workflow } = await this.#load(repoPath);
    const skill = PHASE_SKILL[workflow.phase] ?? null;
    const available = await this.#skillAvailability(skill);
    const setupStatus =
      workflow.phase === "SETUP"
        ? await this.#setupStatus(workflow.repo_path)
        : null;

    return {
      workflow,
      ...(setupStatus ? { setup_status: setupStatus } : {}),
      recommendation: {
        phase: workflow.phase,
        skill,
        skill_available: available,
        reason: this.#reason(workflow),
        human_boundary: HUMAN_BOUNDARY[workflow.phase],
        handoff_instruction: PHASE_HANDOFF[workflow.phase],
        user_prompt:
          workflow.phase === "DONE"
            ? "This workflow is complete."
            : available
              ? "Continue. The assistant should read and follow the recommended skill, while respecting the workflow handoff instruction."
              : "Install a skill source containing " + skill + " before continuing.",
      },
    };
  }

  #reason(workflow) {
    switch (workflow.phase) {
      case "SETUP":
        return "This repository has not yet recorded the issue tracker and domain-document layout required by the engineering workflow.";
      case "GRILLING":
        return "The change still needs shared understanding in the current repository before build work starts.";
      case "WAYFINDING":
        return "The effort spans multiple sessions and the route is still foggy, so decisions must be mapped before a spec is produced.";
      case "PROTOTYPE":
        return "A runnable answer is needed to settle a design question that conversation alone cannot resolve.";
      case "SPEC":
        return "Planning decisions are settled enough to collapse into one buildable specification.";
      case "TICKETS":
        return "The multi-session specification must be split into self-contained tracer-bullet tickets with blocking edges.";
      case "IMPLEMENT":
        return "The current planning unit is ready to build; implementation should drive TDD and finish with code review.";
      case "REVIEW":
        return "Implementation is complete and must be checked against both code standards and the intended behavior.";
      case "BLOCKED":
        return "The workflow is blocked and needs an explicit routing or human decision before it can proceed.";
      case "DONE":
        return "The planned change has passed review.";
      default:
        return "The workflow phase is unknown.";
    }
  }

  #assertNoOpenDecisions(workflow, event) {
    const open = (workflow.open_decisions ?? [])
      .map((value) => String(value).trim())
      .filter(Boolean);
    if (open.length > 0) {
      throw new AgentDockError(
        "WORKFLOW_OPEN_DECISIONS",
        "The workflow cannot cross this phase boundary while decisions remain unresolved.",
        { phase: workflow.phase, event, open_decisions: open },
      );
    }
  }

  async advance({
    repoPath,
    event,
    sessionSpan,
    routeClarity,
    openDecisions,
    note,
  }) {
    if (!EVENTS.has(event)) {
      throw new AgentDockError(
        "INVALID_WORKFLOW_EVENT",
        "Unsupported workflow event.",
        { event, supported_events: [...EVENTS] },
      );
    }

    const { identity, workflow } = await this.#load(repoPath);
    if (!PHASES.has(workflow.phase)) {
      throw new AgentDockError(
        "INVALID_WORKFLOW_PHASE",
        "Persisted workflow has an invalid phase.",
        { phase: workflow.phase },
      );
    }

    if (sessionSpan !== undefined) {
      workflow.session_span = validateEnum(
        sessionSpan,
        ["single", "multi", "unknown"],
        "INVALID_WORKFLOW_SESSION_SPAN",
        "session_span",
      );
    }
    if (routeClarity !== undefined) {
      workflow.route_clarity = validateEnum(
        routeClarity,
        ["clear", "foggy", "unknown"],
        "INVALID_WORKFLOW_ROUTE_CLARITY",
        "route_clarity",
      );
    }
    if (openDecisions !== undefined) {
      workflow.open_decisions = [...openDecisions].map((value) => String(value));
    }

    const previousPhase = workflow.phase;
    switch (event) {
      case "setup_complete":
        if (previousPhase !== "SETUP") this.#invalidTransition(workflow, event);
        {
          const setupStatus = await this.#setupStatus(workflow.repo_path);
          if (!setupStatus.configured) {
            throw new AgentDockError(
              "WORKFLOW_SETUP_INCOMPLETE",
              "setup_complete requires the Matt engineering-skill repo configuration to be complete.",
              { missing: setupStatus.missing },
            );
          }
        }
        workflow.setup_configured = true;
        workflow.phase = workflow.after_setup_phase || "GRILLING";
        workflow.after_setup_phase = null;
        break;
      case "prototype_needed":
        if (!["GRILLING", "WAYFINDING"].includes(previousPhase)) {
          this.#invalidTransition(workflow, event);
        }
        workflow.return_phase = previousPhase;
        workflow.phase = "PROTOTYPE";
        break;
      case "prototype_complete":
        if (previousPhase !== "PROTOTYPE") {
          this.#invalidTransition(workflow, event);
        }
        workflow.phase = workflow.return_phase || "GRILLING";
        workflow.return_phase = null;
        break;
      case "grilling_complete":
        if (previousPhase !== "GRILLING") this.#invalidTransition(workflow, event);
        this.#assertNoOpenDecisions(workflow, event);
        if (workflow.session_span === "unknown") {
          throw new AgentDockError(
            "WORKFLOW_SESSION_SPAN_REQUIRED",
            "Before leaving grilling, classify the build as single-session or multi-session.",
          );
        }
        workflow.decisions_settled = true;
        workflow.phase =
          workflow.session_span === "multi" ? "SPEC" : "IMPLEMENT";
        break;
      case "map_clear":
        if (previousPhase !== "WAYFINDING") this.#invalidTransition(workflow, event);
        this.#assertNoOpenDecisions(workflow, event);
        workflow.decisions_settled = true;
        workflow.route_clarity = "clear";
        workflow.phase = "SPEC";
        break;
      case "spec_complete":
        if (previousPhase !== "SPEC") this.#invalidTransition(workflow, event);
        this.#assertNoOpenDecisions(workflow, event);
        if (workflow.session_span === "unknown") {
          throw new AgentDockError(
            "WORKFLOW_SESSION_SPAN_REQUIRED",
            "Before leaving the spec phase, classify the build as single-session or multi-session.",
          );
        }
        workflow.decisions_settled = true;
        workflow.phase =
          workflow.session_span === "multi" ? "TICKETS" : "IMPLEMENT";
        break;
      case "tickets_complete":
        if (previousPhase !== "TICKETS") this.#invalidTransition(workflow, event);
        workflow.phase = "IMPLEMENT";
        break;
      case "implementation_complete":
        if (previousPhase !== "IMPLEMENT") this.#invalidTransition(workflow, event);
        workflow.phase = "REVIEW";
        break;
      case "review_passed":
        if (previousPhase !== "REVIEW") this.#invalidTransition(workflow, event);
        workflow.phase = "DONE";
        break;
      case "review_changes_requested":
        if (previousPhase !== "REVIEW") this.#invalidTransition(workflow, event);
        workflow.phase = "IMPLEMENT";
        break;
      case "blocked":
        if (previousPhase === "DONE" || previousPhase === "BLOCKED") {
          this.#invalidTransition(workflow, event);
        }
        workflow.return_phase = previousPhase;
        workflow.phase = "BLOCKED";
        break;
      case "resume":
        if (previousPhase !== "BLOCKED") this.#invalidTransition(workflow, event);
        workflow.phase = workflow.return_phase || "GRILLING";
        workflow.return_phase = null;
        break;
      default:
        this.#invalidTransition(workflow, event);
    }

    workflow.last_event = event;
    workflow.updated_at = new Date().toISOString();
    workflow.history.push({
      at: workflow.updated_at,
      event,
      from_phase: previousPhase,
      phase: workflow.phase,
      note: note ? String(note) : null,
    });
    if (workflow.history.length > 200) {
      workflow.history = workflow.history.slice(-200);
    }

    await atomicJsonWrite(identity.filePath, workflow);
    return this.guide({ repoPath: identity.repoPath });
  }

  #invalidTransition(workflow, event) {
    throw new AgentDockError(
      "INVALID_WORKFLOW_TRANSITION",
      "Workflow event is not valid from the current phase.",
      { phase: workflow.phase, event },
    );
  }
}
