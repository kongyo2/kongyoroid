# kongyoroid

LLM エージェントが CLI やライブラリとして扱う前提で作った、日本語の**読み上げ**と**歌唱**のツールです。

- **内蔵エンジンが本体**です。外部サービスも GPU も不要で、`npm install` だけで漢字かな交じり文を読み、歌います。同じリクエストからは常にビット単位で同じ WAV が出ます。
- **JSON で会話します。** 入力は JSON Schema 付きのリクエスト、出力は 1 行 1 JSON。失敗は構造化エラー (`code` / `path` / `hint` / `repairOptions`) と終了コードで返します。
- **レンダリングの前に確認できます。** `validate` と `plan` が読み (アクセント付きかな)、音素、音符の時刻、推定尺、警告を返すので、エージェントは音声を書き出す前に直せます。

## 要件とインストール

- Node.js 22.18 以上 (ESM)。
- 依存は日本語テキストフロントエンド `kanji2koe-openjtalk` (jpreprocess + NAIST-JDic の WebAssembly、約 20 MB) のみ。初回ロードに 0.5 秒前後かかり、以降はプロセス内で再利用されます。

```sh
npm install @kongyo2/kongyoroid
npx kongyoroid doctor
```

`doctor` が `"ok": true` を返せば、フロントエンドと合成器が動いています。

## 30 秒で使う

```sh
# 読み上げ (漢字・数字・日付・英単語をそのまま)
kongyoroid speak --text "テストが3件失敗しました。ログを確認してください。" -o result.wav

# 歌唱 (歌詞 + 音名 + 拍)
kongyoroid sing --lyrics "きらきらぼし" --melody "C4 C4 G4 G4 A4 A4" --beats "1 1 1 1 1 2" -o twinkle.wav

# 書き出す前に読みを確認する
kongyoroid plan --text "橋の端で箸を使う" | jq .plan.reading.kana
# "ハシ'ノ/ハシデ/ハ'シヲ/_ツカウ。"

# 読みを直す
kongyoroid speak --text "kongyoroidは便利です" --dict-entry kongyoroid=コンギョロイド:0 -o dict.wav
kongyoroid speak --text "橋の端" --kana "ハシ'ノ/ハシ" -o hashi.wav

# 文が届き次第、音声を流す (LLM の出力をそのまま再生)
llm-agent run | kongyoroid speak --input - --stream --output - --format pcm | aplay -f S16_LE -r 24000 -c 1

# リクエスト JSON はそのまま speak / render に渡せる
kongyoroid speak --input request.json --voice soft -o request.wav
```

すべてのコマンドは標準出力に 1 行の JSON を書きます。

```json
{"ok":true,"path":"/work/result.wav","written":true,"unchanged":false,"engine":"formant","engineVersion":"formant-2.1.0","kind":"speech","voice":"neutral","kana":"テ'_ストガ/サン'ゲン/シッパイ/シマ'_シタ。ロ'グヲ/カクニン/_シテ/クダサ'イ。","chunks":2,"cached":false,"sha256":"66b3…","requestHash":"42de…","bytes":209622,"sampleRate":24000,"channels":1,"frames":104789,"durationSeconds":4.366,"peak":0.7198,"rms":0.0925,"limitedSamples":0,"warnings":[],"adjustments":[]}
```

## エージェント向けの作法

1. **`validate` → `plan` → `speak` / `sing` / `render`** の順に使うと、失敗を最短で直せます。`validate` は構造と意味 (読める文字か、音符が短すぎないか、音域内か) を検査して推定尺とハッシュを返し、`plan` は読みと時刻表を返します。どちらも音声を書きません。
2. **エラーは `code` で分岐**してください。メッセージは人間向けで変わり得ます。`path` は JSON Pointer 風 (`$.notes[1].beats`、フラグなら `$flags.speed`)、`repairOptions[].action` は機械可読な修正案です。
3. **終了コード**: `0` 成功、`1` 内部エラー、`2` 入力エラー (直して再送)、`3` エンジン利用不可 (VOICEVOX 未起動やフロントエンド破損)、`4` 入出力エラー (上書き拒否など)、`130` 中断。
4. **同じ内容の再書き出しは no-op** です。`--output` の既存ファイルが同一内容なら `"unchanged": true`、異なる内容なら `IO_ERROR` と `use-force` の修正案を返します。
5. **決定性**: 同じリクエスト・同じ `seed`・同じバージョンなら WAV は同一です。`requestHash` (正規化したリクエスト) と `planHash` (合成計画) で差分を追えます。
6. **長文は `--stream`** で文単位に流し、短い通知はキャッシュ (`--cache-dir`) を効かせてください。

