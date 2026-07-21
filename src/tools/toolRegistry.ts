/**
 * ToolRegistry — the single source of truth for which tools are
 * available during a turn, and the schema doc that derives from them.
 *
 * Phase 1 (§3.1, §6.2). The registry's jobs:
 *   1. Hold the set of `Tool`s the harness may dispatch.
 *   2. Provide `buildToolSchemasDoc()` — a future-proofed helper that
 *      renders the canonical schema description. Today the JSON-
 *      dispatcher prompt still uses the hand-written schema strings
 *      in `promptBuilders.ts` (changing them would be a Phase-1
 *      behavior change, which §5.3 forbids). `buildToolSchemasDoc()`
 *      is provided as the target end-state: any NEW tool or schema
 *      change should be made here first, then propagated to the
 *      prompt strings in a follow-up. This is what closes the
 *      schema-drift gap called out in §6.2.
 *   3. Provide `get(name)` lookup so the harness dispatches a tool
 *      by name (used in Phase 2's native tool-calling path; Phase 1
 *      dispatches by explicit reference since the dispatcher returns
 *      a `DispatcherIntent` blob, not tool calls).
 */

import type { Tool } from "../agent/types.js";
import type { LLMToolDeclaration } from "../types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const t of tools) {
      this.register(t);
    }
  }

  /**
   * Register a tool. The concrete `Tool<TArgs, TResult>` is erased to
   * `Tool` (the unconstrained default) on insertion — the registry
   * does not need the type parameters, and erasure lets tools with
   * different arg shapes coexist in one registry without contravariance
   * gymnastics. Callers that retrieve a tool via `get()` and invoke its
   * executor are responsible for knowing the tool's arg shape (they
   * built it, so they know).
   */
  register(tool: Tool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Render the canonical schema doc derived from the registered tools.
   *
   * TARGET END-STATE (Phase 2+): the JSON-dispatcher prompt's inline
   * schema strings in `promptBuilders.ts` are replaced by this output.
   * In Phase 1 we DO NOT touch those strings (§5.3 forbids behavior
   * changes), but this helper exists so any new tool is described here
   * first and the prompt strings are migrated against it in a
   * follow-up — closing the schema-drift gap.
   *
   * Shape is intentionally simple (a stable, sorted JSON-able object)
   * so it can be diffed in tests and rendered into either a prompt
   * fragment or a native function-calling declaration.
   */
  buildToolSchemasDoc(): Record<string, unknown> {
    const doc: Record<string, unknown> = {};
    for (const tool of this.list()) {
      doc[tool.name] = {
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
    }
    return doc;
  }

  /**
   * Phase 2 — build native tool declarations for `provider.chat()`.
   * Returns the canonical `LLMToolDeclaration[]` shape that
   * `GenericLLMProvider.chat()` will inject into the request payload
   * via the template's `toolsPayloadTemplate`.
   *
   * Excludes signal tools whose executors throw in Phase 1 (the
   * `speak`/`like_picture`/`end_turn`/`skip_turn`/`skip_proactive`
   * placeholders) when `opts.excludeSignalTools` is true — those
   * become real tool declarations too in Phase 2, but a caller who
   * only wants the side-effecting tools can filter them out.
   */
  buildToolDeclarations(opts?: {
    excludeSignalTools?: boolean;
  }): LLMToolDeclaration[] {
    const SIGNAL_TOOLS = new Set([
      "speak",
      "like_picture",
      "end_turn",
      "skip_turn",
      "skip_proactive",
    ]);
    return this.list()
      .filter((t) => !opts?.excludeSignalTools || !SIGNAL_TOOLS.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
  }
}
