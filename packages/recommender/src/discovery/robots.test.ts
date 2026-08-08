import { describe, expect, it } from "vitest";

import { isAllowed, parseRobots, rulesForUnavailableRobots } from "./robots";

const SAMPLE = `
# a comment
User-agent: *
Disallow: /private
Disallow: /tmp
Crawl-delay: 10

User-agent: KarakeepRecommender
Disallow: /nope
Allow: /nope/ok
`;

describe("parseRobots", () => {
  it("prefers the group addressed to us", () => {
    // 自分向けのグループがあれば * は混ぜない。規格どおり。
    const rules = parseRobots(SAMPLE, "karakeeprecommender");
    expect(rules.disallow).toEqual(["/nope"]);
    expect(rules.allow).toEqual(["/nope/ok"]);
  });

  it("falls back to the wildcard group", () => {
    const rules = parseRobots(SAMPLE, "someoneelse");
    expect(rules.disallow).toEqual(["/private", "/tmp"]);
    expect(rules.crawlDelaySeconds).toBe(10);
  });

  it("shares a group across consecutive user-agent lines", () => {
    const rules = parseRobots(
      `User-agent: a\nUser-agent: b\nDisallow: /x`,
      "b",
    );
    expect(rules.disallow).toEqual(["/x"]);
  });

  it("ignores comments and junk lines", () => {
    const rules = parseRobots(
      `# hi\nnot a directive\nUser-agent: *\nDisallow: /x`,
      "any",
    );
    expect(rules.disallow).toEqual(["/x"]);
  });

  it("returns empty rules for an empty file", () => {
    expect(parseRobots("", "any")).toEqual({
      disallow: [],
      allow: [],
      crawlDelaySeconds: null,
    });
  });
});

describe("isAllowed", () => {
  const rules = parseRobots(SAMPLE, "karakeeprecommender");

  it("blocks a disallowed prefix", () => {
    expect(isAllowed(rules, "/nope/page")).toBe(false);
  });

  it("honours a more specific allow", () => {
    expect(isAllowed(rules, "/nope/ok/page")).toBe(true);
  });

  it("allows anything not mentioned", () => {
    expect(isAllowed(rules, "/feed.xml")).toBe(true);
  });

  it("treats an empty Disallow as full permission", () => {
    expect(
      isAllowed(parseRobots("User-agent: *\nDisallow:", "any"), "/x"),
    ).toBe(true);
  });

  it("treats Disallow: / as a full block", () => {
    expect(
      isAllowed(parseRobots("User-agent: *\nDisallow: /", "any"), "/x"),
    ).toBe(false);
  });
});

describe("rulesForUnavailableRobots", () => {
  it("treats a missing robots.txt as unrestricted", () => {
    expect(isAllowed(rulesForUnavailableRobots(404), "/x")).toBe(true);
  });

  it("stays away when the server is unhealthy", () => {
    // 相手の都合が分からないときは許可ではなく拒否に倒す。
    expect(isAllowed(rulesForUnavailableRobots(503), "/x")).toBe(false);
    expect(isAllowed(rulesForUnavailableRobots(0), "/x")).toBe(false);
  });
});
