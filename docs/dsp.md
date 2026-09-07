# 合成器の設計メモ

ソースにはコメントを置かない方針なので、設計の根拠と単位をここにまとめます。対象は `src/synth/` と `src/text/` です。値はすべて 2.0.0 時点のものです。

## パイプライン

```
text ──normalize──▶ jpreprocess ──parse──▶ ReadingPlan (accent phrases, moras, boundaries)
kana ──parse────────────────────────────▶
                                          │
                     planSpeech / planSong ▼
                     SynthesisPlan: segments (phoneme, keyframes), pitch points, vibrato regions,
                                    mora / phrase / note markers, warnings, adjustments
                                          │
                              PlanRenderer ▼   1 ms control hop, per-sample synthesis
                     Float32 PCM ──▶ soft limiter ──▶ PCM16 WAV / blocks
```

計画 (`SynthesisPlan`) は JSON 化できる純粋なデータで、`planHash` はその正規化 JSON の SHA-256 です。レンダラーは計画と `sampleRate` だけから音を作り、ブロック境界や同期/非同期の経路に依存しません (`test/synth.test.ts` で最大差 0 を確認)。

## タイミング (読み上げ)

`SPEECH_TIMING` (`src/synth/speech.ts`):

| 定数 | 値 | 意味 |
| --- | --- | --- |
| `mora` | 0.108 s | 1 モーラの基準長 |
| `consonantShare` | 0.6 | 子音長のうち母音から差し引く割合 |
| `minVowel` | 0.04 s | 母音の下限 |
| `moraicNasal` / `closure` / `longVowel` / `devoiced` | 0.08 / 0.08 / 0.1 / 0.055 s | ン / ッ / ー / 無声化母音 |
| `pauseComma` / `pauseSentence` / `pauseParagraph` | 0.2 / 0.38 / 0.7 s | `、` / 文末 / 段落末のポーズ |
| `phraseFinalStretch` / `sentenceFinalStretch` / `questionStretch` | 1.12 / 1.3 / 1.45 | 句末・文末・疑問文末の伸長 |
| `sentenceInitialStretch` | 1.05 | 文頭の伸長 |

子音長は音素表 (`PHONEMES[...].duration`) から取り、`speed × voice.rateScale` で子音・母音・ポーズを一様に割ります (1.0.0 では母音だけが縮んでいた)。ポーズは `speed^0.7` で縮み、`pauseScale` を掛け、`pauseLength` があれば `、` はその値、文末は `max(pauseLength, 0.38)` です。発話の最後の句は、明示的な `、` の時だけポーズを足し、文末記号では足しません。段落末 (`\n\n`) は文末記号の種類に関わらず 0.7 s に引き上げます。

## 韻律 (藤崎モデル)

`src/synth/prosody.ts`。log F0 を基準値 + フレーズ成分 + アクセント成分 + 境界トーンで表します。

- 基準値: `voice.baseF0 × 0.82 × 2^(pitchSemitones/12)`。
- フレーズ成分: `Gp(t) = α² t e^{−αt}`、α = 3 /s。文頭の指令は句頭の 0.12 s 前に振幅 0.28、`、` の後は 0.16、句境界 `/` では 0.05 (いずれも `intonation × voice.intonationScale` 倍)。
- アクセント成分: `Ga(t) = min(γ, 1 − (1 + βt) e^{−βt})`、β = 20 /s、γ = 0.9。指令は核モーラの母音開始の 0.08 s 前 (`ACCENT_LEAD_SECONDS`) に立ち上がり、核モーラ終端の 0.03 s 前で降ります。振幅は頭高 0.44、中高・尾高 0.4、平板 0.32 (平板は第 2 モーラから句末まで)。0.08 s 先行させるのは、β = 20 では 80 % に達するまで約 150 ms かかるためで、これで核モーラの母音中央で 30 % 程度の上昇になります。
- 境界トーン: 疑問文末は最終モーラで +0.38 (対数)、それ以外の文末は最後の 0.25 s で −0.12 の下降。感嘆 (`！`) は文全体のフレーズ・アクセント振幅を 1.2 倍にし、レベル +1.5 dB・Rd −0.1 (やや張った声) にします。
- 生成した F0 は 5 ms ごとにサンプルし、`PitchPoint` として計画に入れます。VOICEVOX 互換の `pitch` (pitchScale) は VOICEVOX と同じく対数 F0 に `2^pitch` を掛けるので、Hz では `F0^(2^pitch)` になります (`applyPitchScale`)。実用範囲が ±0.15 程度なのはこのためで、内蔵エンジンでは半音単位の `pitchSemitones` を推奨します。

音域検査: F0 が 30 Hz 未満、2500 Hz 超、またはサンプルレートの 20 % 超なら `PITCH_OUT_OF_RANGE`。ボイスの `f0Min`–`f0Max` を外れると警告。

## 音素と調音

