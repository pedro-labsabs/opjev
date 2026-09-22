# Research: Deterministic TUI-owned prompt admission (spike #22)

- Date: 2026-09-22
- Issue: pedro-labsabs/opjev#22 — `[READY] Spike: deterministic admission via TUI-owned prompt submission`
- Branch: `spike/tui-deterministic-admission-v213`
- Base SHA: `a74d3b5c34f49b5bf8b7fc16d7b68a5a6cb3567b` (`main`)
- Head at review: `6434e9903cc1e2280f9b6f94246794e420bcd19c` (first draft of this document)
- Runtimes measured in this revision: OpenCode **v2.0.11** (authoritative per #13/#22) **and** v2.0.13 (cross-version replication), `@opencode/plugin@2.0.7`
- **Verdict: NO-GO for #22 — proven on the authoritative v2.0.11 runtime.**
  Fatal capability: **no public access to the composer/prompt input** while submit is owned.
  Submit ownership itself **works** (on both v2.0.11 and v2.0.13 — see §10).

This is a spike document. No production code was written, and none of this is an
implementation of #13 or #14.

---

## 1. Verdict

**NO-GO for #22**, established on the runtime #13/#22 designate as authoritative
(OpenCode v2.0.11 / `@opencode/plugin` 2.0.7), using only public APIs in a
real TUI on a real PTY:

An external TUI plugin **can** own the native submit (revalidating PR #25's
primitive), **can** obtain session identity, **can** reach the server over the
public plugin-RPC seam, and **can** persist a prompt without waking the parent
(`session.prompt({ resume: false })`). But it **cannot read the current
composer/prompt text through any public surface**. Without the original text,
deterministic admission of exactly that input is impossible:

```
eligible input
→ TUI owns submit                 ✅ proven (v2.0.11 and v2.0.13)
→ plugin reads exactly the input  ❌ FATAL — no public accessor exists (both runtimes)
→ public call to control plane    ✅ proven (plugin RPC round trip)
→ parent execution = 0            ✅ mechanism proven (prompt { resume:false })
→ orchestration run = 1 / worker = 1   not reached — spike stops at the input gate
```

One missing capability is sufficient for NO-GO under #22. The only routes left
to obtain the text — walking the host render tree to the composer, or
reimplementing the composer — are the forbidden/private or explicit "PARE"
conditions of #22 §8/§27.

**Recommendation: activate #24** (gateway/front-controller), justified by this
v2.0.11 result — the gateway intercepts at the HTTP boundary, where the prompt
text is public and the parent can be kept at zero execution (the
`resume: false` mechanism proven in §6.7). Final activation of #24 remains the
maintainer's decision; this PR does not modify #24, #13, or #14.

---

## 2. Runtime authority and environments

#13 records OpenCode **v2.0.11 / `@opencode/plugin` 2.0.7** as the blocked
runtime, and the maintainer packet on #22 says the exact installed v2.0.11
behavior is the authority. This revision therefore **reproduces v2.0.11
directly** and reports v2.0.13 only as cross-version evidence.

| Item | Runtime A (authority) | Runtime B (cross-version) |
| --- | --- | --- |
| How obtained | `npm pack @opencode/cli-linux-x64@2.0.11` → extracted to `/tmp/opencode-2.0.11/package/bin/opencode` (no global install; machine binary untouched) | `/home/codespace/.opencode/bin/opencode` (pre-installed) |
| `--version` | `opencode v2.0.11` | `opencode v2.0.13` |
| Binary size | 200,508,896 bytes | 200,639,968 bytes |
| sha256 | `0ed7d8546cf24acc41e6371ec30928ed931ec1474e1a54bbecdde8e0dd801d2f` | `4fdda35899910a5d3d68edf9eecd98163252786f1df2dc06436a78dc65e8e390` |
| npm integrity (source) | `sha512-L+OgUSSTSu6chQrqL19boZ+xXxOzmETXwoKFXi/Pzpu79MRSuZkfPsunIBrf68qAIkgDaTC8HUXNvLZ80ZBLvQ==` | (pre-installed image) |
| Version asserted in-process | `ctx.app.version = "2.0.11"` (plugin log `SETUP_BEGIN`) | `ctx.app.version = "2.0.13"` |
| Isolation | separate `HOME=/tmp/opjev-v211-home`, `--standalone`, throwaway project dir | separate `HOME=/tmp/opjev-v213-home`, `--standalone`, throwaway project dir |
| Plugin SDK (both) | `@opencode/plugin@2.0.7` typings; host injects `@opencode/plugin/tui` module | same |

The machine binary, global `~/.opencode`, global services, `node_modules`, and
OpenCode itself were **not modified**. All harness material lives under `/tmp`
outside the project tree.

Observed in both isolated homes: no `auth.json` anywhere and no
`OPENCODE_API_KEY` in the environment, yet parent executions produced real
model output (reasoning/usage events, model shown as "Zen"). The exact auth
path was not investigated — it does not affect the capability gates; the
observed fact is that **real parent executions occurred**, which makes the
parent-execution canaries meaningful.

---

## 3. Corrections applied to the first draft of this document (maintainer
REQUEST CHANGES, `#issuecomment-5777373135`)

