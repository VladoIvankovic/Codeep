/**
 * Per-run memory of what the flat agent history stands for on the Responses
 * wire (api/responses.ts).
 *
 * runAgent keeps its conversation as flat `{role, content}` messages — that is
 * what sessions, exports, ACP history and cloud sync store, and none of that
 * changes. On the Responses API an assistant turn is more than its text: the
 * reasoning items (with encrypted_content), the commentary message's `phase`
 * and the function calls must be replayed as returned, and each call answered
 * by a `function_call_output` with its call_id. This table maps the message
 * OBJECTS runAgent pushes to that native form, for the life of one run.
 *
 * A WeakMap rather than an extra property on Message: the Chat Completions and
 * Anthropic branches spread `messages` straight into request bodies, and an
 * unknown field would reach providers that reject one. Nothing here is ever
 * written to disk, and a nested (delegated) run creates its own table, so
 * items never cross between parent and sub-agent.
 */

import type { NativeTurn, ResponsesReplayLookup, ResponsesReplayTag, ToolOutputEntry } from '../api/responses';

export class ResponsesRunState implements ResponsesReplayLookup {
  private readonly tags = new WeakMap<object, ResponsesReplayTag>();

  /** `message` is the assistant turn `turn` came back as. */
  tagAssistant(message: object, turn: NativeTurn): void {
    this.tags.set(message, { kind: 'assistant', turn });
  }

  /** `message` is the tool-results message answering these calls. */
  tagToolOutputs(message: object, outputs: ToolOutputEntry[]): void {
    this.tags.set(message, { kind: 'toolOutputs', outputs: [...outputs] });
  }

  lookup(message: object): ResponsesReplayTag | undefined {
    return this.tags.get(message);
  }
}