`src/synth/phonemes.ts` の `PHONEMES` が音素ごとの定常フォルマント (F1–F3)、帯域幅、音源レベル (`av`)、長さ、ロカス、摩擦スペクトル、閉鎖・破裂・気音の時間を持ちます。母音 (Hz): ア 700/1150/2450、イ 290/2250/3000、ウ 320/1250/2250、エ 480/1850/2500、オ 480/800/2400。

`src/synth/acoustics.ts` の `compileSegments` が音素列を時間付きキーフレームに変換します。

- 子音→母音の遷移はロカス理論: 開始フォルマント = `locus + λ (steady − locus)`。λ は軟口蓋音 0.55、両唇音 0.42、それ以外 0.5、/h/ は 1 (母音に溶ける)。遷移時間は音素表の `transition`。
- 母音→子音は逆向きに 0.3–0.5 の割合で次の音の目標へ寄せ、鼻音の前後は鼻音混合 (`nasalMix` 0.5–0.55) と反共振の周波数を掛けます。
- 撥音 (ン) は次の音の調音点に同化 (両唇/歯茎/軟口蓋/口蓋垂の目標、`MORAIC_NASAL_TARGETS`)。
- 促音 (ッ) は摩擦音の前では摩擦の持続 (`af` を保つ)、破裂音の前では無音の閉鎖。
- 無声化母音 (`_シ`、デ`_ス`) はカスケードを通した気音 (母音のフォルマント形状を持つ雑音、レベル −13 dB)。
- 破裂音は閉鎖 → 破裂 (音素ごとのバーストスペクトル、/k g/ は後続母音が i/e なら口蓋化スペクトル) → 気音 → 有声化。
- 有声開始のレベル: 句頭は −26 dB から、無声子音の後は −10 dB、閉鎖の後は −14 dB、再アーティキュレーションは −18 dB から 50 ms で立ち上げ、直前の母音の末尾も −14 dB まで落として Rd を +0.3 (少し息を混ぜる)。タイ/メリスマ (`continue`) は一切のアタックを入れません。

`PhoneDraft.gainDb` / `rdOffset` / `emphasis` で音ごとのレベル・張り・強調を、`sustain` で持続 (オフセット遷移無し) を指定します。

## 音源 (LF モデル)

`src/synth/glottal.ts`。Fant の Liljencrants–Fant モデルを `Rd` 1 パラメータで制御します。

- `Rd → (Ra, Rk, Rg)`: `Ra = (−1 + 4.8 Rd)/100`、`Rk = (22.4 + 11.8 Rd)/100`、`Rg = Rk / (4 ((0.11 Rd)/(0.5 + 1.2 Rk) − Ra))` (Fant 1995)。`Rd` は 0.3 (張った声) 〜 2.7 (息の多い声) に制限。
- 周期を 1 に正規化し、`tp = 1/(2Rg)`、`te = tp (1 + Rk)`、`ta = Ra`。ε は `ε ta = 1 − e^{−ε (1 − te)}` の不動点、α は開放相の面積と回帰相の面積が釣り合う値を二分法で解きます (面積の釣り合いが流量の周期内ゼロ和 = DC 無しを保証)。
- 導関数波形は `E0 e^{αt} sin(ωt)` (0 ≤ t ≤ te)、`−(e^{−ε(t−te)} − e^{−ε(1−te)}) / (ε ta)` (te < t ≤ 1)。負のピークは −1 に正規化。`te` と実際の最小値の位置は Rd が大きいとき 1–2 % ずれますが、これはモデルの性質でテストは 2 % を許容します。
- 形状は Rd を 48 段階に量子化してキャッシュし、周期ごとに補間せずそのまま使います。
- 音源は 2 倍オーバーサンプリングで生成し、31 タップのハーフバンドフィルタで間引きます (高いピッチや低いサンプルレートでの折り返しを抑えるため)。
- 揺らぎ: ジッター (周期ごとのガウス乱数 × `jitter`)、シマー (振幅、dB)、フラッター (低周波の正弦揺れ)。乱数は `xorshift32` で、種は `deriveSeed(seed, label)` により用途ごとに分けるので、パラメータを 1 つ変えても他の雑音列は変わりません。
- 気音: 開放相で強くなる雑音 (`lfOpenPhaseWeight`) を `ah` (dB) でカスケードに混ぜます。

## 声道

`src/synth/renderer.ts` と `src/synth/filters.ts`。Klatt 型の並列/直列構成です。

