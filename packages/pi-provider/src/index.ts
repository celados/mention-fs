import { MentionFsClient, type MentionFsMatch } from "../../client/src/index.ts";

export type AutocompleteItem = {
  value: string;
  label: string;
  description?: string;
  icon?: string;
  hint?: string;
};

export type AutocompleteResult = {
  items: AutocompleteItem[];
  prefix: string;
};

export type AppliedCompletion = {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
  onApplied?: () => void;
};

export type PiAutocompleteProvider = {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    signal?: AbortSignal,
  ): Promise<AutocompleteResult | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): AppliedCompletion;
  getInlineHint?(lines: string[], cursorLine: number, cursorCol: number): string | null;
  trySyncSlashCompletion?(textBeforeCursor: string): AutocompleteResult | null;
  trySyncInlineReplace?(textBeforeCursor: string): { replaceLen: number; insert: string } | null;
  getForceFileSuggestions?(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    signal?: AbortSignal,
  ): Promise<AutocompleteResult | null>;
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean;
};

export type PiMentionProviderOptions = {
  client: MentionFsClient;
  settle?: "first" | "complete";
};

export type OmpMentionFsOptions = {
  binary: string;
  root: string;
  settle?: "first" | "complete";
};

export type OmpExtensionUi = {
  addAutocompleteProvider(
    factory: (current: PiAutocompleteProvider) => PiAutocompleteProvider,
  ): void;
};

export type OmpExtensionApi = {
  on(
    event: "session_start" | "session_shutdown",
    handler: (event: unknown, context: { cwd: string; ui: OmpExtensionUi }) => void | Promise<void>,
  ): void;
};

export type OmpExtensionFactoryOptions = {
  binary: string;
  settle?: "first" | "complete";
};

type MentionContext = {
  prefix: string;
  query: string;
  hidden: boolean;
  quoted: boolean;
};

const TOKEN_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function extractMention(text: string): MentionContext | null {
  for (let index = text.length - 1; index >= 0; index--) {
    if (text[index] !== "@") continue;
    if (index > 0 && !TOKEN_DELIMITERS.has(text[index - 1] ?? "")) continue;

    const prefix = text.slice(index);
    const hidden = prefix.startsWith("@!");
    const content = prefix.slice(hidden ? 2 : 1);
    const quoted = content.startsWith('"');
    const query = quoted ? content.slice(1) : content;
    if (!quoted && /\s/.test(query)) return null;
    return { prefix, query, hidden, quoted };
  }
  return null;
}

function toAutocompleteItem(match: MentionFsMatch, quoted: boolean): AutocompleteItem {
  const path = match.is_directory ? `${match.path}/` : match.path;
  const needsQuotes = quoted || path.includes(" ");
  const value = needsQuotes ? `@"${path}${match.is_directory ? "" : '"'}` : `@${path}`;
  const segments = match.path.split("/");
  const name = segments.at(-1) ?? match.path;
  return {
    value,
    label: `${name}${match.is_directory ? "/" : ""}`,
    description: match.path,
  };
}

export function createPiMentionProvider(
  current: PiAutocompleteProvider,
  options: PiMentionProviderOptions,
): PiAutocompleteProvider {
  const settle = options.settle ?? "complete";
  let mentionActive = false;
  let hiddenMode = false;

  return {
    async getSuggestions(lines, cursorLine, cursorCol, signal) {
      const currentLine = lines[cursorLine] ?? "";
      const context = extractMention(currentLine.slice(0, cursorCol));
      if (!context) {
        mentionActive = false;
        return current.getSuggestions(lines, cursorLine, cursorCol, signal);
      }
      if (!mentionActive || hiddenMode !== context.hidden) {
        options.client.restart(context.hidden);
      }
      mentionActive = true;
      hiddenMode = context.hidden;

      const query = options.client.query(context.query, {
        hidden: context.hidden,
        limit: 100,
      });
      const result = settle === "first" ? await query.first(signal) : await query.complete(signal);
      if (result.status !== "ready") return null;
      return {
        items: result.snapshot.matches.map((match) => toAutocompleteItem(match, context.quoted)),
        prefix: context.prefix,
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    getInlineHint: current.getInlineHint
      ? (lines, cursorLine, cursorCol) =>
          current.getInlineHint?.(lines, cursorLine, cursorCol) ?? null
      : undefined,
    trySyncSlashCompletion: current.trySyncSlashCompletion
      ? (textBeforeCursor) => current.trySyncSlashCompletion?.(textBeforeCursor) ?? null
      : undefined,
    trySyncInlineReplace: current.trySyncInlineReplace
      ? (textBeforeCursor) => current.trySyncInlineReplace?.(textBeforeCursor) ?? null
      : undefined,
    getForceFileSuggestions: current.getForceFileSuggestions
      ? (lines, cursorLine, cursorCol, signal) =>
          current.getForceFileSuggestions?.(lines, cursorLine, cursorCol, signal) ??
          Promise.resolve(null)
      : undefined,
    shouldTriggerFileCompletion: current.shouldTriggerFileCompletion
      ? (lines, cursorLine, cursorCol) =>
          current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false
      : undefined,
  };
}

export function installOmpMentionFs(ui: OmpExtensionUi, options: OmpMentionFsOptions): () => void {
  const client = new MentionFsClient({ binary: options.binary, root: options.root });
  ui.addAutocompleteProvider((current) =>
    createPiMentionProvider(current, {
      client,
      settle: options.settle,
    }),
  );
  return () => client.close();
}

export function createOmpMentionFsExtension(
  options: OmpExtensionFactoryOptions,
): (omp: OmpExtensionApi) => void {
  return (omp) => {
    let dispose: (() => void) | undefined;
    omp.on("session_start", (_event, context) => {
      dispose?.();
      dispose = installOmpMentionFs(context.ui, {
        binary: options.binary,
        root: context.cwd,
        settle: options.settle,
      });
    });
    omp.on("session_shutdown", () => {
      dispose?.();
      dispose = undefined;
    });
  };
}
