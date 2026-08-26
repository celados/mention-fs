import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MentionFsClient } from "../src/index.ts";

const roots: string[] = [];
const clients: MentionFsClient[] = [];
const binary = resolve(import.meta.dir, "../../../target/debug/mention-fs");

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("MentionFsClient", () => {
  test("receives a completed ranked snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "mention-fs-client-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "src", "package-helper.ts"), "export {};\n");

    const client = new MentionFsClient({ binary, root });
    clients.push(client);
    const result = await client.query("package", { limit: 10 }).complete();

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.snapshot.done).toBe(true);
    expect(result.snapshot.matches[0]?.path).toBe("package.json");
  });

  test("terminates an empty query result", async () => {
    const root = await mkdtemp(join(tmpdir(), "mention-fs-client-"));
    roots.push(root);
    await writeFile(join(root, "alpha.txt"), "x\n");

    const client = new MentionFsClient({ binary, root });
    clients.push(client);
    const result = await client.query("does-not-exist").complete();

    expect(result.status).toBe("done-empty");
  });

  test("restart refreshes a long-lived index", async () => {
    const root = await mkdtemp(join(tmpdir(), "mention-fs-client-"));
    roots.push(root);
    await writeFile(join(root, "alpha.txt"), "a\n");
    const client = new MentionFsClient({ binary, root });
    clients.push(client);

    const initial = await client.query("txt").complete();
    expect(initial.status).toBe("ready");
    await rm(join(root, "alpha.txt"));
    await writeFile(join(root, "beta.txt"), "b\n");

    client.restart();
    const refreshed = await client.query("txt").complete();
    expect(refreshed.status).toBe("ready");
    if (refreshed.status !== "ready") return;
    expect(refreshed.snapshot.matches.map((match) => match.path)).toEqual(["beta.txt"]);
  });
});
