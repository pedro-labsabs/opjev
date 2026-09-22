# Research: Deterministic TUI-owned prompt admission (spike #22)

- Date: 2026-09-22
- Issue: pedro-labsabs/opjev#22 — `[READY] Spike: deterministic admission via TUI-owned prompt submission`
- Branch: `spike/tui-deterministic-admission`
- Base SHA: `a74d3b5c34f49b5bf8b7fc16d7b68a5a6cb3567b` (`main`)
- **Verdict: NO-GO**

This is a spike document. No production code was written, and none of this is an
implementation of #13 or #14.

---

## 1. Verdict

**NO-GO.**

An external OpenCode TUI plugin cannot, with the public APIs of the installed
runtime, both (a) own prompt submission before the native submit and (b) read the
native composer input. Without (b) there is no way to admit the original user
text deterministically, and without (a) the parent model always receives a
normal turn.

The two failure points are independent; either one alone is a NO-GO criterion
from issue #22 §27:

1. **No public access to the composer input** (`não há acesso público ao input`).
2. **External plugin cannot own submit** (`external plugin não consegue possuir submit`).

Recommendation (explicit): **activate #24 gateway**.

---

## 2. Runtime authority

The authority for this spike is the runtime installed on this machine, not the
upstream `dev` branch.

| Item | Real value |
| --- | --- |
| `which opencode` | `/home/codespace/.opencode/bin/opencode` |
| `opencode --version` | `v2.0.13` |
| Binary | ELF 64-bit x86-64, 200,639,968 bytes, not stripped |
| Wrapper | `/home/codespace/.opencode/bin/opencode2` → `exec .../opencode "$@"` |
| TUI plugin package (project dependency) | `@opencode/plugin@2.0.7` |
| TUI subpath export | `@opencode/plugin/tui` → `./dist/tui/index.js` |
| Public symbols injected by host | `Plugin`, `PluginContextProvider`, `usePlugin` |

The historical expectation in the issue was `/home/pedro/.opencode/bin/opencode`
`v2.0.11`. The real machine differs; **the real values above are authoritative**
and were used throughout.

The host injects the TUI module into plugin scope rather than resolving the
package:

```js
GW({additional:{"@opencode/plugin/tui":{Plugin:Bf,PluginContextProvider:Vl,usePlugin:R1}}});
```

Plugin entrypoint resolution (binary, verbatim):

```js
return { server: n(["server",""]), tui: n(["tui"]), rpc: n(["rpc"]) };
```

So a plugin package may provide `index`/`server`, `tui`, and `rpc` entrypoints.
A local plugin directory is resolved as `directory/server|index`,
`directory/tui`, `directory/rpc`.

---

## 3. Real API surface (contract found)

### 3.1 TUI plugin `Context` — declared

From `@opencode/plugin@2.0.7` `dist/tui/context.d.ts`:

```ts
export interface Context {
  readonly options: Readonly<Record<string, any>>;
  readonly location: LocationRef | undefined;
  readonly app: App;
  readonly renderer: CliRenderer;
  readonly client: OpenCodeClient;
  readonly data: Data;
  readonly attention: Attention;
  readonly theme: ResolvedTheme;
  readonly themeMode: "dark" | "light";
  readonly markdown: { registerCodeBlockRenderer(...): () => void };
  readonly keymap: Keymap;
  readonly storage: Storage;
  readonly ui: UI;
}
```

### 3.2 TUI plugin `Context` — observed at runtime

Enumerated from the live TUI (`Object.getOwnPropertyNames` plus prototype
chain), identical to the declared type:

```
CTX_KEYS = options, location, app, renderer, client, data, attention,
           theme, themeMode, markdown, keymap, storage, ui
UI_KEYS  = dialog, toast, format, router, panel, tabs, slot
KEYMAP_KEYS = layer, dispatch, shortcuts, commands, pending, active, mode
```

Runtime construction in the binary matches:

```js
client:n.client.api, data:n.data, attention:n.attention,
markdown:{registerCodeBlockRenderer(...)},
keymap:{layer:pe.createLayer, dispatch:n.keymap.dispatch,
        shortcuts:n.shortcuts.list, commands:n.keymapState.commands,
        pending:n.keymapState.pending, active:n.keymapState.active,
        mode:n.keymap.mode},
storage:{...}, ui:{dialog:l, toast:p, format:{path}, router:{...}, ...}
```

