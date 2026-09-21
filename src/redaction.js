const SECRET_KEY = /(authorization|api[_-]?key|token|password|passwd|secret|credential|cookie)/i;

const INLINE_PATTERNS = [
  /(Authorization\s*:\s*Bearer\s+)[^\s"']+/gi,
  /((?:api[_-]?key|token|password|passwd|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)[^\s"'&,;]+/gi,
];

export function redactString(value) {
  let result = value;
  for (const pattern of INLINE_PATTERNS) {
    result = result.replace(pattern, "$1[REDACTED]");
  }
  return result;
}

export function redactObject(value, key = "") {
  if (value === null || value === undefined) {
    return value;
  }

  if (SECRET_KEY.test(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactObject(childValue, childKey),
      ]),
    );
  }

  return value;
}

export function redactEnv(env) {
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([key, value]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : redactString(String(value)),
    ]),
  );
}
