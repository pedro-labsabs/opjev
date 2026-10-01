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

export function installPluginToHome(homeDir, repoDir = REPO) {
  const pluginTargetDir = path.join(homeDir, ".config", "opencode", "plugins", "opjev");
  fs.mkdirSync(pluginTargetDir, { recursive: true });

  // Copia o package.json real (com exports["./tui"]) e os arquivos do plugin
  fs.copyFileSync(path.join(repoDir, "package.json"), path.join(pluginTargetDir, "package.json"));
  fs.copyFileSync(path.join(repoDir, "index.ts"), path.join(pluginTargetDir, "index.ts"));
  fs.copyFileSync(path.join(repoDir, "tui.ts"), path.join(pluginTargetDir, "tui.ts"));
  fs.cpSync(path.join(repoDir, "src"), path.join(pluginTargetDir, "src"), { recursive: true });

  // Resolucao de @opencode/plugin a partir do plugin do config dir (walk-up do Node/Bun)
  const cliNodeModules = path.join(homeDir, "node_modules");
  try {
    fs.rmSync(cliNodeModules, { force: true, recursive: true });
  } catch {
    // melhor esforco
  }
  fs.symlinkSync(path.join(repoDir, "node_modules"), cliNodeModules, "dir");
}

export function installServerPluginToProject(projectDir, repoDir = REPO) {
  const serverTargetDir = path.join(projectDir, "plugins", "opencode-jev-free-router");
  fs.mkdirSync(serverTargetDir, { recursive: true });

  fs.copyFileSync(path.join(repoDir, "package.json"), path.join(serverTargetDir, "package.json"));
  fs.copyFileSync(path.join(repoDir, "index.ts"), path.join(serverTargetDir, "index.ts"));
  fs.copyFileSync(path.join(repoDir, "tui.ts"), path.join(serverTargetDir, "tui.ts"));
  fs.cpSync(path.join(repoDir, "src"), path.join(serverTargetDir, "src"), { recursive: true });

  const projectNodeModules = path.join(serverTargetDir, "node_modules");
  try {
    fs.rmSync(projectNodeModules, { force: true, recursive: true });
  } catch {
    // melhor esforco
  }
  fs.symlinkSync(path.join(repoDir, "node_modules"), projectNodeModules, "dir");
}

export function preparePluginInstallation(homeDir, projectDir, repoDir = REPO) {
  installPluginToHome(homeDir, repoDir);
  if (projectDir) {
    installServerPluginToProject(projectDir, repoDir);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const targetHome = process.env.HOME ?? path.join(process.cwd(), "home");
  const targetProject = process.cwd();
  preparePluginInstallation(targetHome, targetProject);
  console.log(`[opjev] Plugin TUI instalado em ${path.join(targetHome, ".config/opencode/plugins/opjev")}`);
  console.log(`[opjev] Plugin Server instalado em ${path.join(targetProject, "plugins/opencode-jev-free-router")}`);
}
