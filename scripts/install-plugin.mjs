#!/usr/bin/env node
// Helper deterministico de instalacao do plugin opjev para OpenCode v2.0.11.
//
// No OpenCode v2.0.11, o servidor backend (`opencode serve`) carrega o plugin de projeto
// configurado em `opencode.json` (superficie `.`), enquanto o CLI/TUI (`opencode`) carrega
// plugins TUI a partir de `<HOME>/.config/opencode/plugins/<nome-do-plugin>` (superficie `./tui`).
//
// Este script prepara essa estrutura de forma 100% fiel ao package.json real do repositorio
// (preservando name, version, main e exports `.` / `./tui`).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assertNoSymlinkParents(rootDir, targetDir) {
  const root = path.resolve(rootDir);
  const parent = path.relative(root, path.dirname(path.resolve(targetDir)));
  if (parent === ".." || parent.startsWith(`..${path.sep}`) || path.isAbsolute(parent)) {
    throw new Error(`refusing plugin path outside its selected root: ${targetDir}`);
  }
  const filesystemRoot = path.parse(root).root;
  let current = filesystemRoot;
  for (const part of root.slice(filesystemRoot.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`refusing symlink or non-directory root: ${current}`);
    } catch (err) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
  }
  current = root;
  for (const part of parent.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`refusing symlink or non-directory parent: ${current}`);
    } catch (err) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
  }
}

function assertPluginEntries(targetDir) {
  for (const file of ["package.json", "index.ts", "tui.ts"]) {
    try {
      const stat = fs.lstatSync(path.join(targetDir, file));
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`refusing non-file plugin entry: ${path.join(targetDir, file)}`);
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
    }
  }
  try {
    const stat = fs.lstatSync(path.join(targetDir, "src"));
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`refusing non-directory plugin source: ${path.join(targetDir, "src")}`);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

function assertPluginTarget(targetDir, packageName) {
  try {
    const stat = fs.lstatSync(targetDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`refusing existing plugin target: ${targetDir}`);
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(targetDir, "package.json"), "utf8"));
    } catch (err) {
      if (err?.code === "ENOENT") throw new Error(`refusing unowned plugin target: ${targetDir}`);
      throw err;
    }
    if (pkg.name !== packageName) throw new Error(`refusing unowned plugin target: ${targetDir}`);
  } catch (err) {
    if (err?.code === "ENOENT" && !fs.existsSync(targetDir)) return;
    throw err;
  }
}

function checkDependencyLink(linkPath, dependencyPath) {
  try {
    if (!fs.lstatSync(linkPath).isSymbolicLink() || fs.realpathSync(linkPath) !== fs.realpathSync(dependencyPath)) {
      throw new Error(`refusing existing node_modules path: ${linkPath}`);
    }
    return true;
  } catch (err) {
    if (err?.code === "ENOENT" && !fs.existsSync(linkPath)) return false;
    throw err;
  }
}

function installPlugin(targetDir, dependencyLink, repoDir) {
  const packagePath = path.join(repoDir, "package.json");
  const packageName = JSON.parse(fs.readFileSync(packagePath, "utf8")).name;
  const dependencyPath = path.join(repoDir, "node_modules");
  if (!fs.statSync(dependencyPath).isDirectory()) throw new Error(`plugin dependencies missing: ${dependencyPath}`);
  assertPluginTarget(targetDir, packageName);
  const linkExists = checkDependencyLink(dependencyLink, dependencyPath);
  assertPluginEntries(targetDir);

  fs.mkdirSync(targetDir, { recursive: true });
  if (!linkExists) fs.symlinkSync(dependencyPath, dependencyLink, "dir");
  for (const file of ["package.json", "index.ts", "tui.ts"]) {
    fs.copyFileSync(path.join(repoDir, file), path.join(targetDir, file));
  }
  fs.cpSync(path.join(repoDir, "src"), path.join(targetDir, "src"), { recursive: true });
}

export function installPluginToHome(homeDir, repoDir = REPO) {
  const pluginTargetDir = path.join(homeDir, ".config", "opencode", "plugins", "opjev");
  const dependencyLink = path.join(homeDir, "node_modules");
  assertNoSymlinkParents(homeDir, pluginTargetDir);
  assertNoSymlinkParents(homeDir, dependencyLink);
  installPlugin(pluginTargetDir, dependencyLink, repoDir);
}

export function installServerPluginToProject(projectDir, repoDir = REPO) {
  const serverTargetDir = path.join(projectDir, "plugins", "opencode-jev-free-router");
  const dependencyLink = path.join(serverTargetDir, "node_modules");
  assertNoSymlinkParents(projectDir, serverTargetDir);
  assertNoSymlinkParents(projectDir, dependencyLink);
  installPlugin(serverTargetDir, dependencyLink, repoDir);
}

export function preparePluginInstallation(homeDir, projectDir, repoDir = REPO) {
  const sourcePackage = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8"));
  const homeTarget = path.join(homeDir, ".config", "opencode", "plugins", "opjev");
  assertNoSymlinkParents(homeDir, homeTarget);
  assertNoSymlinkParents(homeDir, path.join(homeDir, "node_modules"));
  assertPluginTarget(homeTarget, sourcePackage.name);
  assertPluginEntries(homeTarget);
  checkDependencyLink(path.join(homeDir, "node_modules"), path.join(repoDir, "node_modules"));
  if (projectDir) {
    const serverTarget = path.join(projectDir, "plugins", "opencode-jev-free-router");
    assertNoSymlinkParents(projectDir, serverTarget);
    assertNoSymlinkParents(projectDir, path.join(serverTarget, "node_modules"));
    assertPluginTarget(serverTarget, sourcePackage.name);
    assertPluginEntries(serverTarget);
    checkDependencyLink(path.join(serverTarget, "node_modules"), path.join(repoDir, "node_modules"));
  }
  installPluginToHome(homeDir, repoDir);
  if (projectDir) installServerPluginToProject(projectDir, repoDir);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targetHome = process.env.HOME ?? path.join(process.cwd(), "home");
  const targetProject = process.cwd();
  preparePluginInstallation(targetHome, targetProject);
  console.log(`[opjev] Plugin TUI instalado em ${path.join(targetHome, ".config/opencode/plugins/opjev")}`);
  console.log(`[opjev] Plugin Server instalado em ${path.join(targetProject, "plugins/opencode-jev-free-router")}`);
}