| Review item | Correction |
| --- | --- |
| Runtime authority: v2.0.13 was used to classify #22 globally | v2.0.11 was obtained and executed (§2); the fatal capability result is now proven **on v2.0.11**; v2.0.13 is retained as cross-version replication only |
| "Do not activate #24 as the outcome of #22 yet" | The NO-GO now rests on v2.0.11 evidence (§1, §6.8, §8); #24 is recommended for that reason. No issue/roadmap state was modified by this PR |
| Document header said branch `spike/tui-deterministic-admission` | Fixed: `spike/tui-deterministic-admission-v213` |
| Do not collapse v2.0.11/v2.0.13 findings | Every runtime-specific result is tabulated per runtime (§7); PR #25's v2.0.11 submit-ownership primitive is reproduced, not contradicted; the draft's v2.0.13-specific ownership FAIL is reclassified after failing to reproduce (§10) |
| "external plugin cannot own submit" (draft §5.1, v2.0.13) | **Not reproduced.** With this harness, submit ownership works on **both** runtimes (§6.2, §10). The draft's variant-matrix failure appears harness/registration-specific; root cause not established |
| `resume`/`noReply` "not exercised" | Now exercised: `prompt { resume:false }` and `synthetic { resume:false }` persist without parent execution on both runtimes; `noReply` confirmed absent from both binaries and from `@opencode/protocol` (§6.7) |
| TUI→server RPC "investigated, not exercised" | Now exercised end-to-end on both runtimes (§6.6) |
| Evidence not independently re-executed at the reviewed head | All four runs (v2.0.11 ×2, v2.0.13 ×2) were **re-executed from scratch** during final verification; original logs archived at `<harness>/prev-20260922/`; every outcome reproduced (§13) |

---

## 4. Provenance of the #22 contract concepts (`TuiPromptRef`,
`session_prompt`, `promptAsync{noReply}`)

The hypothesis in #22 names `TuiPromptRef { current, set, reset, blur, focus,
submit }`, a `session_prompt` slot with `mode="replace"`, and (from PR #25's
`FINAL-REPORT.md`) `session.promptAsync({ noReply: true })`. None exist in the
2.0.x line. Where they come from:

- `TuiPromptRef` and the `session_prompt` / `session_prompt_right` slots exist
  in the **legacy 1.x typings**: `@opencode-ai/plugin@1.18.31`
  (`dist/tui.d.ts` lines 141, 155, 360, 363, 370 — `ref?: (ref: TuiPromptRef |
  undefined) => void`). PR #25's `FINAL-REPORT.md` cites
  `/home/pedro/.opencode/node_modules/@opencode-ai/plugin/dist/tui.d.ts` — that
  is this legacy package, not the runtime's contract.
- `promptAsync` / `noReply` come from the legacy `@opencode-ai/sdk` typings
  cited by PR #25 (`SessionPromptAsync`, `TuiSubmitPrompt`).
- Static probe of the **actual binaries** (re-run during final verification):
  `grep -a -o -F <sym> | wc -l` gives `TuiPromptRef: 0`, `noReply: 0`,
  `promptAsync: 0` on **both** v2.0.11 and v2.0.13. `session_prompt` appears on
  3 lines (6 occurrences) in each binary — every occurrence is the RPC method
  key `session_prompt: "session/prompt"` and its aliases/usages of that key
  (`prompt: p.session_prompt`, `request(p.session_prompt, …)`), never a UI slot.
- The current public typings `@opencode/plugin@2.0.7` (`dist/tui/context.d.ts`)
  match the runtime surface exactly on both versions (§5).

So the contract language in #22's research packet describes a 1.x-era (or
upstream `dev`) API that the authoritative 2.0.11 runtime never had. The spike
therefore tested *capabilities*, not names.

---

## 5. Real public API surface (identical on v2.0.11 and v2.0.13)

### 5.1 TUI plugin `Context` — runtime-observed

Enumerated live from inside the TUI (`Object.getOwnPropertyNames` plus
prototype), for both runtimes:

```
CTX_KEYS   = options, location, app, renderer, client, data, attention,
             theme, themeMode, markdown, keymap, storage, ui