### 3.3 `Keymap`

```ts
layer(input: () => KeymapLayer): void;   // "owned by the calling component"
dispatch(id: string, input?: string): void;
shortcuts(id: string): readonly string[];
commands(): readonly KeymapCommand[];
pending(): readonly KeymapPending[];
active(): readonly KeymapActive[];
mode: { current(): string; push(mode: string): () => void };

interface KeymapLayer {
  mode?: string;       // defaults to base; "global" opts out
  enabled?: boolean | (() => boolean);
  target?: () => Renderable | null | undefined;
  priority?: number;
  commands?: readonly KeymapCommand[];
  bindings?: readonly string[];   // ids whose configured bindings are active
}
interface KeymapCommand {
  id?: string;                 // omit for an inline command
  bind?: false | string;       // automatic binding
  run: (input?: string, event?: KeyEvent) => void | false | Promise<void>;
}
```

### 3.4 Published slot paths

Declared `SlotMap` (identical in the host binary, e.g. `path:"session.composer.top"`):

```
app
home.footer, home.footer.status
prompt.footer, prompt.footer.status, prompt.footer.file
session.composer.top          ({sessionID})
session.panel                 (PanelInput)
sidebar.content, sidebar.footer
```

Slot claim semantics: `prepend | append | before | after | replace`. A claim at
an unpublished path degrades — additive claims fall back to the nearest
surviving ancestor, **replacement claims are suppressed**. This behaviour was
used as the existence probe described in §5.2.

---

## 4. Answers to the specific concepts raised in #22

| Concept from the issue | Status in v2.0.13 |
| --- | --- |
| `TuiPromptRef { current, set, reset, blur, focus, submit }` | **Does not exist.** `grep -c TuiPrompt` in the binary = 0. |
| Host-internal `PromptRef` | Exists, but private: a minified Solid context `{ get current(); set(i) }`. Not exported to plugins; reachable only by reaching into host internals (forbidden). |
| `session_prompt` slot | **Does not exist.** `session_prompt` in the binary is the RPC method key mapping to `"session/prompt"` (an HTTP/RPC endpoint), not a UI slot. |
| `mode="replace"` | Exists as generic slot semantics, but there is no prompt/composer slot to replace. |
| `api.ui.Prompt` | **Does not exist.** Runtime `UI_KEYS` = dialog, toast, format, router, panel, tabs, slot. |
| `prompt.submit` semantic command | Exists as a command id, but its default binding is `"none"`; `keymap.shortcuts("prompt.submit")` returns `[]` at runtime. It is not on the Return path. |
| `api.keymap` | Named `context.keymap` (see §3.3). |
| `api.client` | Named `context.client` (`OpenCodeClient`). |
| Plugin RPC | **Exists** (see §6). |

### 4.1 What actually owns Return

Runtime shortcuts (read from `context.keymap.shortcuts`):

```
prompt.submit   -> []
prompt.queue    -> []  (home) / ["ctrl+x enter"] (session)
input.submit    -> ["enter", "alt+enter", "alt+kpenter"]
input.newline   -> ["shift+enter","ctrl+enter","alt+enter","ctrl+j","enter","kpenter","linefeed"]
session.interrupt -> ["escape"]
```

`keymap.active()` on the composer:

```
{"key":"enter","description":"Submit input","group":"Text Editing"}
```

`keymap.commands()` includes `prompt.submit` (palette/dispatch only) and
`input.submit`. So **Return is owned by the input layer through `input.submit`**,
and `input.newline` is bound to the same key — meaning the input layer itself
decides newline vs submit.

---

## 5. Runtime experiments

All experiments ran against the real `opencode` TUI (v2.0.13) in a PTY, in a
throwaway project directory, with an **external, temporary plugin**:

```
/tmp/opjev-tui-spike-a74d3b5/
  opencode.jsonc                      { "plugins": [{ "package": "./plugins/spike-admission" }] }
  plugins/spike-admission/{index.ts,tui.ts,package.json}
  drive.py                            PTY driver (boot / enter / rounds / ctrl+g probe)
  tui.log                             JSONL instrumentation
```

No file in the `opjev` package was modified while capability was unproven.

### 5.0 Plugin loading (control)

`opencode plugin list` (from the spike project, `--log-level debug`):

