/**
 * Client-side reader for the `/api/ask` stream.
 *
 * The route emits newline-delimited JSON — one event per line — so the trace can
 * be rendered as it happens rather than after the turn completes. A network
 * chunk has no reason to land on a line boundary, so the parser buffers the
 * tail and only emits whole lines. Getting that wrong shows up as a JSON error
 * on exactly the long answers this endpoint exists to produce.
 */

export type AskEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown }
  | { type: "done"; toolCalls: number; truncated?: boolean }
  | { type: "error"; message: string };

/** A tool the model called, as rendered in the trace. */
export interface ToolCall {
  name: string;
  input: unknown;
}

export interface AskTurn {
  role: "user" | "assistant";
  text: string;
  tools: ToolCall[];
  /** Set when the turn ended on an error rather than a `done`. */
  failed?: boolean;
}

function isAskEvent(value: unknown): value is AskEvent {
  if (typeof value !== "object" || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === "text" || type === "tool" || type === "done" || type === "error";
}

/**
 * Incremental NDJSON parser.
 *
 * `push` returns the events completed by this chunk; `flush` returns whatever a
 * final line without a trailing newline left behind. A line that is not valid
 * JSON surfaces as an error event rather than being dropped — a silently
 * swallowed line reads on screen as the model going quiet, which is the least
 * debuggable failure this stream has.
 */
export function createAskParser() {
  let buffer = "";

  const parseLine = (line: string): AskEvent | null => {
    const trimmed = line.trim();
    if (trimmed === "") return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!isAskEvent(parsed)) {
        return { type: "error", message: `Unrecognised event: ${trimmed.slice(0, 120)}` };
      }
      return parsed;
    } catch {
      return { type: "error", message: `Malformed stream line: ${trimmed.slice(0, 120)}` };
    }
  };

  return {
    push(chunk: string): AskEvent[] {
      buffer += chunk;
      const lines = buffer.split("\n");
      // The last element is either "" (chunk ended on a newline) or a partial
      // line, and in both cases it belongs to the next chunk.
      buffer = lines.pop() ?? "";
      return lines.map(parseLine).filter((e): e is AskEvent => e !== null);
    },
    flush(): AskEvent[] {
      const rest = buffer;
      buffer = "";
      const event = parseLine(rest);
      return event ? [event] : [];
    },
  };
}

/**
 * Apply an event to the assistant turn being built.
 *
 * Text arrives as whole blocks rather than tokens, so consecutive blocks are
 * joined with a blank line — that is how the model paragraphs an answer, and
 * concatenating them bare runs the sections together.
 */
export function applyEvent(turn: AskTurn, event: AskEvent): AskTurn {
  switch (event.type) {
    case "text":
      return { ...turn, text: turn.text === "" ? event.text : `${turn.text}\n\n${event.text}` };
    case "tool":
      return { ...turn, tools: [...turn.tools, { name: event.name, input: event.input }] };
    case "error":
      return {
        ...turn,
        failed: true,
        text: turn.text === "" ? event.message : `${turn.text}\n\n${event.message}`,
      };
    case "done":
      return turn;
  }
}

/**
 * History for the next request.
 *
 * The stream carries the model's prose but not its `tool_use` blocks, so the
 * transcript sent back is text-only. That is deliberate: a partial reconstruction
 * with tool_use blocks and no matching tool_result would be an invalid
 * conversation, and the API would reject the whole turn. Text-only costs the
 * model its scratch work and keeps every follow-up valid.
 */
export function toHistory(turns: AskTurn[]): { role: "user" | "assistant"; content: string }[] {
  const out: { role: "user" | "assistant"; content: string }[] = [];

  // Emit complete user→assistant pairs only. Dropping a failed answer while
  // keeping the question that produced it would leave a trailing user turn, and
  // the next question would then be a second user turn in a row — the Messages
  // API requires the roles to alternate and rejects the whole request. A turn
  // that produced no usable answer takes its question down with it.
  for (let i = 0; i < turns.length; i++) {
    const question = turns[i];
    const answer = turns[i + 1];
    if (!question || question.role !== "user") continue;
    if (!answer || answer.role !== "assistant") continue;
    if (answer.failed || answer.text.trim() === "" || question.text.trim() === "") continue;

    out.push({ role: "user", content: question.text });
    out.push({ role: "assistant", content: answer.text });
    i++;
  }

  return out;
}
