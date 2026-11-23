import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import server from "../dist/server.js";
import v1 from "../dist/server-v1.js";
import { discoverRepository } from "../dist/repository.js";
import { clearModels, markSetupComplete, readModels, writeDecision } from "../dist/settings.js";

const execute = promisify(execFile);
const git = (root, ...args) => execute("git", ["-C", root, ...args]);
const commit = (root) => git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");

async function fixture(t, submodule = false, version = 2) {
    const directory = await mkdtemp(path.join(tmpdir(), "trailmate-child-changes-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = path.join(directory, "parent");
    const source = submodule ? path.join(directory, "source") : path.join(root, "child");
    await mkdir(root);
    await git(root, "init", "-q");
    await mkdir(source);
    await git(source, "init", "-q");
    await writeFile(path.join(source, "tracked.txt"), "original\n");
    await writeFile(path.join(source, ".gitignore"), "ignored*\n");
    await git(source, "add", ".");
    await commit(source);
    if (submodule) await git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "child");
    const child = path.join(root, "child");
    const repository = await discoverRepository(root);
    const nested = await discoverRepository(child);
    await writeDecision(repository, false);
    await writeDecision(nested, true);
    await markSetupComplete(repository, [child]);
    const hooks = new Map();
    const messages = new Map();
    const warnings = [];
    if (version === 1) {
        const history = [];
        const hooks = await v1.server({
            directory: root,
            client: {
                app: { log: async ({ body }) => { if (body.level === "warn") warnings.push(body.message); } },
                session: {
                    messages: async ({ path: session, query }) => {
                        assert.equal(query.directory, root);
                        return { data: history.filter(({ info }) => info.sessionID === session.id) };
                    },
                },
            },
        });
        t.after(() => assert.deepEqual(warnings, []));
        const tool = async (model, operation, { fail = false, byPartID = false, unmatched = false } = {}) => {
            const sessionID = "session";
            const messageID = `v1-message-${history.length}`;
            const part = { type: "tool", id: `part-${messageID}`, callID: `call-${messageID}`, messageID, sessionID, tool: "bash" };
            const info = { id: messageID, sessionID, role: "assistant", path: { cwd: root }, providerID: "v1", modelID: model };
            history.push({ info, parts: [{ ...part, state: { status: "pending" } }] });
            // A newer, unrelated assistant must not be credited for this call.
            history.push({ info: { ...info, id: `${messageID}-newer`, modelID: "wrong" }, parts: [] });
            const callID = unmatched ? "unmatched" : byPartID ? part.id : part.callID;
            const input = { sessionID, callID, tool: part.tool };
            await hooks["tool.execute.before"](input, { args: {} });
            await operation();
            if (fail) {
                await hooks.event({ event: {
                    type: "message.part.updated",
                    properties: { part: { ...part, state: { status: "error", error: "failed" } } },
                } });
            } else {
                await hooks["tool.execute.after"]({ ...input, args: {} }, { title: "", output: "", metadata: {} });
            }
        };
        return { root, child, repository, nested, tool };
    }
    t.mock.method(console, "warn", (...args) => warnings.push(args));
    const cleanup = await server.setup({
        location: { directory: root },
        session: {
            context: async () => [...messages.values()],
            get: async () => ({ location: { directory: root } }),
        },
        tool: { hook: async (name, callback) => hooks.set(name, callback) },
        // No file paths, patches or snapshot events are supplied by this test.
        event: { subscribe: async function* () {} },
    });
    t.after(cleanup);
    t.after(() => assert.deepEqual(warnings, []));
    let id = 0;
    const tool = async (model, operation) => {
        const messageID = `message-${++id}`;
        messages.set(messageID, { id: messageID, type: "assistant", model: { providerID: "provider", id: model } });
        const call = { sessionID: "session", messageID, id: `call-${id}`, tool: "shell" };
        await hooks.get("execute.before")(call);
        try {
            await operation();
        } catch (error) {
            await hooks.get("execute.after")({ ...call, status: "error", error });
            throw error;
        }
        await hooks.get("execute.after")({ ...call, status: "completed", result: { content: [] } });
    };
    return { root, child, repository, nested, tool };
}

for (const submodule of [false, true]) {
    test(`V2 records shell edits in an enabled ${submodule ? "submodule" : "nested repository"} without snapshot events`, async (t) => {
        const { root, child, repository, nested, tool } = await fixture(t, submodule);
        // Both states have the same Git status; comparing status alone is insufficient.
        await writeFile(path.join(child, "tracked.txt"), "already dirty\n");
        await tool("read-only", () => readFile(path.join(child, "tracked.txt")));
        assert.deepEqual(await readModels(nested), []);
        await tool("editor", () => execute("sh", ["-c", "printf 'changed again\\n' > child/tracked.txt"], { cwd: root }));
        assert.deepEqual(await readModels(nested), ["provider/editor"]);
        assert.deepEqual(await readModels(repository), []);
    });

    test(`V1 records shell edits in an enabled ${submodule ? "submodule" : "nested repository"} without patch events`, async (t) => {
        const { root, child, repository, nested, tool } = await fixture(t, submodule, 1);
        await writeFile(path.join(child, "tracked.txt"), "already dirty\n");
        await tool("read-only", () => readFile(path.join(child, "tracked.txt")));
        await tool("unmatched", () => writeFile(path.join(child, "tracked.txt"), "unmatched edit"), { unmatched: true });
        assert.deepEqual(await readModels(nested), []);
        await tool("editor", () => execute("sh", ["-c", "printf 'changed again\\n' > child/tracked.txt"], { cwd: root }));
        assert.deepEqual(await readModels(nested), ["v1/editor"]);
        assert.deepEqual(await readModels(repository), []);
    });
}

test("V1 records child edits when a tool error event replaces the after hook", async (t) => {
    const { child, nested, tool } = await fixture(t, false, 1);
    const file = path.join(child, "tracked.txt");
    await tool("failed-call", () => writeFile(file, "first change"), { fail: true });
    await tool("failed-part", () => writeFile(file, "second change"), { fail: true, byPartID: true });
    assert.deepEqual(await readModels(nested), ["v1/failed-call", "v1/failed-part"]);
});

test("V2 child detection catches repeated untracked edits, binary edits, deletions and mode changes", async (t) => {
    const { child, nested, tool } = await fixture(t);
    const file = path.join(child, "new.bin");
    await tool("new", () => writeFile(file, Buffer.from([0, 1, 2])));
    await tool("update", () => writeFile(file, Buffer.from([0, 3, 2])));
    await tool("mode", () => chmod(path.join(child, "tracked.txt"), 0o755));
    await tool("delete", () => rm(path.join(child, "tracked.txt")));
    assert.deepEqual(await readModels(nested), ["provider/delete", "provider/mode", "provider/new", "provider/update"]);
});

test("V2 records files changed by failed tools and does not count ignored or parent-only edits", async (t) => {
    const { root, child, nested, tool } = await fixture(t);
    await tool("ignored", () => writeFile(path.join(child, "ignored.log"), "cache"));
    await tool("parent", () => writeFile(path.join(root, "parent.txt"), "parent"));
    assert.deepEqual(await readModels(nested), []);
    await assert.rejects(tool("failed", async () => {
        await writeFile(path.join(child, "tracked.txt"), "changed before failure");
        throw new Error("tool failed");
    }), /tool failed/);
    assert.deepEqual(await readModels(nested), ["provider/failed"]);
});

test("V2 child detection hashes symlink targets without following the links", async (t) => {
    const { root, child, nested, tool } = await fixture(t);
    const target = path.join(root, "outside.txt");
    const link = path.join(child, "link");
    await writeFile(target, "original");
    await symlink(target, link);
    await tool("outside", () => writeFile(target, "changed"));
    assert.deepEqual(await readModels(nested), []);
    await tool("link", async () => {
        await rm(link);
        await symlink("different-target", link);
    });
    assert.deepEqual(await readModels(nested), ["provider/link"]);
});

test("V2 does not re-add cleared attribution for git add or a subsequent successful commit", async (t) => {
    const { child, nested, tool } = await fixture(t);
    await tool("editor", () => writeFile(path.join(child, "tracked.txt"), "edited"));
    assert.deepEqual(await readModels(nested), ["provider/editor"]);
    await clearModels(nested);
    await tool("stage", () => git(child, "add", "."));
    assert.deepEqual(await readModels(nested), []);
    await tool("edit-again", () => writeFile(path.join(child, "tracked.txt"), "edited again"));
    await git(child, "add", ".");
    await tool("commit", () => commit(child));
    assert.deepEqual(await readModels(nested), []);
    const { stdout } = await git(child, "log", "-1", "--format=%B");
    assert.match(stdout, /Assisted-by: provider\/edit-again/);
});

test("V2 does not record child edits when disabled before or during the tool", async (t) => {
    const { child, nested, tool } = await fixture(t);
    await writeDecision(nested, false);
    await tool("disabled", () => writeFile(path.join(child, "tracked.txt"), "disabled"));
    await writeDecision(nested, true);
    await tool("disable-during", async () => {
        await writeFile(path.join(child, "tracked.txt"), "disabled during tool");
        await writeDecision(nested, false);
    });
    assert.deepEqual(await readModels(nested), []);
});

test("V2 attributes edits only to the owning child, not its enclosing repository", async (t) => {
    const { root, child, repository, nested, tool } = await fixture(t);
    const grandchild = path.join(child, "grandchild");
    await mkdir(grandchild);
    const file = path.join(grandchild, "file.txt");
    await writeFile(file, "original");
    // Even if an enclosing index still tracks these paths, the nested repo owns them.
    await git(child, "add", ".");
    await commit(child);
    await git(grandchild, "init", "-q");
    await git(grandchild, "add", ".");
    await commit(grandchild);
    const grand = await discoverRepository(grandchild);
    await writeDecision(grand, true);
    await markSetupComplete(repository, [child, grandchild]);
    await tool("grandchild-edit", () => writeFile(file, "changed"));
    assert.deepEqual(await readModels(grand), ["provider/grandchild-edit"]);
    assert.deepEqual(await readModels(nested), []);
    assert.deepEqual(await readModels(await discoverRepository(root)), []);
    await writeDecision(grand, false);
    await tool("disabled-grandchild", () => writeFile(file, "changed while disabled"));
    assert.deepEqual(await readModels(nested), []);
});

test("stale discovery hints do not hide changes owned by a valid child repository", async (t) => {
    const { child, repository, nested, tool } = await fixture(t);
    const stale = path.join(child, "no-longer-a-repository");
    await mkdir(stale);
    const file = path.join(stale, "file.txt");
    await writeFile(file, "original");
    await git(child, "add", ".");
    await commit(child);
    await markSetupComplete(repository, [child, stale]);
    await tool("edit", () => writeFile(file, "changed"));
    assert.deepEqual(await readModels(nested), ["provider/edit"]);
});
