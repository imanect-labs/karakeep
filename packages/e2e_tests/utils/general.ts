export async function waitUntil(
  f: () => Promise<boolean>,
  description: string,
  // 19 個のテストファイルが 1 つのコンテナを共有して並列に走るので、
  // ワーカーの処理待ち時間は他ファイルの負荷次第で大きく振れる。
  // 4 コアの CI ランナーでは 60 秒に収まらないことがあり
  // （実測: 15 件のインポートが 68 秒）、処理自体は成功しているのに
  // タイムアウトで落ちていた。vitest.config.ts の testTimeout と揃えること。
  timeoutMs = 120000,
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    console.log(`Waiting for ${description}...`);
    try {
      const res = await f();
      if (res) {
        console.log(`${description}: success`);
        return;
      }
    } catch (error) {
      // Ignore errors and retry
      console.log(`${description}: error, retrying...: ${error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`${description}: timeout after ${timeoutMs}ms`);
}
