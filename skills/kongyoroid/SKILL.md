---
name: kongyoroid
description: >-
  npm の @kongyo2/kongyoroid (内蔵 formant エンジン) で日本語の読み上げ・ナレーション・通知音声・歌唱の WAV を作り、
  読み (かな・アクセント)・音符の時刻・出力波形を JSON で検証する。日本語 TTS、テキスト読み上げ、音声合成、
  しゃべらせる、歌わせる、歌唱合成、MML や楽譜から歌声、ボイス通知、読み方やアクセントの確認、固有名詞・数字・
  助数詞の読み間違いの修正、LLM 出力のストリーミング再生、WAV の生成・検査を頼まれたら、ユーザーが kongyoroid と
  名指ししていなくても必ずこのスキルを使う。CLI (speak / sing / render / validate / plan / reading / batch /
  inspect / dict / cache / doctor) と ESM ライブラリ (Kongyoroid クラス) の導入・実装・レビュー・修正にも使う。
  Japanese text-to-speech, singing synthesis, narration WAV, kana reading and pitch-accent verification with
  kongyoroid. 音声認識・文字起こし、日本語以外の言語の音声合成、音楽ファイルの編集には使わない。
license: MIT
compatibility: >-
  Node.js 22.18 以上 (ESM)。npm の @kongyo2/kongyoroid 2.1 以降。内蔵 formant エンジンだけを使い、
  外部サービス・GPU・実行時のネットワークは要らない (VOICEVOX ENGINE は任意の追加機能)。
---

# kongyoroid で日本語音声をつくる

`@kongyo2/kongyoroid` は LLM エージェントが CLI かライブラリとして扱う前提の日本語読み上げ・歌唱ツール。入力はリクエスト JSON かフラグ、出力は 1 行 1 JSON と WAV。**内蔵 formant エンジン**が本体で、`npm install` だけで漢字かな交じり文を読み、歌う。

## このエンジンの性質が作業の形を決める

1. **決定的**: 同じリクエスト・同じ `seed`・同じ版からは常にビット単位で同じ WAV が出る。「何度も鳴らして当たりを待つ」は無意味で、**読み・音符・時刻を JSON で先に確認し、直してから 1 回描画する**のが最短で唯一の道。`reading` `validate` `plan` は音声を書かないので、飛ばす理由がない。
2. **`ok: true` は「正しく読めた」ではない**。フロントエンド (jpreprocess + NAIST-JDic) は警告なしで別の読みを返したり、読めない文字を落としたりする。実測:

   | 入力 | 実際の読み | 起きたこと |
   | --- | --- | --- |
   | `二文目。` | `ニア'ヤメ。` | 誤読 |
   | `3件` | `サン'ゲン。` | 助数詞の取り違え (3 で終わる数すべて) |
   | `12件` | `ジュー/ニ'ケン。` | 複合数詞が 2 句に割れ、数がひと続きに聞こえない |
   | `完了しました🎉` | `カンリョー/シマ'_シタ。` | 絵文字が消える (警告なし) |
   | `user@example.com` | `ユーエスイーアール、アットマ'ーク、…` | 1 文字ずつ読む (`EMAIL_READ_LITERALLY` の助言あり) |

   だから**必ず `reading` か `plan` の `kana` を原稿と突き合わせる**。固有名詞・数値と助数詞・同音異義語・英単語・記号を優先して見る。数値は値ごとに読みが変わるので、実行時に値が変わる原稿では読みの検査もパイプラインに組み込む。
3. **読めないと判定できた文字は止まる**: `彁` やハングル・キリル文字のようにフロントエンドが確実に落とす文字は `UNREADABLE_TEXT` (終了コード 2)。文字を削ったり `--no-strict-reading` で黙らせたりせず、`--kana` か辞書で読みを与える。

## 導入と確認

```sh
npm install --save-exact @kongyo2/kongyoroid
npx kongyoroid doctor --engine formant     # ok:true, formant.frontend.available:true, formant.synthesis.ok:true
npx kongyoroid --version                   # {"ok":true,"name":"@kongyo2/kongyoroid","version":"2.1.0"}
```

- 既存プロジェクトでは lockfile の版を尊重し、無断で上げない。版ごとの一次情報は `npx kongyoroid capabilities` と `npx kongyoroid <command> --help`、`node_modules/@kongyo2/kongyoroid/docs/cli.md`、型は `dist/index.d.ts`。**フラグや JSON フィールドを推測しない**。
- 日本語フロントエンドは WebAssembly (約 20 MB) で、**プロセスごとに初回 0.6〜1.2 秒**かかる。以降は同じプロセス内で再利用される。多数の音声を作るなら CLI を何度も起動せず `batch --input -` かライブラリを使う。

## 作業の流れ

読み確認 → 検証 → 計画 → 描画 → 検査。前の 3 つは音声を書かないので、失敗しても副作用がない。

```sh
K=./node_modules/.bin/kongyoroid

# 1. 読みを見る (読み上げ)。kana を原稿と突き合わせ、warnings を読む
$K reading --text "リリースは2026年9月7日、テストは3件失敗しました。"

# 2. 構造と意味を検証し、尺・ハッシュ・正規化リクエストを得る (音声は書かない)
$K validate --engine formant --input request.json

# 3. 時刻表を見る (歌唱では必須。読み上げでも語尾・間が問題のとき)
$K plan --engine formant --input request.json

# 4. 描画 (同じ内容の再描画は no-op、違う内容なら IO_ERROR で止まる)
$K render --engine formant --input request.json --output out.wav

# 5. 出力を数値で検査
$K inspect out.wav
```

