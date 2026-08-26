import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import * as v from "valibot";

const matchSchema = v.object({
  path: v.string(),
  score: v.number(),
  indices: v.array(v.number()),
  is_directory: v.boolean(),
});

const snapshotEventSchema = v.object({
  type: v.literal("snapshot"),
  query_id: v.number(),
  matches: v.array(matchSchema),
  total_items: v.number(),
  done: v.boolean(),
});

const eventSchema = v.variant("type", [
  snapshotEventSchema,
  v.object({ type: v.literal("superseded"), query_id: v.number() }),
  v.object({ type: v.literal("closed"), query_id: v.nullable(v.number()) }),
]);

export type MentionFsMatch = v.InferOutput<typeof matchSchema>;
export type MentionFsSnapshot = v.InferOutput<typeof snapshotEventSchema>;
export type MentionFsEvent = v.InferOutput<typeof eventSchema>;

export type FirstSnapshotResult =
  | { status: "ready"; snapshot: MentionFsSnapshot }
  | { status: "done-empty"; snapshot: MentionFsSnapshot }
  | { status: "superseded" }
  | { status: "aborted" }
  | { status: "closed" };

export type MentionFsClientOptions = {
  binary: string;
  root: string;
};

export type MentionFsQueryOptions = {
  hidden?: boolean;
  directoriesOnly?: boolean;
  limit?: number;
};

class QueryFeed {
  readonly events: MentionFsEvent[] = [];
  readonly #waiters = new Set<() => void>();
  #error: Error | undefined;

  push(event: MentionFsEvent): void {
    this.events.push(event);
    this.#wake();
  }

  fail(error: Error): void {
    this.#error = error;
    this.#wake();
  }

  error(): Error | undefined {
    return this.#error;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.#error) return Promise.reject(this.#error);
    if (signal?.aborted) return Promise.reject(signal.reason);

    const waiter = Promise.withResolvers<void>();
    const wake = (): void => {
      signal?.removeEventListener("abort", abort);
      this.#waiters.delete(wake);
      waiter.resolve();
    };
    const abort = (): void => {
      this.#waiters.delete(wake);
      waiter.reject(signal?.reason);
    };
    this.#waiters.add(wake);
    signal?.addEventListener("abort", abort, { once: true });
    return waiter.promise;
  }

  #wake(): void {
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }
}

export class MentionFsQuery implements AsyncIterable<MentionFsEvent> {
  readonly id: number;
  readonly #feed: QueryFeed;

  constructor(id: number, feed: QueryFeed) {
    this.id = id;
    this.#feed = feed;
  }

  async first(signal?: AbortSignal): Promise<FirstSnapshotResult> {
    try {
      for await (const event of this.#iterate(signal)) {
        if (event.type === "snapshot") {
          if (event.matches.length > 0) return { status: "ready", snapshot: event };
          if (event.done) return { status: "done-empty", snapshot: event };
        } else if (event.type === "superseded") {
          return { status: "superseded" };
        } else {
          return { status: "closed" };
        }
      }
      return { status: "closed" };
    } catch (error) {
      if (signal?.aborted) return { status: "aborted" };
      throw error;
    }
  }

  async complete(signal?: AbortSignal): Promise<FirstSnapshotResult> {
    try {
      for await (const event of this.#iterate(signal)) {
        if (event.type === "snapshot" && event.done) {
          return event.matches.length > 0
            ? { status: "ready", snapshot: event }
            : { status: "done-empty", snapshot: event };
        }
        if (event.type === "superseded") return { status: "superseded" };
        if (event.type === "closed") return { status: "closed" };
      }
      return { status: "closed" };
    } catch (error) {
      if (signal?.aborted) return { status: "aborted" };
      throw error;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<MentionFsEvent> {
    return this.#iterate();
  }

  async *#iterate(signal?: AbortSignal): AsyncGenerator<MentionFsEvent> {
    let cursor = 0;
    while (true) {
      while (cursor < this.#feed.events.length) {
        const event = this.#feed.events[cursor++];
        if (!event) continue;
        yield event;
        if (event.type !== "snapshot" || event.done) return;
      }
      const error = this.#feed.error();
      if (error) throw error;
      await this.#feed.wait(signal);
    }
  }
}

export class MentionFsClient {
  readonly #process: ChildProcessWithoutNullStreams;
  readonly #queries = new Map<number, QueryFeed>();
  #nextQueryId = 1;
  #closed = false;
  #stderr = "";

  constructor(options: MentionFsClientOptions) {
    this.#process = spawn(options.binary, [options.root], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = createInterface({ input: this.#process.stdout });
    lines.on("line", (line) => this.#acceptLine(line));
    this.#process.stderr.setEncoding("utf8");
    this.#process.stderr.on("data", (chunk) => {
      this.#stderr += String(chunk);
    });
    this.#process.on("error", (error) => this.#failAll(error));
    this.#process.on("exit", (code) => {
      this.#closed = true;
      if (code !== 0) {
        const detail = this.#stderr.trim();
        this.#failAll(new Error(detail || `mention-fs exited with code ${code ?? "unknown"}`));
      } else {
        this.#closeAll();
      }
    });
  }

  restart(hidden = false): void {
    if (this.#closed) throw new Error("mention-fs client is closed");
    this.#process.stdin.write(`${JSON.stringify({ type: "restart", hidden })}\n`);
  }

  query(pattern: string, options: MentionFsQueryOptions = {}): MentionFsQuery {
    if (this.#closed) throw new Error("mention-fs client is closed");
    const id = this.#nextQueryId++;
    const feed = new QueryFeed();
    this.#queries.set(id, feed);
    this.#process.stdin.write(
      `${JSON.stringify({
        type: "query",
        id,
        pattern,
        hidden: options.hidden ?? false,
        directories_only: options.directoriesOnly ?? false,
        limit: options.limit ?? 100,
      })}\n`,
    );
    return new MentionFsQuery(id, feed);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#process.stdin.end(`${JSON.stringify({ type: "stop" })}\n`);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #acceptLine(line: string): void {
    let input: unknown;
    try {
      input = JSON.parse(line);
    } catch {
      this.#failAll(new Error("mention-fs emitted invalid JSON"));
      return;
    }
    const parsed = v.safeParse(eventSchema, input);
    if (!parsed.success) {
      this.#failAll(new Error("mention-fs emitted an invalid event"));
      return;
    }
    const event = parsed.output;
    const queryId = event.query_id;
    if (queryId === null) {
      this.#closeAll();
      return;
    }
    const feed = this.#queries.get(queryId);
    if (!feed) return;
    feed.push(event);
    if (event.type !== "snapshot" || event.done) this.#queries.delete(queryId);
  }

  #failAll(error: Error): void {
    for (const feed of this.#queries.values()) feed.fail(error);
    this.#queries.clear();
  }

  #closeAll(): void {
    for (const [queryId, feed] of this.#queries) {
      feed.push({ type: "closed", query_id: queryId });
    }
    this.#queries.clear();
  }
}
