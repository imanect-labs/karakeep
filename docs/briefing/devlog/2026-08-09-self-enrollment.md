# feat(recommender): Briefing を自分で有効化できるようにする

- 作業日時: 2026-08-09
- 対応内容:
  - シード収集元 98 件をコードに持たせた（`SEED_SOURCES`）
  - `enroll` / `getEnrollment` の tRPC を追加
  - `enroll` タスクで初回パイプラインを 1 ジョブで直列に流す
  - Briefing ページに「はじめる」と「準備しています…」を追加
  - 要件に FR-C-08 / FR-U-15 を追加
- 変更したファイル:
  - `packages/recommender/src/sources/seed.ts` / `seed.test.ts` / `index.ts`
  - `packages/trpc/routers/recommender.ts` / `recommender.test.ts`
  - `packages/trpc/testUtils.ts` / `package.json`
  - `packages/shared-server/src/queues.ts`
  - `apps/workers/workers/recommender/enroll.ts` / `index.ts`
  - `apps/web/components/dashboard/briefing/BriefingView.tsx`
  - `docs/briefing/requirements.md`
- 確認内容:
  - vitest: `@karakeep/recommender` 5 件（新規）、`@karakeep/trpc` 3 件（新規）
  - `pnpm typecheck` / `lint` / `format`（monorepo 全体、pre-commit フック）
  - シード 98 件を giken-ops の `docs/karakeep-recommender-sources.md` と
    突き合わせ、欠落・余剰ともゼロを確認
- 残課題:
  - 同僚のアカウントは `DISABLE_SIGNUPS=true` のため自分で作れない。
    招待フローか管理者作成が先に要る（手順書は giken-ops 側）
  - シード一覧が既存ユーザー 1 人の嗜好に寄っている件は giken-ops#120

## 何が詰まっていたのか

スキーマもワーカーも**既に完全にユーザー単位**だった。`rec*` の全テーブルが
`userId` NOT NULL + cascade を持ち、全ワーカーが `run*(userId, …)` で、cron は
`recommenderUserIds()` を回してユーザーごとにジョブを投入している。tRPC も
全エンドポイントが `ctx.user.id` で絞られていて、Briefing ページは既に
ログイン済みの全員に見えていた。

詰まっていたのは 1 点だけ ── **新規ユーザーが最初の `recSources` 行を作る
手段が無い**。

```ts
// apps/workers/workers/recommender/shared.ts
export async function recommenderUserIds(): Promise<string[]> {
  const rows = await db.selectDistinct({ userId: recSources.userId }).from(recSources);
  return rows.map((r) => r.userId);
}
```

「収集元を 1 つでも持っている」が有効化の signal。ところが `recSources` に行を
作るコードは `discover.ts` の `ensureSourcesForDomains` 1 箇所だけで、その
`discover` は上のリストに載っているユーザーにしか走らない。鶏と卵で、
放っておくと永遠に何も起きない。`bootstrap` に至っては enqueue する場所が
どこにも無かった（本番の 1 人分は手で投入した）。

UI もそれを反映していて、空状態が「収集元を登録し、夜間の収集ジョブが 1 度
走ると表示されます」と**登録する手段の無い操作を案内していた**。

## 供給層は全員共通にする（FR-C-08）

ここが今回いちばん考えたところ。

シード収集元に `domainId` を付けてドメインのライフサイクルに載せると、
一見「URL リストが人ごとに最適化されていく」ように見える:

- `allocateIntake` の重みがその人の事後平均になる（`collect.ts`）
- `retierDomains` がその人の事後で 25/50/25 に振り直す
- `planDemotions` で降格すると `recSources` ごと `enabled=false` になる

**採らなかった。** これは**ランキングでは取り消せない供給層のフィルタ**に
なる。`no_positives` は「直近 20 examined で正例 0」で発火するので、ニッチだが
良い情報源が偶然そこに落ちると二度と出てこない。設計が `profileIndependent` の
床でわざわざ防いでいる「視野が狭まるフィードバックループ」を、より粗い形で
作り直すことになる。

しかも `planDemotions` は `manualDecision === "subscribe"` を無条件で
スキップする ── **「人が選んだものは自動降格しない」というカテゴリが
コードに既にある**。98 件は人が選んで取得確認まで済ませたものなので、
そちら側に属する。

`domainId = NULL` の帰結を確認しておく:

| 挙動 | 評価 |
|---|---|
| `allocateIntake` の重みが 0.2 固定 | **むしろ望ましい。** 重みが均一なので D'Hondt は事実上ラウンドロビンになり、供給の多様性が最大化される。事後で重み付けすると「既に好きなもの」に供給が集中する |
| 3 層化の対象外＝毎日取得 | クロール量の節約が効かないだけ。5 人 × 98 = 490 fetch/日、1 feed あたり日 5 リクエストで、どの常識的なレート制限も下回る |
| 自動降格されない | 意図どおり。**壊れた feed だけは `consecutiveFailures >= 5` で無効化される** ── 嗜好ではなく故障による停止で、これが正しい安全弁 |

