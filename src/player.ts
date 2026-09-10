import { spawn } from "node:child_process";
import { platform } from "node:process";
import { KongyoroidError, aborted } from "./errors.ts";

export interface PlayerCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export function playerCandidates(path: string, os: NodeJS.Platform = platform): readonly PlayerCommand[] {
  switch (os) {
    case "darwin":
      return [{ command: "afplay", args: [path] }];
    case "win32":
      return [
        {
          command: "powershell",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(New-Object System.Media.SoundPlayer -ArgumentList @('${path.replaceAll("'", "''")}')).PlaySync()`,
          ],
        },
      ];
    default:
      return [
        { command: "paplay", args: [path] },
        { command: "aplay", args: ["-q", path] },
        { command: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "error", path] },
        { command: "play", args: ["-q", path] },
      ];
  }
}

type Attempt =
  | { readonly outcome: "ok" }
  | { readonly outcome: "missing" }
  | { readonly outcome: "failed"; readonly reason: string };

function attempt(candidate: PlayerCommand, signal?: AbortSignal): Promise<Attempt> {
  return new Promise((resolve, reject) => {
    const child = spawn(candidate.command, candidate.args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 2000);
    });
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error: NodeJS.ErrnoException) => {
      signal?.removeEventListener("abort", onAbort);
      if (error.code === "ENOENT") resolve({ outcome: "missing" });
      else resolve({ outcome: "failed", reason: error.message });
    });
    child.once("exit", (code, signalName) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(aborted("Playback cancelled."));
      else if (code === 0) resolve({ outcome: "ok" });
      else resolve({ outcome: "failed", reason: `exited with ${code ?? signalName ?? "unknown"}: ${stderr.trim()}` });
    });
  });
}

export async function playWav(path: string, signal?: AbortSignal): Promise<{ readonly player: string }> {
  const candidates = playerCandidates(path);
  const attempts: string[] = [];
  for (const candidate of candidates) {
    if (signal?.aborted) throw aborted("Playback cancelled.");
    const result = await attempt(candidate, signal);
    if (result.outcome === "ok") return { player: candidate.command };
    attempts.push(`${candidate.command} (${result.outcome === "missing" ? "not found" : result.reason})`);
  }
  throw new KongyoroidError({
    code: "PLAYER_UNAVAILABLE",
    message: `No audio player could play ${path}. Tried: ${attempts.join("; ")}.`,
    retryable: false,
    hint: "Install one of the listed players, fix the failing one, or open the WAV file with your own tool.",
    detail: { attempts },
  });
}
