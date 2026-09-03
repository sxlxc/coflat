import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = join(repositoryRoot, "src");
const failures = [];

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
}

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
for (const name of ["@codemirror/lang-markdown", "@lezer/markdown"]) {
  if (packageJson.dependencies?.[name] || packageJson.peerDependencies?.[name]) {
    failures.push(`package.json: ${name} must remain development-only`);
  }
}

const lockfile = await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
if (/@lezer\/markdown[^\n]*patch_hash/.test(lockfile)) {
  failures.push("pnpm-lock.yaml: the retired private @lezer/markdown patch is still active");
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
