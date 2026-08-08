"use client";

import { useQuery } from "@tanstack/react-query";
import { Compass } from "lucide-react";

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