個別最適化は 2 層目が担う。`discover` の D1（本人のブックマークのドメイン）/
D2（お気に入り記事の外部リンク）/ D4（アグリゲータ経由で見たドメイン）が
**その人だけの**収集元を作り、そちらは `domainId` を持つので議席 80 も試用枠も
昇降格も完全に効く。共通の土台は減らないまま、各自の裾野だけが伸びる。

## シード一覧は新しく選ばない

giken-ops の `docs/karakeep-recommender-sources.md` に、**登録前にすべて実際に
取得して 200 と item 数を確認済み**の一覧がある。落としたもの（はてブの
サブカテゴリは `?category=` が無視されて親と item が完全一致、
Uber / LinkedIn / Box は feed 無し、Quora は robots で拒否、Yelp は 403）と
その理由まで記録されている。検証コストは支払い済みなので、そのままコードへ
移した。98 件（本番の 102 件のうち 4 件は `discover` が自動追加したもの）。

スクリプトで突き合わせて、ドキュメントにあってコードに無い feed も、
コードにあってドキュメントに無い feed も 0 件であることを確認した。

## 初回パイプラインを 1 ジョブにした理由

ボタンを押して翌朝 05:30 まで何も起きないのは、セルフサービスとして成立
しない。かといって **`bootstrap` / `collect` / `rank` を 3 ジョブに分けて
投入すると壊れる**。

`RecommenderQueue` は `concurrency: 1` の FIFO なので一見順序が保証されそうだが、
`runCollect` は埋め込みを**別キュー**（`RecommenderEmbedQueue`、独立した
ランナー）へ渡す。2 つのキューの間に順序は無い。結果、`rank` が埋め込み完了前に
走り、`loadRankableCandidates` が `embedding: null` を読んで
`scoreHeuristic` が鮮度とドメイン事前値だけに落ち、`duplicateOfId` も未設定の
まま ── **目に見えて悪い初回 Briefing** が出る。何も出ないより悪い。

なので `enroll` タスクを足して 5 つを直接呼ぶ:

```
runBootstrap → runEmbed → runCollect → runEmbed → runRank
```

5 つとも既に export 済みで `(userId, …)` を取る。ワーカーを直接呼ぶのは
このコードベースの流儀（`rank.ts` が `refreshProfiles` をそう呼んでいる）。
所要は bootstrap ~1 分 + ライブラリ埋め込み ~30 秒 + collect 数分 +
候補埋め込み ~4 分 + rank ~10 秒 ≒ **10 分弱**。`jobTimeoutSec` は本番で
3600 に上げてあるので収まる（既定の 900 では収まらない）。

再試行しても安全。`runBootstrap` は明示的に冪等、`runCollect` は
`dropKnownDuplicates` + `onConflictDoNothing`、`runEmbed` は
`embeddingStatus='pending'` しか触らず、`runRank` の `upsertBriefing` は
既存行を再利用してフィードバック済みの impression を保つ。

**`discover` は入れていない。** 最も通信が重く（robots + トップページ +
feed 探索を 20 ドメイン）、価値は本人のブックマークからのドメイン発見なので、
シードが初日の供給を担う以上は急がない。03:30 の cron で走る。

## 冪等性は 2 段で守る

1. mutation の先頭で `count(recSources where userId) > 0` を見て即戻る。
   **この述語は `recommenderUserIds()` と完全に同一にしてある** ── ずれると
   UI が「登録済み」と言っているのに cron がそのユーザーを列挙しない、という
   無症状の状態が生まれる
2. `idempotencyKey: rec:enroll:${userId}`（日付を含めない）。ジョブが走って
   いる間の二度押しを liteque 側で握り潰す

収集元の insert は mutation の中で同期的にやる。98 行で数ミリ秒だし、ここで
やると次の refetch で UI がボタン → 準備中へ一度で切り替わる。ワーカーに
回すと、その間ボタンが押せる状態のまま残る。

## UI の状態を 3 つに分けた

未登録の判定に `getBriefing` の `status` を流用しなかった。`status` は
`recBriefings` の行の状態（`generating` / `ready`）+ 合成の `missing` で、
そこにアカウントの状態を相乗りさせると別物が混ざる。クエリを分けた。

- **未登録** → 「はじめる」
- **登録済み・Briefing 未生成** → 「準備しています…」+ 登録した収集元の件数。
  この状態のときだけ 15 秒間隔で invalidate して、`runEnroll` 完了で自動的に
  切り替わる
- **登録済み・生成済みで 0 件** → 従来の空状態（案内文から「収集元を登録し」を
  削った）

`briefing.isPending` のガードを `enrollment.isPending` にも広げた。広げないと
登録済みのユーザーにも読み込みのたび「はじめる」が一瞬出る。

## テストの落とし穴

`packages/trpc/testUtils.ts` の `vi.mock` に `RecommenderQueue` /
`RecommenderEmbedQueue` を足す必要があった。無いと `enroll` の enqueue が
実 `queue.db` を開きにいく。

さらに、`vi.mock` が `defaultBeforeEach` の**中**で登録されるので、テスト
ファイルの静的 import は素のモジュールを掴む（巻き上げの対象外）。モックされた
側を見るには動的 import で取り直す必要がある。呼び出し回数もモジュール単位で
溜まるので、`beforeEach` で `mockClear()` している。
