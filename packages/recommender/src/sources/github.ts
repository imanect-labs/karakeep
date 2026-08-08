import type { CollectedItem, SourceAdapter } from "./types";
import { fetchJson, toDate } from "./types";

export interface GithubSourceConfig {
  /** 例: `rust`, `typescript`。省略すると言語を絞らない。 */
  language?: string;
  /** 直近何日のうちに作られたリポジトリを見るか。 */
  createdWithinDays?: number;
  minStars?: number;
  /** 任意の検索語。トピック名を入れると効く。 */
  query?: string;
}

interface GithubRepo {
  html_url: string;
  full_name: string;
  description: string | null;
  created_at: string;
  pushed_at: string | null;
  stargazers_count: number;
  language: string | null;
  owner?: { login?: string };
}

interface GithubSearchResponse {
  items: GithubRepo[];
}

/**
 * GitHub。
 *
 * `github.com/trending` は HTML をスクレイプするしかなく壊れやすいので、
 * 公式の検索 API で「最近作られてスターが付いたリポジトリ」を取る。
 * trending の代用として実用上ほぼ同じものが得られ、しかも壊れない。
 */
export const githubAdapter: SourceAdapter<GithubSourceConfig> = {
  kind: "github",

  async fetchItems(config, ctx): Promise<CollectedItem[]> {
    const params = new URLSearchParams({
      q: buildQuery(config),
      sort: "stars",
      order: "desc",
      per_page: String(Math.min(ctx.limit, 100)),
    });
    const response = await fetchJson<GithubSearchResponse>(
      `https://api.github.com/search/repositories?${params.toString()}`,
      ctx,
    );

    return (response.items ?? []).slice(0, ctx.limit).map((repo) => ({
      url: repo.html_url,
      title: repo.full_name,
      summary: repo.description,
      contentExcerpt: null,
      author: repo.owner?.login ?? null,
      // 「作られた日」ではなく「最後に動いた日」を鮮度とする。古いリポジトリが
      // 再活性化したときに拾えるようにするため。
      publishedAt: toDate(repo.pushed_at ?? repo.created_at),
      lang: null,
    }));
  },
};

export function buildQuery(config: GithubSourceConfig): string {
  const parts: string[] = [];
  if (config.query) {
    parts.push(config.query);
  }
  if (config.language) {
    parts.push(`language:${config.language}`);
  }
  parts.push(`stars:>=${config.minStars ?? 50}`);

  const days = config.createdWithinDays ?? 30;
  const since = new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
  parts.push(`created:>${since}`);

  return parts.join(" ");
}
