# Research: Result presentation boundary (PR #27 — orchestration result visibility)

- Date: 2026-10-01
- PR: pedro-labsabs/opjev#27 — `feat: add deterministic orchestration admission gateway`
- Branch: `feat/deterministic-admission-gateway`
- Delivery HEAD: `0bf727a` (with P1 token correlation, unified plugin install, and fresh evidence)
- Base at investigation: `main@7a3686e` (not advanced — no rebase needed)
- Runtime authority: OpenCode **v2.0.11** (`/home/pedro/.config/ai.opencode.desktop/cli/2.0.11/opencode-cli`), `@opencode/plugin@2.0.7`
- **Verdict: GO.** A supported public surface exists and was proven end-to-end in real runtime; the orchestration result is now VISIBLE in the real TUI with `parent=0`, `RPC=1`, `run=1`, strictly correlated to the unique run identity/digest.

## 1. Capability question and answer

Question: what is the smallest supported public surface able to show the user a
result produced by the control plane WITHOUT waking/executing the parent model?

Answer, proven in runtime v2.0.11 (probe + E2E at the delivery HEAD):

```
server: registration.events.emit(...)            ✅ proven (probe evidence, keys ["dispose","events"])
        on a public events-only RPC definition
        (ctx.rpc.register; note: v2.0.11 host
        requires methods:{} present on the def)
   ↓ public SSE event bus
TUI: ctx.client.rpc(def).events.on(...)          ✅ proven (probe evidence: EVENT_ON with bounded payload)
   ↓ public presentation APIs
ctx.ui.toast.show({...})                         ✅ proven VISIBLE in the real TUI PTY dump
```

## 2. Runtime evidence (probe, isolated HOME + project, real PTY)

Harness: `/tmp/opjev-present-probe/` (outside the repo), driver
`scripts/e2e-tui.py` from the repo, binary `v2.0.11`, plugin loaded from
`<HOME>/.config/opencode/plugins` (the cli/TUI discovery root in v2.0.11;
project `opencode.json` plugins are NOT inherited by the cli process —
discovered during the probe and worked around via the config plugins dir).

Server JSONL evidence (`evidence/server.jsonl`):
- `RPC_REGISTER_OK keys=["dispose","events"] eventKeys=["emit"]` — public
  registration returns the event emitter;
- `EVENT_EMIT_OK` repeatedly (events-only def, no methods required).

TUI JSONL evidence (`evidence/tui.jsonl`):
- `TUI_SETUP version=2.0.11`;
- `EVENT_SUB_OK offType=function` — public subscription API;
- `EVENT_ON type=rpc.probe.present.v1.orchestration-result
  data={runID,phase,text,sessionID}` — bounded payload received;
- `TOAST_FROM_EVENT_OK` — toast call succeeded.

PTY terminal capture (`pty-dump-logs.bin`):
- `PROBE_TOAST_MARKER` (setup toast) AND `PROBE_PRESENT_VISIBLE_MARKER`
  (toast triggered by the server event) both RENDERED in the real TUI screen
  output. This is display evidence, not inbox/storage presence.

Additional runtime facts observed (all public surfaces):
- An events-only RPC def registers fine when `methods: {}` is present.
- `ctx.ui.slot({ append: "session.composer.top", render })` claims succeed
  (`SLOT_APPEND_OK unclaimType=function`); a `render` returning a string did
  not render on screen in the probe (unproven), so the production choice is
  `ctx.ui.toast` — proven visible.
- The cli process loads TUI plugins from `~/.config/opencode/plugins` and
  `~/.config/opencode` + `.opencode` dirs; "Plugin failed" appears when a
  project-level package plugin lacks a resolvable `./tui` entrypoint there.