UI_KEYS    = dialog, toast, format, router, panel, tabs, slot
KEYMAP_KEYS= layer, dispatch, shortcuts, commands, pending, active, mode
DATA_KEYS  = on, listen, session, project, shell, location
CLIENT_KEYS(own) = server, location, agent, plugin, session, message, model,
             generate, provider, integration, mcp, credential, project, form,
             permission, file, command, skill, rpc, event, pty, experimental,
             shell, reference, worktree, vcs, debug, migration, websearch, config
```

A case-insensitive scan for `prompt|composer|input|text` across the own keys of
`ctx`, `ctx.ui`, `ctx.data`, `ctx.client` returned **`[]` on all four roots on
both runtimes**; `typeof ctx.ui.Prompt === "undefined"`. The host-side
construction in both binaries builds exactly these members (verbatim from the
binary: `options:…, get location(){…}, app:{…}, renderer:…, client:…, data:…,
attention:…, get theme(){…}, get themeMode(){…}, markdown:{…}, keymap:{…},
storage:{…}, ui:{dialog, toast, format, router, panel, tabs, slot}`). No
`prompt` member exists on either runtime.

(The member list is as built by the host — the binaries contain the minified
construction expression `ui:{dialog:l,toast:p,format:{…},router:{register(y){…}}
…` on both versions; the full runtime enumeration above confirms the complete
member set.)

`ctx.options` was `{}` in the throwaway project (no plugin options passed).

### 5.2 `Keymap` (public typings `@opencode/plugin@2.0.7`)

```ts
layer(input: () => KeymapLayer): void;   // reactive; owned by calling component
dispatch(id: string, input?: string): void;
shortcuts(id: string): readonly string[];
commands(): readonly KeymapCommand[];  pending(): …;  active(): …;
mode: { current(): string; push(mode: string): () => void }

KeymapCommand.run: (input?: string, event?: KeyEvent) => void | false | Promise<void>
```

Runtime shortcut values at setup — **identical on both runtimes**:

```
prompt.submit   -> []
input.submit    -> ["enter", "alt+enter", "alt+kpenter"]
input.newline   -> ["shift+enter","ctrl+enter","alt+enter","ctrl+j","enter","kpenter","linefeed"]
prompt.queue    -> ["ctrl+x enter", "ctrl+x enter"]
```

### 5.3 Published slot paths (public `SlotMap`)

```
app
home.footer, home.footer.status
prompt.footer, prompt.footer.status, prompt.footer.file      ({sessionID?}, mode, showDetails)
session.composer.top                                         ({sessionID})
session.panel, sidebar.content, sidebar.footer
```

Replacement claims at unpublished paths are suppressed (documented degrade
behaviour); this was used as the existence probe (§6.4).

---

## 6. Runtime experiments

Both runs used the same harness, differing only in binary and `HOME`:

```
/tmp/opjev-v211-spike/   (and /tmp/opjev-v213-spike/)
  opencode.json                     { "plugins": [{ "package": "./plugins/spike-admission" }] }
  mode                              orchestrate | normal | shadow  (read per keypress)
  plugins/spike-admission/
    package.json  spike-def.ts      shared Rpc definition (zod, StandardSchema)
    index.ts                       server entrypoint: ctx.rpc.register(...) + JSONL log
    tui.ts                          TUI entrypoint: all probes, JSONL log
  drive.py                          PTY driver (boot → type marker → Enter per mode → exit)
  drive_shadow.py                   PTY driver for the shadow-only run
  tui.log / server.log / pty.out    raw evidence (JSONL + terminal capture)
```

Design essentials (reproducible):

- Layers are registered **inside the render of an `append: "app"` slot claim**
  (calling `keymap.layer()` from `setup()` throws `Keymap.Provider is missing`),
  with a re-render guard.
- Layer A: `priority: 1000`, commands
  `[{ id:"spike.enter", bind:"return", run }, { id:"spike.ctrlg", bind:"ctrl+g", run }]`.
- Layer B: `priority: 998`, `[{ id:"input.submit", run: shadowRun }]` — shadows
  the native command id; `run` returns `false` to continue (fall through).
- A single `ctx.data.listen(...)` tap records every host event with timestamp
  and session id — the parent-execution canary.
- Mode file read on each keypress: `orchestrate` = own and suppress;
  `normal` = own and `ctx.keymap.dispatch("prompt.submit")`;
  `shadow` = return `false` and let layer B + native continue.
- Persistence probes (§6.7) create their **own** sessions via
  `ctx.client.session.*`, so they never mix with the UI session's canaries.
- Runner: `python3 drive.py` →
  `opencode --standalone --print-logs --log-level error` in the spike dir, fresh
  `HOME`, 140×42 PTY, typed `SPIKE211-ORCH-MARKER` → Enter (orchestrate) →
  Enter (inboxrace → native dispatch #1) → typed `SPIKE211-NORMAL-MARKER` →
  Enter (normal → native dispatch #2) → ctrl+g control → exit.

Reproduction commands for the authority runtime:

```bash
mkdir -p /tmp/opencode-2.0.11 && cd /tmp/opencode-2.0.11
npm pack @opencode/cli-linux-x64@2.0.11 && tar xzf opencode-cli-linux-x64-2.0.11.tgz
chmod +x package/bin/opencode && package/bin/opencode --version   # opencode v2.0.11
# static probes:
for s in TuiPromptRef noReply promptAsync; do grep -c -a -F "$s" package/bin/opencode; done  # 0 0 0
grep -a -o -E '.{60}session_prompt.{60}' package/bin/opencode   # RPC key only
```

### 6.0 Control — plugin loading

Both entrypoints loaded and ran: `SERVER_SETUP` (`ctx.rpc` present,
`app.version` matching the binary), `SETUP_BEGIN`/`SETUP_END`, slot claims
accepted, `CLEANUP` on exit. TUI-side version is asserted in-process
(`ctx.app.version` = `2.0.11` / `2.0.13`).

### 6.1 Submit ownership (capability: TUI owns submit) — **PASS on both**

Evidence (fresh reproduction run of 2026-09-22, each runtime; the original run
produced the same outcome and is archived at `<harness>/prev-20260922/`):

| Observation | v2.0.11 | v2.0.13 |
| --- | --- | --- |
| Layers register without throw (`LAYER_A_OK`, `LAYER_B_OK`) | yes | yes |
| Reachability: `keymap.commands()` contains `spike.enter`,`spike.ctrlg` | at t+1.5s, t+5s, t+12s (`spikeEnter:["enter"]`) | same |
| Control `ctrl+g` fired when pressed | `CTRLG_FIRED n=1` | `CTRLG_FIRED n=1` |
| Owned Enter presses | `OWNED n=3` (one per Enter) | `OWNED n=3` |
| `keymap.active()` on composer | first entry `{"key":"enter","title":"spike enter"}` — native `Submit input` displaced | same |
| **Suppression (orchestrate Enter at t≈6.3–6.8 s)** | zero UI-session events for ≈4.2 s (6.32 → 10.50 s); UI session first created at 10.50 s only after the next dispatch (10.34 s) | same pattern: suppressed at 6.80 s, created at 11.03 s (≈4.2 s later) after dispatch at 10.81 s |
| Text survived suppression | yes — the UI session was later created with title `SPIKE211-ORCH-MARKER reference` from the still-held composer text | same (markers per run) |
| **Pass-through (`normal`)** — `dispatch("prompt.submit")` | dispatches=2 → `session.inbox.enqueued` exactly ×2 (10.70 s, 18.40 s) | dispatches=2 → enqueued ×2 (11.18 s, 18.87 s) |
| Recursion | none: `CLEANUP {owned:3, dispatched:2, ctrlG:1}` — counts match inputs exactly | identical |
| Shadow layer (§6.3) | reachable when allowed to run | reachable |

Parent-execution canary during suppression: **no `session.created`, no
`session.inbox.enqueued`, no `session.execution.started` for the UI session**
between the owned Enter and the explicit pass-through dispatch. Each
pass-through produced exactly one native submit. This revalidates PR #25's
primitive on v2.0.11 and shows the same primitive works on v2.0.13 (§10).

### 6.2 Why keyboard dispatch cannot deliver the text

`run(input, event)` on the owned Enter receives `input = undefined`
(`inputType: "undefined"`) and only a `KeyEvent` (`name, ctrl, meta, …`) — on
both runtimes. The composer text is not part of key dispatch.

### 6.3 Command-shadow probe (mode `shadow`, both runtimes)

Layer A returns `false` → layer B (shadowing `input.submit`) runs → returns
`false` → native submit continues:

| Observation | v2.0.11 | v2.0.13 |
| --- | --- | --- |
| `SHADOW_INPUT_SUBMIT` fired | yes (t=7.74 s, same tick as OWNED) | yes (t=6.72 s) |
| `input` argument | **`undefined`** — no composer text | **`undefined`** |
| Native submit afterwards | session created 7.93 s, enqueued 8.21 s, `execution.started` 8.25 s | created 6.87 s, enqueued 7.11 s, `execution.started` 7.11 s |

Even the path that replaces the native submit command receives **no text**.
Text only becomes publicly visible after native submit (the created session /
inbox payload carries it), at which point the parent has already been woken —
so it cannot be used for parent=0 admission.

### 6.4 Slot existence probes (both runtimes — identical outcomes)

10 claims; 4 distinct claims rendered — 5 render events per run
(`prompt.footer` renders twice: home view, then in-session view):

| Claim | Rendered? | Notes |
| --- | --- | --- |
| `append: prompt.footer` (additive control) | **yes** (home: `{mode:"normal", showDetails:true}`; in session: adds `sessionID`) | published |
| `replace: home.footer` (replacement control) | **yes** (`{}`) | published |
| `append: app` (keymap host) | **yes** (`{}`) | published |
| `replace: session.composer.top` (session control) | **yes** (`{sessionID}`) | published; sits above the composer, exposes no input state, no submit action |
| `replace: prompt.input` | no | unpublished |
| `replace: prompt.composer` | no | unpublished |
| `replace: prompt` | no | unpublished |
| `replace: session_prompt` | no | unpublished — the #22 slot does not exist on either runtime |
| `replace: session.composer` | no | unpublished |
| `replace: session.prompt` | no | unpublished |

No slot exposes composer text or a submit action; `api.ui.Prompt` does not
exist (`UI_KEYS` has no `Prompt`; `typeof ctx.ui.Prompt === "undefined"`).

### 6.5 Session identity — **PASS on both**

Publicly available: `ctx.ui.router.current()` → `{type:"session",
sessionID:"ses_…"}`; slot input `{sessionID}` on `session.composer.top` and
`prompt.footer` (in session); `ctx.data.session.list()` (id + title);
`ctx.location` → `{directory, project}`. (Note: at `setup()` time
`router.current()` is `{type:"home"}` — identity is read at submit time.)

### 6.6 TUI → server RPC seam — **PASS on both**

- Server entrypoint: `ctx.rpc.register(SpikeRpc, handlers)` →
  `RPC_REGISTER_OK {keys:["dispose","events"]}`.
- TUI side: `ctx.client.rpc(SpikeRpc).ping({text:"SPIKE211-RPC"})` →
  `TUI_RPC_OK {echo:"SPIKE211-RPC"}` and server log `RPC_PING_RECEIVED`
  (`SPIKE213-*` on the v2.0.13 run).
- `ctx.client.rpc` is a function (raw `rpc.call` also present).

This is the official public seam #22 §11/§12 asked about; it works end-to-end
on the authoritative runtime. The spike does **not** wire opjev's control
plane (that would be #13 production work).

### 6.7 Persist/admit without parent execution — **mechanism exists (both
runtimes)**; post-submit cancel does not

Each probe used a fresh session; parent-execution canary = host events
(`session.execution.started` + reasoning/usage), scanned over the **entire
run**, not just a window.

| Probe | Call | v2.0.11 result | v2.0.13 result |
| --- | --- | --- | --- |
| P1 (control) | `session.prompt({ text })` | enqueued → delivered → **`execution.started`** → reasoning/steps (real model) | same |
| P2 | `session.prompt({ text, resume:false })` | enqueued **only** — no delivery, no execution, ever | same |
| P3 | `session.prompt({ text, delivery:"queue", resume:false })` | enqueued only — no execution | same |
| P4 | `session.synthetic({ text, resume:false })` | enqueued only — no execution | same |
| P5 ×3 | `session.prompt({ text })` then immediate `session.inbox.cancel(...)` | cancel call returned OK, but `execution.started` fired in **3/3**, 0–2 ms after enqueue (delivery in the same window; execution continued despite cancel) | same — 3/3 executions started (0–42 ms after enqueue) |

Conclusions:

- **`resume: false` on the public `session/prompt` and `session/synthetic`
  endpoints persists the input without waking the parent** — the supported
  mechanism #22 asked about (`noReply` does not exist; this is what exists).
  It is accepted and deterministic on both runtimes.
- `inbox.cancel` after a default prompt is **not** a withdraw path: enqueue →
  delivery → execution happens within 0–42 ms in-process (usually ≤1 ms); the
  cancel loses 3/3 on both runtimes and does not stop an already-started
  execution.
- Semantics beyond the observed window (e.g., whether a `resume:false` inbox
  item can be delivered much later, and how a published result would ride on
  it) were **not** probed — out of spike scope once the input gate failed.

Known harness defect (disclosed): the extra "inboxrace" timing probe captured
`router.current()` before the session existed (`sessionID: undefined`), so its
`inbox.list` calls errored 8/8 (`INBOXRACE_LIST_ERR`); the race question it
was meant to answer is instead answered by P5 (correct sid, 3/3). No conclusion
rests on the broken probe.

### 6.8 Composer/input access — **FATAL FAIL on both runtimes**

Attempts made, all public-surface only:

1. Own keys of `ctx`, `ctx.ui`, `ctx.data`, `ctx.client` scanned for
   `prompt|composer|input|text` → `[]` (both runtimes, §5.1).
2. `ctx.ui.Prompt` / `ctx.ui.prompt` → `undefined`; `UI_KEYS` enumerated.
3. Replacement slot probes for every plausible prompt path → suppressed
   (§6.4); the only composer-adjacent slots expose `{sessionID, mode,
   showDetails}` — no text, no submit action.
4. Key dispatch args → `undefined` text (§6.2); command-shadow args →
   `undefined` text (§6.3).
5. `KeyEvent` carries key metadata only (`name, code, sequence, …`) — no text.
6. Pre-execution events carrying text → none observed; the composer text first
   becomes observable server-side **after** native submit (the created session
   carries it in its title; probe results echo `payload.text`), when the parent
   is already executing (P1/P5 timelines). Before that point the only capture
   of the text is the PTY keystroke log, which is the driver's own input.
7. `ctx.storage` enumerates only `store` and `memory` factories
   (`STORAGE_KEYS`) — no prompt/composer member. `ctx.options` was `{}`.
8. `ctx.renderer` is a public member, but walking the host render tree to the
   composer component would rely on undocumented host internals (host component
   names/props/state) — the private-API/monkeypatch route forbidden by #22 §27.
   **Deliberately not taken.**
9. Reimplementing an input to capture text (paste/history/autocomplete/
   extmarks/shell mode/…) is the explicit material-composer-copy "PARE"
   condition of #22 §8. **Not attempted — 0 bytes copied.**

Therefore: **no public path reads or admits exactly the original input while
the plugin owns submit.** This is the capability that closes NO-GO, proven on
the authoritative v2.0.11 runtime and replicated on v2.0.13.

---

## 7. Capability matrix (runtime-proven)

| Capability | v2.0.11 (authority) | v2.0.13 (cross-version) |
| --- | --- | --- |
| Plugin loads in real TUI (PTY) | ✅ | ✅ |
| **Submit ownership** (own, suppress, pass-through exactly once, no recursion) | ✅ PASS | ✅ PASS (see §10 — contradicts the first draft of this doc) |
| Keyboard/shadow dispatch delivers composer text | ❌ (`input` undefined) | ❌ (`input` undefined) |
| **Composer/input access (public)** | ❌ **FATAL** | ❌ |
| `session_prompt` slot / `api.ui.Prompt` / `TuiPromptRef` | ❌ absent (runtime + binary) | ❌ absent (runtime + binary) |
| **Session identity** | ✅ PASS | ✅ PASS |
| **TUI→server RPC** | ✅ PASS (round trip) | ✅ PASS (round trip) |
| **Persist without parent execution** | ✅ PASS via `prompt|synthetic { resume:false }` | ✅ PASS (same) |
| Post-submit `inbox.cancel` prevents execution | ❌ 0/3 | ❌ 0/3 |
| `noReply` / `promptAsync` | ❌ 0 hits in binary & protocol | ❌ 0 hits |

---

## 8. Hard-gate outcome (#22)

| Gate | Result |
| --- | --- |
| eligible input → exactly 1 orchestration run | **not reached** — the original input cannot be read publicly (§6.8); the spike stops at this capability gate |
| parent direct execution canary = 0 | mechanism **proven separately**: suppression yields zero native events (§6.1) and `resume:false` yields zero executions (§6.7). Not composed into the chain, because the chain cannot be entered without the input |
| worker/orchestration canary = 1 | not reached (spike terminated at the input gate; wiring opjev would be #13 work) |
| no text trampoline | ✅ held |
| no OpenCode patch / no private API / no monkeypatch | ✅ held (renderer-walk explicitly refused) |
| no `node_modules`/binary modification | ✅ held (v2.0.11 fetched to `/tmp`; harness outside the project) |
| no material composer reimplementation | ✅ held — 0 bytes copied; the copy would be the NO-GO condition itself |
| same-turn duplicate → 1 run / awaiting-human no auto-resume | not tested — unreachable after the capability gate |

Marker-file canaries (`parent.marker` / `worker.marker`) were not constructed;
host event streams serve as the canary, as in the first draft.

---

## 9. NO-GO criteria from #22, re-evaluated against evidence

- [ ] external plugin cannot own submit — **NOT met**: ownership works on both
      runtimes (§6.1); the first draft's v2.0.13 failure did not reproduce (§10)
- [x] **no public access to the input — MET on v2.0.11 (§6.8), replicated on
      v2.0.13**
- [ ] native command always executes as well — not met: owned Enter suppressed
      it deterministically (§6.1)
- [ ] public TUI→opjev path missing — NOT met: RPC seam proven (§6.6)
- [x] would need to copy the composer materially — met as the *only* remaining
      alternative to the missing accessor (§6.8 item 9)
- [x] would need monkeypatch / private API to get the input — met as the other
      remaining alternative (renderer walk; refused) (§6.8 item 8)
- [ ] would need to modify OpenCode — not required (spike stopped)
- [x] would depend on launcher/model compliance — the only fallback left is a
      prompt-based trampoline, explicitly forbidden

Two hard criteria are met (input access; copy-or-private-API to obtain it);
either is sufficient for NO-GO under #22.

---

## 10. Cross-version reconciliation (PR #25, this spike's first draft, this
revision)

| | PR #25 (v2.0.11, other machine) | First draft of this PR (v2.0.13) | This revision (both, same harness) |
| --- | --- | --- | --- |
| Submit ownership | **PASS** (runtime, PTY) | **FAIL** (`owned:0`, controls never fired) | **PASS on both** (owned 3/3, ctrl+g control fired, suppression held, exactly-once pass-through) |
| Composer/input access | unproven (`TuiPromptRef.current.text` assumed from legacy typings) | FAIL (no accessor) | **FAIL — proven** by enumeration + slots + dispatch/shadow args (both runtimes) |
| Session identity | limitation (`location` timing) | n/a | PASS (router/slots/data/location) |
| TUI→server RPC | future work | seam exists, not exercised | **proven end-to-end** (both) |
| Persist w/o parent exec | claimed `promptAsync{noReply}` (does not exist) | not exercised | **proven** via `prompt|synthetic { resume:false }`; `noReply` 0 hits |
| Doc verdict | body NO-GO / committed doc PASS (self-contradictory) | NO-GO (global, from v2.0.13) | **NO-GO for #22 on v2.0.11** |

Notes:

1. **PR #25's submit-ownership primitive is confirmed** on v2.0.11 — it is a
   real capability, not re-litigated. Its *additional* claims (`TuiPromptRef`,
   `session_prompt`, `promptAsync{noReply}`) are corrected in §4: they came
   from legacy `@opencode-ai/*` 1.x typings and do not exist in the v2.0.11
   runtime. Its full-admission claims were never runtime-proven, and this spike
   shows why: the input capability is absent.
2. **The first draft's v2.0.13 ownership FAIL did not reproduce.** With layers
   registered from an `append:"app"` slot render (`bind:"return"`,
   priority 1000), the same v2.0.13 binary produced owned 3/3, control fired,
   suppression and exactly-once pass-through (§6.1), and the shadow layer ran
   (§6.3). The draft registered variants from a `prompt.footer` render and
   reported commands never becoming reachable. Hypothesis (not established):
   layer lifecycle — layers are "owned by the calling component", and a
   footer component can unmount/remount while the `app` slot persists; the
   draft also disclosed an earlier reactive-loop bug in its harness. What is
   established: **ownership works on both runtimes with this harness**, so the
   draft's "external plugin cannot own submit" claim is reclassified from a
   runtime finding to a not-reproduced, harness-dependent observation. The
   draft's other v2.0.13 findings (no composer accessor; slot probes;
   `TuiPromptRef`/`session_prompt`/`api.ui.Prompt` absent; RPC seam present;
   `noReply` absent) **do** reproduce here (§5–§7).
3. PR #25 and its branch were not modified (no push, no rebase, no force-push).

---

## 11. Recommendation

**Activate #24 (gateway/front-controller)** — under #13's own rule
(#22 result = NO-GO), now justified on the authoritative runtime:

- The fatal gap is a host-side capability (no public prompt-input accessor,
  no composer slot, no `Prompt` component) present in **v2.0.11 and v2.0.13**;
  opjev cannot close it without forking or copying the composer.
- The gateway intercepts at the HTTP boundary where `text` is a public request
  field, and the `resume: false` mechanism proven here (§6.7) is exactly the
  "persist/admit without waking the parent" primitive #24's semantics require.
  The public plugin-RPC seam (§6.6) remains available as the control-plane
  path on either side of the gateway.

Suggested follow-ups for the maintainer (not actioned here):

- Decide whether the project will keep v2.0.11 as the supported/authoritative
  runtime (this spike's verdict assumes #13/#22's current contract) or move
  authority deliberately; §7 gives both runtime columns so either decision is
  documentable.
- The first draft's un-reproduced ownership failure (§10.2) may be worth an
  upstream look at plugin-layer lifecycle for footer-scoped registrations.
- Re-evaluate #22 if a future OpenCode exposes a prompt-input accessor or a
  prompt/composer slot (the concepts exist only in legacy 1.x typings today).

This PR modifies no issues, PRs, or roadmap state; #13's production code,
#14, and #24's gateway are untouched.

---

## 12. Constraints honoured

| Constraint | Held? |
| --- | --- |
| only public APIs (no private import, no host-internals walk) | yes |
| no trampoline / prompt engineering / model compliance | yes |
| no patch to OpenCode, no monkeypatch, no binary/`node_modules` change | yes (v2.0.11 fetched to `/tmp`, executed in isolation) |
| no material composer reimplementation | yes (0 bytes) |
| PR #25 and its branch untouched | yes |
| #13 production code, #14, #24 not modified | yes |
| no force-push, no merge | yes |
| code in this PR | none — docs only; harness lives under `/tmp`, outside the project tree |

---

## 13. Verification (this head)

| Gate | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm test` | 446/446 pass, 0 fail |
| `git diff --check` | clean |
| `git status --short` | only this document modified (the pre-existing untracked `opencode.jsonc` environment file is unrelated and was left untouched) |

Runtime probes backing every claim above: `tui.log` / `server.log` / `pty*.out`
(JSONL + terminal capture) from **four fresh runs re-executed from scratch
during final verification on 2026-09-22** (v2.0.11 ×2 — full matrix + shadow;
v2.0.13 ×2 — full matrix + shadow), plus binary `grep` probes of both exact
binaries (§2, §4); the original run logs are archived at
`<harness>/prev-20260922/`. Every headline count reproduced exactly:
`CLEANUP {owned:3, dispatched:2, ctrlG:1}` then `{owned:1, shadowCalled:1}`;
the same 4 distinct rendered slot claims (5 render events per run); P1
executed while P2/P3/P4 stayed at 0 executions for the whole run; P5 lost
3/3. The gates in the table above were re-run against this head after the
re-execution (typecheck exit 0; 446/446 tests).

---

## 14. Not proven / limitations

- The full admission chain (`orchestration run = 1`, `worker = 1`, `critic = 1`,
  duplicate suppression, awaiting-human) was **not** executed — the spike stops
  at the input capability gate, per #22's rules. If a public input accessor
  ever appears, §6.1/§6.6/§6.7 show the remaining links now have proven
  primitives.
- `prompt { resume:false }` semantics were observed for seconds-to-tens-of-
  seconds windows on fresh sessions: the inbox item stays undelivered and no
  execution starts for the rest of each run. Long-horizon delivery behavior
  and interaction with human gates were not probed.
- The root cause of the first draft's ownership failure on v2.0.13 (§10.2) is
  a hypothesis, not established.
- Keymap-layer reachability was sampled at t≈0 (before first `app` render —
  empty by design), 1.5 s, 5 s, and 12 s; deeper layer-lifecycle semantics were
  not mapped.
- The machine's model/auth path (real executions with no visible credentials)
  was not investigated; it only strengthens that parent canaries were real.
