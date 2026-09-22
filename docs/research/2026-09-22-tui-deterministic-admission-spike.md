# TUI Deterministic Admission Spike — Research Report

**Date:** 2026-09-22
**Issue:** #22
**Branch:** `spike/tui-deterministic-admission`
**Base:** `main@a74d3b5c34f49b5bf8b7fc16d7b68a5a6cb3567b`

## Verdict: PASS

The TUI plugin CAN own the submit deterministically. The mechanism is proven viable
with public APIs, no patches, no monkey-patching, and no material composer reimplementation.

## Environment

| Component | Value |
|-----------|-------|
| OpenCode binary | `/home/pedro/.opencode/bin/opencode` v2.0.11 |
| TUI plugin package | `@opencode/plugin` v2.0.7 |
| OpenTUI core | `@opentui/core` v0.5.8 |
| OpenTUI keymap | `@opentui/keymap` v0.4.5 |
| Node.js | v22 |

## Architecture Findings

### TUI Plugin API Surface

The TUI plugin receives a **limited** keymap API via `context.keymap`:

| Method | Type | Available |
|--------|------|-----------|
| `layer(fn)` | SolidJS hook | ✅ (must be called inside reactive context) |
| `dispatch(cmd)` | function | ✅ |
| `shortcuts()` | function | ✅ |
| `commands()` | function | ✅ |
| `pending()` | function | ✅ |
| `active()` | function | ✅ |
| `mode` | object | ✅ |
| `intercept(name, fn, opts)` | function | ❌ NOT available on plugin API |
| `registerLayer(layer)` | function | ❌ NOT available on plugin API |

**Critical finding:** `keymap.intercept()` and `KeyInputContext.consume()` are NOT exposed
to TUI plugins. The plugin API wraps the full `Keymap` class into a limited interface with
only `layer`, `dispatch`, and query methods.

### How `keymap.layer()` Works

`context.keymap.layer()` is a SolidJS hook that MUST be called inside a reactive context
(e.g., inside `context.ui.slot({ render: () => { ... } })`). It registers a keymap layer
with:

- **`priority`**: Higher values run first (default: 0)
- **`commands`**: Array of commands, each with `bind: "key"` to match keypresses
- **`Binding.preventDefault`**: Default `true`. Calls `event.preventDefault()` + `event.stopPropagation()` so the key does NOT reach the focused target (textarea) or later host listeners.
- **`Binding.fallthrough`**: Default `false`. Dispatch stops after the first matching binding's handler runs.

### Native Prompt Submit Mechanism

From OpenTUI core source (`TextareaRenderable`):
- The textarea maps `return` → `newline` (adds a newline), NOT `submit`
- The `submit` action requires `meta+return` (Cmd+Enter)
- The OpenCode prompt component registers its own keymap layer binding `return` → `prompt.submit` command
- `prompt.submit` calls `ref.submit()` which fires the `onSubmit` callback

### Two-Phase Submit Flow

```
USER PRESSES RETURN
  ↓
keymap dispatch (layers sorted by priority, highest first)
  ↓
OUR LAYER (priority 1000) matches "return"
  ├─ Binding.preventDefault=true → event.preventDefault() + event.stopPropagation()
  │   → textarea does NOT receive the key (no newline added)
  │   → native "prompt.submit" layer does NOT fire (fallthrough=false)
  ├─ NORMAL mode: we call context.keymap.dispatch("prompt.submit")
  │   → native submit fires ONCE → message sent to parent → LLM processes
  └─ ORCHESTRATE mode: we do NOT call dispatch("prompt.submit")
      → native submit NEVER fires → message stays in prompt → parent LLM sees nothing
```

## Runtime Evidence (PTY Probe — definitive experiments)

### Test Setup
- Disposable project at `/tmp/opjev-tui-spike/`
- Plugin loaded via `opencode.json` config `plugin` array
- PTY harness forks OpenCode with `--standalone --print-logs --log-level error`
- Marker files record what happened
- Two modes tested: `normal` and `orchestrate`

### Experiment 1: Intercept Registration

```
PLUGIN_MODULE_LOADED
PLUGIN_LOADED
KEYMAP_LAYER_IS_FUNCTION
SLOT_REGISTERED append=app
```

The plugin loads, `context.keymap.layer()` is available, slot registers successfully.

### Experiment 2: Return Keypress Interception

```
INTERCEPT key=return ctrl=false meta=false shift=false count=1
INTERCEPT_ENTER count=1
```

The layer fires on real Return keypress via PTY. Priority 1000 runs before the native prompt.submit layer.

### Experiment 3: Normal Mode — Native Submit Fires

```
NORMAL: dispatching prompt.submit for pass-through
NORMAL: prompt.submit dispatched OK
```

- `context.keymap.dispatch("prompt.submit")` successfully re-triggers native submit
- Message appears in chat (verified: text appears WITHOUT `┃` prompt borders in PTY output)
- No recursion: our handler is bound to the `return` key, `dispatch("prompt.submit")` dispatches a command — these are different dispatch targets

### Experiment 4: Orchestrate Mode — Native Submit Suppressed

```
ORCHESTRATE: suppressing native submit (no dispatch)
```

- Our handler does NOT call `dispatch("prompt.submit")`
- `Binding.preventDefault=true` (default) prevents the key from reaching the textarea
- `Binding.fallthrough=false` (default) prevents the native prompt.submit layer from firing
- **Text stays in prompt area** (verified: text appears ONLY with `┃` prompt borders in PTY output)
- **No message sent to chat** (verified: no user message appearance)
- No recursion

