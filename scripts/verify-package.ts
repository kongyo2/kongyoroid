import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isObject } from "../src/validate.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command: string, args: readonly string[], cwd: string, input?: string): string {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const scratch = await mkdtemp(join(tmpdir(), "kongyoroid-consumer-"));
try {
  const packOutput = run(npm, ["pack", "--json", "--pack-destination", scratch], root);
  const packed: unknown = JSON.parse(packOutput);
  const filename = Array.isArray(packed) && isObject(packed[0]) ? packed[0]["filename"] : undefined;
  if (typeof filename !== "string") throw new Error(`unexpected npm pack output: ${packOutput}`);
  const tarball = join(scratch, filename);
  const bin = (name: string): string =>
    join(root, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
  run(bin("attw"), [tarball, "--profile", "esm-only"], root);
  run(bin("publint"), ["--strict"], root);
  await writeFile(
    join(scratch, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module", version: "0.0.0" }),
  );
  run(npm, ["install", "--no-audit", "--no-fund", "--no-package-lock", tarball], scratch);
  await writeFile(
    join(scratch, "consumer.mjs"),
    [
      'import { Kongyoroid, VERSION, REQUEST_SCHEMA, parseKanaNotation, inspectWav } from "@kongyo2/kongyoroid";',
      'import pkg from "@kongyo2/kongyoroid/package.json" with { type: "json" };',
      'if (pkg.version !== VERSION) throw new Error("version mismatch");',
      'const agent = new Kongyoroid({ engine: "formant", endpoint: "http://127.0.0.1:1" });',
      'const result = await agent.speak({ text: "こんにちは", kana: "コンニチワ\'" });',
      'if (result.engine !== "formant" || inspectWav(result.audio).frames < 1000) throw new Error("render failed");',
      'if (parseKanaNotation("ア\'").length !== 1) throw new Error("notation failed");',
      'if (REQUEST_SCHEMA.title !== "kongyoroid RenderRequest") throw new Error("schema missing");',
      "console.log(JSON.stringify({ ok: true, version: VERSION, frames: result.info.frames }));",
    ].join("\n"),
  );
  const runtime = run(process.execPath, [join(scratch, "consumer.mjs")], scratch);
  if (!runtime.includes('"ok":true')) throw new Error(`consumer failed: ${runtime}`);
  await writeFile(
    join(scratch, "consumer.ts"),
    [
      'import { Kongyoroid, type RenderResult, type SpeechRequest } from "@kongyo2/kongyoroid";',
      'const request: SpeechRequest = { kind: "speech", text: "x", engine: "formant" };',
      "export async function render(): Promise<RenderResult> {",
      "  return new Kongyoroid().render(request);",
      "}",
    ].join("\n"),
  );
  await writeFile(
    join(scratch, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        target: "es2024",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
        typeRoots: [join(root, "node_modules", "@types")],
      },
      files: ["consumer.ts"],
    }),
  );
  run(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(scratch, "tsconfig.json"), "--pretty", "false"],
    scratch,
  );
  const cli = join(scratch, "node_modules", ".bin", process.platform === "win32" ? "kongyoroid.cmd" : "kongyoroid");
  const version = run(cli, ["--version"], scratch);
  const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const expected = isObject(manifest) ? manifest["version"] : undefined;
  if (typeof expected !== "string" || !version.includes(`"version":"${expected}"`)) {
    throw new Error(`unexpected --version output: ${version}`);
  }
  const wav = join(scratch, "out.wav");
  const speak = run(cli, ["speak", "--engine", "formant", "--text", "てすと", "--output", wav], scratch);
  if (!speak.includes('"ok":true')) throw new Error(`speak failed: ${speak}`);
  const summary: unknown = JSON.parse(runtime.trim());
  console.log(JSON.stringify({ ok: true, tarball: filename, runtime: summary }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
