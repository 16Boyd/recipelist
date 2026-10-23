#!/usr/bin/env node

/**
 * Report production callable documentation coverage and fail below 80% overall.
 * Run with `npm run docs:coverage`. TypeScript callables need JSDoc; production Bash
 * functions need a contiguous `#` comment block immediately above the definition.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const threshold = 0.8;
const excludedDirectoryNames = new Set([
  "__tests__",
  "__generated__",
  "build",
  "coverage",
  "dist",
  "dist-server",
  "fixtures",
  "generated",
  "node_modules",
  "test",
  "tests",
]);

async function collectFiles(directory, accept) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!excludedDirectoryNames.has(entry.name)) {
        files.push(...(await collectFiles(path.join(directory, entry.name), accept)));
      }
    } else if (entry.isFile() && accept(entry.name)) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

function isProductionTypeScriptFile(file) {
  return /\.tsx?$/.test(file)
    && !/\.d\.ts$/.test(file)
    && !/\.generated\.tsx?$/.test(file)
    && !/(?:^|\.){1}(?:test|spec)\.[^.]+$/.test(file)
    && !/\.config\.[^.]+$/.test(file);
}

function hasJsDoc(node) {
  return (node.jsDoc ?? []).some((doc) => {
    const prose = typeof doc.comment === "string"
      ? doc.comment
      : Array.isArray(doc.comment)
        ? doc.comment.map((part) => part.text ?? "").join("")
        : "";
    if (prose.trim()) return true;
    return (doc.tags ?? []).some((tag) => {
      const tagProse = typeof tag.comment === "string"
        ? tag.comment
        : Array.isArray(tag.comment)
          ? tag.comment.map((part) => part.text ?? "").join("")
          : "";
      return tagProse.trim().length > 0;
    });
  });
}

function hasCallableJsDoc(node) {
  if (hasJsDoc(node)) return true;
  if (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)) {
    const statement = node.parent.parent;
    return ts.isVariableStatement(statement) && hasJsDoc(statement);
  }
  return false;
}

function isDocumentedBashFunction(lines, index) {
  let previous = index - 1;
  let foundComment = false;
  while (previous >= 0 && /^\s*#/.test(lines[previous])) {
    if (lines[previous].replace(/^\s*#\s?/, "").trim()) foundComment = true;
    previous -= 1;
  }
  return foundComment;
}

function unwrapFunctionInitializer(initializer) {
  let current = initializer;
  while (current) {
    if (ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isTypeAssertionExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
  return undefined;
}

function isFunctionInitializer(initializer) {
  const unwrapped = unwrapFunctionInitializer(initializer);
  return Boolean(unwrapped && (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)));
}

function isCountedTypeScriptCallable(node) {
  const isNamedFunction = ts.isFunctionDeclaration(node) && node.name && node.body;
  const isNamedFunctionVariable = ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && isFunctionInitializer(node.initializer);
  const isNamedFunctionProperty = ts.isPropertyDeclaration(node)
    && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))
    && isFunctionInitializer(node.initializer);
  const isMethod = ts.isMethodDeclaration(node) && node.body;
  return Boolean(isNamedFunction || isNamedFunctionVariable || isNamedFunctionProperty || isMethod);
}

function countTypeScriptCallablesInSource(source) {
  let total = 0;
  let documented = 0;
  function visit(node) {
    if (isCountedTypeScriptCallable(node)) {
      total += 1;
      if (hasCallableJsDoc(node)) documented += 1;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { documented, total };
}

function isBashFunctionHeader(lines, index) {
  const header = lines[index];
  // This is a line-based recognizer for supported declaration forms, not a shell parser.
  // Bash's `function name` keyword is required when parentheses are omitted.
  const match = /^\s*(?:function\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(\s*\))?|([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\))\s*(.*)$/.exec(header);
  if (!match) return false;
  const remainder = match[3];
  if (/^\s*(?:\{|\()/.test(remainder)) return true;
  return remainder.trim() === "" && /^\s*(?:\{|\()/.test(lines[index + 1] ?? "");
}

function countBashFunctionsInLines(lines) {
  let total = 0;
  let documented = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!isBashFunctionHeader(lines, index)) continue;
    total += 1;
    if (isDocumentedBashFunction(lines, index)) documented += 1;
  }
  return { documented, total };
}

function meetsThreshold(documented, total) {
  return total === 0 || documented / total >= threshold;
}

function runSelfTest() {
  if (!meetsThreshold(4, 5) || meetsThreshold(3, 5)) {
    throw new Error("80% threshold boundary self-test failed");
  }
  const callableFixture = ts.createSourceFile("fixture.ts", [
    "/** Function docs. */ function declared() {}",
    "/** Arrow docs. */ const arrow = ((() => {}) as () => void);",
    "/** Asserted function docs. */ const asserted = (<() => void>function () {})!;",
    "const undocumented = (() => {}) satisfies () => void;",
    "(function internalName() {});",
    "const immediate = (() => {})();",
    "class Fixture {",
    "  /** Property docs. */ property = (() => {}) as () => void;",
    "  empty = (() => {});",
    "  /** Method docs. */ method() {}",
    "}",
    "/** */ function emptyDoc() {}",
  ].join("\n"), ts.ScriptTarget.Latest, true);
  const callableCounts = countTypeScriptCallablesInSource(callableFixture);
  if (callableCounts.total !== 8 || callableCounts.documented !== 5) {
    throw new Error("TypeScript JSDoc recognition self-test failed");
  }
  if (!isProductionTypeScriptFile("src/app.tsx")
    || !isProductionTypeScriptFile("db-config.ts")
    || !isProductionTypeScriptFile("auth-config.ts")
    || !isProductionTypeScriptFile("viteProxy.ts")
    || isProductionTypeScriptFile("src/generated.generated.ts")
    || isProductionTypeScriptFile("src/app.config.ts")
    || !excludedDirectoryNames.has("build")
    || !excludedDirectoryNames.has("generated")
    || !excludedDirectoryNames.has("__generated__")) {
    throw new Error("TypeScript production file exclusion self-test failed");
  }
  const bashCounts = countBashFunctionsInLines([
    "# Docs", "run_task() {", "}",
    "function named {", "}",
    "# More docs", "function parenthesized()", "{", "}",
    "# Subshell docs", "function subshell ()", "(", ")",
    "bare_name {", "}",
    "undocumented() {", "}",
  ]);
  if (bashCounts.total !== 5 || bashCounts.documented !== 3
    || isDocumentedBashFunction(["", "run_task() {"], 1)
    || isDocumentedBashFunction(["#", "run_task() {"], 1)
    || isDocumentedBashFunction(["#   ", "run_task() {"], 1)) {
    throw new Error(`Bash comment recognition self-test failed (${bashCounts.documented}/${bashCounts.total})`);
  }
  console.log("Docstring coverage checker self-tests passed.");
}

