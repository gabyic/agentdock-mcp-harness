const SECRET_KEY = /(authorization|api[_-]?key|token|password|passwd|secret|credential|cookie)/i;

const INLINE_PATTERNS = [
  /(Authorization\s*:\s*Bearer\s+)[^\s"']+/gi,
  /(Cookie\s*:\s*)[^\r\n]+/gi,
  /((?:--)?(?:api[_-]?key|token|password|passwd|secret|access[_-]?token|refresh[_-]?token)(?:\s*[:=]\s*|\s+))[^\s"'&,;]+/gi,
];

function normalizeSensitiveValues(values) {
  return [...new Set(
    [...(values ?? [])]
      .map((value) => String(value ?? ""))
      .filter((value) => value.length >= 4),
  )].sort((left, right) => right.length - left.length);
}

export function sensitiveValuesFromEnv(env) {
  return normalizeSensitiveValues(
    Object.entries(env ?? {})
      .filter(([key]) => SECRET_KEY.test(key))
      .map(([, value]) => value),
  );
}

export function redactString(value, sensitiveValues = []) {
  let result = String(value ?? "");
  for (const pattern of INLINE_PATTERNS) {
    result = result.replace(pattern, "$1[REDACTED]");
  }
  for (const secret of normalizeSensitiveValues(sensitiveValues)) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

const SECRET_ARG_FLAG = /^--?(?:authorization|api[_-]?key|token|password|passwd|secret|credential|cookie|access[_-]?token|refresh[_-]?token)$/i;

export function redactArgv(argv, sensitiveValues = []) {
  if (!Array.isArray(argv)) return argv;
  const redacted = [];
  let redactNext = false;
  for (const value of argv) {
    const text = String(value ?? "");
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    const cleaned = redactString(text, sensitiveValues);
    redacted.push(cleaned);
    if (SECRET_ARG_FLAG.test(text)) {
      redactNext = true;
    }
  }
  return redacted;
}

export function redactObject(value, key = "", sensitiveValues = []) {
  if (value === null || value === undefined) {
    return value;
  }

  if (SECRET_KEY.test(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return redactString(value, sensitiveValues);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, "", sensitiveValues));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactObject(childValue, childKey, sensitiveValues),
      ]),
    );
  }

  return value;
}

export function redactEnv(env) {
  const sensitiveValues = sensitiveValuesFromEnv(env);
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([key, value]) => [
      key,
      SECRET_KEY.test(key)
        ? "[REDACTED]"
        : redactString(String(value), sensitiveValues),
    ]),
  );
}