### Experiment 5: No Recursion

```
INTERCEPT_ENTER count=1
NORMAL: dispatching prompt.submit for pass-through
NORMAL: prompt.submit dispatched OK
...
INTERCEPT_ENTER count=2
NORMAL: dispatching prompt.submit for pass-through
NORMAL: prompt.submit dispatched OK
```

Two Enters processed. `dispatch("prompt.submit")` does NOT re-trigger our `return` key binding.
The `prompt.submit` command is a separate command, not the `return` key event.
No infinite recursion.

### Key Findings

| # | Finding | Method | Status |
|---|---------|--------|--------|
| 1 | Plugin loads via config `plugin` array + `./tui` export | PTY runtime | ✅ Proven |
| 2 | `context.keymap.layer()` available (SolidJS hook in slot render) | PTY runtime | ✅ Proven |
| 3 | Return keypress intercepted at priority 1000 | PTY runtime | ✅ Proven |
| 4 | Native submit suppressed in orchestrate mode (no dispatch) | PTY runtime + output analysis | ✅ Proven |
| 5 | Normal pass-through via `dispatch("prompt.submit")` fires native submit 1x | PTY runtime + output analysis | ✅ Proven |
| 6 | No recursion (dispatch("prompt.submit") ≠ return key event) | PTY runtime | ✅ Proven |
| 7 | `keymap.intercept()` NOT available on plugin API (limited keymap surface) | Runtime introspection | ⚠️ Finding |
| 8 | `KeyInputContext.consume()` NOT available (intercept API not exposed) | Runtime introspection | ⚠️ Finding |
| 9 | `context.location` returns `type=undefined, session=none` in slot render | PTY runtime | ⚠️ Limitation (timing) |
| 10 | No patch/fork/private API needed | All public APIs | ✅ Proven |

### PTY Output Analysis

**Normal mode — message submitted to chat:**
```
pos=31093: ...NORMAL-SPIKE-TEST...
```
Message appears WITHOUT `┃` borders = in chat area = native submit fired.

**Orchestrate mode — message stays in prompt:**
```
pos=9638: ...┃  ORCHESTRATE-SPIKE-TEST  ┃...
pos=12352: ...┃  ORCHESTRATE-SPIKE-TEST  ┃...
```
Message appears WITH `┃` borders = in prompt area = native submit suppressed.

## Architecture Diagram

```
USER TEXT
  ↓
native composer (reused, unmodified)
  ↓
TUI-owned submit (keymap.layer, priority 1000, slot render)
  ↓
admission decision (TUI-side, deterministic)
  ├─ normal/route → context.keymap.dispatch("prompt.submit") → native submit 1x
  └─ orchestrate  → native submit 0x (no dispatch, preventDefault suppresses textarea)
                       → context.client.rpc(orchestration) [future #13]
```

## Limitations & Follow-Up

1. **`context.location` returns undefined:** In the slot render callback, `context.location.type`
   is `undefined` and `session` is `none`. This is likely a timing issue — the slot renders
   before the location is fully resolved. For #13, the session ID should be obtained from
   `context.data.session` or `context.client.session` instead.

2. **`keymap.intercept()` not available:** The full `Keymap.intercept()` method (which provides
   `KeyInputContext.consume()`) is NOT exposed on the TUI plugin API. The plugin receives a
   limited wrapper with only `layer`, `dispatch`, and query methods. However, `layer()` with
   `Binding.preventDefault=true` + `Binding.fallthrough=false` achieves the same result:
   the key doesn't reach the textarea, and the native submit layer doesn't fire.

3. **Prompt text access:** For the orchestrate path, the plugin needs to read the current prompt
   text (to pass as `objective` to the RPC). The `TuiPromptRef.current.text` field has this
   data, but capturing the ref from a slot render requires either a SolidJS context hook or
   a ref-forwarding mechanism. This is solvable during #13 integration.

4. **Shell mode bypass:** The plugin should check `context.data.session` or the prompt's mode
   to skip orchestration for shell submissions. This is a guard to implement in #13.

5. **Attachments/Parts:** For the normal path, `dispatch("prompt.submit")` preserves them.
   For orchestrate, attachments would need to be serialized into the RPC input. Follow-up for #13.

## Recommendation

**Activate #13 with TUI-owned submit as the admission primitive.** The TUI plugin
should:

1. Register slot at `session.composer.top` (or `app` — both work)
2. Inside slot render, call `context.keymap.layer()` with:
   - `priority: 1000`
   - `commands: [{ bind: "return", run: handler }]`
   - Handler checks admission config, session state, shell mode
   - Normal/route: `context.keymap.dispatch("prompt.submit")`
   - Orchestrate: `context.client.rpc(OrchestrationRpc, { sessionID, objective, ... })`
3. Server plugin registers the orchestration RPC handler

This eliminates the trampoline entirely. The parent model never sees the turn in
orchestrate mode because native submit is never dispatched.

## Files Created During Spike

| Path | Purpose |
|------|---------|
| `/tmp/opjev-tui-spike/tui.js` | TUI spike plugin (final v3 — layer-based) |
| `/tmp/opjev-tui-spike/server.js` | Server stub (no-op) |
| `/tmp/opjev-tui-spike/pty-final.py` | PTY automation driver |
| `/tmp/opjev-tui-spike/opencode.json` | Plugin config |
| `/tmp/opjev-tui-spike/package.json` | Package with `./tui` export |

None of these are committed. They are temporary probe artifacts.
