import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import { createCollector } from "../dist/collection.js";
import { discoverRepository } from "../dist/repository.js";
import { clearModels, readModels, settingsPath, writeDecision } from "../dist/settings.js";

const execute = promisify(execFile);

async function fixture(t) {
    const root = await mkdtemp("/tmp/opencode/auto-attr-collection-");
    t.after(() => rm(root, { recursive: true, force: true }));
    await execute("git", ["-C", root, "init", "-q"]);
    const repository = await discoverRepository(root);
    const warnings = [];
    const messages = new Map();
    const collector = createCollector(repository, {
        app: { log: async ({ body }) => warnings.push(body.message) },
        session: { message: async ({ path }) => ({ data: messages.get(path.messageID) }) },
    });
    const info = (id, extra = {}) => ({
        id,
        sessionID: "session",
        role: "assistant",
        providerID: "provider",
        modelID: id,
        path: { cwd: root, root },
        ...extra,
    });
    const message = (info) => collector.event({ type: "message.updated", properties: { info } });
    const patch = (id, messageID, files = ["file"], sessionID = "session") =>
        collector.event({
            type: "message.part.updated",
            properties: { part: { type: "patch", id, messageID, sessionID, files, hash: "hash" } },
        });
    return { root, repository, warnings, messages, collector, info, message, patch };
}

test("only non-summary file-changing messages contribute, including subagents and reordered events", async (t) => {
    const { repository, info, message, patch, messages } = await fixture(t);
    await writeDecision(repository, true);
    await message(info("discussion"));
    await message(info("empty"));
    await patch("empty-patch", "empty", []);
    await message(info("summary", { summary: true }));
    await patch("summary-patch", "summary");
    await message(info("main"));
    await patch("main-patch", "main");
    await patch("reordered-patch", "reordered");
    await message(info("reordered"));
    messages.set("lookup", { info: info("lookup"), parts: [] });
    await patch("lookup-patch", "lookup");
    await message(info("child", { sessionID: "subagent" }));
    await patch("child-patch", "child", ["changed"], "subagent");
    assert.deepEqual(await readModels(repository), [
        "provider/child",
        "provider/lookup",
        "provider/main",
        "provider/reordered",
    ]);
});

test("duplicate events do not undo clear, disable discards changes, new patches are collected", async (t) => {
    const { repository, info, message, patch } = await fixture(t);
    await writeDecision(repository, true);
    await message(info("model"));
    await patch("patch-1", "model");
    await clearModels(repository);
    await Promise.all([patch("patch-1", "model"), message(info("model"))]);
    assert.deepEqual(await readModels(repository), []);
    await writeDecision(repository, false);
    await patch("disabled", "model");
    await writeDecision(repository, true);
    await patch("disabled", "model");
    assert.deepEqual(await readModels(repository), []);
    await patch("new", "model");
    assert.deepEqual(await readModels(repository), ["provider/model"]);
});

test("failed model writes retry and events from other worktrees are excluded", async (t) => {
    const { root, repository, collector, warnings, info, message, patch } = await fixture(t);
    await writeDecision(repository, true);
    await message(info("retry"));
    const lock = `${settingsPath(repository)}.lock`;
    await writeFile(lock, "held");
    await patch("retry-patch", "retry");
    assert.match(warnings[0], /Timed out/);
    await rm(lock);
    await collector.flush();
    assert.deepEqual(await readModels(repository), ["provider/retry"]);
    const outside = `${root}/other`;
    await mkdir(outside);
    await execute("git", ["-C", outside, "init", "-q"]);
    await message(info("other", { path: { cwd: outside, root: outside } }));
    await patch("other-patch", "other");
    assert.deepEqual(await readModels(repository), ["provider/retry"]);
});

test("independent collector processes merge model additions without losing settings", async (t) => {
    const { repository } = await fixture(t);
    await writeDecision(repository, true);
    const module = new URL("../dist/settings.js", import.meta.url).href;
    const run = (model) =>
        execute(process.execPath, [
            "--input-type=module",
            "-e",
            `import { addModel } from ${JSON.stringify(module)};
         const repository = JSON.parse(process.argv[1]);
         for (let i = 0; i < 6; i++) await addModel(repository, process.argv[2]);`,
            JSON.stringify(repository),
            model,
        ]);
    await Promise.all([run("first/model"), run("second/model")]);
    assert.deepEqual(await readModels(repository), ["first/model", "second/model"]);
});
