import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installPluginToHome, installServerPluginToProject } from "../scripts/install-plugin.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opjev-installer-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "opencode-jev-free-router", version: "0.1.0" }));
  fs.writeFileSync(path.join(repo, "index.ts"), "export default {};");
  fs.writeFileSync(path.join(repo, "tui.ts"), "export default {};");
  fs.writeFileSync(path.join(repo, "src", "entry.ts"), "export {};");
  fs.mkdirSync(path.join(repo, "node_modules"));
  return { root, repo };
}

test("installPluginToHome refuses an existing unrelated node_modules directory without deleting it", t => {
  const { root, repo } = fixture(t);
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(home, "node_modules", "user-data"), "keep");

  assert.throws(() => installPluginToHome(home, repo), /node_modules/);
  assert.equal(fs.readFileSync(path.join(home, "node_modules", "user-data"), "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(home, ".config", "opencode", "plugins", "opjev")), false);
});

test("installServerPluginToProject refuses an existing unrelated node_modules without deleting it", t => {
  const { root, repo } = fixture(t);
  const project = path.join(root, "project");
  const dependencies = path.join(project, "plugins", "opencode-jev-free-router", "node_modules");
  fs.mkdirSync(dependencies, { recursive: true });
  fs.writeFileSync(path.join(dependencies, "user-data"), "keep");

  assert.throws(() => installServerPluginToProject(project, repo), /unowned|node_modules/);
  assert.equal(fs.readFileSync(path.join(dependencies, "user-data"), "utf8"), "keep");
  assert.equal(fs.existsSync(path.join(project, "plugins", "opencode-jev-free-router", "index.ts")), false);
});

test("installer is idempotent when its existing dependency link already targets this repo", t => {
  const { root, repo } = fixture(t);
  const home = path.join(root, "home");
  installPluginToHome(home, repo);
  const link = path.join(home, "node_modules");
  const before = fs.lstatSync(link);
  installPluginToHome(home, repo);
  const after = fs.lstatSync(link);

  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(repo, "node_modules")));
  assert.equal(after.ino, before.ino);
  assert.equal(fs.readFileSync(path.join(home, ".config", "opencode", "plugins", "opjev", "src", "entry.ts"), "utf8"), "export {};");
});

test("installer rejects a symlinked plugin parent instead of writing through it", t => {
  const { root, repo } = fixture(t);
  const home = path.join(root, "home");
  const sharedPlugins = path.join(root, "shared-plugins");
  fs.mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  fs.mkdirSync(sharedPlugins);
  fs.symlinkSync(sharedPlugins, path.join(home, ".config", "opencode", "plugins"), "dir");

  assert.throws(() => installPluginToHome(home, repo), /symlink|parent/i);
  assert.equal(fs.existsSync(path.join(sharedPlugins, "opjev")), false);
  assert.equal(fs.existsSync(path.join(home, "node_modules")), false);
});

test("installer preflights the source directory before overwriting plugin files", t => {
  const { root, repo } = fixture(t);
  const home = path.join(root, "home");
  const target = path.join(home, ".config", "opencode", "plugins", "opjev");
  const outside = path.join(root, "outside");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "opencode-jev-free-router" }));
  fs.writeFileSync(path.join(target, "index.ts"), "preexisting index");
  fs.writeFileSync(path.join(target, "tui.ts"), "preexisting tui");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(target, "src"), "dir");

  assert.throws(() => installPluginToHome(home, repo), /source|src|symlink/i);
  assert.equal(fs.readFileSync(path.join(target, "index.ts"), "utf8"), "preexisting index");
  assert.equal(fs.readFileSync(path.join(target, "tui.ts"), "utf8"), "preexisting tui");
  assert.equal(fs.existsSync(path.join(home, "node_modules")), false);
});

test("installer refuses symlinked selected roots before writing outside them", t => {
  const { root, repo } = fixture(t);
  const actualHome = path.join(root, "actual-home");
  const homeLink = path.join(root, "home-link");
  const actualProject = path.join(root, "actual-project");
  const projectLink = path.join(root, "project-link");
  fs.mkdirSync(actualHome);
  fs.mkdirSync(actualProject);
  fs.symlinkSync(actualHome, homeLink, "dir");
  fs.symlinkSync(actualProject, projectLink, "dir");

  assert.throws(() => installPluginToHome(homeLink, repo), /symlink|root|parent/i);
  assert.throws(() => installServerPluginToProject(projectLink, repo), /symlink|root|parent/i);
  assert.equal(fs.existsSync(path.join(actualHome, ".config", "opencode", "plugins", "opjev")), false);
  assert.equal(fs.existsSync(path.join(actualProject, "plugins", "opencode-jev-free-router")), false);
  assert.equal(fs.existsSync(path.join(actualHome, "node_modules")), false);
});
