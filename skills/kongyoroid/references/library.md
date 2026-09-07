# ESM ライブラリ・ストリーミング・バッチ・キャッシュ

`@kongyo2/kongyoroid` は ESM 専用 (`"type": "module"`)、Node.js 22.18 以上。型は `dist/index.d.ts` に全部入っているので、**シグネチャに迷ったら `node_modules/@kongyo2/kongyoroid/dist/*.d.ts` を読む**。

CLI を何度も起動するとフロントエンドのロード (0.6〜1.2 秒) が毎回かかる。**3 つ以上の音声を作るならライブラリか `batch`** にすると、その分が 1 回で済む。

## 目次

- [Kongyoroid クラス](#kongyoroid-クラス)
- [作る](#作る)
- [確認する](#確認する)
- [計画と描画を分ける](#計画と描画を分ける)
- [ストリーミング](#ストリーミング)
- [ファイルに書く](#ファイルに書く)
- [エラー処理](#エラー処理)
- [辞書](#辞書)
- [キャッシュ](#キャッシュ)
- [バッチ](#バッチ)
- [補助関数](#補助関数)

## Kongyoroid クラス

```ts
import { Kongyoroid } from "@kongyo2/kongyoroid";

const agent = new Kongyoroid({
  engine: "formant",              // 必ず明示する。既定は環境変数で動く
  voice: "female",
  dictionary: [{ surface: "kongyoroid", reading: "コンギョロイド", accent: 0 }],
  strictReading: true,
  concurrency: 4,                 // 同時描画数
  cache: { directory: "./cache", maxBytes: 200_000_000, enabled: true },
});
```

`KongyoroidOptions` で使うのは `engine` `voice` `dictionary` (`LocalDictionary` か配列) `strictReading` `concurrency` `cache` / `cacheDir` / `cacheBytes`。

インスタンスは**フロントエンドと再生プランのキャッシュを共有する**ので、プロセス内では作り直さず使い回す。

## 作る

```ts
const speech = await agent.speak("kongyoroidは便利です。");
speech.audio;            // Uint8Array (WAV)
speech.kana;             // "コンギョロイドワ/ベ'ンリデ_ス。" ← 必ず原稿と突き合わせる
speech.info;             // { sampleRate, channels, frames, bitsPerSample, format, durationSeconds }
speech.sha256;           // 出力の SHA-256
speech.requestHash;      // 正規化リクエストのハッシュ
speech.warnings;         // Diagnostic[]
speech.adjustments;      // { code, message }[]
speech.peak, speech.rms, speech.limitedSamples;

// 設定付きなら文字列ではなくオブジェクトを渡す (kind は不要)
await agent.speak({ text: "…", voice: "soft", speed: 1.1, postPause: 0.3 });

const song = await agent.sing({ notes: { lyrics: "ドレミ", melody: "C4 D4 E4" }, tempo: 100 });

// kind 付きの完全なリクエストを渡す
const out = await agent.render({ kind: "speech", engine: "formant", text: "…" });
```

`speak` / `sing` / `render` はどれも `RenderResult` を返す。第 2 引数に `{ signal }` を渡せば `AbortSignal` で中断できる (`ABORTED`)。

## 確認する

```ts
const check = await agent.validate({ kind: "speech", engine: "formant", text: "…" });
check.renderable;        // true | false | "unknown"
check.estimate;          // { durationSeconds, frames, wavBytes, sampleRate }
check.reading;           // { kana, frontend, moraCount }
check.notes;             // 歌唱なら音符数
check.request;           // 既定値まで展開された正規化リクエスト
check.requestHash, check.planHash;

const plan = await agent.plan({ kind: "speech", engine: "formant", text: "…" }, { detail: "phonemes" });
plan.plan.reading.phrases;   // アクセント句と accentSource
plan.plan.moras;             // モーラごとの startSeconds / endSeconds / phonemes
plan.plan.notes;             // 歌唱の音符ごとの時刻
plan.plan.f0;                // { min, max }

const reading = await agent.reading("橋の端");
reading.kana;                // "ハシ'ノ/ハシ。"
reading.phrases;             // accent / accentSource / boundary / moras
reading.dictionaryHits;      // applied を確認する
```

`plan` の第 2 引数は**オブジェクト** `{ detail }`。文字列を直接渡す形 (`agent.plan(req, "phonemes")`) は黙って無視され、`summary` のままになる。

`agent.inspect(bytes, options?)` は**同期関数で、パスではなく `Uint8Array` を取る**:

```ts
import { readFile } from "node:fs/promises";
const info = agent.inspect(new Uint8Array(await readFile("out.wav")));
const direct = agent.inspect(speech.audio, { pitchTrack: true, windowMs: 30 });
// { info, bytes, sha256, peak, rms, dc, clipped, finite, pitch: { medianHz, minHz, maxHz, voicedRatio, track? } }
```

診断: `await agent.doctor({ engine: "formant" })`、`await agent.voices({ engine: "formant" })`、`agent.frontendStatus()`、`agent.voiceProfile(id)`、`agent.voiceHash(id)`。

## 計画と描画を分ける

同じ原稿を設定違いで何度も描画するときや、計画を保存してレビューしたいときに使う。

```ts
const compiled = await agent.compile({ kind: "speech", engine: "formant", text: "…" });
compiled.plan;         // SynthesisPlan
compiled.planHash;
compiled.requestHash;
compiled.readMs, compiled.planMs;

const result = await agent.renderPlan(compiled.plan, { requestHash: compiled.requestHash });
```

`compile` は日本語解析を含むので重く、`renderPlan` は純粋な信号処理なので軽い。計画を JSON で保存しておけばレビューの証跡になる。

## ストリーミング

### テキストが届き次第しゃべる

```ts
async function* tokens() { yield "ストリームの一文目。"; yield "二つ目の"; yield "文です。"; }

for await (const ev of agent.speakStream(tokens(), { voice: "soft" })) {
  if (ev.type === "sentence") {
    // { index, text, kana, durationSeconds, frames, warnings, startFrame }
    console.error(ev.index, ev.kana);
  } else if (ev.type === "audio") {
    play(ev.block.samples);       // Float32Array, ev.block.start, ev.block.sampleRate
  } else if (ev.type === "end") {
    // { sentences, frames, durationSeconds }
  }
}
```

文の切れ目は `。！？` と改行。次の文を先読みして合成するので途切れない。文間ポーズは次の文の先頭に付き、`postPause` は最後に 1 回だけ付く。第 2 引数は `text` を除いた `SpeakInput`、第 3 引数のうち実装が読むのは `blockFrames` と `maxSentenceChars`。

**ストリーミングと一括合成は同じ音にはならない。**

| 性質 | 結果 |
| --- | --- |
| チャンクの切り方への非依存 | 1 文字ずつでも一括でも**バイト単位で同一**。トークン境界を気にしなくてよい |
| 実行ごとの決定性 | 同一。ストリーミング自体は決定的 |
| 尺 | ほぼ一致するが**厳密には一致しない**。`あ。い。う。え。お。` で一括 59536 フレーム / ストリーム 59538 フレーム |
| 波形 | **一致しない**。`PlanRenderer` が計画ごとに雑音を種から作り直すため、文ごとに計画が分かれるストリーミングでは息成分の実現値が変わる |

尺やハッシュで一括合成と突き合わせる検証は成立しない。ストリーミングの検証はストリーミング自身の出力に対して行う。

**未終端の文はイテラブルが終わるまで出ない。**時間切れで流す仕組みは無い (`TextStreamOptions.flushMs` は型にあるだけで実装は読まない)。エージェントが文の途中で止まりうるなら、送信側で `。` を補って区切りを保証する。

### 完成したリクエストを PCM ブロックで流す

```ts
const stream = agent.renderStream({ kind: "speech", engine: "formant", text: "…" }, { blockFrames: 1200 });
for await (const block of stream) writeToDevice(block.samples);
const { plan, stats } = await stream.return(undefined);  // または for-await 完走後の戻り値
```

低レベルが要るなら `renderPcmStream(plan, options)` / `renderInto(plan, sink, options)` / `encodePlanAsync(plan)` / `streamingWavHeader(sampleRate)` を直接使う。

## ファイルに書く

`writeAudioIdempotent` は CLI と同じ上書き規則を実装している。**自前で `writeFile` すると事故防止の仕組みを失う**ので、こちらを使う。

```ts
import { writeAudioIdempotent } from "@kongyo2/kongyoroid";

const w = await writeAudioIdempotent("out.wav", speech.audio);
// 1 回目: { path, written: true,  unchanged: false }
// 同内容: { path, written: false, unchanged: true }   ← no-op、成功
// 別内容: KongyoroidError { code: "IO_ERROR" } を投げる (exitCodeOf → 4)
await writeAudioIdempotent("out.wav", other.audio, true); // 第 3 引数 force で置換
```

一時ファイルに書いてからリネームするので、途中で落ちても壊れたファイルは残らない。

## エラー処理

```ts
import { KongyoroidError, asKongyoroidError, exitCodeOf, formatDiagnostic } from "@kongyo2/kongyoroid";

try {
  await agent.speak("彁");
} catch (err) {
  const e = asKongyoroidError(err);      // 何を投げられても KongyoroidError にする
  e.code;            // "UNREADABLE_TEXT"
  e.path;            // "$.text"
  e.retryable;       // false
  e.hint;
  e.repairOptions;   // [{ action: "provide-kana", ... }, ...]
  e.sourceSpan;      // { start, end, unit: "unicode-code-point" }
  e.detail;          // コード固有の構造化情報
  e.toJSON();        // CLI と同じ形の JSON
  exitCodeOf(e);     // 2
}
```

**分岐は `code` と `repairOptions[].action` で行う**。`message` は人間向けで変わり得る。警告を人が読む形にするなら `formatDiagnostic(diagnostic, "<request>")` が CLI の `--diagnostics compact` と同じ 1 行を返す。

## 辞書

```ts
import { LocalDictionary, dictionaryFromJson, parseDictionaryEntry } from "@kongyo2/kongyoroid";

const dict = new LocalDictionary([
  { surface: "kongyoroid", reading: "コンギョロイド", accent: 0 },
  { surface: "端", reading: "ハシ", accent: 0, match: "anywhere", priority: 3 },
]);
const agent = new Kongyoroid({ engine: "formant", dictionary: dict });
agent.dictionary;                                   // 同じインスタンス
await agent.dictionaryDigest();                     // キャッシュキーに入るダイジェスト
```

ファイルから読むなら `dictionaryFromJson(JSON.parse(text))`、CLI の `--dict-entry` と同じ書式は `parseDictionaryEntry("kongyoroid=コンギョロイド:0")`。

## キャッシュ

```ts
const agent = new Kongyoroid({
  engine: "formant",
  cache: { directory: "./cache", maxBytes: 200_000_000, maxEntries: 5000, memoryBytes: 64_000_000, enabled: true },
});

await agent.cacheStats();     // { entries, bytes, budget }
await agent.pruneCache(200_000_000, 5000);
await agent.clearCache();
```

`directory` を渡すと `directory/kongyoroid-cache/` の中だけを使い、外のファイルには触らない。キーはエンジン・パッケージ版・エンジン版・フロントエンド版・辞書ダイジェスト・正規化リクエストから作るので、更新後に古い音声が返ることはない。同じリクエストが同時に来ても合成は 1 回だけ (in-flight dedupe)。ヒット時は 760 ms → 4.6 ms。

短い通知を繰り返し鳴らす用途ではキャッシュが効く。1 回きりの長文では効かないので `enabled: false` でよい。

## バッチ

CLI の `batch` は 1 行 1 ジョブの JSONL を受け取り、**標準入力なら長寿命セッション**として動く。エージェントが逐次ジョブを投げる用途にはこれが向く。

```sh
kongyoroid batch --input - --output-dir out --concurrency 4
```

```json
{"id":"notify-1","request":{"kind":"speech","engine":"formant","text":"ビルドが完了しました。"}}
{"id":"jingle","request":{"kind":"song","engine":"formant","notes":{"lyrics":"ら","melody":"C4 E4 G4"}}}
```

結果は**完了順**に 1 行ずつ出る (`{"ok":true,"id":"…","line":1,…}` / `{"ok":false,"id":"…","line":3,"error":{…}}`)。失敗した行があっても続行し、終了コードは最悪の結果。順番が必要なら `id` で並べ直す。

ライブラリ側で同じことをするなら `mapConcurrent(items, limit, fn)` と `Semaphore` が使える。

## 補助関数

`index.d.ts` に公開されている主なもの。CLI を通さずに読みや譜面だけ扱いたいときに使う。

| 用途 | 関数 |
| --- | --- |
| テキスト正規化 | `normalizeForReading(text)` → `{ text, substitutions }` |
| 文分割 | `splitSentences(text)` → `SentencePiece[]` |
| 読み | `readJapanese(text, options)` / `readKanaNotation` / `readKanaHeuristically` / `loadFrontend` / `frontendState` |
| かな記法 | `parseKanaNotation(kana)` → `AccentPhrase[]` / `formatKanaNotation` |
| モーラ | `countMoras` `kanaToMoras` `toKatakana` `toHiragana` `isKanaOnly` `MORA_TABLE` |
| レキシコン | `lookupLexicon(word)` / `BUILTIN_LEXICON` (Map、695 語) |
| 譜面 | `parseMml(mml)` / `parseScoreText({lyrics,melody,beats})` / `parseNotes` / `resolveNotes` / `alignLyrics` |
| 音高 | `noteToMidi("A4")` → 69 / `midiToHz(69)` → 440 / `midiToNoteName` / `A4_HZ` |
| 計画 | `compileRequest` `planSpeech` `planSong` `planHash` `summarizePlan` |
| 描画 | `PlanRenderer` `renderPcm` `renderPcmStream` `encodePlanAsync` `renderInto` |
| WAV | `inspectWav` `decodeWav` `encodeWav` `concatWav` `silenceWav` `pcm16Samples` |
| 解析 | `estimatePitch` `signalStats` `spectralCentroid` `centsBetween` |
| 定数 | `VERSION` `ENGINE_VERSION` `LIMITS` `BUILTIN_VOICES` `ERROR_CODES` `EXIT_CODES` `MIN_F0_HZ` `MAX_F0_HZ` `DEFAULT_SAMPLE_RATE` |
| スキーマ | `REQUEST_SCHEMA` `BATCH_JOB_SCHEMA` `DICTIONARY_SCHEMA` `CAPABILITIES` |
