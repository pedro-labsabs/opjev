import { observeContextRequest, observeToolAfter, resolveContextManagementStage } from "./observer.ts";
import type { RouterOptions } from "../config.ts";

/** Register independent OBSERVE callbacks after the existing authority/session hooks. */
export async function registerContextManagementHooks(
  ctx: any,
  opts: RouterOptions,
): Promise<void> {
  if (resolveContextManagementStage(opts.contextManagementStage) === "disabled") return;
  const deps = {
    storage: ctx.storage,
    owner: ctx,
    getSession: async (sessionID: string) => await ctx.session.get({ sessionID }),
  };
  await ctx.tool.hook("execute.after", (event: any) => {
    void observeToolAfter(event, deps);
  });
  await ctx.session.hook("context", (event: any) => {
    void observeContextRequest(event, deps);
  });
}
