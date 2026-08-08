/**
 * robots.txt の最小実装（FR-D-16c）。
 *
 * 完全な準拠は目指さない。必要なのは「明示的に拒否されているパスを叩かない」
 * ことだけで、そこを外さなければ相手に迷惑をかけない。判断に迷ったら
 * **許可ではなく拒否に倒す**。
 */

export interface RobotsRules {
  /** 自分に適用されるグループの Disallow パス。 */
  disallow: string[];
  allow: string[];
  /** Crawl-delay（秒）。指定があればこちらの既定より長い方を採る。 */
  crawlDelaySeconds: number | null;
}

const EMPTY: RobotsRules = { disallow: [], allow: [], crawlDelaySeconds: null };

/**
 * robots.txt を解析して、自分の User-Agent に適用されるルールを返す。
 *
 * 自分向けの明示的なグループがあればそれを、無ければ `*` のグループを使う。
 * 両方あるときに自分向けだけを見るのは規格どおりで、`*` を混ぜてはいけない。
 */
export function parseRobots(text: string, userAgentToken: string): RobotsRules {
  const target = userAgentToken.toLowerCase();
  const groups = new Map<string, RobotsRules>();
  let currentAgents: string[] = [];
  let lastLineWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    if (line === "") {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      // 連続する User-Agent 行は同じグループを共有する。
      if (!lastLineWasAgent) {
        currentAgents = [];
      }
      currentAgents.push(value.toLowerCase());
      for (const agent of currentAgents) {
        if (!groups.has(agent)) {
          groups.set(agent, {
            disallow: [],
            allow: [],
            crawlDelaySeconds: null,
          });
        }
      }
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;

    for (const agent of currentAgents) {
      const rules = groups.get(agent);
      if (!rules) {
        continue;
      }
      if (field === "disallow") {
        rules.disallow.push(value);
      } else if (field === "allow") {
        rules.allow.push(value);
      } else if (field === "crawl-delay") {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) {
          rules.crawlDelaySeconds = parsed;
        }
      }
    }
  }

  return groups.get(target) ?? groups.get("*") ?? EMPTY;
}

/**
 * そのパスを取りにいってよいか。
 *
 * 規格どおり、最も長く一致したルールが勝つ。同じ長さなら Allow が勝つ
 * （相手が意図的に例外を書いているケースを尊重する）。
 */
export function isAllowed(rules: RobotsRules, pathname: string): boolean {
  let bestDisallow = -1;
  for (const rule of rules.disallow) {
    // 空の Disallow は「すべて許可」を意味する。無視してよい。
    if (rule === "") {
      continue;
    }
    if (pathname.startsWith(rule) && rule.length > bestDisallow) {
      bestDisallow = rule.length;
    }
  }
  if (bestDisallow < 0) {
    return true;
  }

  let bestAllow = -1;
  for (const rule of rules.allow) {
    if (rule !== "" && pathname.startsWith(rule) && rule.length > bestAllow) {
      bestAllow = rule.length;
    }
  }
  return bestAllow >= bestDisallow;
}

/** robots.txt が取れなかったときの扱い。 */
export function rulesForUnavailableRobots(status: number): RobotsRules {
  // 404 は「robots.txt が無い」＝制限なし。5xx や取得失敗は相手の都合が
  // 分からないので、この日は触らない側に倒す。
  if (status === 404 || status === 410) {
    return EMPTY;
  }
  return { disallow: ["/"], allow: [], crawlDelaySeconds: null };
}
