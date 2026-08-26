import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MentionFsClient } from "@celados/mention-fs";
import {
  createPiMentionProvider,
  type AutocompleteItem,
  type PiAutocompleteProvider,
} from "../src/index.ts";

const roots: string[] = [];
const clients: MentionFsClient[] = [];
const binary = resolve(import.meta.dir, "../../../target/debug/mention-fs");

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function baseProvider(): PiAutocompleteProvider {
  return {
    async getSuggestions() {
      return { items: [{ value: "/help", label: "help" }], prefix: "/" };
    },
    applyCompletion(lines, cursorLine, cursorCol, item: AutocompleteItem) {
      return { lines: [item.value], cursorLine, cursorCol };
    },
  };
}

describe("createPiMentionProvider", () => {
  test("replaces @ mention lookup and delegates other completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "mention-fs-pi-"));
    roots.push(root);
    await writeFile(join(root, "package.json"), "{}\n");
    const client = new MentionFsClient({ binary, root });
    clients.push(client);
    const provider = createPiMentionProvider(baseProvider(), { client });

    const mention = await provider.getSuggestions(["inspect @pack"], 0, "inspect @pack".length);
    expect(mention?.prefix).toBe("@pack");
    expect(mention?.items[0]?.value).toBe("@package.json");

    const slash = await provider.getSuggestions(["/h"], 0, 2);
    expect(slash?.items[0]?.value).toBe("/help");
  });

  test("supports Grok-style @! hidden lookup", async () => {
    const root = await mkdtemp(join(tmpdir(), "mention-fs-pi-"));
    roots.push(root);
    await writeFile(join(root, ".env"), "SECRET=x\n");
    const client = new MentionFsClient({ binary, root });
    clients.push(client);
    const provider = createPiMentionProvider(baseProvider(), { client });

    const result = await provider.getSuggestions(["@!.env"], 0, 6);
    expect(result?.items.some((item) => item.value === "@.env")).toBe(true);
  });

  test("reindexes when a new @ interaction starts", async () => {
    const root = await mkdtemp(join(tmpdir(), "mention-fs-pi-"));
    roots.push(root);
    await writeFile(join(root, "alpha.txt"), "a\n");
    const client = new MentionFsClient({ binary, root });
    clients.push(client);
    const provider = createPiMentionProvider(baseProvider(), { client });

    const initial = await provider.getSuggestions(["@alpha"], 0, 6);
    expect(initial?.items[0]?.value).toBe("@alpha.txt");

    await rm(join(root, "alpha.txt"));
    await writeFile(join(root, "beta.txt"), "b\n");
    await provider.getSuggestions(["plain"], 0, 5);
    const refreshed = await provider.getSuggestions(["@beta"], 0, 5);

    expect(refreshed?.items[0]?.value).toBe("@beta.txt");
  });
});