- Keymap/key dispatch and shadow commands never carry composer text
  (spike #22 §6.2/§6.3, confirmed unchanged in 2.0.11).

## 3. Production design (presentation = ZERO authority)

New files:
- `src/orchestration/presentation.ts` — PURE, deterministic:
  - `NOTICE_EVENT_LIMIT = 2000` (same quota as the authoritative notice);
  - `buildOrchestrationResultEvent(input)` — allowlist builder
    (`runID/sessionID/phase/round?/notice`), reject-on-missing-required,
    discard-unknown-fields (never an exfiltration channel), bounded notice;
  - `OrchestrationResultRpc` — events-ONLY public RPC def
    (`opjev.presentation.v1`, event `orchestration-result`); no methods =>
    presentation cannot be invoked to decide/execute anything;
  - `createOrchestrationResultPresenter(deps)` — `publish` with runID dedupe
    (FIFO cap), fail-closed `isPresentable` seam, emit failures isolated
    (bounded degradation, never propagated);
  - `isPresentableSession` — TUI-side role filter: current session must equal
    event session; native subagent (`parentID`) never presents; internal
    worker/critic/orchestrator sessions (jev markers) never present.
- `tui.ts` — the plugin TUI entrypoint: subscribes to the public event,
  filters by role, dedupes by runID, renders via `ctx.ui.toast.show`.
  NEVER touches session.prompt/synthetic/inbox/storage (no wake, no authority).

Modified (wiring only — no architecture change):
- `src/orchestration/admission-rpc.ts` — optional `notify(event)` seam on
  `AdmissionHandlerDeps`; called AFTER record+binding persistence and AFTER
  the authoritative synthetic publication, with the SAME bounded notice
  (`buildAdmissionRunNotice`), also on the failed path. Failures isolated
  (`notifyPresentationSafe`); absent seam = old behavior (zero regression).
- `index.ts` — server setup registers `OrchestrationResultRpc` (best-effort;
  unsupported surfaces degrade to null emitter) and wires `notify` to
  fire-and-forget `events.emit` (catch → bounded degradation). TUI-safe guard
  for `ctx.tool` added (cli resolution loads the server entry there).
- `package.json` — public `exports`: `.` (server) and `./tui` (TUI entry).
- `scripts/e2e-gateway.mjs` — installs the plugin into
  `<HOME>/.config/opencode/plugins/opjev` for the cli process (with
  `node_modules` symlink for `@opencode/plugin` resolution) and upgrades the
  PTY visibility assertion from `required:false` (documented blocker) to
  `required:true` (now proven deliverable).

## 4. TDD

- RED observed: `src/presentation.test.mjs` failed with
  `ERR_MODULE_NOT_FOUND: presentation.ts`; `R-NOTIFY` tests failed before the
  seam existed (15 pass / 3 fail / file-level TDZ cycle found and fixed).
- GREEN: 518/518 total (`npm test`), including:
  - V1/V2: schema bounding, allowlist, reject-invalid;
  - V3: identity 1:1 (runID/sessionID preserved);
  - V4: presentable filter + fail-closed unknown role;
  - V5: runID dedupe (replay => 1 display; distinct runs distinct; FIFO cap);
  - V6: emit failure isolated (never propagates);
  - V7: presenter exposes only `publish`;
  - V8: event schema registered publicly (additionalProperties:false);
  - V9: TUI role filter (current session, internal, parentID);
  - R-NOTIFY: success AND failed runs notify with the same bounded notice;
    notify failure preserves record/binding/publish; absent notify = no
    regression; notify receives the validated event shape.

## 5. E2E (authoritative v2.0.11, real gateway + real TUI + real PTY)

Command: `OPENCODE_BIN=/home/pedro/.config/ai.opencode.desktop/cli/2.0.11/opencode-cli npm run e2e:gateway`
Run dir: `/tmp/opjev-e2e/runs/2026-10-01T12-11-31-579Z/` (`e2e-result.json`, `pty-dump.bin`, `gateway.log`, `upstream.log`, `http.jsonl`).

Summary: **total=40 fail=0 partial=0** (visibility assertion REQUIRED and verified against unique runID digest).
Key results from the artifact:
- `normal: resposta nativa chega ao transcript`: PASS (assistantInTranscript=true)
- `orchestrate: EXATAMENTE 1 dispatch de RPC (run=1)` — dispatched=1;
- `orchestrate: resultado PUBLICADO (notice synthetic) sem wake` — PASS;
- `orchestrate: parent=0 (ZERO execucao na sessao parent)` — execStarted=0;
- `duplicata CONCORRENTE: mesmo runID + EXATAMENTE 1 dispatch (run=1)` — PASS;
- `duas sessoes: parent=0 em AMBAS` — PASS;
- `TUI orchestrate: parent=0 (janela admission->ping limpa...)` —
  windowExecs=0 execAtOrch=0 finalExecs=1;
- `TUI: notice daquele run contem o tuiRunID` — notice title & ID verified;
- `TUI: publicacao VISIVEL na experiencia (dump do PTY contem o notice e a identidade unica do run)` —
  **PASS (required=true)**: rendered in real TUI PTY dump correlated to `auto-ses_f089b4088ffemg72184jg0TIeQ-msg_0f764bf7b001lo1ydrYPch8fMV-97a7bebcd6ad`;
- `wire: ZERO PATCH de inbox` — patchInbox=0 (no wake mechanism, any phase);
- `wire: admissao persist-first com resume:false observada` — occurrences=7;
- counts: intercepts=11 (normal=3, route=1, orchestrate=7), admitted=7,
  rpcDispatched=5, rpcSkipped=2, failClosed=0.

Parent-execution canary remains `session.execution.*` over SSE (never
agent-provided logs/screenshots).

## 6. Adversarial review (final, this HEAD)

| Risk | Guard | Evidence |
| --- | --- | --- |
| Indirect parent wake | presentation never calls prompt/synthetic/inbox/PATCH; wire check `patchInbox=0` across ALL phases | V7 + E2E wire |
| Duplicate display | client dedupe by runID (FIFO cap 64); server emit is once per run conclusion; replay => `rpc-skipped` | V5 + E2E duplicate phase |
| Wrong session/run identity | event carries authoritative runID/sessionID 1:1; TUI requires exact current-session match | V3/V4/V9 + E2E TUI phase |
| Presentation authority | events-only RPC (no methods); presenter interface = `{publish}` only; emit after record+binding+synthetic; failures isolated | V7 + code |
| Internal recursion | role filter drops internal sessions; E2E internal phase bypasses admission (admitted=0 rpc=0) | V9 + E2E |
| awaiting-human auto-resume | presentation never resumes; human gate unchanged and still prevails (existing R13 suite) | existing tests green |
| Unbounded payload | allowlist + NOTICE_EVENT_LIMIT (2000) + notice pre-bounded by `buildAdmissionRunNotice`; schema maxLength | V1/V2 + V8 |
| Secret leakage | no credentials in event/notice; E2E leak check passed (no password/authz in logs) | E2E check 13 |

One repair round was used during development (import TDZ cycle between
presentation.ts and admission-rpc.ts — resolved by making presentation.ts the
leaf owner of the limit constant); affected gates re-run afterwards.

## 7. Limitations / not proven

- Presentation requires the plugin TUI entrypoint to be loadable by the cli
  process (config plugins dir in v2.0.11). If a future runtime changes plugin
  discovery, presentation degrades to the previous state: durable synthetic
  notice in the inbox, no PTY render — the run and all contracts remain
  authoritative and intact (bounded degradation, by design).
- `ctx.ui.slot("session.composer.top")` with string children did not render in
  the probe; not used in production. Toast is the proven renderer.
- Presentation is fire-and-forget: a TUI closed at emit time shows nothing
  (the durable notice remains in the inbox as before).
