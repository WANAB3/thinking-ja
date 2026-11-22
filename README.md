# thinking-ja

コーディングエージェントの思考（thinking / reasoning）を、手元の翻訳モデル（PLaMo 3 Translate など）で日本語に訳して表示します。訳は表示するだけで、モデルへの入力や会話の記録は書き換えません。

| ハーネス | 訳の出る場所 | 導入 |
|---|---|---|
| [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) | 英文の思考のすぐ下に、生成中の訳から全文まで | `omp plugin install github:WANAB3/thinking-ja` |
| [pi](https://pi.dev) | 思考のあとに訳のカード | `pi install git:github.com/WANAB3/thinking-ja` |
| [Claude Code](https://code.claude.com) | 思考ブロックの真下の行（mod） | marketplace から（下記） |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web / Desktop | 思考（Think）を開いたとき、原文の下 | `dsh plugin --profile web add github:WANAB3/thinking-ja` |
| Codex CLI ほか | 別ペインに訳を流す | `thinking-ja watch codex` |

## 1. 翻訳サーバーを動かす

OpenAI 互換の API があれば何でも使えます。おすすめは llama.cpp の `llama-server` と [PLaMo 3 Translate](https://huggingface.co/pfnet/plamo-3-translate-2b-GGUF) です。

```sh
hf download pfnet/plamo-3-translate-2b-GGUF plamo-3-translate-2b-Q4_K_M.gguf --local-dir ~/models-translate
llama-server -m ~/models-translate/plamo-3-translate-2b-Q4_K_M.gguf \
  --port 8095 -c 32768 -np 8 --sleep-idle-seconds 600
```

- `-np 8` はサーバー全体で同時に翻訳できる件数です。同じ URL を使う omp セッションはこの8枠を共有し、セッションごとにモデルを起動することはありません。
- `--sleep-idle-seconds 600` は、10 分使わなければモデルをメモリから外す設定です。
- PLaMo 3 Translate の重みは [PLaMo Community License](https://plamo.preferredai.jp/info/plamo-community-license-ja) です。個人利用は無料・登録不要です。

## 2. 設定ファイルを書く

`~/.config/thinking-ja/config.json`（`$XDG_CONFIG_HOME` に従う。`THINKING_JA_CONFIG` で別の場所も指定できます）:

```json
{
  "translators": [
    { "preset": "plamo-3-translate", "url": "http://127.0.0.1:8095/v1/completions" }
  ]
}
```

`translators` は上から順に試され、失敗したら次へ進みます。確認するには:

```sh
echo "I should read the config file first." | npx github:WANAB3/thinking-ja translate
```

### 他の翻訳モデルを使う

`preset` の代わりに、そのモデルの入力書式を書きます。completions 形式なら `prompt`、chat 形式なら `messages` です。文字列中の `{{text}}` は訳す本文に、`{{source_lang}}` は `en` か `zh` に置き換わります。

```json
{
  "translators": [
    {
      "url": "http://127.0.0.1:8095/v1/chat/completions",
      "messages": [{ "role": "user", "content": "Translate the following segment into Japanese, without additional explanation.\n\n{{text}}" }],
      "body": { "temperature": 0.7, "top_k": 20, "top_p": 0.6, "repeat_penalty": 1.05 }
    }
  ]
}
```

| 項目 | 意味 |
|---|---|
| `url` | エンドポイントの URL（必須） |
| `preset` | `plamo-3-translate` / `hy-mt`。書式と既定値を入れる |
| `prompt` / `messages` | completions / chat のリクエスト本文。どちらか一方 |
| `model`, `stop` | そのまま送る |
| `body` | 追加のリクエスト項目（サンプリングなど）。最後に上書きでまとめる |
| `chunkChars`, `concurrency` | 長い思考を何字ずつ・何並列で訳すか（先頭の translator の値を使う） |

## 3. ハーネスごとの導入

### oh-my-pi (omp)

```sh
omp plugin install github:WANAB3/thinking-ja
```

英文は元のまま残り、日本語訳はそれぞれの思考ブロックのすぐ下に出ます。入力欄には字幕を置きません。ローカルの翻訳サーバーは、英文の一文や一行が区切れたところから訳し始めます。句点も改行もない長文は最大240字が目安です。ストリーミングに対応したサーバーなら、日本語が生成された分から読めます。通常の JSON を返すサーバーでは、一件の訳ができた時点で表示します。

訳が届く前に、表示中の英文の長さ・改行・端末の横幅から行数を見積もります。英文の表示が先に更新されても、途中まで出た訳とその続きは、更新後の英文の下に残ります。見積もりに収まらない場合だけ、訳の完成時に一度広げて全文を表示します。3行の上限はありません。端末の変更できないスクロールバックに先に流れた場合も、`/thinking-ja show` で完成した訳を読めます。`Esc` で会話に戻り、`/thinking-ja` で翻訳を停止・再開できます。

思考の翻訳には `translators` に指定した URL だけを使い、HTTP リダイレクトにも従いません。設定がない場合や、指定した翻訳先がすべて失敗した場合は、新しい訳をスキップします。英文と、すでに訳し終えた文はそのままです。`@thinking-ja`・`@smol`・`@default` など、omp のチャットモデルには切り替えません。

### pi

```sh
pi install git:github.com/WANAB3/thinking-ja
```

思考が終わるたびに、その訳をカードとして会話に足します。カードはセッションに残り、再開しても訳し直しません。モデルには送られません。`/thinking-ja` で翻訳を止めたり再開したりできます。

### Claude Code

```text
/plugin marketplace add WANAB3/thinking-ja
/plugin install thinking-ja@thinking-ja
```

`~/.claude/settings.json` に次の設定が必要です。Claude Code は既定では思考の本文を記録しません。

```json
{ "showThinkingSummaries": true }
```

思考ブロックが確定するとその真下に行を置き、訳が届いたら中身を埋めます。この行は Claude には読まれません（mod の `$.ui.place`。Claude Code 2.1.314 以降）。

### DeepSeek Harness (DSH)

```sh
dsh plugin --profile web add github:WANAB3/thinking-ja
```

DSH を再起動したあと、思考（Think）の行を開くと、原文の下に訳が出ます。訳は DSH の Host 経由で翻訳サーバーに頼み、セッションには書き込みません。

### Codex CLI ほか（別ペインで見る）

```sh
npm install -g --install-links github:WANAB3/thinking-ja   # thinking-ja コマンドが入る
thinking-ja watch codex          # 今いるディレクトリの最新セッションを追う
thinking-ja watch claude --backlog 3 --original
thinking-ja watch dsh --file ~/.dsh/sessions/<...>/session.v4.jsonl.zstd
```

対応: `claude` / `codex` / `pi` / `omp` / `dsh`。セッションの記録ファイルを追い、新しい思考が書かれるたびに訳を出します。新しいセッションが始まると自動で乗り換えます。Codex は思考の要約だけを記録します。暗号化されたものは訳せません。

`--install-links` を外すと、npm は消える一時フォルダへのリンクとして入れるため、コマンドが動きません。

## 速さの目安

M4 Mac・PLaMo 3 Translate 2B（Q4_K_M）・1500 字 × 8 並列での実測です。

| 思考の長さ | 訳が出るまで |
|---|---|
| 中央値（数百字） | 約 3 秒 |
| 4,500〜11,000 字 | 11〜23 秒 |

0.8B にすると 2〜3 倍速くなりますが、コード中の語をまれに訳してしまいます。

## 開発

```sh
bun install
bun run test           # ビルドしてから、コア・omp・ビューアのテスト
bun run test:claude    # Claude Code mod のテスト（claude plugin test）
bun run typecheck
bun run typecheck:claude  # mod の型検査
```

- `dist/`（CLI と DSH 用のビルド結果）はコミットしています。GitHub から直接入れたとき、ビルドなしで動かすためです。`bun run test` は先にビルドするので、`src/` を変えたら `dist/` の差分も一緒にコミットしてください。
- `typecheck:claude` は、Claude Code が `claude --plugin-dir .` で mod を読み込んだときに書き出す型（`.claude-plugin/types/`）を使います。

## English

thinking-ja shows a Japanese translation of a coding agent's thinking, made by a local translation model (any OpenAI-compatible endpoint; PLaMo 3 Translate recommended). Translations are display-only: model input and transcripts are never changed. On oh-my-pi, each visible thinking block reserves space for its full translation based on the original text and terminal width. Sealed source sentences are translated while thinking continues, and streaming endpoints draw partial Japanese in place. Any overflow expands once when the block's translation finishes. `/thinking-ja show` opens a scrollable snapshot. Other integrations include a card extension for pi, a Claude Code mod (needs `"showThinkingSummaries": true`), a DeepSeek Harness Web/Desktop plugin, and `thinking-ja watch`, a side viewer for Claude Code, Codex, pi, omp and DSH. Install from GitHub with the commands above; configure translators in `~/.config/thinking-ja/config.json`.

The omp extension sends thinking only to the configured translator URLs, not to redirect targets or a fallback chat model. If no endpoint is configured or all fail, it skips the unavailable translation. Sessions using the same URL share one translation server, not their translation history.

## License

MIT. Translation model weights are not included and come under their own licenses.
