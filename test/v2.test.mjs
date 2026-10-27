import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import server from "../dist/server.js";
import tui from "../dist/tui.js";
import v1 from "../dist/server-v1.js";
import { discoverRepository } from "../dist/repository.js";
import { readDecision, readHookStatus, readModels, writeDecision } from "../dist/settings.js";

const execute = promisify(execFile);
async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), "trailmate-v2-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await execute("git", ["-C", root, "init", "-q"]);
    return { root, repository: await discoverRepository(root) };
}

test("V2 collects changed steps, including failed and subagent steps, and stops its subscription", async (t) => {
    const { root, repository } = await fixture(t);
    const other = await fixture(t);
    await writeDecision(repository, true);
    let signal;
    let boundary;
    let drained;
    const ready = new Promise((resolve) => {
        drained = resolve;
    });
    let lookups = 0;
    const started = (id, directory = root) => ({
        id: `start-${id}`,
        type: "session.step.started",
        location: { directory },
        data: {
            sessionID: id === "child" ? "child-session" : "session",
            assistantMessageID: id,
            model: { providerID: "provider", id },
        },
    });
    const ended = (id, files = ["changed"], type = "session.step.ended") => ({
        id: `end-${id}`,
        type,
        location: { directory: root },
        data: { ...started(id).data, files },
    });
    const events = [
        started("discussion"),
        ended("discussion", []),
        started("main"),
        ended("main"),
        ended("main"),
        started("child"),
        ended("child"),
        started("failed"),
        ended("failed", ["changed"], "session.step.failed"),
        started("outside", other.root),
        ended("outside"),
        ended("lookup"),
    ];
    const cleanup = await server.setup({
        location: { directory: root },
        session: {
            context: async () => {
                lookups++;
                return [
                    {
                        id: "lookup",
                        type: "assistant",
                        model: { providerID: "provider", id: "lookup" },
                    },
                ];
            },
            get: async () => ({ location: { directory: root } }),
        },
        tool: {
            hook: async (name, callback) => {
                assert.equal(name, "execute.before");
                boundary = callback;
            },
        },
        event: {
            subscribe: async function* (options) {
                signal = options.signal;
                yield* events;
                drained();
                if (!signal.aborted)
                    await new Promise((resolve) =>
                        signal.addEventListener("abort", resolve, { once: true }),
                    );
            },
        },
    });
    t.after(cleanup);
    await ready;
    await boundary();
    assert.deepEqual(await readModels(repository), [
        "provider/child",
        "provider/failed",
        "provider/lookup",
        "provider/main",
    ]);
    assert.equal(lookups, 1, "started events avoid fetching session history");
    await cleanup();
    assert.equal(signal.aborted, true);
});

test("V1 adapter still records patches through its SDK client", async (t) => {
    const { root, repository } = await fixture(t);
    await writeDecision(repository, true);
    const hooks = await v1.server({
        directory: root,
        client: {
            app: { log: async () => {} },
            session: {
                message: async ({ path }) => ({
                    data: {
                        info: {
                            id: path.messageID,
                            sessionID: path.id,
                            role: "assistant",
                            path: { cwd: root },
                            providerID: "v1",
                            modelID: "model",
                        },
                    },
                }),
            },
        },
    });
    await hooks.event({
        event: { type: "message.part.updated", properties: { part: { type: "text" } } },
    });
    await hooks.event({
        event: {
            type: "message.part.updated",
            properties: {
                part: {
                    type: "patch",
                    id: "patch",
                    sessionID: "session",
                    messageID: "message",
                    files: ["changed"],
                },
            },
        },
    });
    await hooks["tool.execute.before"]();
    assert.deepEqual(await readModels(repository), ["v1/model"]);
});

test("V2 TUI enables attribution and exposes native management commands", async (t) => {
    const { root, repository } = await fixture(t);
    let tick;
    let command;
    const alerts = [];
    const errors = [];
    const choices = ["enable", "status", "disable", "status"];
    t.mock.method(globalThis, "setInterval", (callback) => {
        tick = callback;
        return 1;
    });
    t.mock.method(globalThis, "clearInterval", () => {});
    const cleanup = tui.setup({
        location: { directory: root },
        keymap: {
            layer: (factory) => {
                [command] = factory().commands;
            },
        },
        ui: {
            dialog: {
                select: async () => choices.shift(),
                alert: async (options) => {
                    alerts.push(options.message);
                },
                clear: () => {},
            },
            toast: { show: (options) => errors.push(options.message) },
        },
    });
    t.after(cleanup);
    tick();
    // The timer starts asynchronous repository discovery and hook installation.
    for (let i = 0; i < 100 && (await readDecision(repository)) !== "enabled"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(await readDecision(repository), "enabled");
    assert.equal(command.slash.name, "trailmate");
    assert.equal(command.palette, true);
    await command.run();
    assert.match(alerts[0], /Trailmate: enabled/);
    await command.run();
    assert.equal(await readDecision(repository), "disabled");
    assert.equal(await readHookStatus(repository), "not installed in this worktree");
    await command.run();
    assert.match(alerts[2], /Trailmate: disabled/);
    assert.deepEqual(errors, []);
});

test("V2 TUI closes pending opt-in on workspace change and disposal without saving stale choices", async (t) => {
    const { root, repository } = await fixture(t);
    let tick;
    t.mock.method(globalThis, "setInterval", (callback) => {
        tick = callback;
        return 1;
    });
    t.mock.method(globalThis, "clearInterval", () => {});
    for (const reason of ["switch", "dispose"]) {
        let location = { directory: root };
        let choose;
        let opened;
        const ready = new Promise((resolve) => {
            opened = resolve;
        });
        let closed = 0;
        const cleanup = tui.setup({
            get location() {
                return location;
            },
            keymap: { layer: () => {} },
            ui: {
                dialog: {
                    select: () =>
                        new Promise((resolve) => {
                            choose = resolve;
                            opened();
                        }),
                    clear: () => {
                        closed++;
                        choose("enable");
                    },
                },
                toast: { show: (options) => assert.fail(options.message) },
            },
        });
        tick();
        await ready;
        if (reason === "switch") {
            location = { directory: "" };
            tick();
        } else {
            cleanup();
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(closed, 1);
        assert.equal(await readDecision(repository), "unknown");
        if (reason === "switch") cleanup();
    }
});
