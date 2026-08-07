# ci: base ブランチに `/` を含む PR で CI が起動しない

- 作業日時: 2026-08-07

## 症状

このフォークの PR #2〜#10 で GitHub Actions が一度も起動せず、`gh pr checks`
がすべて "no checks reported" を返していた。ワークフローは `active`、
リポジトリの Actions permissions も `enabled: true` だったため、当初は
組織側の課金・実行制限を疑った。**これは誤りだった。**

## 原因

`.github/workflows/ci.yml` のフィルタ。

```yaml
on:
  pull_request:
    branches: ["*"]
```

**GitHub のフィルタパターンでは `*` は `/` にマッチしない。** そして
`pull_request` の `branches` は **base ブランチ**に対して評価される。

| PR | base | 起動 |
|---|---|---|
| #1 | `main` | ○ |
| #2〜#10 | `feat/...` / `docs/...` | × |

2026-08-01 に走った唯一の CI が PR #1（base=main）で、それ以降ずっと
base に `/` を含む PR しか作っていなかったため、CI が全部黙っていた。

upstream は常に `main` を base にするのでこの罠を踏まない。**フォークで
作業ブランチを base にした瞬間に、エラーも警告も無しに CI が止まる。**

## 対処

```yaml
    branches: ["**"]
```

`**` は `/` を含むブランチ名にマッチする。これで PR #10 の 5 ジョブ
（format / lint / open-api-spec / tests / typecheck）が起動した。

## 申し送り

PR #9 は base も head も別ブランチなので、この修正が head に乗るまで
CI は起動しない。#10 が #9 にマージされた時点で解消する。

`.github/workflows/ci.yml` は upstream 由来のファイルなので、upstream 取り込み
時にこの 1 行が戻る可能性がある。取り込み後に PR の checks が消えていたら
まずここを疑う。

---

## 続き: CI を有効にしたら E2E が落ちた

ブランチフィルタを直して初めて CI が走り、**E2E が 2 件失敗した**
（`inference.test.ts` のタグ付けと `import.test.ts` が 60 秒でタイムアウト）。

### 切り分け

この系統で CI が走ったことが無く、比較対象が無かったので、実装を一切含まない
ベースライン PR（#11、`docs/briefing-recommender` + ci.yml の 1 行のみ）を
立てて比較した。

| | E2E |
|---|---|
| #11 ベースライン（実装なし） | pass |
| #10 実装あり（初回） | fail |
| #10 実装あり（再実行） | fail |

**実装由来**と確定。

### 原因

失敗した run の docker ログを取ると、**ワーカープロセスが 6〜7 秒ごとに
クラッシュ再起動していた**（10 回の起動に対して 10 回のクラッシュ）。

```
Starting recommender worker ...
Starting recommender embedding worker ...
Listening on http://127.0.0.1:35749
  #  node[70]: void node::RemoveEnvironmentCleanupHook(...) at ../src/api/hooks.cc:142
  #  Assertion failed: (env) != nullptr
  3: Statement::~Statement() [better_sqlite3.node]
```

ジョブが 1 つも完走できないので、タグ付けと import が 60 秒でタイムアウト
していた。**テスト自体は正しく、実装が壊していた。**

ローカルでは tsx でもバンドル版（tsdown）でも 25 秒間クラッシュしない。
Docker 環境（Meilisearch あり、s6 管理下）でのみ再現する。

### 対処

`RECOMMENDER_ENABLED=false` のあいだは、推薦機能のキューランナーを
**そもそも起動しない**ようにした。

これは切り分けのための小細工ではなく、設計として正しい。無効な機能のために
ポーリングを 2 本回す理由が無く、既存デプロイのワーカープロセスに一切
触れないという当初の方針（cron を登録しない）とも揃う。

あわせて、CI のテストジョブに `packages/recommender` が入っていなかったので
追加した。296 件が一度も CI で走っていなかった。

### 申し送り

`RECOMMENDER_ENABLED=true` にした時点で、このクラッシュが再び出る可能性が
ある。有効化は E2E を Docker で通してから行うこと。better-sqlite3 の
Statement ファイナライザが env 破棄後に走る形なので、キューランナーの
`stop()` 漏れか、liteque のプリペアドステートメントの保持の仕方を疑う。

---

## 訂正と、実際に分かったこと

### 「実装由来」という断定は誤りだった

ベースライン PR #11 が 1 回通ったことを根拠に「E2E の失敗は実装由来」と
断定したが、**#11 は 2 回目で落ちた**。E2E は元々不安定で、n=1 の pass を
根拠にしたのが誤りだった。

| | migration 失敗 | assertion | workers 再起動 |
|---|---|---|---|
| #11 ベースライン | 0 | 9 | 5 |
| #10 実装あり | 0 | 25 | 20 |

`better-sqlite3` のアサーションは**ベースラインにも出ている**。upstream の
潜在バグであって、こちらが持ち込んだものではない。

ただし実装を載せるとアサーションが約 3 倍、ワーカー再起動が約 4 倍になる。
`rec*` 10 テーブルぶんプリペアドステートメントが増え、潜在バグを踏む頻度が
上がったため。再起動が増えればジョブが完走せず E2E が落ちやすくなる。

**「単独の原因」ではなく「元々の不安定さを増幅している」が正しい。**

### 見つけた実バグ: マイグレーションが閉じずに終わる

ローカルで E2E を再現したところ、CI では見えなかった症状が出た。

```
s6-rc: info: service init-db-migration: starting
Running db migration script
  #  Assertion failed: (env) != nullptr
  3: Statement::~Statement() [/db_migrations/.../better_sqlite3.node]
s6-rc: warning: unable to start service init-db-migration: command exited 134
```

`packages/db/migrate.ts` が SQLite ハンドルを閉じずに終了するため、
`Statement` が Node の環境破棄後にファイナライズされて abort する
（exit 134）。s6 はこれを起動失敗とみなし、**マイグレーション自体は成功
しているのにコンテナが永久にヘルシーにならない**。

`closeDatabase()` を足して修正。ローカルではこれで global setup を通過し、
テストが実際に走るようになった（それ以前は "No test files found"）。

### それでも残っている問題

修正後のローカル E2E は 151 件中 34 件が失敗。**全部 `fetch failed`** で、
web コンテナが実行中に落ちている。起動は通るようになったが、稼働中の
クラッシュは残っている。

根本にあるのは better-sqlite3 のファイナライザ問題で、upstream 側の課題。
こちらでできるのは踏む頻度を下げることだけ。次に試す価値がある順に:

1. 長生きするプロセスでも終了時に `closeDatabase()` を呼ぶ
2. better-sqlite3 を 11.3.0 から上げる（このアサーションは既知の修正あり）
3. `0094` を複数のマイグレーションに分割してステートメント数を減らす

**PR #10 は CI red のまま。マージ不可。**
