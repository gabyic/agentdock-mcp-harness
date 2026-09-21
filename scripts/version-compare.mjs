#!/usr/bin/env node
function parse(version) {
  const match = String(version).match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) {
    throw new Error("Unsupported semantic version: " + version);
  }
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? null : match[4].split("."),
  };
}

function cmpIdentifier(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an && !bn) return -1;
  if (!an && bn) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function compare(a, b) {
  const av = parse(a);
  const bv = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (av.core[i] !== bv.core[i]) {
      return Math.sign(av.core[i] - bv.core[i]);
    }
  }
  if (av.pre === null && bv.pre === null) return 0;
  if (av.pre === null) return 1;
  if (bv.pre === null) return -1;

  const length = Math.max(av.pre.length, bv.pre.length);
  for (let i = 0; i < length; i += 1) {
    if (av.pre[i] === undefined) return -1;
    if (bv.pre[i] === undefined) return 1;
    const result = cmpIdentifier(av.pre[i], bv.pre[i]);
    if (result !== 0) return result;
  }
  return 0;
}

if (process.argv.length !== 4) {
  process.stderr.write("Usage: version-compare.mjs VERSION_A VERSION_B\n");
  process.exit(2);
}

try {
  process.stdout.write(String(compare(process.argv[2], process.argv[3])));
} catch (error) {
  process.stderr.write(error.message + "\n");
  process.exit(1);
}
