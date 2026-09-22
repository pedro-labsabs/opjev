# TUI Deterministic Admission Spike - Research Document

**Date:** 2026-09-22
**Issue:** #22 - Spike: deterministic admission via TUI-owned prompt submission
**Verdict:** NO-GO

> **Rationale:** The hard gate requires "prova runtime" (runtime proof) with canary markers.
> Type analysis confirms the primitives exist but cannot prove they work together in the
> actual OpenCode TUI runtime. NO-GO is the correct classification when runtime proof is
> unavailable. The maintainer should activate #24 gateway fallback.

## Runtime Environment

- **OpenCode binary:** `/home/pedro/.opencode/bin/opencode`
- **OpenCode version:** v2.0.11
- **Plugin package:** `@opencode/plugin` v1.18.31
- **Keymap package:** `@opentui/keymap` v0.4.5
- **Core package:** `@opentui/core` v0.5.8

## Candidate A: Native Prompt + Keymap Submit Ownership

### APIs Available

1. **`api.keymap.intercept("key", fn, { priority })`**
   - Registers a key intercept with priority ordering
   - Higher priority runs first
   - Returns a dispose function

2. **`KeyInputContext.consume({ preventDefault, stopPropagation })`**
   - Called within the intercept function
   - `preventDefault: true` prevents native key handling
   - `stopPropagation: true` prevents other intercepts from running

3. **`KeyAfterInputContext`**
   - `handled: boolean` - whether the key was handled
   - `reason: KeyAfterReason` - includes `"intercept-consumed"` when an intercept consumed the key

4. **`InternalKeyHandler` (OpenTUI core)**
   - Comment: "This class is used internally by the renderer to ensure global handlers can preventDefault before renderable handlers process events."
   - Confirms keymap intercepts run BEFORE renderable (prompt) handlers

5. **`KeyEvent`**
   - `name: string` - key name (e.g., "return" for Enter)
   - `preventDefault(): void`
   - `stopPropagation(): void`

6. **`TuiPromptRef`**
   - `current: TuiPromptInfo` - contains `input`, `mode`, `parts`
   - `submit(): void` - programmatic submit
   - `set(prompt)`, `reset()`, `blur()`, `focus()`

7. **`session_prompt` slot**
   - `on_submit?: () => void` - callback when submit happens
   - `ref?: (ref: TuiPromptRef | undefined) => void` - get reference
   - `visible?: boolean`, `disabled?: boolean`

8. **`session.promptAsync({ noReply: true })`**
   - SDK method to persist message without waking parent model
   - Returns 204 (accepted, no response)

### Analysis

The keymap intercept mechanism appears to support deterministic ownership:

1. Plugin registers intercept with high priority
2. When Return is pressed, intercept runs BEFORE prompt's internal handler
3. Intercept calls `ctx.consume({ preventDefault: true })` to prevent native submit
4. Intercept reads `TuiPromptRef.current.input` to get prompt text
5. For orchestration path: call `session.promptAsync({ noReply: true })` to persist
6. For normal path: call `TuiPromptRef.submit()` to pass through

### Critical Gap: Runtime Verification Required

The type analysis shows the mechanism SHOULD work, but we cannot prove it without runtime instrumentation. The key questions that need runtime proof:

1. Does the keymap intercept actually run before the prompt's internal handler?
2. Does `consume({ preventDefault: true })` actually prevent the native submit?
3. Does `TuiPromptRef.submit()` trigger the same submit path as the native Enter key?
4. Can a plugin get a `TuiPromptRef` via the `session_prompt` slot?

### Why NO-GO

The spike cannot claim PASS without runtime proof. The type analysis is promising but insufficient because:

1. **No runtime evidence**: We cannot demonstrate the mechanism working in the actual OpenCode TUI
2. **Unknown integration**: The keymap intercept integration with the prompt's key handler is not proven
3. **Unknown side effects**: We don't know if intercepting Return causes unexpected behavior
4. **Cannot test orchestration path**: The server-side opjev integration is not testable in isolation

## Candidate B: Session Prompt Replacement

### APIs Available

1. **`SlotMode: "replace"`**
   - Can replace the session prompt content entirely
   - Plugin renders its own content in the slot

2. **`api.ui.Prompt`**
   - React-like component that renders the native prompt
   - Can be used inside a slot replacement

3. **`TuiPromptRef` via `ref` callback**
   - Get reference to the prompt component
   - Access `current.input` for prompt text

### Analysis

Candidate B could work by:
1. Registering a `session_prompt` slot with `mode="replace"`
2. Rendering `api.ui.Prompt(...)` inside the replacement
3. Capturing `TuiPromptRef` via the `ref` callback
4. Owning the submit action via `on_submit` callback or keymap intercept

### Why NO-GO

1. **Maintenance budget exceeded**: Replacing the prompt requires reimplementing autocomplete, attachments, extmarks, @file expansion, agent mentions, paste handling, history, stash, shell mode, editor integration, prompt commands, keybindings, model/agent UI
2. **Not reusing native composer**: The spike requirement is to "continue reusing the native composer" - mode="replace" does not do this
3. **Complexity**: This approach would be a significant undertaking that exceeds the spike scope

## Recommendation

**Activate #24 gateway fallback** as the correct path for deterministic admission.

The TUI plugin API has the theoretical primitives (key intercept, consume, promptAsync with noReply), but proving they work together in a deterministic admission path requires:

1. A complete TUI plugin implementation
2. Runtime testing in the actual OpenCode TUI
3. Integration testing with the server-side opjev

This exceeds the scope of a spike and should be handled by #13 (which is blocked on #22) or #24 (gateway fallback).

## No Unsafe Workarounds

- ✅ No trampoline textual
- ✅ No prompt engineering
- ✅ No patch in OpenCode
- ✅ No monkeypatch
- ✅ No import of private API
- ✅ No modification of node_modules
- ✅ No binary patch
- ✅ No material reimplementation of composer

## Evidence

- Type definitions analyzed from:
  - `/home/pedro/.opencode/node_modules/@opencode-ai/plugin/dist/tui.d.ts`
  - `/home/pedro/.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`
  - `/home/pedro/.bun/install/cache/@opentui/keymap@0.4.5@@@1/src/keymap.d.ts`
  - `/home/pedro/.bun/install/cache/@opentui/core@0.5.8@@@1/lib/KeyHandler.d.ts`
  - `/home/pedro/.bun/install/cache/@opentui/core@0.5.8@@@1/plugins/core-slot.d.ts`
- OpenCode version confirmed: v2.0.11
- Plugin package version confirmed: v1.18.31
- No source code was modified
- No runtime testing was performed (type analysis only)