"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Compass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import { useTRPC } from "@karakeep/shared-react/trpc";

/**
 * 「興味の現在地」（FR-U-06）。
 *
 * 潜在プロフィールは埋め込みなので、そのままでは人間に読めない。クラスタの
 * ラベルとして提示することで、**本人が言語化していない興味を見える形にする**
 * — これがこの機能の目的そのものなので、UI から落とせない。
 */
export default function InterestPanel() {
  const api = useTRPC();
  const state = useQuery(api.recommender.getInterestState.queryOptions());

  if (!state.data) {
    return null;
  }

  const { topClusters, negativeClusters, trialDomains, recentlyPromoted } =
    state.data;

  return (
    <section className="flex flex-col gap-3 rounded-md border bg-background p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Compass className="size-4" />
        興味の現在地
      </h2>

      <ExplicitTopicsForm topics={state.data.explicitTopics} />

      {topClusters.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">上位のトピック</span>
          {topClusters.map((c) => (
            <div
              key={c.id}
              className="flex items-baseline justify-between gap-2"
            >
              <span className="truncate text-sm">
                {c.label ?? `クラスタ ${c.id.slice(0, 6)}`}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {(c.score * 100).toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      )}

      {negativeClusters.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            反応の薄いトピック
          </span>
          {negativeClusters.map((c) => (
            <span key={c.id} className="truncate text-sm text-muted-foreground">
              {c.label ?? `クラスタ ${c.id.slice(0, 6)}`}
            </span>
          ))}
        </div>
      )}

      {trialDomains.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">試用中の情報源</span>
          <span className="text-sm">
            {trialDomains.map((d) => d.domain).join("、")}
          </span>
        </div>
      )}

      {recentlyPromoted.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">最近購読に昇格</span>
          <span className="text-sm">
            {recentlyPromoted.map((d) => d.domain).join("、")}
          </span>
        </div>
      )}

      <div className="flex justify-between border-t pt-2 text-xs text-muted-foreground">
        {/*
          観測率はすべての完了条件と中止基準の基準値なので、常時見えるところ
          に置く。ここが 60% を割ったら、精度より先に運用を直す合図になる。
        */}
        <span>Briefing 観測率</span>
        <span className="tabular-nums">
          {(state.data.observationRate * 100).toFixed(0)}%
        </span>
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>候補プール</span>
        <span className="tabular-nums">{state.data.candidatePoolSize} 件</span>
      </div>
    </section>
  );
}

function ExplicitTopicsForm({ topics }: { topics: string[] }) {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [text, setText] = useState(topics.join("\n"));
  const save = useMutation(
    api.recommender.setExplicitTopics.mutationOptions({
      onSuccess: ({ topics: saved }) => {
        setText(saved.join("\n"));
        void queryClient.invalidateQueries(
          api.recommender.getInterestState.pathFilter(),
        );
      },
    }),
  );
  const values = text
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
  const invalid = values.length > 12 || values.some((t) => t.length > 200);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!invalid) save.mutate({ topics: values });
      }}
    >
      <label
        htmlFor="briefing-explicit-topics"
        className="text-xs text-muted-foreground"
      >
        関心のあるトピック
      </label>
      <Textarea
        id="briefing-explicit-topics"
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={save.isPending}
        rows={3}
        placeholder={"インフラ・分散システム\nOS・カーネルなどの低レイヤー"}
      />
      <p className="text-xs text-muted-foreground">
        1行に1つ，12件まで。次回のBriefingから反映します。空にして保存すると解除できます。
      </p>
      {invalid && (
        <p role="alert" className="text-xs text-destructive">
          12件以内，各200文字以内で入力してください。
        </p>
      )}
      {save.isError && (
        <p role="alert" className="text-xs text-destructive">
          保存できませんでした。もう一度お試しください。
        </p>
      )}
      {save.isSuccess && (
        <p role="status" className="text-xs text-muted-foreground">
          保存しました。
        </p>
      )}
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={invalid || save.isPending}
      >
        保存
      </Button>
    </form>
  );
}