```
ID                      VERSION  SOURCE
spike.admission.server  local    /tmp/opjev-tui-spike-a74d3b5/plugins/spike-admission/index.ts
```

The TUI plugin setup ran (`SETUP_BEGIN` … `SETUP_END`) and emitted `CLEANUP` on
exit, proving it was loaded and unmounted by the real TUI.

### 5.1 Candidate A — keymap ownership of submit

Registration context matters: calling `keymap.layer()` from `setup()` throws

```
LAYER_THREW  Error: Keymap.Provider is missing
```

so layers must be registered from inside a rendered slot. The spike registered
layers from an `append: "prompt.footer"` slot render, where registration
succeeds (`LAYER_OK`).

Variants tested, each registered as its own layer:

| Variant | Shape |
| --- | --- |
| V0 (control) | inline command, `bind: "ctrl+g"`, mode `global`, priority 1000 |
| V0b (control) | inline command, `bind: "alt+enter"`, mode `global`, priority 1000 |
| V1 | inline (no id), `bind` = `enter` or `return`, priority 1000 |
| V2 | named `spike.enter` + `bindings:["spike.enter"]`, priority 999 |
| V3 | **shadow the native command**: `id:"input.submit"` + own `run`, priority 998 |

Matrix run:

- `mode: "global"` and `mode: "base"` (current mode observed as `"base"`)
- `bind: "enter"` and `bind: "return"` (both canonical spellings)
- home prompt and session prompt (2 rounds: first Enter creates the session,
  second Enter submits inside it)

Results:

| Observation | Value |
| --- | --- |
| `LAYER_OK` for every variant/mode/bind | yes (no throw) |
| `SPIKE_ENTER_OWNED` fired | **never** (`owned: 0` in every run) |
| V0 control (`ctrl+g`) fired | **never** |
| `keymap.commands()` contains any `spike*` | **no** — `{"spike":[],"inputSubmit":true,"promptSubmit":true,"total":103}` |
| `keymap.shortcuts("spike.enter")` | `[]` immediately **and** 1.5 s deferred |
| `keymap.dispatch("spike.enter")` | returns without error, `run` never executes |
| native submit on every Enter | **yes** |

Native evidence that submit still ran (representative run):

```
session.created
session.inbox.enqueued
session.execution.started
session.inbox.delivered
session.step.started
... session.execution.succeeded
```

Two rounds produced two `session.inbox.enqueued` events while the plugin
counter stayed at 0.

**Candidate A result: FAIL.** The plugin's commands never become reachable and
never receive the key, so submit cannot be owned, and native submit always runs
alongside.

Disclosure for skeptical review: registration returns no error yet never
produces a reachable command. The most likely reading is that plugin keymap
layers are not consulted by host dispatch in v2.0.13 (or are scoped away from
the input layer). An earlier iteration of this instrument removed a re-render
guard, which produced a reactive feedback loop (register inside render →
re-render → re-register); that was an instrumentation bug in the spike harness,
not a product finding, and was reverted. The results above are from the guarded
harness.

Crucially, **the verdict does not depend on this ambiguity**: even if keymap
ownership were made to work, failure #2 below is independently fatal.

### 5.2 Candidate B — `session_prompt` replacement reusing `api.ui.Prompt`

Existence probe design: replacements at unpublished paths are suppressed, so a
render callback firing proves the path is real. A known-good path is used as the
positive control.

Claimed inside a real session (after the first Enter created it):

| Path | `replace` claim | Rendered? |
| --- | --- | --- |
| `session.composer.top` (control) | accepted | **yes** → `SLOT_EXISTS` |
| `session_prompt` | accepted | **no** → not published |
| `session.composer` | accepted | **no** → not published |
| `session.prompt` | accepted | **no** → not published |
| `prompt` | accepted | **no** → not published |

Also probed on the home screen: `prompt.input`, `prompt.composer` — not
published; `prompt.footer` (control) — published.

**Candidate B result: FAIL.** There is no `session_prompt` slot, no slot that
owns the composer, and no `api.ui.Prompt` component to render. The only
composer-adjacent slot is `session.composer.top`, which sits *above* the
composer and receives only `{ sessionID }` — it exposes no input state and no
submit action.

---

## 6. TUI → opjev server seam (investigated, not the blocker)

