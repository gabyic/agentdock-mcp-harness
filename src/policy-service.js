import { AgentDockError } from "./errors.js";

const EFFECTS = new Set(["allow", "ask", "deny"]);

function parseRules(value) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new AgentDockError(
      "INVALID_POLICY_CONFIG",
      "Policy rules must be an array.",
    );
  }

  return value.map((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new AgentDockError(
        "INVALID_POLICY_CONFIG",
        "Policy rule " + index + " must be an object.",
      );
    }
    if (!EFFECTS.has(rule.effect)) {
      throw new AgentDockError(
        "INVALID_POLICY_CONFIG",
        "Policy rule " + index + " has invalid effect.",
      );
    }
    if (typeof rule.id !== "string" || !rule.id) {
      throw new AgentDockError(
        "INVALID_POLICY_CONFIG",
        "Policy rule " + index + " must have a non-empty id.",
      );
    }
    if (typeof rule.tool !== "string" || !rule.tool) {
      throw new AgentDockError(
        "INVALID_POLICY_CONFIG",
        "Policy rule " + index + " must have a tool.",
      );
    }

    let shellRegex = null;
    if (rule.shell_regex !== undefined) {
      if (typeof rule.shell_regex !== "string") {
        throw new AgentDockError(
          "INVALID_POLICY_CONFIG",
          "shell_regex must be a string.",
        );
      }
      try {
        shellRegex = new RegExp(rule.shell_regex);
      } catch (error) {
        throw new AgentDockError(
          "INVALID_POLICY_CONFIG",
          "Invalid shell_regex in rule " + rule.id + ": " + error.message,
        );
      }
    }

    let argvPrefix = null;
    if (rule.argv_prefix !== undefined) {
      if (
        !Array.isArray(rule.argv_prefix) ||
        !rule.argv_prefix.every((item) => typeof item === "string")
      ) {
        throw new AgentDockError(
          "INVALID_POLICY_CONFIG",
          "argv_prefix must be an array of strings.",
        );
      }
      argvPrefix = [...rule.argv_prefix];
    }

    return {
      id: rule.id,
      effect: rule.effect,
      tool: rule.tool,
      approval_scope:
        typeof rule.approval_scope === "string" && rule.approval_scope
          ? rule.approval_scope
          : rule.id,
      shell_regex: shellRegex,
      argv_prefix: argvPrefix,
    };
  });
}

function prefixMatches(value, prefix) {
  if (!prefix) {
    return true;
  }
  if (!Array.isArray(value) || value.length < prefix.length) {
    return false;
  }
  return prefix.every((item, index) => value[index] === item);
}

export class PolicyService {
  #rules;

  constructor({ rules, rulesJson } = {}) {
    let value = rules;
    if (value === undefined && rulesJson !== undefined) {
      try {
        value = rulesJson ? JSON.parse(rulesJson) : [];
      } catch (error) {
        throw new AgentDockError(
          "INVALID_POLICY_CONFIG",
          "rulesJson is not valid JSON: " + error.message,
        );
      }
    }
    this.#rules = parseRules(value);
  }

  evaluate({ tool, shell, argv }) {
    for (const rule of this.#rules) {
      if (rule.tool !== "*" && rule.tool !== tool) {
        continue;
      }
      if (rule.shell_regex && !rule.shell_regex.test(shell ?? "")) {
        continue;
      }
      if (!prefixMatches(argv, rule.argv_prefix)) {
        continue;
      }

      return {
        rule_id: rule.id,
        effect: rule.effect,
        approval_scope: rule.approval_scope,
      };
    }

    return {
      rule_id: "default-allow",
      effect: "allow",
      approval_scope: "default-allow",
    };
  }
}
