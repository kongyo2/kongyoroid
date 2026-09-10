import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KongyoroidError } from "../src/errors.ts";
import { playWav, playerCandidates } from "../src/player.ts";

test("player candidates depend on the platform", () => {
  assert.deepEqual(
    playerCandidates("/tmp/a.wav", "darwin").map((c) => c.command),
    ["afplay"],
  );
  assert.deepEqual(
    playerCandidates("/tmp/a.wav", "linux").map((c) => c.command),
    ["paplay", "aplay", "ffplay", "play"],
  );
  const windows = playerCandidates("C:\\a's.wav", "win32");
  assert.equal(windows[0]?.command, "powershell");
  assert.ok(windows[0]?.args.at(-1)?.includes("a''s.wav"));
});

test(
  "playWav falls through missing players and reports when none exist",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "kongyoroid-player-"));
    const originalPath = process.env["PATH"];
    try {
      process.env["PATH"] = directory;
      await assert.rejects(
        playWav("/nonexistent.wav"),
        (error: unknown) => error instanceof KongyoroidError && error.code === "PLAYER_UNAVAILABLE",
      );
      const fake = process.platform === "darwin" ? "afplay" : "aplay";
      await writeFile(join(directory, fake), "#!/bin/sh\nexit 0\n");
      await chmod(join(directory, fake), 0o755);
      assert.deepEqual(await playWav("/nonexistent.wav"), { player: fake });
      await writeFile(join(directory, fake), "#!/bin/sh\necho broken >&2\nexit 3\n");
      await assert.rejects(
        playWav("/nonexistent.wav"),
        (error: unknown) =>
          error instanceof KongyoroidError && error.code === "PLAYER_UNAVAILABLE" && error.message.includes("broken"),
      );
      if (process.platform !== "darwin") {
        await writeFile(join(directory, "ffplay"), "#!/bin/sh\nexit 0\n");
        await chmod(join(directory, "ffplay"), 0o755);
        assert.deepEqual(await playWav("/nonexistent.wav"), { player: "ffplay" });
      }
    } finally {
      process.env["PATH"] = originalPath;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