- 直列 (カスケード): 5 つの 2 次共振器 (F1–F5)。係数は `c = −r²`、`b = 2 r cos(2πF/fs)`、`a = 1 − b − c` (DC 利得 1)。F4/F5 と帯域幅はボイスごと (`f4` `f5` `bandwidthScale`)、F1–F3 は `formantScale` で声道長を表します。
- 鼻音: 鼻腔の極 (`nasalPole`, 270 Hz 基準) と反共振 (`nasalZero`) を `nasalMix` で混ぜます。
- 並列 (摩擦): 雑音 → 1 次ハイパス (`fricHp`) → 2 つの共振器 (`fricF1/B1/G1`、`fricF2/B2/G2`)。レベルは `af` (dB)。
- 出力: DC ブロッカー → `volume` → ソフトリミッター。リミッターは knee 0.85 から連続的に圧縮するので、`volume` を 0.999→1.001 と動かしてもレベルは単調・連続です (`limitedSamples` に圧縮したサンプル数を報告)。
- 制御: 24 個のパラメータ (`PARAM_NAMES`: f1–f5、b1–b5、av、ah、af、rd、nasalMix、nasalPole、nasalZero、fricF1…fricHp) を 1 ms ごとにキーフレームから線形補間し、1 次の平滑化 (時定数: av/ah 2.5 ms、af 1.2 ms、rd 20 ms、nasalMix 6 ms、その他 4 ms) をかけます。周波数は補間後に係数へ変換します。
- 利得定数: `SOURCE_GAIN` 0.19、`ASPIRATION_GAIN` 0.6、`FRICATION_GAIN` 0.016。`av`/`ah`/`af` は dB で、−120 dB は完全に無音 (`dbToGain` が 0 を返す)。

サンプルレートが低い時は fs/2 を超えるフォルマントを無効化します (8 kHz でも破綻しません)。

## 歌唱の計画

`src/synth/song.ts`。

- 音符の開始時刻は `leadIn` + 拍 × 60/tempo の累積。母音を拍頭に置き、先頭子音は前の休符か前の音符の末尾 (最大 `MAX_BORROW_FRACTION` = 40 %) から借ります。借りられない分は音符内に入り (`CONSONANT_TAKEN_FROM_NOTE`)、それでも母音が 30 ms (`MIN_VOWEL_SECONDS`) を割るなら子音を短縮 (`CONSONANT_COMPRESSED`、45 % 未満で警告) するか、`consonantCompression: false` なら `NOTE_TOO_SHORT` で `availableMs` / `requiredMs` を返します。
- 複数モーラの歌詞は母音予算を等分し、モーラごとの子音長は音素表の値を使います。
- 同じ母音が続き、先頭子音が無く、前の音符と隙間が無い場合は `rearticulate` (既定) か `legato` (= `continue`)。タイ/メリスマは常に `continue` で、`sustainId` を引き継ぎます。
- ピッチ曲線は対数領域の折れ線 (`PitchPoint`) で、各音符の高さを保持点で押さえ、つながった音符間だけ `portamentoMs` の窓で移行します。しゃくりは音符頭で `scoopCents` 下から `scoopMs` かけて上がります。レンダラーは `interpolatePitchLog` で補間し、ビブラート (`VibratoRegion`: 持続ごとの開始・終了・遅延・フェード・深さ・速さ) を対数領域で加えます。
- レベル: `SONG_LEVEL_OFFSET_DB` = −4 dB を基準に、`velocity` は `20 log10(v/100)` 相当の dB と `Rd` の −0.5..0.5 の変化 (強い音ほど張る) に写します。

`test/synth.test.ts` は音階の各音で ±8 セント以内、持続母音で ±1 セント以内を確認し、`test/song.test.ts` はタイ・メリスマ・再アーティキュレーション・ベロシティ・ビブラート領域・子音予算の振る舞いを確認します。

## テキスト処理

- `normalizeForReading` (`src/text/normalize.ts`) は NFKC 正規化しつつ元テキストへの索引 (`map`) を保ち、`sourceSpan` を Unicode コードポイント単位で返せるようにします。辞書置換とレキシコン置換はカタカナをそのまま文中に埋め込み、置換位置 (`normalizedStart`) を記録します。
- `readJapanese` (`src/text/frontend.ts`) は文ごとにフロントエンドへ渡し、AquesTalk 風記法をアクセント句に解析します。読めない文字は「その文字を取り除いて再変換しても出力が変わらない」ことで検出します。
- 辞書のアクセント適用は、置換位置より前のテキストを変換してモーラ数を数え、期待位置に最も近い一致を選びます。レキシコンのアクセントは、フロントエンドが読みを複数句に割ったとき、核が特殊拍 (ー・ン・ッ) に乗っているとき、平板と判定したとき、または頭字語 (文字名の連続) のときだけ上書きします。それ以外は NAIST-JDic の辞書アクセントを優先します。
- 無声化規則 (`applyDevoicingRules`): 無声子音を持つイ・ウが次の無声子音の前にあるとき、または文末のウ (ス・ツ等) を無声化。核モーラと、直前が無声化済みのモーラは対象外。

## 決定性と互換性

- 同じ `SynthesisPlan` と `sampleRate` からは同じ Float32 列が出ます。乱数は計画内の `seed` からのみ派生します。
- `ENGINE_VERSION` は波形が変わる変更で、`PLAN_VERSION` は計画 JSON の形が変わる変更で上げます。キャッシュキーは両方とパッケージ版・フロントエンド版・辞書ダイジェストを含みます。
- ボイスプロファイルには `voiceProfileHash` があり、`voices` コマンドの `hash` として見えます。
