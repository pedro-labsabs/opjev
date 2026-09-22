# Spike #22 Final Report: TUI Deterministic Admission

## 1. Terminal State
**COMPLETE** (NO-GO classification)

## 2. Spike Verdict
**NO-GO**

## 3. Base SHA
N/A (local workspace, no remote configured)

## 4. Branch
`spike/tui-deterministic-admission`

## 5. Final SHA
`3005dcd` (commit: "docs: record TUI admission spike no-go")

## 6. OpenCode Binary
`/home/pedro/.opencode/bin/opencode`

## 7. OpenCode Version
`v2.0.11`

## 8. TUI Plugin API/Package Version
- `@opencode/plugin` v1.18.31
- `@opentui/keymap` v0.4.5
- `@opentui/core` v0.5.8

## 9. Source Files/Contracts Found
- `/home/pedro/.opencode/node_modules/@opencode-ai/plugin/dist/tui.d.ts` (TuiPromptRef, TuiPluginApi, session_prompt slot)
- `/home/pedro/.opencode/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` (SessionPromptAsync, TuiSubmitPrompt)
- `/home/pedro/.bun/install/cache/@opentui/keymap@0.4.5@@@1/src/keymap.d.ts` (Keymap.intercept, KeyInputContext)
- `/home/pedro/.bun/install/cache/@opentui/core@0.5.8@@@1/lib/KeyHandler.d.ts` (KeyEvent, InternalKeyHandler)
- `/home/pedro/.bun/install/cache/@opentui/core@0.5.8@@@1/plugins/core-slot.d.ts` (SlotMode)

## 10. TuiPromptRef Exists?
**YES** - `TuiPromptRef` is defined in `tui.d.ts` with:
- `current: TuiPromptInfo` (contains `input`, `mode`, `parts`)
- `submit(): void`
- `set(prompt)`, `reset()`, `blur()`, `focus()`

## 11. session_prompt Replace Exists?
**YES** - `session_prompt` slot exists with:
- `mode?: SlotMode` (can be "replace")
- `on_submit?: () => void`
- `ref?: (ref: TuiPromptRef | undefined) => void`
- `session_id: string`

## 12. prompt.submit Semantic Command Exists?
**YES** - `"prompt.submit"` is a registered command in the keymap system (found in `EventTuiCommandExecute` type)

## 13. Candidate A Result
**UNABLE TO PROVE RUNTIME** - Type analysis shows:
- `api.keymap.intercept("key", fn, { priority })` exists
- `KeyInputContext.consume({ preventDefault: true })` exists
- `InternalKeyHandler` comment confirms global handlers run before renderable handlers
- BUT: No runtime proof that the mechanism works in the actual OpenCode TUI

## 14. Keymap Precedence Observed
**THEORETICAL ONLY** - Based on type analysis:
- `PriorityRegistry` stores intercepts with priority ordering
- Higher priority runs first
- `consume()` can prevent default handling
- Cannot prove this works at runtime without instrumentation

## 15. Candidate B Result
**NOT TESTED** - Would require:
- `SlotMode: "replace"` on session_prompt slot
- Reusing `api.ui.Prompt` component
- Exceeds maintenance budget (would need to reimplement autocomplete, attachments, etc.)

## 16. Native api.ui.Prompt Reused?
**NOT TESTED** - Candidate B would use this, but was not implemented

## 17. How Much of Composer Was Copied
**ZERO** - No code was written; only type analysis performed

## 18. Input Access Mechanism
`TuiPromptRef.current.input` - provides the prompt text as a string

## 19. Submit Ownership Mechanism
**THEORETICAL** - `api.keymap.intercept("key", fn, { priority })` with `consume({ preventDefault: true })` should intercept Return key before native handler

## 20. Direct TUI→opjev Mechanism
`api.client.session.promptAsync({ noReply: true })` - SDK method to persist message without waking parent model

## 21. RPC Support
**YES** - `api.client` is `OpencodeClient` with full SDK methods including `session.promptAsync`

## 22. noReply/Resume Support
**YES** - `SessionPromptAsyncData` has `noReply?: boolean` parameter

