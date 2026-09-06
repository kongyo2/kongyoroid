# kongyoroid

LLM エージェントが CLI やライブラリとして扱う前提で作った、日本語の**読み上げ**と**歌唱**のツールです。

- 本体は内蔵の**フォルマント合成エンジン**です。依存ゼロ・決定的で、かな入力と AquesTalk 風のアクセント記法による読み上げ、楽譜からの歌唱を、外部サービス無しにその場で行います。
- **VOICEVOX ENGINE** を起動すれば、同じ CLI とライブラリから HTTP で駆動できます。キャラクター音声、漢字混じりの文章、読み（アクセント）の確認と修正、ユーザー辞書の管理まで扱えます。`speaker` / `singer` / `teacher` を指定すると自動的に voicevox エンジンが選ばれます。
- 入出力は常に **1 行 1 JSON**。エラーも JSON で、`code` / `path` / `hint` と安定した終了コードを返します。
- 長文は文単位に分割して並列合成し、順序を保って結合します。結果はリクエストのハッシュでキャッシュされます（読み上げはユーザー辞書の内容もキーに含むため、辞書を変えた後に古い音声が返ることはありません）。

英語のエージェント向け要約は [AGENTS.md](./AGENTS.md) にあります。

## インストール

```bash
npm install -g @kongyo2/kongyoroid
# または一度だけ
npx @kongyo2/kongyoroid --help
```

