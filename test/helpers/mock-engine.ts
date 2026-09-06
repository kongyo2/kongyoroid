import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import type { KanaUnit } from "../../src/mora.ts";
import { MORA_TABLE, kanaToUnits, toKatakana } from "../../src/mora.ts";
import type { AccentPhrase } from "../../src/notation.ts";
import { formatKanaNotation, parseKanaNotation } from "../../src/notation.ts";
import { midiToHz } from "../../src/pitch.ts";
import { isObject } from "../../src/validate.ts";
import { encodeWav } from "../../src/wav.ts";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface Fault {
  readonly status: number;
  times: number;
  readonly path?: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

interface Style {
  readonly name: string;
  readonly id: number;
  readonly type: string;
}

interface Character {
  readonly name: string;
  readonly speaker_uuid: string;
  readonly version: string;
  readonly styles: readonly Style[];
}

export const MOCK_SPEAKERS: readonly Character[] = [
  {
    name: "ずんだもん",
    speaker_uuid: "388f246b-8c41-4ac1-8e2d-5d79f3ff56d9",
    version: "0.14.0",
    styles: [
      { name: "ノーマル", id: 3, type: "talk" },
      { name: "あまあま", id: 1, type: "talk" },
      { name: "ささやき", id: 22, type: "talk" },
    ],
  },
  {
    name: "四国めたん",
    speaker_uuid: "7ffcb7ce-00ec-4bdc-82cd-45a8889e43ff",
    version: "0.14.0",
    styles: [
      { name: "ノーマル", id: 2, type: "talk" },
      { name: "あまあま", id: 0, type: "talk" },
    ],
  },
];

export const MOCK_SINGERS: readonly Character[] = [
  {
    name: "波音リツ",
    speaker_uuid: "b1a81618-b27b-40d2-b0ea-27a9ad408c4b",
    version: "0.14.0",
    styles: [{ name: "ノーマル", id: 6000, type: "singing_teacher" }],
  },
  {
    name: "ずんだもん",
    speaker_uuid: "388f246b-8c41-4ac1-8e2d-5d79f3ff56d9",
    version: "0.14.0",
    styles: [{ name: "ノーマル", id: 3001, type: "frame_decode" }],
  },
  {
    name: "ナースロボ＿タイプＴ",
    speaker_uuid: "882a636f-3bac-431a-966d-c5e6bba9f949",
    version: "0.14.0",
    styles: [{ name: "ノーマル", id: 3002, type: "sing" }],
  },
];

const PHONEMES: ReadonlySet<string> = new Set([
  "pau",
  "A",
  "E",
  "I",
  "N",
  "O",
  "U",
  "a",
  "b",
  "by",
  "ch",
  "cl",
  "d",
  "dy",
  "e",
  "f",
  "g",
  "gw",
  "gy",
  "h",
  "hy",
  "i",
  "j",
  "k",
  "kw",
  "ky",
  "m",
  "my",
  "n",
  "ny",
  "o",
  "p",
  "py",
  "r",
  "ry",
  "s",
  "sh",
  "t",
  "ts",
  "ty",
  "u",
  "v",
  "w",
  "y",
  "z",
]);

const FRAME_RATE = 93.75;

class HttpError extends Error {
  public readonly status: number;
  public readonly detail: unknown;

  public constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isObject(value)) throw new HttpError(422, `${what} must be an object`);
  return value;
}

function asList(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new HttpError(422, `${what} must be an array`);
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== "number") throw new HttpError(422, `${what} must be a number`);
  return value;
}

function styleIds(): ReadonlySet<number> {
  const ids = new Set<number>();
  for (const character of [...MOCK_SPEAKERS, ...MOCK_SINGERS]) for (const style of character.styles) ids.add(style.id);
  return ids;
}