async function countTypeScriptCallables() {
  const files = [
    ...(await collectFiles(path.join(root, "src"), isProductionTypeScriptFile)),
    ...(await collectFiles(path.join(root, "server"), isProductionTypeScriptFile)),
  ];
  let total = 0;
  let documented = 0;
  const perFile = [];

  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    const counts = countTypeScriptCallablesInSource(source);
    const { total: fileTotal, documented: fileDocumented } = counts;
    total += fileTotal;
    documented += fileDocumented;
    if (fileTotal > 0) perFile.push({ file: path.relative(root, file), total: fileTotal, documented: fileDocumented });
  }
  return { documented, total, perFile };
}

async function countBashFunctions() {
  const files = await collectFiles(path.join(root, "scripts"), (name) =>
    name.endsWith(".sh") && !/(?:^|[._-])(?:test|spec)(?:[._-]|$)/i.test(name));
  let total = 0;
  let documented = 0;
  const perFile = [];
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    const counts = countBashFunctionsInLines(lines);
    const { total: fileTotal, documented: fileDocumented } = counts;
    total += fileTotal;
    documented += fileDocumented;
    if (fileTotal > 0) {
      perFile.push({ file: path.relative(root, file), documented: fileDocumented, total: fileTotal });
    }
  }
  return { documented, total, perFile };
}

function format({ documented, total }) {
  const percent = total === 0 ? 100 : (documented / total) * 100;
  return `${documented}/${total} (${percent.toFixed(1)}%)`;
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
  process.exit(0);
}

const [typescript, bash] = await Promise.all([countTypeScriptCallables(), countBashFunctions()]);
const overall = {
  documented: typescript.documented + bash.documented,
  total: typescript.total + bash.total,
};
for (const file of [...typescript.perFile, ...bash.perFile]) {
  console.log(`${file.file}: ${format(file)}`);
}
console.log(`TypeScript/TSX: ${format(typescript)}`);
console.log(`Bash installer: ${format(bash)}`);
console.log(`Overall: ${format(overall)} (target: ${(threshold * 100).toFixed(0)}%)`);

if (!meetsThreshold(overall.documented, overall.total)) {
  console.error("Docstring coverage is below the required threshold.");
  process.exitCode = 1;
}
