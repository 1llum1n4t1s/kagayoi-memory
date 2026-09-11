import { access, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectPackageFiles, isAllowedPackagePath, REPOSITORY_ROOT } from "./package-plugin.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const EXPECTED_HOOKS = new Set(["PreToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
const TEXT_EXTENSIONS = new Set([".js", ".json", ".jsonc", ".md", ".mjs", ".ps1", ".sql", ".ts", ".yaml", ".yml"]);

async function parseJson(root, relativePath, errors) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: invalid JSON (${error.message})`);
    return undefined;
  }
}

function portableReference(value, label, errors) {
  if (typeof value !== "string" || !value.startsWith("./")) {
    errors.push(`${label}: must be a ./ relative path`);
    return undefined;
  }
  if (value.includes("\\") || path.posix.normalize(value).startsWith("../") || path.posix.isAbsolute(value)) {
    errors.push(`${label}: must be portable and remain inside the plugin`);
    return undefined;
  }
  return value.slice(2).replace(/\/$/u, "");
}

async function requirePath(root, relativePath, kind, errors) {
  if (!relativePath) return;
  try {
    const stats = await lstat(path.join(root, relativePath));
    if (stats.isSymbolicLink() || (kind === "file" ? !stats.isFile() : !stats.isDirectory())) {
      errors.push(`${relativePath}: expected a regular ${kind}`);
    }
  } catch {
    errors.push(`${relativePath}: referenced ${kind} does not exist`);
  }
}

async function listFiles(root, relativeDirectory = "") {
  const files = [];
  const entries = await readdir(path.join(root, relativeDirectory), { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
    else files.push(relativePath);
  }
  return files;
}

function validatePortablePluginManifest(plugin, errors) {
  if (!plugin || typeof plugin !== "object") return;
  if (plugin.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
    errors.push("plugin.json: unsupported or missing plugin schema");
  }
  if (!/^[a-z0-9-]+$/u.test(plugin.name ?? "")) errors.push("plugin.json: name must be lowercase kebab-case");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(plugin.version ?? "")) errors.push("plugin.json: version must be SemVer");
  if (typeof plugin.description !== "string" || !plugin.description.trim()) errors.push("plugin.json: description is required");
  if (typeof plugin.author?.name !== "string" || !plugin.author.name.trim()) errors.push("plugin.json: author.name is required");
  if (plugin.license !== "MIT") errors.push("plugin.json: license must match the distributed MIT license");
  const openAi = plugin.extensions?.["com.openai"];
  if (!openAi || typeof openAi !== "object") {
    errors.push("plugin.json: extensions.com.openai is required");
    return;
  }
  if (typeof openAi.interface?.displayName !== "string" || typeof openAi.interface?.shortDescription !== "string") {
    errors.push("plugin.json: extensions.com.openai.interface displayName and shortDescription are required");
  }
}

function validateLegacyPluginManifest(plugin, errors) {
  if (!plugin || typeof plugin !== "object") return;
  if (!/^[a-z0-9-]+$/u.test(plugin.name ?? "")) errors.push(".codex-plugin/plugin.json: name must be lowercase kebab-case");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(plugin.version ?? "")) errors.push(".codex-plugin/plugin.json: version must be SemVer");
  for (const field of ["description", "skills"]) {
    if (typeof plugin[field] !== "string" || !plugin[field].trim()) errors.push(`.codex-plugin/plugin.json: ${field} is required`);
  }
  if (typeof plugin.interface?.displayName !== "string" || typeof plugin.interface?.shortDescription !== "string") {
    errors.push(".codex-plugin/plugin.json: interface displayName and shortDescription are required");
  }
}

function validateMcpManifest(mcp, errors) {
  const servers = mcp?.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers) || !Object.keys(servers).length) {
    errors.push("mcp.json: at least one MCP server is required");
    return;
  }
  for (const [name, server] of Object.entries(servers)) {
    const prefix = `mcp.json: mcpServers.${name}`;
    if (server?.command !== "node") errors.push(`${prefix}.command must be node`);
    if (!Array.isArray(server?.args) || !server.args.every((arg) => typeof arg === "string")) {
      errors.push(`${prefix}.args must be an array of strings`);
      continue;
    }
    const command = server.args.join(" ");
    if (server?.type !== "stdio") errors.push(`${prefix}.type must be stdio`);
    if (server?.cwd !== undefined) errors.push(`${prefix}.cwd must be omitted so task provenance uses the caller's working directory`);
    if (server.args.length !== 1 || server.args[0] !== "${PLUGIN_ROOT}/scripts/mcp-launcher.mjs") {
      errors.push(`${prefix} must launch the portable \${PLUGIN_ROOT}/scripts/mcp-launcher.mjs path`);
    }
    if (/[A-Za-z]:[\\/]|(?:^|["'])\/(?:home|Users)\//u.test(command) || command.includes("\\")) {
      errors.push(`${prefix} contains a machine-specific or non-portable path`);
    }
  }
}