Issue #22 §11/§12 asks whether a public programmatic path exists.

**Yes — official plugin RPC exists in the installed SDK:**

- Entrypoint: a plugin package may provide an `rpc` entrypoint
  (`n(["rpc"])` in the resolver above).
- Definition/handlers: `@opencode/schema/rpc` → `Rpc.Definition`,
  `Rpc.define()`.
- Registration (server side): `RpcDomain.register(definition, handlers)` and
  `RpcRegistration.events.emit`.
- Invocation (client side): `@opencode/client` →
  `client.rpc(definition).<method>(input, { signal })`, plus
  `client.rpc(definition).events.on(...)`.
- Wire: `rpc: { call(input: RpcCallInput) }` on the generated client.

This seam was **not exercised end-to-end**, because the spike terminated earlier
at the admission gate (§5.1, §5.2). It is recorded so that #13/#24 do not assume
the seam is missing: the *communication* path is available; the *admission*
path is not.

### `noReply` / `resume`

- `noReply` **does not exist** anywhere in `@opencode/protocol`.
- `resume?: boolean` exists on:
  - `POST /api/session/:sessionID/prompt` — body `{ metadata?, delivery?: "steer"|"queue", resume?: boolean, text, files }`
  - `POST /api/session/:sessionID/synthetic` — `{ text, description?, metadata?, delivery?: "steer"|"queue", resume?: boolean }`
  - `POST /api/session/:sessionID/interrupt` — query `resume?: boolean`
- Runtime effect of `resume: false` was **not exercised** (not needed once the
  gate failed). Its semantics are therefore unproven and must not be assumed by #13.

---

## 7. How much of the composer would have to be copied

Because no slot owns the composer and no `Prompt` component is exported, the
only way to keep a TUI-controlled input would be to render our own input
component and reimplement, at minimum:

autocomplete, attachments/parts, extmarks, `@file` expansion, agent mentions,
paste handling, prompt history, stash, shell mode, editor integration, prompt
commands, model/agent UI, and the input layer's newline-vs-submit resolution.

That is the entire composer. This is far beyond the maintenance budget in #22 §8
and is explicitly the "PARE" condition. We did **not** attempt any of it: **the
composer was copied zero bytes.**

Reaching instead for the host-internal `PromptRef` context or walking
`context.renderer` to find the composer renderable would be a private-API /
monkeypatch route, which #22 §27 forbids. It was deliberately not taken.

---

## 8. Hard-gate outcome

The hard gate requires runtime proof of:

| Gate | Result |
| --- | --- |
| parent direct execution canary = 0 | **FAIL** — native submit executed; `session.execution.started` / `session.execution.succeeded` observed, plugin ownership = 0 |
| worker/orchestration canary = 1 | **not reached** — no admission path exists |
| orchestration run count = 1 | **not reached** |

Required constraints were respected while producing this verdict:

| Constraint | Held? |
| --- | --- |
| no text trampoline | yes |
| no prompt engineering | yes |
| no patch to OpenCode | yes |
| no monkeypatch | yes |
| no private API import | yes (only `Context` public members were touched) |
| no `node_modules` modification | yes |
| no binary patch | yes |
| no material composer reimplementation | yes (0 bytes copied) |
| no model/launcher compliance | yes |

Marker-file canaries (`parent.marker` / `worker.marker`) were not constructed,
because the spike terminated at the capability gate before any orchestration
path could be entered. The event-stream evidence above is the equivalent proof
that the parent path still executes.

---

## 9. Real runtime evidence

| Field | Value |
| --- | --- |
| OpenCode version | `v2.0.13` |
| Binary | `/home/codespace/.opencode/bin/opencode` |
| TUI plugin package/version | `@opencode/plugin@2.0.7`, export `./tui` |
| TUI plugin load evidence | `SETUP_BEGIN`/`SETUP_END`/`CLEANUP` JSONL; `opencode plugin list` shows `spike.admission.server` from the local spike directory |
| Session IDs observed | `ses_f36c8f540ffevmFEZbwgJ8sLcJ` (title `Greeting with Spike`) and further throwaway sessions created by repeated Enter presses |
| Submission mode | normal native submit (home prompt and session prompt) |
| Native submit count | 1 per Enter press, in every run |
| Parent execution | started + succeeded in run 1; started in later runs |
| opjev orchestration run count | 0 (no admission path) |
| Worker session / critic session / worker canary | not reached |
| Classification | **real OpenCode TUI/runtime** + real probe of the installed plugin SDK. No SystemOne/Jev stub was used, because no orchestration branch could be selected — there was no branch to select. |

