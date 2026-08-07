"use client";

import { Button } from "@/components/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radar } from "lucide-react";

import { useTRPC } from "@karakeep/shared-react/trpc";

const CHANNEL_LABELS: Record<string, string> = {
  bookmark_backfill: "保存済みブックマークから",
  outbound_link: "保存記事のリンクから",
  aggregator: "アグリゲータから",
  author: "著者の追跡から",
  blogroll: "リンク集から",
  smallweb_search: "small-web 検索から",
  domain_neighbor: "似た情報源から",
  social: "SNS の共有から",
  llm_search: "LLM 検索から",
};

/**
 * 「今日の新しい発見」（FR-U-10）。
 *
 * 発見経路の説明を必ず添える。ドメイン名だけ出されても購読するか判断
 * できないし、経路が分かると「この掘り方は効いている / 効いていない」を
 * 人間が体感できる。
 */
export default function DiscoveryBlock() {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const discoveries = useQuery(
    api.recommender.listDiscoveries.queryOptions({ limit: 5 }),
  );
  const decide = useMutation(
    api.recommender.decideDomain.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(
          api.recommender.listDiscoveries.pathFilter(),
        );
      },
    }),
  );

  if (!discoveries.data || discoveries.data.length === 0) {
    return null;
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border bg-background p-4">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Radar className="size-4" />
        今日の新しい発見
      </h2>
      <ul className="flex flex-col gap-3">
        {discoveries.data.map((d) => (
          <li key={d.domainId} className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{d.domain}</span>
            <span className="text-xs text-muted-foreground">
              {d.evidence ?? CHANNEL_LABELS[d.channel] ?? d.channel}
            </span>
            <div className="flex gap-1">
              {/*
                人間の一発判断はどんなモデルより安く正確なので、試用判定を
                待たずにショートカットできるようにする（FR-D-17）。
              */}
              <Button
                size="sm"
                variant="outline"
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({
                    domainId: d.domainId,
                    decision: "subscribe",
                  })
                }
              >
                購読
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({ domainId: d.domainId, decision: "reject" })
                }
              >
                却下
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