function analyze(text: string): AccentPhrase[] {
  let units: readonly KanaUnit[];
  try {
    units = kanaToUnits(text);
  } catch {
    units = Array.from(text).map((char): KanaUnit =>
      /[、。！？!?,.]/u.test(char)
        ? { kind: "pause", text: char, weight: 1 }
        : { kind: "mora", text: "ア", consonant: null, vowel: "a" },
    );
  }
  const phrases: AccentPhrase[] = [];
  let moras: AccentPhrase["moras"][number][] = [];
  const flush = (pause: boolean, interrogative: boolean): void => {
    if (moras.length === 0) return;
    phrases.push({ moras, accent: phrases.length === 0 ? 1 : moras.length, pause, interrogative });
    moras = [];
  };
  for (const unit of units) {
    if (unit.kind === "pause") {
      flush(true, unit.text === "?" || unit.text === "？");
      continue;
    }
    moras.push({ text: unit.text, consonant: unit.consonant, vowel: unit.vowel });
    if (moras.length >= 6) flush(false, false);
  }
  flush(false, false);
  return phrases;
}

function engineShape(phrase: AccentPhrase): unknown {
  return {
    moras: phrase.moras.map((mora) => ({
      text: mora.text,
      consonant: mora.consonant,
      consonant_length: mora.consonant === null ? null : 0.03,
      vowel: mora.vowel,
      vowel_length: 0.08,
      pitch: mora.vowel === "pau" || mora.vowel === "cl" ? 0 : 5.6,
    })),
    accent: phrase.accent,
    pause_mora: phrase.pause
      ? { text: "、", consonant: null, consonant_length: null, vowel: "pau", vowel_length: 0.3, pitch: 0 }
      : null,
    is_interrogative: phrase.interrogative,
  };
}

function tone(seconds: number, sampleRate: number, amplitude: number, hz: number = 220): Uint8Array {
  const pcm = new Float32Array(Math.max(1, Math.round(seconds * sampleRate)));
  for (let i = 0; i < pcm.length; i++) pcm[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return encodeWav(pcm, sampleRate);
}

function querySeconds(query: Record<string, unknown>): number {
  const speed = Number(query["speedScale"] ?? 1);
  let seconds = Number(query["prePhonemeLength"] ?? 0) + Number(query["postPhonemeLength"] ?? 0);
  const pauseLength = query["pauseLength"];
  const pauseScale = Number(query["pauseLengthScale"] ?? 1);
  for (const rawPhrase of asList(query["accent_phrases"], "accent_phrases")) {
    const phrase = asRecord(rawPhrase, "accent_phrase");
    const moras = asList(phrase["moras"], "moras").map((m) => asRecord(m, "mora"));
    const pauseMora = phrase["pause_mora"];
    if (pauseMora !== null && pauseMora !== undefined) moras.push(asRecord(pauseMora, "pause_mora"));
    for (const mora of moras) {
      const pause = mora["vowel"] === "pau";
      const vowel =
        pause && typeof pauseLength === "number"
          ? pauseLength
          : Number(mora["vowel_length"]) * (pause ? pauseScale : 1);
      seconds += (vowel + Number(mora["consonant_length"] ?? 0)) / speed;
    }
  }
  return seconds;
}

function stereoize(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const frames = (wav.byteLength - 44) / 2;
  const out = new Uint8Array(44 + frames * 4);
  out.set(wav.subarray(0, 44));
  const outView = new DataView(out.buffer);
  outView.setUint32(4, 36 + frames * 4, true);
  outView.setUint16(22, 2, true);
  outView.setUint32(28, view.getUint32(24, true) * 4, true);
  outView.setUint16(32, 4, true);
  outView.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    const sample = view.getInt16(44 + i * 2, true);
    outView.setInt16(44 + i * 4, sample, true);
    outView.setInt16(46 + i * 4, sample, true);
  }
  return out;
}

interface ScoreNote {
  readonly id: string | null;
  readonly key: number | null;
  readonly frame_length: number;
  readonly lyric: string;
}