エラーの例:

```json
{"ok":false,"error":{"code":"NOTE_TOO_SHORT","message":"Note n1 (カ) leaves only 25 ms for 1 vowel(s); at least 30 ms are needed.","retryable":false,"path":"$.notes[0].beats","hint":"Give the note more beats, lower the tempo, or use fewer moras in the lyric.","detail":{"availableMs":25,"requiredMs":30,"noteId":"n1"},"repairOptions":[{"action":"increase-duration","description":"Give the note more beats or lower the tempo.","path":"$.notes[0].beats"},{"action":"use-vowel-continuation","description":"Move some moras to neighbouring notes or hold the previous vowel.","path":"$.notes[0].lyric"}]}}
```

コマンドの完全な一覧と出力形式は [docs/cli.md](docs/cli.md)にあります。

## テキストの読み方

内蔵エンジンは次の順で文章を読みます。

1. **正規化**: 日付 (`2026/09/07` → 2026年9月7日)、時刻 (`9:05` → 9時5分)、バージョン (`v1.2.3` → ブイ1テン2テン3)、単位 (`3ms` → 3ミリ秒、`100kg`、`25℃`)、通貨 (`¥1,200`、`$5`)、符号と範囲 (`-5`、`10〜20`)、`#42`、URL とメールアドレス (記号を読み下し、`URL_READ_LITERALLY` / `EMAIL_READ_LITERALLY` の助言付き)、Markdown の行頭記号、全角/半角。
2. **英単語**: 約 700 語の技術系レキシコン (`npm`、`API`、`Claude Code`、`GitHub`、`deploy` …) をカタカナとアクセントに置き換えます。頭字語は「最後の文字の先頭にアクセント」(エーピーア'イ) で読み、フロントエンドが文字ごとに分割してしまう読みを 1 つのアクセント句にまとめます。未知の 5 文字以上の英単語には `ASCII_WORD_UNKNOWN` の助言が付きます。
3. **形態素解析とアクセント**: jpreprocess (OpenJTalk の Rust 実装) と NAIST-JDic で読みとアクセント核、アクセント句境界を決めます。数詞・助数詞 (3件 → サン'ゲン、一本 → イッ'ポン)、助詞の付属、母音の無声化 (デ_ス) を含みます。
4. **辞書**: リクエストの `dictionary`、`--dict-entry`、`--dictionary` ファイル (`KONGYOROID_DICTIONARY`) の順で表記を読みに置き換え、指定があればアクセントも上書きします。同じ読みが文中に複数ある場合は位置で照合するので、「橋の端」で `端 → ハシ (0)` を登録しても橋のアクセントは変わりません。
5. **読めない文字**: フロントエンドが黙って落とす文字 (幽霊文字、ハングル、絵文字など) は既定で `UNREADABLE_TEXT` エラーになり、位置 (`sourceSpan`) と修正案 (かな指定・辞書追加・削除) を返します。`strictReading: false` (`--no-strict-reading`) なら警告付きで読み飛ばします。

読みは `reading` コマンドか `plan` で確認できます。各アクセント句には `accentSource` (`frontend` / `dictionary` / `lexicon` / `user` / `rule`) が付き、どこから来た読みかが分かります。文は `。！？` と改行で区切られ、直後の閉じ括弧 (`」』）` など) は前の文に付きます。

### かな記法

`kana` を与えるとテキスト解析を飛ばして、その通りに読みます。

| 記号 | 意味 | 例 |
| --- | --- | --- |
| `'` | 直前のモーラがアクセント核。無ければ平板 (0 型) | `ハ'シ` (橋)、`ハシ'` (端…尾高)、`ハシ` (平板) |
| `/` | アクセント句の境界 (ポーズなし) | `コンニチワ'/セカ'イ` |
| `、` | 短いポーズ (既定 0.2 秒) | `ハ'イ、ワカリマ'_シタ` |
| `。` `？` `！` | 文末。`？` は文末上昇、`！` は文全体を強める | `デ_スカ？` |
| `_` | 直後のモーラを無声化 | `_シテ`、`デ_ス` |
| `ー` | 長音 | `トーキョー` |

ひらがなでもカタカナでも構いません。`_` が 1 つも無い場合は、無声化規則 (無声子音に挟まれた イ・ウ、文末の ス) を自動で適用します。末尾の `、` は末尾ポーズとして残り、`。` などの文末記号は末尾に無音を足しません (末尾の無音は `postPause` で決めます)。

## 読み上げのパラメータ

| フィールド (CLI フラグ) | 既定 | 内容 |
| --- | --- | --- |
| `voice` (`--voice`) | `neutral` | 内蔵ボイス: `neutral` `female` `male` `child` `soft` `bright` `deep` |
| `speed` (`--speed`) | 1 | 話速倍率 0.25–4。子音・母音・ポーズを一様に縮めます |
| `pitchSemitones` (`--pitch-semitones`) | 0 | 基本ピッチの半音シフト −24..24 |
| `pitch` (`--pitch`) | – | VOICEVOX 互換の `pitchScale` (F0 × 2^pitch)。`pitchSemitones` と排他 |
| `intonation` (`--intonation`) | 1 | 抑揚の幅 0–3。0 でほぼ平坦 |
| `volume` / `gainDb` | 1 / – | 出力レベル (線形 0–3、または dB)。ソフトリミッターの前段 |
| `breathiness` (`--breathiness`) | 0 | 声門の張り −1..1.5。正で息っぽく |
| `prePause` / `postPause` | 0.1 / 0.1 | 前後の無音 (秒) |
| `pauseLength` / `pauseScale` | – / 1 | `、` の絶対長 (秒) と、全ポーズの倍率 |
| `upspeak` (`--no-upspeak`) | true | 疑問文末の上昇 |
| `sampleRate` (`--sample-rate`) | 24000 | 8000–48000 Hz |
| `seed` (`--seed`) | 1 | ノイズ・揺らぎの種 |

イントネーションは藤崎モデル (フレーズ指令 + アクセント指令) で生成し、文末の下降、疑問の上昇、感嘆の強調、段落末の長いポーズを付けます。

## 歌唱

譜面は 3 つの形で渡せます。

```jsonc
// 1. 音符リスト (最も細かい制御)
{ "kind": "song", "tempo": 90, "voice": "male",
  "notes": [
    { "key": null, "beats": 0.5 },
    { "id": "sa", "key": "E4", "beats": 1, "lyric": "さ" },
    { "id": "ku", "key": "E4", "beats": 1, "lyric": "く", "velocity": 110 },
    { "id": "ra", "key": "F4", "beats": 2, "lyric": "ら" },
    { "id": "ra-hold", "key": "F4", "beats": 2, "continuation": "tie", "vibrato": { "depthCents": 45 } },
    { "id": "ra-up", "key": "G4", "beats": 1, "continuation": "melisma" },
    { "key": "C4", "beats": 2, "lyric": "きら" }        // 1 音に複数モーラ (最大 8)
  ] }

// 2. コンパクト譜 (歌詞 + 音名 + 拍)
{ "kind": "song", "notes": { "lyrics": "きらきらぼし", "melody": "C4 C4 G4 G4 A4 ~ ~G4 R", "beats": "1 1 1 1 1 1 1 1" } }

// 3. MML
{ "kind": "song", "notes": { "mml": "t132 o4 l8 e e r e r c e4 g4 r4 <g4", "lyrics": "ららららら" } }
```

- `~` (タイ) は直前の母音を同じ高さで伸ばし、`~G4` (メリスマ) は高さを変えて伸ばします。母音は再アタックせず、ポルタメント (`portamentoMs`、既定 60 ms) で滑らかにつながります。
- 同じ母音が続く音符 (「ああ」) は既定で再アーティキュレーション (`rearticulate`: 短い減衰と再アタック) になり、`articulation: "legato"` で連結できます。
- `velocity` (1–127) または `gainDb` で音ごとの強さ、`vibrato` (`depthCents` / `rateHz` / `delayMs` / `fadeMs` または `false`) で持続音ごとのビブラート、`portamentoMs` で音ごとの移行時間を指定できます。`scoopCents` / `scoopMs` はフレーズ頭のしゃくりです。
- 子音は前の休符・前の音符の末尾 (最大 40 %) から借りて、母音が拍頭に乗るように配置します。足りない時は子音を短縮して `CONSONANT_COMPRESSED` を `adjustments` に記録し、`consonantCompression: false` なら `NOTE_TOO_SHORT` で失敗します。母音が 30 ms を切る音符は常に `NOTE_TOO_SHORT` です。
- 音域は 30–2500 Hz (かつサンプルレートの 20 %)。外れると `PITCH_OUT_OF_RANGE`、ボイスの得意音域を外れると `F0_OUTSIDE_VOICE_RANGE` の警告です。
- 音高精度: 持続母音で 1 セント以内、拍ごとに変わる音階で 8 セント以内 (テストで検証)。

`plan` の `notes[]` には音ごとの開始・母音開始・終了時刻、`sustainId`、`continuation`、`articulation` が入ります。

## ストリーミング

```sh
# 文が確定するたびに合成し、PCM (s16le mono) を流す
kongyoroid speak --input - --stream --output - --format pcm

# 未確定長 WAV / NDJSON (文イベント + base64 音声ブロック)
kongyoroid speak --input - --stream --output - --format wav
kongyoroid speak --input - --stream --output - --format ndjson

# ファイルへ (最後にヘッダーを書き戻す)
kongyoroid speak --input - --stream -o long.wav --progress

# 文末記号が来なくても、300 ms 入力が止まれば溜まった分を読む
kongyoroid speak --input - --stream --flush-ms 300 --output - --format pcm
```

文の切れ目 (`。！？` と改行) で分割し、次の文を先読みして合成するので、途切れません。チャンクが文末記号で終わるときは閉じ括弧が続くかどうかを次の文字で確かめてから読むので、文の切れ目はチャンクの切り方に依存しません。文間ポーズは次の文の先頭に付くため、一括合成した場合と同じ長さになります。`--flush-ms N` を付けると、文末記号が届かないまま N ms 入力が止まった時点で溜まっている断片を 1 文として読みます。`--input` が `{` で始まればリクエスト JSON として読んでその `text` を流し、読みが得られない文 (絵文字だけなど) は一括合成と同じく読み飛ばします。ライブラリでは `agent.speakStream(asyncIterable, input, { flushMs })` が `sentence` / `audio` / `end` イベントを返します。

## 内蔵ボイス

| id | 基本 F0 | 特徴 |
| --- | --- | --- |
| `neutral` | 170 Hz | 中性的な中音域。通知・検証の既定 |
| `female` | 225 Hz | 短めの声道、やや息混じり |
| `male` | 115 Hz | 長めの声道、張りのある声門 |
| `child` | 290 Hz | 小さな声道と高いピッチ |
| `soft` | 185 Hz | 息の多い穏やかな声、抑揚控えめ |
| `bright` | 215 Hz | 張った明瞭な声、抑揚大きめ |
| `deep` | 92 Hz | とても低い声、落ち着いた調子 |

`kongyoroid voices` で音域とハッシュを確認できます。歌唱でも同じボイスを使います。

## キャッシュとファイル

- `--cache-dir DIR` (または `KONGYOROID_CACHE_DIR`) を与えると、`DIR/kongyoroid-cache/` の中だけに `.kcache` ファイルを書きます。`cache prune` / `cache clear` はこの名前空間の外に触りません。無関係なファイルが混ざっていても消しません。
- キャッシュキーはエンジン・パッケージ版・エンジン版・フロントエンド版・辞書ダイジェスト・正規化リクエストから作るので、更新後に古い音声が返ることはありません。
- 同時に同じリクエストが来た場合は 1 回だけ合成します (in-flight dedupe)。
- 出力は一時ファイルに書いてからハードリンク/リネームするので、途中で落ちても壊れたファイルは残りません。

## ライブラリとして使う

```ts
import { Kongyoroid } from "@kongyo2/kongyoroid";

const agent = new Kongyoroid({
  voice: "female",
  dictionary: [{ surface: "kongyoroid", reading: "コンギョロイド", accent: 0 }],
  cache: { directory: "./cache" },
});

// 読み上げ
const speech = await agent.speak("kongyoroidは便利です。");
speech.audio; // Uint8Array (WAV)
speech.kana; // "コンギョロイドワ/ベ'ンリデ_ス。"

// 歌唱
const song = await agent.sing({ notes: { lyrics: "ドレミ", melody: "C4 D4 E4" }, tempo: 100 });

// 確認してから書き出す
const check = await agent.validate({ kind: "speech", text: "…" });
if (check.renderable) {
  const plan = await agent.plan({ kind: "speech", text: "…" }, { detail: "phonemes" });
  const compiled = await agent.compile({ kind: "speech", text: "…" });
  const result = await agent.renderPlan(compiled.plan, { requestHash: compiled.requestHash });
}

// 文単位のストリーミング (flushMs: 文末記号が来なくても 300 ms 止まれば読む)
for await (const event of agent.speakStream(tokens(), { voice: "soft" }, { flushMs: 300 })) {
  if (event.type === "audio") play(event.block.samples); // Float32Array
}
```

`Kongyoroid` の他に、テキスト処理 (`readJapanese`、`normalizeForReading`、`parseKanaNotation`、`LocalDictionary`)、計画 (`compileRequest`、`planSpeech`、`planSong`)、レンダリング (`PlanRenderer`、`renderPcm`、`renderPcmStream`、`encodePlanAsync`)、解析 (`estimatePitch`、`inspectWav`)、譜面 (`parseMml`、`parseScoreText`) を個別に import できます。型はすべて `dist/index.d.ts` に含まれます。

## VOICEVOX (任意)

VOICEVOX ENGINE が起動していれば、`--speaker` / `--singer` / `--teacher` (id か名前) を付けるだけで、そのスタイルで合成します。`--engine auto` はエンドポイントが応答すれば VOICEVOX、応答しなければ内蔵エンジンにフォールバックします。`dict --scope voicevox` でユーザー辞書、`voices --engine voicevox` でスタイル一覧、`doctor --engine voicevox` で診断ができます。VOICEVOX の歌唱は 1 音 1 モーラで、タイ・メリスマ・複数モーラは内蔵エンジン専用です。

## 制限と環境変数

| 項目 | 値 |
| --- | --- |
| テキスト / かな | 20,000 文字 |
| 音符 | 4,096 個 |
| 内蔵エンジンの 1 リクエスト | 1,800 秒 |
| 入力ファイル | 8 MiB |
| バッチ行数 / 並列度 | 10,000 / 16 |
| 辞書エントリ | 20,000 |

環境変数: `KONGYOROID_ENGINE`、`KONGYOROID_VOICE`、`KONGYOROID_DICTIONARY`、`KONGYOROID_CACHE_DIR`、`KONGYOROID_ENDPOINT` (別名 `VOICEVOX_URL`)、`KONGYOROID_SPEAKER`、`KONGYOROID_SINGER`、`KONGYOROID_TEACHER`。`kongyoroid capabilities` が対応機能・制限・エラーコードを JSON で返します。

## ドキュメント

- [docs/cli.md](docs/cli.md): コマンドと出力形式のリファレンス
- `examples/`: 内蔵エンジン向け (`builtin/`)、VOICEVOX 向け (`voicevox/`)、バッチ (`batch.jsonl`) の実例

## ライセンス

MIT