---

## 10. NO-GO criteria hit

From #22 §27:

- [x] external plugin cannot own submit — §5.1
- [x] no public access to the input — §3.2, §5.1
- [ ] native prompt command always executes as well — effectively yes: native
      submit executed on every Enter while the plugin never ran (§5.1)
- [ ] public TUI→opjev path missing — **not hit**: RPC seam exists (§6)
- [ ] would need to copy the composer materially — hit only as the hypothetical
      alternative to missing input access (§7)
- [x] would need monkeypatch / private API to get the input (§7)
- [ ] would need to modify OpenCode — not required, because we stopped
- [x] would depend on launcher/model compliance — the only fallback left would
      be a prompt-based trampoline, which is explicitly forbidden

Two independent hard criteria are sufficient for **NO-GO**.

---

## 11. Recommendation

**Activate #24 gateway.**

Rationale: deterministic admission requires owning the submit *and* reading the
composer input. The installed OpenCode TUI plugin API exposes neither. The
missing pieces are host-side capabilities (a prompt input accessor and/or a
composer slot plus a real `Prompt` component), not something opjev can build
without forking or reimplementing the TUI.

Suggested follow-ups, for the maintainer to weigh:

- Re-evaluate when a future OpenCode exposes a `TuiPromptRef`-style accessor or
  a `session_prompt`-like composer slot. The concepts named in #22 appear to
  come from upstream `dev`, not from v2.0.13.
- Verify whether plugin keymap layers are intended to be reachable at all; if
  they are, that is an upstream bug worth reporting independently.
- Treat the TUI→server RPC seam (§6) as available infrastructure for whatever
  design #24 or a future #13 adopts.

The maintainer decides the final classification of #22, whether #24 is released,
and any change to #13/#14.

---

## 12. Conflicting prior spike claim (PR #25) — read before merging

While pushing this branch, it was discovered that `spike/tui-deterministic-admission`
**already existed on the remote**, with three commits on the same base
(`a74d3b5`), and **PR #25** already open against it (review status:
*changes requested*).

That prior work is **not** reconciled with this one, and it disagrees with the
runtime measured here:

| | Prior work (branch / PR #25) | This spike |
| --- | --- | --- |
| Document verdict | **PASS** | **NO-GO** |
| PR body verdict | **NO-GO** (contradicts its own committed doc) | **NO-GO** |
| OpenCode | `/home/pedro/.opencode/bin/opencode` **v2.0.11** | `/home/codespace/.opencode/bin/opencode` **v2.0.13** |
| Node | v22 | (host runtime) |
| Keymap package | `@opentui/keymap` 0.4.5 | (keymap is host-internal) |

The prior document's PASS rests on the prompt component owning Return through a
`return` → `prompt.submit` layer that a plugin layer at `priority: 1000` can
shadow, with `dispatch("prompt.submit")` as pass-through.

**On the runtime installed here that premise does not hold:**

- `keymap.shortcuts("prompt.submit")` → `[]` (no binding at all)
- `keymap.shortcuts("input.submit")` → `["enter", "alt+enter", "alt+kpenter"]`
- `keymap.active()` → `{"key":"enter","description":"Submit input"}`
- plugin layers register without error but never become reachable and never
  fire (`owned: 0`) while native submit executes on every Enter (§5.1)

This is most likely a **behavioural difference between v2.0.11 and v2.0.13**
(input layer now owns `enter` via `input.submit`). It is *not* an argument that
either run is wrong — but it does mean **the PASS claim cannot be reproduced on
v2.0.13**, which is the authority for this spike.

Two independent items for the maintainer:

1. PR #25 is self-contradictory (body NO-GO, committed document PASS) and was
   already under review with changes requested — it was deliberately left
   untouched by this run (no force-push, no rebase, no added commits).
2. Whichever verdict survives, **input access remains absent on v2.0.13** (§3.2),
   so even a working keymap shadow would not yield deterministic admission of
   the original text.

This spike therefore stands as an independent, reproducible **NO-GO** on the
runtime actually installed, and recommends **#24** either way.