Node.js 22.4 以上が必要です。VOICEVOX を使う場合は [VOICEVOX ENGINE](https://github.com/VOICEVOX/voicevox_engine) を起動しておきます（VOICEVOX アプリを起動していれば同じポートで動いています）。

```bash
docker run --rm -p 127.0.0.1:50021:50021 voicevox/voicevox_engine:cpu-latest
kongyoroid doctor
```

## クイックスタート

```bash
# 内蔵エンジン（既定）で読み上げ・歌唱。かな、または AquesTalk 風記法で読みを指定します
kongyoroid speak --text "こんにちは、せかい" -o hello.wav
kongyoroid speak --text "はしのはし" --kana "ハシノ'/ハシ'" -o hashi.wav
kongyoroid sing --lyrics "きらきらぼし" --melody "C4 C4 G4 G4 A4 A4 G4 ~" --beats "1 1 1 1 1 1 1 1" --tempo 100 -o twinkle.wav

# VOICEVOX ENGINE の状態と利用できるスタイル
kongyoroid doctor
kongyoroid voices --kind speech
kongyoroid voices --kind song

# VOICEVOX で読み上げ・歌唱（スタイルを指定すると voicevox エンジンが選ばれます。id でも名前でも可）
kongyoroid speak --text "こんにちは、今日はいい天気ですね？" --speaker ずんだもん -o zundamon.wav
kongyoroid speak --text "こんにちは" --speaker "四国めたん/あまあま" --speed 1.1 --intonation 1.3 -o metan.wav
kongyoroid sing --lyrics "きらきらぼし" --melody "C4 C4 G4 G4 A4 A4 G4 ~" --singer ずんだもん --tempo 100 -o twinkle-vv.wav

# 読みの確認と修正（VOICEVOX）
kongyoroid reading --text "橋の端で箸を使う"
kongyoroid speak --text "橋の端で箸を使う" --kana "ハシノ'/ハシデ'/ハ'シオ/ツカ'ウ" --engine voicevox -o hashi-vv.wav
kongyoroid dict add --surface "端" --pronunciation "ハシ" --accent 1 --word-type COMMON_NOUN

# JSON リクエスト、JSONL バッチ、再生
kongyoroid render --input examples/speech.json -o out.wav
kongyoroid batch --input examples/batch.jsonl --output-dir out --concurrency 2
kongyoroid play out.wav

# エンジンを明示する
kongyoroid speak --engine auto --text "こんにちは" -o auto.wav
```

成功時は標準出力に 1 行の JSON、失敗時は標準エラー出力に 1 行の JSON が出ます。

```json
{"ok":true,"path":"/work/hello.wav","engine":"voicevox","kind":"speech","styles":{"speaker":{"id":3,"name":"ノーマル","character":"ずんだもん","type":"talk"}},"kana":"コンニチワ'、キョ'オワ/イ'イ/テ'ンキデスネ？","chunks":1,"cached":false,"sha256":"…","bytes":123456,"sampleRate":24000,"channels":1,"frames":61706,"durationSeconds":2.571,"elapsedMs":412.3}
{"ok":false,"error":{"code":"ENGINE_UNAVAILABLE","message":"Could not reach VOICEVOX ENGINE at http://127.0.0.1:50021: fetch failed","retryable":true,"hint":"Start VOICEVOX ENGINE (default http://127.0.0.1:50021), pass --endpoint, or use --engine formant."}}
```

| 終了コード | 意味 |
| --- | --- |
| 0 | 成功 |
| 1 | 内部エラー |
| 2 | 入力エラー（`error.path` に JSON パスかフラグ名） |
| 3 | エンジン到達不能、HTTP エラー、タイムアウト |
| 4 | ファイル書き込み・再生の失敗 |
| 130 | SIGINT / SIGTERM で中断 |

`-o -` を指定すると WAV のバイト列を標準出力へ、JSON を標準エラー出力へ書きます（`kongyoroid speak -t あ -o - | aplay`）。`-o` を省略すると作業ディレクトリに `kongyoroid-<kind>-<hash>.wav` を作ります。既存ファイルは `--force` なしでは上書きしません。

## コマンド

| コマンド | 役割 |
| --- | --- |
| `speak` | テキストを読み上げて WAV を書く。`--text` / `--input FILE` / `--input -`（標準入力） |
| `sing` | 歌詞・メロディ・拍で歌う。`--input` で JSON の楽譜も読める（フラグが優先） |
| `render` | `schema` で得られる形式の JSON リクエストをそのまま合成する |
| `batch` | JSONL（1 行 `{"id":"...","request":{...}}`）をまとめて合成。失敗行も JSON で報告し、最悪の終了コードで終わる |
| `reading` | エンジンが判断した読みを AquesTalk 風記法とアクセント句の詳細で返す |
| `voices` | 話者・歌手スタイルの一覧（`--kind speech\|song\|all`, `--query 名前`） |
| `doctor` | エンジンのバージョン・マニフェスト・対応デバイス・スタイル数。`--speaker X --initialize` でスタイルの初期化 |
| `dict list\|add\|update <uuid>\|delete <uuid>` | VOICEVOX ユーザー辞書の管理 |
| `play <file.wav>` | OS の再生コマンド（afplay / paplay / aplay / ffplay / play / PowerShell）で再生 |
| `schema` | リクエストの JSON Schema（`--kind batch` でバッチ行のスキーマ） |
| `capabilities` | 対応機能・制限・環境変数・終了コードの機械可読な一覧 |

共通フラグ: `--engine formant|voicevox|auto`（既定は formant。`speaker` / `singer` / `teacher` を指定すると voicevox）, `--endpoint URL`, `--timeout-ms N`, `--retries N`, `--cache-dir DIR`, `--concurrency N`, `-o/--output`, `--force`, `--play`。

環境変数: `KONGYOROID_ENDPOINT`（別名 `VOICEVOX_URL`）, `KONGYOROID_ENGINE`, `KONGYOROID_SPEAKER`, `KONGYOROID_SINGER`, `KONGYOROID_TEACHER`, `KONGYOROID_CACHE_DIR`。フラグが環境変数より優先されます。

## リクエスト形式

`kongyoroid schema` が JSON Schema（draft-07）を出力します。未知のプロパティは拒否されます。

### 読み上げ `kind: "speech"`

| プロパティ | 既定値 | 説明 |
| --- | --- | --- |
| `text` | 必須 | 読み上げる文章。formant はかな（と `kana` 記法）、voicevox は漢字混じりの文章も可 |
| `kana` | なし | AquesTalk 風記法の読み。指定するとエンジンの読み推定を使わず、分割もしない |
| `speaker` | voicevox の先頭スタイル | VOICEVOX のスタイル id、または `"ずんだもん"` / `"ずんだもん/あまあま"`。指定すると voicevox エンジンが選ばれる |
| `speed` `pitch` `intonation` `volume` | 1 / 0 / 1 / 1 | VOICEVOX の speedScale / pitchScale / intonationScale / volumeScale と同じ意味 |
| `prePause` `postPause` | 0.1 / 0.1 | 前後の無音（秒） |
| `pauseLength` `pauseScale` | なし / 1 | 句読点の無音の絶対値（秒）と倍率。VOICEVOX と同じく、倍率は絶対値を指定した場合にもその後から掛かる |
| `upspeak` | true | 疑問文の語尾上げ |
| `split` | `"sentence"` | 分割単位: `sentence`（。！？と改行）/ `paragraph`（改行のみ）/ `none` |
| `sampleRate` | エンジン既定（24000） | 8000〜48000 |
| `engine` `seed` | `"formant"`（`speaker` 指定時は `"voicevox"`）/ 1 | `seed` は formant のノイズ用 |

### 歌唱 `kind: "song"`

| プロパティ | 既定値 | 説明 |
| --- | --- | --- |
| `notes` | 必須 | 音符配列 `[{ "key": "C4", "beats": 1, "lyric": "ド" }, { "key": null, "beats": 1 }]` または楽譜テキスト `{ "lyrics", "melody", "beats" }` |
| `tempo` | 120 | BPM |
| `singer` | voicevox の先頭歌唱スタイル | 声を出す VOICEVOX スタイル（種類 `frame_decode` か `sing`）。指定すると voicevox エンジンが選ばれる |
| `teacher` | singer が `sing` なら同じ、そうでなければ先頭の `singing_teacher` | 音高とタイミングを予測するスタイル |
| `transpose` | 0 | 全音符の移調（半音） |
| `vibratoDepth` `vibratoRate` | voicevox 0 / formant 25、5.5 | ビブラート（セント、Hz） |
| `leadIn` `leadOut` | 0.16 / 0.16 | 先頭・末尾に補う休符（秒）。VOICEVOX は先頭が休符である必要がある |
| `volume` `sampleRate` `engine` `seed` | 1 / 既定 / formant（`singer` か `teacher` 指定時は voicevox）/ 1 | |

楽譜テキストの規則:

- `lyrics` はかなで、音高のある音符 1 つにつき 1 モーラ消費します（`きゃ` は 1 モーラ、`ー` は直前の母音を伸ばす）。
- `melody` は空白区切りで、音名（`C4` `F#4` `Bb3`、オクターブは -1〜9）または MIDI 番号（60 = C4）。`R` は休符、`~` はタイ（直前の母音を同じ音高で新しい音符として伸ばす）。
- `beats` は各音符の拍（4 分音符 = 1）。`"1 1 0.5 1/2"` のように分数も書けます。値が 1 つなら全音符に適用、省略時は全て 1 拍。

VOICEVOX が 1 音符 1 モーラしか受け付けないため、複数モーラの歌詞はエンジンに送る前に音符の位置つきで拒否されます。

### 読みの制御（AquesTalk 風記法）

`reading` が返す `kana` と、`speak --kana` / `kana` プロパティは同じ記法です。

- 読みはカタカナ（ひらがなと長音記号 ー も受け付け、`スウパア'` のような正規形に変換してからエンジンへ送ります）
- `/` でアクセント句を区切り、`、` は無音つきの区切り
- `'` をアクセント核の直後に置く。各アクセント句にちょうど 1 つ必要（平板は末尾に `'`）
- `_` を置いた直後のモーラの母音を無声化
- `？` を句末に置くと疑問形

## ライブラリ

```ts
import { Kongyoroid, KongyoroidError } from "@kongyo2/kongyoroid";

const agent = new Kongyoroid({
  endpoint: "http://127.0.0.1:50021",
  speaker: "ずんだもん",
  concurrency: 2,
  cacheDir: ".kongyoroid-cache",
});

const speech = await agent.speak("こんにちは、世界。");
await writeFile("hello.wav", speech.audio);
console.log(speech.info.durationSeconds, speech.kana, speech.styles.speaker);

const song = await agent.sing({
  tempo: 100,
  notes: { lyrics: "ドレミ", melody: "C4 D4 E4", beats: "1 1 2" },
});

const reading = await agent.reading("橋の端");
const styles = await agent.voices("song");
const uuid = await agent.dictionary.add({ surface: "端", pronunciation: "ハシ", accentType: 1 });

try {
  await agent.render(JSON.parse(untrusted));
} catch (error) {
  if (error instanceof KongyoroidError) console.error(error.code, error.path, error.hint);
}
```

- `render(request, { signal })` は `unknown` を受け取り、検証してから合成します。`speak` / `sing` は `kind` を補うだけの薄いラッパーです。
- 戻り値 `RenderResult` は WAV バイト列 `audio`、`info`（サンプルレート・フレーム数・秒）、`engine`、`styles`、`kana`、`chunks`、`cached`、`sha256`、`elapsedMs` を持ちます。
- 下位 API も公開しています: `VoicevoxClient`（各エンドポイント）、`StyleCatalog`（名前解決）、`synthesizeSpeech` / `synthesizeSong`、`parseKanaNotation` / `formatKanaNotation`、`kanaToMoras`、`parseScoreText` / `resolveNotes` / `notesToEngineScore`、`renderFormant`、`encodeWav` / `decodeWav` / `concatWav`、`REQUEST_SCHEMA` / `CAPABILITIES`。

## エンジンについて

- **formant**（既定）: 音源と 4 フォルマント共鳴器による内蔵エンジンです。VOICEVOX と同じモーラ表（187 モーラ）と AquesTalk 風記法（アクセント核、ポーズ、無声化、疑問形）に対応し、歌唱ではタイ・休符・ビブラート・ポルタメントを扱います。外部サービス無しで動き、同じリクエストと `seed` からは常に同じバイト列が生成されます。メモリ内で符号化するため、1 リクエストあたり 1200 秒までです。
- **voicevox**: `speaker` / `singer` / `teacher` を指定するか `--engine voicevox` で選びます。VOICEVOX の各キャラクターには利用規約があり、生成音声の利用条件はキャラクターごとに異なります。`voices` に出るキャラクター名で公式サイトの規約を確認してください。
- **auto**: エンドポイントを確認し（3 秒でタイムアウト）、到達できなければ formant に落ちます。formant に落ちた場合は 30 秒後に再確認します。結果の `engine` で判別できます。

## 開発

```bash
npm ci
npm run check        # typecheck, typecheck:test, lint, format:check, comments:check, test
npm run lint:typed   # oxlint の型情報つきルール
npm run build        # tsc → dist/
npm run verify:package  # npm pack → 別ディレクトリで node / tsc(nodenext) / CLI を実行
```

開発には Node.js 22.18 以上が必要です（テストとスクリプトは `.ts` を Node の型ストリップで直接実行します）。`check:package` は attw と publint を単独で実行し、`verify:package` は `npm pack` した tarball に対して attw・publint・別ディレクトリでの実行確認を行います。

oxlint の設定で唯一緩めているのは `no-floating-promises` の `allowForKnownSafeCalls` で、`node:test` の `test` / `describe` / `it` の戻り値（ランナーが管理する Promise）を除外しています。

TypeScript 6 の strict 一式（`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `isolatedDeclarations`, `verbatimModuleSyntax`, `erasableSyntaxOnly` など）と oxlint、Prettier を使います。ソースにはコメントを置かず、`ts-comment-scanner` が `check` で検査します。テストは `node --test` で `.ts` を直接実行します。

## ライセンス

MIT
