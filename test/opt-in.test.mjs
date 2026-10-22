import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { discoverRepository } from "../dist/repository.js";
import { readDecision, writeDecision } from "../dist/settings.js";
import { OptIn } from "../dist/opt-in.js";
import serverModule from "../dist/server.js";
import tuiModule from "../dist/tui.js";

const execute = promisify(execFile);
const git = (cwd, ...args) => execute("git", ["-C", cwd, ...args]);

async function fixture(t) {
    const directory = await mkdtemp(path.join(tmpdir(), "trailmate-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));

    const root = path.join(directory, "repository with spaces");
    await mkdir(root);
    await git(root, "init", "-q");

    return { directory, root, repository: await discoverRepository(root) };
}

test("unborn repositories, subdirectories, non-repositories and bare repositories", async (t) => {
    const { directory, root, repository } = await fixture(t);

    assert.equal(repository.root, root);
    assert.equal(repository.commonDir, path.join(root, ".git"));

    const child = path.join(root, "nested");
    await mkdir(child);
    assert.deepEqual(await discoverRepository(child), repository);
    assert.equal(await discoverRepository(directory), undefined);

    const bare = path.join(directory, "bare");
    await git(directory, "init", "--bare", "-q", bare);
    assert.equal(await discoverRepository(bare), undefined);
});

test("settings persist across readers and linked worktrees share the decision", async (t) => {
    const { directory, root, repository } = await fixture(t);

    assert.equal(await readDecision(repository), "unknown");

    await writeDecision(repository, false);
    assert.equal(await readDecision(await discoverRepository(root)), "disabled");

    // A linked worktree needs an initial commit; keep identity and signing
    // configuration local to this command rather than changing user settings.
    await writeDecision(repository, true);
    await git(
        root,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "fixture",
    );

    const linked = path.join(directory, "linked worktree");
    await git(root, "worktree", "add", "-qb", "linked", linked);
    const other = await discoverRepository(linked);

    assert.equal(other.commonDir, repository.commonDir);
    assert.equal(await readDecision(other), "enabled");
});

test("separate Git directory", async (t) => {
    const { directory } = await fixture(t);

    const root = path.join(directory, "separate");
    const gitDir = path.join(directory, "metadata");
    await mkdir(root);
    await git(root, "init", "-q", `--separate-git-dir=${gitDir}`);

    const repository = await discoverRepository(root);
    assert.equal(repository.commonDir, gitDir);
});

test("Later suppresses repeated prompts; restarting asks again; disable persists", async (t) => {
    const { root, repository } = await fixture(t);
    const first = new OptIn();
    let prompts = 0;

    const later = async () => {
        prompts++;
        return "later";
    };

    await first.check(root, () => true, later);
    await first.check(root, () => true, later);
    assert.equal(prompts, 1);
    assert.equal(await readDecision(repository), "unknown");

    // A fresh coordinator represents a restarted TUI, not a new chat session.
    await new OptIn().check(
        root,
        () => true,
        async () => "disable",
    );
    await new OptIn().check(
        root,
        () => true,
        async () => assert.fail("disabled repository prompted"),
    );
    assert.equal(await readDecision(repository), "disabled");
});

test("a directory switch or disposal while prompting cannot save a stale decision", async (t) => {
    const { root, repository } = await fixture(t);

    let active = true;
    await new OptIn().check(
        root,
        () => active,
        async () => {
            // Simulate that the user switches directories or closes opencode before responding to
            // the prompt. check() will call the closure again to verify whether something changed.
            active = false;
            return "enable";
        },
    );

    // Since check() revalidates the context after awaiting the prompt, even an
    // explicit Enable answer will not persist a decision from a stale dialog.
    assert.equal(await readDecision(repository), "unknown");
});

test("switching repositories in one TUI prompts independently", async (t) => {
    const { directory, root } = await fixture(t);

    const second = path.join(directory, "second");
    await mkdir(second);
    await git(second, "init", "-q");

    const controller = new OptIn();
    const prompted = [];
    const prompt = async (repository) => {
        prompted.push(repository.root);
        return "later";
    };

    await controller.check(root, () => true, prompt);
    await controller.check(second, () => true, prompt);
    await controller.check(root, () => true, prompt);
    assert.deepEqual(prompted, [root, second]);
});

test("concurrent checks in one TUI open only one prompt", async (t) => {
    const { root, repository } = await fixture(t);
    const controller = new OptIn();
    let prompts = 0;

    const check = () =>
        controller.check(
            root,
            () => true,
            async () => {
                prompts++;
                return "enable";
            },
        );

    await Promise.all([check(), check(), check()]);
    assert.equal(prompts, 1);
    assert.equal(await readDecision(repository), "enabled");
});

test("server loads and flushes without enabling headless repositories", async (t) => {
    const { root, repository } = await fixture(t);
    const messages = [];

    const hooks = await serverModule.server({
        directory: root,
        client: {
            app: {
                log: async ({ body }) => {
                    messages.push(body.message);
                },
            },
        },
    });

    assert.deepEqual(messages, ["Trailmate plugin loaded"]);
    await hooks["tool.execute.before"]();
    assert.equal(await readDecision(repository), "unknown");
});

test("TUI waits for readiness, closes with Later, and cleans up on disposal", async (t) => {
    const { root, repository } = await fixture(t);
    const abort = new AbortController();
    let dispose;
    let dialog;
    let onClose;
    let renders = 0;

    // Model the host's synchronous onClose callback when clear() is called.
    // This catches accidental replacement of an explicit choice with Later.
    const api = {
        state: { ready: false, path: { directory: root } },
        lifecycle: {
            signal: abort.signal,
            onDispose: (fn) => {
                dispose = fn;
            },
        },
        ui: {
            DialogSelect: (props) => {
                renders++;
                return props;
            },
            toast: (input) => assert.fail(input.message),
            dialog: {
                get open() {
                    return !!dialog;
                },
                replace: (render, close) => {
                    dialog = render();
                    onClose = close;
                },
                clear: () => {
                    dialog = undefined;
                    onClose?.();
                },
            },
        },
    };

    await tuiModule.tui(api);
    t.after(() => {
        abort.abort();
        dispose();
    });

    // Advance beyond the plugin's 500 ms poll interval at each lifecycle boundary.
    const wait = () => new Promise((resolve) => setTimeout(resolve, 650));

    await wait();
    assert.equal(renders, 0);

    api.state.ready = true;
    await wait();
    assert.equal(renders, 1);

    api.ui.dialog.clear();
    await wait();
    assert.equal(renders, 1);
    assert.equal(await readDecision(repository), "unknown");
    assert.equal(
        await readFile(path.join(root, ".git", "config"), "utf8").then((s) =>
            s.includes("hooksPath"),
        ),
        false,
    );
});