function validateHooksManifest(hooksManifest, errors) {
  const hooks = hooksManifest?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    errors.push("hooks/hooks.json: hooks object is required");
    return;
  }
  const actualEvents = new Set(Object.keys(hooks));
  for (const event of EXPECTED_HOOKS) {
    if (!actualEvents.has(event)) errors.push(`hooks/hooks.json: missing ${event} hook`);
  }
  for (const event of actualEvents) {
    if (!EXPECTED_HOOKS.has(event)) errors.push(`hooks/hooks.json: unsupported hook event ${event}`);
    const registrations = hooks[event];
    if (!Array.isArray(registrations) || registrations.length !== 1) {
      errors.push(`hooks/hooks.json: ${event} must have exactly one registration`);
      continue;
    }
    const commands = registrations[0]?.hooks;
    if (!Array.isArray(commands) || commands.length !== 1) {
      errors.push(`hooks/hooks.json: ${event} must have exactly one command`);
      continue;
    }
    const hook = commands[0];
    if (hook?.type !== "command" || typeof hook.command !== "string") {
      errors.push(`hooks/hooks.json: ${event} must use a command hook`);
      continue;
    }
    if (!hook.command.includes("PLUGIN_ROOT") || !hook.command.includes("scripts/hook-launcher.mjs") || !hook.command.includes(`'${event}'`)) {
      errors.push(`hooks/hooks.json: ${event} must launch its event through scripts/hook-launcher.mjs`);
    }
    if (!Number.isFinite(hook.timeout) || hook.timeout <= 0) errors.push(`hooks/hooks.json: ${event} needs a positive timeout`);
    if (/[A-Za-z]:[\\/]|(?:^|["'])\/(?:home|Users)\//u.test(hook.command) || hook.command.includes("\\")) {
      errors.push(`hooks/hooks.json: ${event} contains a machine-specific or non-portable path`);
    }
  }
}

async function validateRelativeImports(root, files, errors) {
  const moduleFiles = files.filter((file) => /\.(?:js|mjs)$/u.test(file));
  for (const relativePath of moduleFiles) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    const imports = source.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*["'](\.{1,2}\/[^"']+)["']/gu);
    for (const match of imports) {
      const target = path.resolve(root, path.dirname(relativePath), match[1]);
      const escaped = path.relative(root, target).startsWith("..");
      if (escaped) {
        errors.push(`${relativePath}: import escapes the plugin (${match[1]})`);
        continue;
      }
      await access(target).catch(() => errors.push(`${relativePath}: import target is missing (${match[1]})`));
    }
  }
}

async function validateText(root, files, errors) {
  for (const relativePath of files) {
    if (!TEXT_EXTENSIONS.has(path.extname(relativePath))) continue;
    const source = await readFile(path.join(root, relativePath), "utf8");
    if (/\b(?:TODO|FIXME)\b/iu.test(source)) errors.push(`${relativePath}: unresolved TODO/FIXME marker`);
    if (source.includes("\0")) errors.push(`${relativePath}: contains a NUL byte`);
  }
}

export async function validatePlugin(root = REPOSITORY_ROOT) {
  const resolvedRoot = path.resolve(root);
  const errors = [];
  const plugin = await parseJson(resolvedRoot, "plugin.json", errors);
  const legacyPlugin = await parseJson(resolvedRoot, ".codex-plugin/plugin.json", errors);
  const mcp = await parseJson(resolvedRoot, "mcp.json", errors);
  const hooks = await parseJson(resolvedRoot, "hooks/hooks.json", errors);

  validatePortablePluginManifest(plugin, errors);
  validateLegacyPluginManifest(legacyPlugin, errors);
  validateMcpManifest(mcp, errors);
  validateHooksManifest(hooks, errors);

  const skillsPath = portableReference(legacyPlugin?.skills, ".codex-plugin/plugin.json: skills", errors);
  const hooksPath = portableReference(plugin?.extensions?.["com.openai"]?.hooks, "plugin.json: extensions.com.openai.hooks", errors);
  await requirePath(resolvedRoot, skillsPath, "directory", errors);
  await requirePath(resolvedRoot, hooksPath, "file", errors);
  await requirePath(resolvedRoot, "mcp.json", "file", errors);
  await requirePath(resolvedRoot, "scripts/hook-launcher.mjs", "file", errors);
  await requirePath(resolvedRoot, "scripts/mcp-launcher.mjs", "file", errors);

  let files = [];
  try {
    files = await collectPackageFiles(resolvedRoot);
  } catch (error) {
    errors.push(error.message);
  }

  const developmentRoot = await access(path.join(resolvedRoot, "scripts", "validate-plugin.mjs")).then(() => true, () => false);
  if (!developmentRoot) {
    const allFiles = await listFiles(resolvedRoot);
    for (const relativePath of allFiles) {
      if (!isAllowedPackagePath(relativePath)) errors.push(`${relativePath}: file is not in the package allowlist`);
    }
    files = allFiles;
  }

  if (plugin?.version) {
    if (legacyPlugin?.name !== plugin.name) errors.push(".codex-plugin/plugin.json: name must match plugin.json");
    if (legacyPlugin?.version !== plugin.version) errors.push(".codex-plugin/plugin.json: version must match plugin.json");
    for (const manifestPath of ["package.json", "server/package.json"]) {
      try {
        const manifest = JSON.parse(await readFile(path.join(resolvedRoot, manifestPath), "utf8"));
        if (manifest.version !== plugin.version) errors.push(`${manifestPath}: version must match plugin.json`);
      } catch (error) {
        if (manifestPath === "server/package.json") errors.push(`${manifestPath}: could not verify version (${error.message})`);
      }
    }
  }

  if (files.length) {
    await validateRelativeImports(resolvedRoot, files, errors);
    await validateText(resolvedRoot, files, errors);
  }

  if (errors.length) {
    const error = new Error(`Plugin validation failed:\n- ${errors.join("\n- ")}`);
    error.validationErrors = errors;
    throw error;
  }
  return { root: resolvedRoot, filesChecked: files.length };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : path.dirname(path.dirname(SCRIPT_PATH));
  try {
    const result = await validatePlugin(target);
    process.stdout.write(`Validated ${result.filesChecked} packaged files in ${result.root}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