function asScore(body: unknown): readonly ScoreNote[] {
  const score = asRecord(body, "score");
  return asList(score["notes"], "notes").map((raw) => {
    const note = asRecord(raw, "note");
    const key = note["key"];
    if (key !== null && typeof key !== "number") throw new HttpError(422, "key must be an integer or null");
    return {
      id: typeof note["id"] === "string" ? note["id"] : null,
      key,
      frame_length: asNumber(note["frame_length"], "frame_length"),
      lyric: typeof note["lyric"] === "string" ? note["lyric"] : "",
    };
  });
}

function frameQuery(body: unknown): unknown {
  const notes = asScore(body);
  const first = notes[0];
  if (first === undefined) throw new HttpError(422, "notes is empty");
  const consonants: (string | null)[] = [];
  const vowels: string[] = [];
  for (const note of notes) {
    if (note.lyric === "") {
      if (note.key !== null) throw new HttpError(400, "lyricが空文字列の場合、keyはnullである必要があります。");
      consonants.push(null);
      vowels.push("pau");
      continue;
    }
    if (note.key === null) throw new HttpError(400, "keyがnullの場合、lyricは空文字列である必要があります。");
    const phonemes = MORA_TABLE.get(note.lyric) ?? MORA_TABLE.get(toKatakana(note.lyric));
    if (phonemes === undefined) throw new HttpError(400, `lyricが不正です: ${note.lyric}`);
    consonants.push(phonemes.consonant);
    vowels.push(phonemes.vowel);
  }
  if (consonants[0] !== null) throw new HttpError(400, "consonant_lengths[0] must be 0, but 3");
  const consonantLength = (index: number): number => {
    const consonant = consonants[index];
    const previous = notes[index - 1];
    return consonant === null || previous === undefined ? 0 : Math.min(3, Math.floor(previous.frame_length / 2));
  };
  const phonemes: { phoneme: string; frame_length: number; note_id: string | null }[] = [];
  const f0: number[] = [];
  const volume: number[] = [];
  const push = (phoneme: string, frames: number, note: ScoreNote): void => {
    if (frames <= 0) return;
    phonemes.push({ phoneme, frame_length: frames, note_id: note.id });
    const hz = note.key === null ? 0 : midiToHz(note.key);
    for (let i = 0; i < frames; i++) {
      f0.push(hz);
      volume.push(note.key === null ? 0 : 0.5);
    }
  };
  for (const [index, note] of notes.entries()) {
    const vowelFrames = note.frame_length - (index < notes.length - 1 ? consonantLength(index + 1) : 0);
    const consonant = consonants[index];
    if (consonant !== null && consonant !== undefined) push(consonant, consonantLength(index), note);
    push(vowels[index] ?? "pau", vowelFrames, note);
  }
  return { f0, volume, phonemes, volumeScale: 1, outputSamplingRate: 24000, outputStereo: false };
}

function frameSynthesis(body: unknown): Uint8Array {
  const q = asRecord(body, "query");
  const phonemes = asList(q["phonemes"], "phonemes").map((raw) => {
    const p = asRecord(raw, "phoneme");
    const phoneme = typeof p["phoneme"] === "string" ? p["phoneme"] : "";
    if (!PHONEMES.has(phoneme)) throw new HttpError(400, `phoneme ${phoneme} is not valid`);
    return { phoneme, frame_length: asNumber(p["frame_length"], "frame_length") };
  });
  const f0 = asList(q["f0"], "f0").map((v) => asNumber(v, "f0"));
  const volume = asList(q["volume"], "volume").map((v) => asNumber(v, "volume"));
  const frames = phonemes.reduce((sum, p) => sum + p.frame_length, 0);
  if (f0.length !== frames) throw new HttpError(400, "f0 length mismatch");
  const rate = asNumber(q["outputSamplingRate"], "outputSamplingRate");
  const volumeScale = asNumber(q["volumeScale"], "volumeScale");
  const pcm = new Float32Array(Math.round((frames / FRAME_RATE) * rate));
  let phase = 0;
  for (let i = 0; i < pcm.length; i++) {
    const frame = Math.min(frames - 1, Math.floor((i / rate) * FRAME_RATE));
    const hz = f0[frame] ?? 0;
    const level = (volume[frame] ?? 0) * volumeScale;
    phase += (2 * Math.PI * hz) / rate;
    pcm[i] = 0.5 * level * Math.sin(phase);
  }
  return encodeWav(pcm, rate);
}

