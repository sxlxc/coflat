import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = join(repositoryRoot, "src");
const failures = [];

const moduleCandidates = (path) => [
  path,
  `${path}.ts`,
  `${path}.tsx`,
  `${path}.mts`,
  `${path}.mjs`,
  join(path, "index.ts"),
  join(path, "index.tsx"),
];

async function existingModule(path) {
  for (const candidate of moduleCandidates(path)) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (_error) {
      // Try the next TypeScript/Vite resolution candidate.
    }
  }
  return null;
}

function relativeModuleSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]?.startsWith(".")) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

async function reachableModules(entry) {
  const pending = [entry];
  const visited = new Set();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    const source = await readFile(path, "utf8");
    for (const specifier of relativeModuleSpecifiers(source)) {
      const resolved = await existingModule(resolve(dirname(path), specifier));
      if (resolved && !visited.has(resolved)) pending.push(resolved);
    }
  }
  return visited;
}

function isProductionTypeScript(path) {
  const extension = extname(path);
  if (extension !== ".ts" && extension !== ".tsx") return false;
  return !(
    /(?:^|\/)test-[^/]*\.tsx?$/.test(path)
    || /(?:^|\/)[^/]*-test-utils\.tsx?$/.test(path)
    || /\.(?:test|spec)(?:\.[^.]+)?\.tsx?$/.test(path)
    || /\.bench\.test\.tsx?$/.test(path)
  );
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (isProductionTypeScript(path)) files.push(path);
  }
  return files;
}

function codeWithoutCommentLines(source) {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith("//")
        && !trimmed.startsWith("*")
        && !trimmed.startsWith("/*");
    })
    .join("\n");
}

for (const path of await sourceFiles(sourceRoot)) {
  const source = await readFile(path, "utf8");
  const code = codeWithoutCommentLines(source);
  const displayPath = relative(repositoryRoot, path);
  if (/\b(?:syntaxTree|ensureSyntaxTree|parseMarkdownSource)\s*\(/.test(code)) {
    failures.push(`${displayPath}: calls a retired Markdown-structure API`);
  }
  if (/from\s+["'](?:@codemirror\/lang-markdown|@lezer\/markdown)["']/.test(code)) {
    failures.push(`${displayPath}: imports the retired production Markdown parser`);
  }
  if (/syntax-parse-scheduler/.test(code)) {
    failures.push(`${displayPath}: imports the retired parse-frontier scheduler`);
  }
  if (
    /pandoc-syntax-tree/.test(code)
    || /\b(?:getPandocSyntaxTree|ensurePandocSyntaxTree|parsePandocCstSource)\b/.test(code)
  ) {
    failures.push(`${displayPath}: imports or reads the retired CST-to-Lezer projection`);
  }
}

// Walk the shipped graph as a second line of defense. This makes the production
// authority boundary explicit instead of trusting bundle tree-shaking.
const editorEntry = join(repositoryRoot, "editor.ts");
for (const path of await reachableModules(editorEntry)) {
  const source = codeWithoutCommentLines(await readFile(path, "utf8"));
  const displayPath = relative(repositoryRoot, path);
  const relativePath = displayPath.replaceAll("\\", "/");
  if (
    relativePath === "src/editor/editor.ts"
    || relativePath.startsWith("src/reader/")
    || relativePath.includes("pandoc-syntax-tree")
    || relativePath.includes("document-analysis")
    || relativePath.includes("editor-mode-state")
  ) {
    failures.push(`${displayPath}: legacy module is reachable from editor.ts`);
  }
  if (/from\s+["'](?:@codemirror\/lang-markdown|@lezer\/markdown|@lezer\/common)["']/.test(source)) {
    failures.push(`${displayPath}: shipped editor directly imports a legacy Markdown tree`);
  }
  if (/\b(?:getPandocSyntaxTree|ensurePandocSyntaxTree|parsePandocCstSource|documentAnalysisField)\b/.test(source)) {
    failures.push(`${displayPath}: shipped editor reads a legacy projection or semantic cache`);
  }
}

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
for (const name of ["@codemirror/lang-markdown", "@lezer/markdown"]) {
  if (
    packageJson.dependencies?.[name]
    || packageJson.devDependencies?.[name]
    || packageJson.peerDependencies?.[name]
  ) {
    failures.push(`package.json: retired parser dependency ${name} is still declared`);
  }
}
for (const name of ["./reader", "./reader/worker", "./rich-readonly", "./inline-render", "./parse"]) {
  if (packageJson.exports?.[name]) {
    failures.push(`package.json: removed legacy surface ${name} is still published`);
  }
}

for (const retiredPath of [
  "reader.ts",
  "reader-worker.ts",
  "rich-readonly.ts",
  "inline-render.ts",
  "parse.ts",
  "src/reader",
  "src/editor/editor.ts",
  "src/core/cst/pandoc-syntax-tree.ts",
]) {
  try {
    await stat(join(repositoryRoot, retiredPath));
    failures.push(`${retiredPath}: retired implementation still exists`);
  } catch (_error) {
    // Missing is the required state.
  }
}

const lockfile = await readFile(new URL("../bun.lock", import.meta.url), "utf8");
if (/"@lezer\/markdown[^"]*"\s*:\s*"patches\//.test(lockfile)) {
  failures.push("bun.lock: the retired private @lezer/markdown patch is still active");
}

const patchFiles = await readdir(new URL("../patches/", import.meta.url));
if (patchFiles.some((name) => /lezer.*markdown|markdown.*lezer/i.test(name))) {
  failures.push("patches/: a private @lezer/markdown patch is still present");
}

if (failures.length > 0) {
  process.stderr.write(`M6 CST authority check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("M6 CST authority check passed.\n");
}
