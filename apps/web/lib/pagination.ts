export interface Page<T> {
  /** 総ページ数。要素が 0 でも 1 を返す（「空の 1 ページ目」）。 */
  pageCount: number;
  /** 範囲に収めたあとのページ番号（0 始まり）。 */
  currentPage: number;
  /** `currentPage` の先頭要素の添字。表示の「1–10 / 30」に使う。 */
  pageStart: number;
  items: T[];
}

/**
 * クライアント側のページ送り。
 *
 * **要求されたページが範囲外なら最後のページに寄せる。** 読んでいる最中に
 * 元の配列が短くなると（Briefing なら rank の再実行）、そのままでは空の
 * ページに取り残されて「壊れた」ように見える。
 */
export function paginate<T>(
  items: T[],
  pageSize: number,
  page: number,
): Page<T> {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const pageStart = currentPage * pageSize;
  return {
    pageCount,
    currentPage,
    pageStart,
    items: items.slice(pageStart, pageStart + pageSize),
  };
}