interface DictionaryEntry {
  surface: string;
  pronunciation: string;
  accent_type: number;
  priority: number;
  part_of_speech: string;
  mora_count: number;
}

export class MockEngine {
  public readonly requests: RecordedRequest[] = [];
  public readonly faults: Fault[] = [];
  public delayMs: number = 0;
  public padBytes: number = 0;
  public stereo: boolean = false;
  public url: string = "";
  private readonly servers: Server[] = [];
  private readonly dictionary: Map<string, DictionaryEntry> = new Map<string, DictionaryEntry>();
  private readonly ids: ReadonlySet<number> = styleIds();

  public async start(): Promise<string> {
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("mock engine did not bind a TCP port");
    this.url = `http://127.0.0.1:${address.port}`;
    return this.url;
  }

  public async stop(): Promise<void> {
    const server = this.servers.pop();
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  public failNext(
    status: number,
    times: number = 1,
    path?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): void {
    this.faults.push({
      status,
      times,
      ...(path === undefined ? {} : { path }),
      ...(body === undefined ? {} : { body }),
      ...(headers === undefined ? {} : { headers }),
    });
  }

  public count(path: string): number {
    return this.requests.filter((r) => r.path === path).length;
  }

  private style(query: Readonly<Record<string, string>>): number {
    const raw = query["speaker"];
    if (raw === undefined) {
      throw new HttpError(422, [{ loc: ["query", "speaker"], msg: "field required", type: "value_error.missing" }]);
    }
    const id = Number(raw);
    if (!this.ids.has(id)) throw new HttpError(422, `Unknown style id ${raw}`);
    return id;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/^\//u, "");
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const piece: unknown = chunk;
      if (Buffer.isBuffer(piece)) chunks.push(piece);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = undefined;
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    this.requests.push({ method: request.method ?? "GET", path, query, body });
    if (this.delayMs > 0) await sleep(this.delayMs);
    const fault = this.faults.find((f) => f.times > 0 && (f.path === undefined || f.path === path));
    if (fault !== undefined) {
      fault.times -= 1;
      response.writeHead(fault.status, { "content-type": "application/json", ...(fault.headers ?? {}) });
      response.end(JSON.stringify(fault.body ?? { detail: `injected ${fault.status}` }));
      return;
    }
    try {
      const result = this.route(request.method ?? "GET", path, query, body);
      if (result === undefined) {
        response.writeHead(204);
        response.end();
        return;
      }
      if (result instanceof Uint8Array) {
        response.writeHead(200, { "content-type": "audio/wav", "content-length": String(result.byteLength) });
        response.end(Buffer.from(result));
        return;
      }
      const payload = this.padBytes > 0 && isObject(result) ? { ...result, pad: "x".repeat(this.padBytes) } : result;
      if (this.padBytes > 0) this.padBytes = 0;
      const text = JSON.stringify(payload);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(text)),
      });
      response.end(text);
    } catch (error) {
      if (error instanceof HttpError) {
        response.writeHead(error.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ detail: error.detail }));
        return;
      }
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: error instanceof Error ? error.message : String(error) }));
    }
  }

  private route(method: string, path: string, query: Readonly<Record<string, string>>, body: unknown): unknown {
    const key = `${method} ${path.split("/")[0] ?? ""}`;
    switch (key) {
      case "GET version":
        return "0.24.0-mock";
      case "GET engine_manifest":
        return {
          manifest_version: "0.13.1",
          name: "MOCK ENGINE",
          brand_name: "MOCK",
          uuid: "c7b58856-bd56-4aa1-afb7-b8415f824b06",
          version: "0.24.0-mock",
          default_sampling_rate: 24000,
          frame_rate: FRAME_RATE,
          supported_features: { sing: { type: "bool", value: true, name: "歌唱音声合成" } },
        };
      case "GET supported_devices":
        return { cpu: true, cuda: false, dml: false };
      case "GET speakers":
        return MOCK_SPEAKERS;
      case "GET singers":
        return MOCK_SINGERS;
      case "POST audio_query": {
        this.style(query);
        const phrases = analyze(query["text"] ?? "");
        return {
          accent_phrases: phrases.map(engineShape),
          speedScale: 1,
          pitchScale: 0,
          intonationScale: 1,
          volumeScale: 1,
          prePhonemeLength: 0.1,
          postPhonemeLength: 0.1,
          pauseLength: null,
          pauseLengthScale: 1,
          outputSamplingRate: 24000,
          outputStereo: false,
          kana: formatKanaNotation(phrases),
        };
      }
      case "POST accent_phrases": {
        this.style(query);
        const text = query["text"] ?? "";
        if (query["is_kana"] === "true") {
          try {
            return parseKanaNotation(text).map(engineShape);
          } catch (error) {
            throw new HttpError(400, {
              text: error instanceof Error ? error.message : String(error),
              error_name: "UNKNOWN_TEXT",
              error_args: { text },
            });
          }
        }
        return analyze(text).map(engineShape);
      }
      case "POST synthesis": {
        this.style(query);
        const q = asRecord(body, "query");
        const rate = asNumber(q["outputSamplingRate"], "outputSamplingRate");
        const wav = tone(querySeconds(q), rate, 0.3 * Number(q["volumeScale"] ?? 1));
        return this.stereo ? stereoize(wav) : wav;
      }
      case "POST sing_frame_audio_query":
        this.style(query);
        return frameQuery(body);
      case "POST frame_synthesis":
        this.style(query);
        return frameSynthesis(body);
      case "POST initialize_speaker":
        this.style(query);
        return undefined;
      case "GET is_initialized_speaker":
        this.style(query);
        return true;
      case "POST validate_kana":
        try {
          parseKanaNotation(query["text"] ?? "");
          return true;
        } catch (error) {
          throw new HttpError(400, {
            text: error instanceof Error ? error.message : String(error),
            error_name: "UNKNOWN_TEXT",
            error_args: {},
          });
        }
      case "GET user_dict":
        return Object.fromEntries(this.dictionary);
      case "POST user_dict_word": {
        const uuid = randomUUID();
        this.dictionary.set(uuid, this.word(query));
        return uuid;
      }
      case "PUT user_dict_word": {
        const uuid = path.split("/")[1] ?? "";
        if (!this.dictionary.has(uuid)) throw new HttpError(422, "unknown word uuid");
        this.dictionary.set(uuid, this.word(query));
        return undefined;
      }
      case "DELETE user_dict_word": {
        const uuid = path.split("/")[1] ?? "";
        if (!this.dictionary.delete(uuid)) throw new HttpError(422, "unknown word uuid");
        return undefined;
      }
      default:
        throw new HttpError(404, "Not Found");
    }
  }

  private word(query: Readonly<Record<string, string>>): DictionaryEntry {
    const pronunciation = query["pronunciation"] ?? "";
    if (!/^[ァ-ヴー]+$/u.test(pronunciation)) throw new HttpError(422, "pronunciation must be katakana");
    return {
      surface: query["surface"] ?? "",
      pronunciation,
      accent_type: Number(query["accent_type"] ?? 0),
      priority: Number(query["priority"] ?? 5),
      part_of_speech: "名詞",
      mora_count: kanaToUnits(pronunciation).length,
    };
  }
}