短い一発ものなら `speak` / `sing` で足りる。**分岐する設定や辞書が絡むならリクエスト JSON を書く**ほうが、差分が追え、`--dry-run` で同じ入力を検証でき、後から再現できる。`speak --input request.json` も `render` と同じ JSON を受け付ける。

```sh
$K speak --engine formant --text "ビルドが完了しました。" --voice soft -o done.wav
$K sing  --engine formant --lyrics "きらきらぼしー" --melody "C4 C4 G4 G4 A4 A4 G4 ~ R" \
         --beats "1 1 1 1 1 1 1 1 2" --tempo 100 -o twinkle.wav
$K speak --engine formant --text "…" --dry-run          # validate と同じ結果だけ返し、何も書かない
```

LLM の出力を届き次第しゃべらせるなら `--stream`。文末記号 (`。！？` と改行) で区切って合成し、`--flush-ms N` を付けると文末記号が来ないまま N ms 入力が止まった断片も読む。詳細は [references/library.md](references/library.md#ストリーミング)。

```sh
llm-agent run | $K speak --input - --stream --flush-ms 300 --output - --format pcm | aplay -f S16_LE -r 24000 -c 1
```

## 守ること

**エンジンとパラメータを書き切る。** リクエストに `"engine": "formant"`、CLI に `--engine formant`。既定値は環境変数 (`KONGYOROID_ENGINE` `KONGYOROID_VOICE` `KONGYOROID_DICTIONARY` `KONGYOROID_CACHE_DIR`) で動くので、再現性が要る値はリクエスト側に持たせる。何が実際に効いているかは `validate` の `request` (既定値まで展開された正規化リクエスト) で確認できる。

**上書きは事故を防ぐ側に倒す。** 同じ内容の再描画は `written: false, unchanged: true` で成功する no-op。内容が違うと `IO_ERROR` (終了コード 4) で止まる。ここで反射的に `--force` を足さない。**別名で書くのが既定**で、`--force` はユーザーがその置換を頼んだときだけ。

**失敗はコードで分岐する。** `error.code` (16 種)、`error.path` (`$.notes[1].beats` のような JSON Pointer 風、フラグは `$flags.speed`)、`error.repairOptions[].action` (`provide-kana` `increase-duration` など) が機械可読な契約で、`message` は人向けで変わり得る。終了コードは 0 成功 / 1 内部 / 2 入力 / 3 エンジン / 4 入出力 / 130 中断。対処は [references/troubleshooting.md](references/troubleshooting.md)。

**`warnings[]` と `adjustments[]` を読む。** `warnings` は読みや音域への助言 (`severity`: `warning` / `advice`)、`adjustments` はエンジンが勝手に変えたこと (子音の短縮など)。どちらも `ok: true` の中に入るので、成功を見ただけで閉じない。

**直したら読み直す。** 辞書は読みだけでなくアクセント句の切れ方も変える (`3件 → サンケン` を足すと `サ'ンケンシッパイ` のように後続の語と 1 句に融合することがある)。設定を 1 つ変えれば `planHash` も出音も変わる。長い制作物では、問題のある短い抜粋で設定を詰めてから全体を描画する。

## 仕上げと報告

- `inspect` で `finite: true`、`clipped: 0`、意図した `durationSeconds` と `sampleRate`、`peak` が無音でないことを確認する。歌唱なら `pitch.medianHz` が狙いの音高帯にあるかも見る (持続した A3 は理論値 220 Hz に対し 219.7)。
- 描画結果の `limitedSamples` が大きければリミッターが働いている。`gainDb` を下げて描画し直す (`gainDb` −60..12、`volume` 0–3、両方は書けない)。RMS を知覚音量や LUFS の代用にしない。
- 聴ける環境なら冒頭・末尾、直した語、文境界、歌の子音と持続母音を試聴する。**聴けないなら「数値検査済み・聴感未確認」と明記する**。formant は声道と音源をモデル化した合成音声で、数値が揃っても人間らしさは保証されない。
- 納品は WAV を主に、再現に必要なリクエスト JSON・辞書・採用した設定・`requestHash` / `planHash` / `sha256` を添える。作った音声、残っている読みの不安や警告、試聴したかどうかを短く伝える。

## 必要になったときだけ読む

| 知りたいこと | 参照先 |
| --- | --- |
| コマンドとフラグ、出力 JSON の各フィールド、制限 | [references/cli.md](references/cli.md) |
| 読み・アクセント・かな記法・辞書・話速や抑揚などの韻律・ボイス | [references/speech.md](references/speech.md) |
| 譜面の 3 形式、モーラ配分、タイ / メリスマ、子音の借用、音域、MML | [references/singing.md](references/singing.md) |
| ESM ライブラリ、ストリーミング (`flushMs`)、バッチ、キャッシュ | [references/library.md](references/library.md) |
| エラーコードごとの原因と直し方、警告一覧、黙って壊れる例、落とし穴 | [references/troubleshooting.md](references/troubleshooting.md) |

公式 CLI と公式 API をそのまま使う。作業用のコマンドが要るなら、作業ディレクトリ側に使い捨てで書く。VOICEVOX ENGINE (`--speaker` / `--singer`) は任意の追加機能で、このスキルの手順は内蔵エンジンを前提にしている。