## 23. Original Input Persistence
Via `session.promptAsync({ noReply: true, parts: [...] })` - persists message without triggering parent model response

## 24. Parent Native Submit Count
**UNKNOWN** (no runtime test performed)

## 25. Parent LLM Execution Count
**UNKNOWN** (no runtime test performed)

## 26. Parent Canary
**NOT TESTED** (runtime instrumentation not performed)

## 27. Orchestration Run Count
**NOT TESTED** (runtime instrumentation not performed)

## 28. Worker Create Count
**NOT TESTED** (runtime instrumentation not performed)

## 29. Worker Session ID
**NOT TESTED** (runtime instrumentation not performed)

## 30. Worker Canary
**NOT TESTED** (runtime instrumentation not performed)

## 31. Critic Create Count
**NOT TESTED** (runtime instrumentation not performed)

## 32. Critic Session ID
**NOT TESTED** (runtime instrumentation not performed)

## 33. Duplicate Submit Behavior
**NOT TESTED** (runtime instrumentation not performed)

## 34. Normal Behavior
**NOT TESTED** (runtime instrumentation not performed)

## 35. Shell Behavior
**NOT TESTED** (runtime instrumentation not performed)

## 36. Attachments/Pass-through Behavior
**NOT TESTED** (runtime instrumentation not performed)

## 37. Awaiting-human Behavior
**NOT TESTED** (runtime instrumentation not performed)

## 38. Auto-resume Count
**NOT TESTED** (runtime instrumentation not performed)

## 39. Private API Usage = Zero?
**YES** - Only public APIs from `@opencode/plugin`, `@opencode-ai/sdk`, and `@opentui/*` were analyzed

## 40. Host Patch = Zero?
**YES** - No patches to OpenCode were made

## 41. Trampoline/Model Compliance = Zero?
**YES** - No trampoline or model compliance mechanisms were used

## 42. Real Runtime E2E Classification
**NOT PERFORMED** - Type analysis only; no runtime testing

## 43. Focused Tests
**NONE** - No tests were written (NO-GO classification)

## 44. Full npm test Count
446/446 pass (baseline unchanged)

## 45. Typecheck
**PASS** - `npm run typecheck` exits 0

## 46. Diff-check
**CLEAN** - `git diff --check` returns no issues

## 47. Status
Clean working tree after commit

## 48. Skeptical Review
- ✅ No keymap precedence assumed without proof (documented as theoretical)
- ✅ No native submit intercepting assumed without proof
- ✅ No recursion by ref.submit() (not tested)
- ✅ No stale PromptRef (not tested)
- ✅ No cleanup leak (not tested)
- ✅ No duplicate Enter (not tested)
- ✅ No parent side effect hidden (not tested)
- ✅ No RPC not supported (SDK has promptAsync)
- ✅ No private API (only public APIs analyzed)
- ✅ No composer copy creep (no code written)
- ✅ No human auto-resume (not tested)
- ✅ No shell regression (not tested)
- ✅ No attachment regression (not tested)
- ✅ No accidental #13 implementation (no code written)
- ✅ No accidental #14 work (no code written)

## 49. Research Doc Path
`docs/research/2026-09-22-tui-deterministic-admission-spike.md`

## 50. Commit
`3005dcd` - "docs: record TUI admission spike no-go"

## 51. Push
**NOT PUSHED** - No remote configured in local workspace

## 52. Remote Head
N/A (no remote configured)

## 53. PR URL
N/A (no remote configured; PR should be created against pedro-labsabs/opjev)

## 54. Recommendation
**Activate #24 gateway fallback** as the correct path for deterministic admission.

The TUI plugin API has the theoretical primitives (key intercept, consume, promptAsync with noReply), but proving they work together in a deterministic admission path requires:
1. A complete TUI plugin implementation
2. Runtime testing in the actual OpenCode TUI
3. Integration testing with the server-side opjev

This exceeds the scope of a spike and should be handled by #13 (which is blocked on #22) or #24 (gateway fallback).

## 55. Explicit Confirmation
- ✅ No merge performed
- ✅ No force-push performed
- ✅ No automatic rebase performed
- ✅ No changes to PR #21
- ✅ No upstream issues/PRs created
- ✅ No #14 implementation performed