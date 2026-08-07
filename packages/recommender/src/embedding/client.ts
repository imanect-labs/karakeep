import type { EmbeddingClient } from "@karakeep/shared/embedding";

import { l2Normalize, truncateMRL } from "../vector";
import type { DocumentForEmbedding } from "./format";
import { formatDocumentForEmbedding } from "./format";

export interface EmbeddedDocument {
  /** 常に L2 正規化済み。ランキング時のコサインを内積に落とすため。 */
  vector: Float32Array;
  modelId: string;
  /** モデルへ実際に渡した文字列。デバッグと再現のために持つ。 */
  input: string;
}

export interface EmbedOptions {
  /**
   * MRL による切り詰め先の次元。省略するとモデルの素の次元をそのまま使う。
   * 切ったあとの再正規化は truncateMRL がやる。
   */
  dimensions?: number;
}

/**
 * 文書をまとめて埋め込む。整形できなかった文書（タイトルも要約も本文も無い）
 * は null を返し、入力と同じ順序・同じ長さの配列になる。呼び出し側で
 * `zip` し直す必要はない。
 */
export async function embedDocuments(
  client: EmbeddingClient,
  docs: DocumentForEmbedding[],
  opts: EmbedOptions = {},
): Promise<(EmbeddedDocument | null)[]> {
  const results: (EmbeddedDocument | null)[] = Array.from(
    { length: docs.length },
    () => null,
  );

  const inputs: string[] = [];
  const positions: number[] = [];
  docs.forEach((doc, i) => {
    const formatted = formatDocumentForEmbedding(doc);
    if (formatted !== null) {
      inputs.push(formatted);
      positions.push(i);
    }
  });

  if (inputs.length === 0) {
    return results;
  }

  const response = await client.generateEmbeddingFromText(inputs);
  if (response.embeddings.length !== inputs.length) {
    throw new Error(
      `Embedding provider returned ${response.embeddings.length} vectors for ${inputs.length} inputs`,
    );
  }

  response.embeddings.forEach((raw, i) => {
    const vector = opts.dimensions
      ? truncateMRL(Float32Array.from(raw), opts.dimensions)
      : l2Normalize(raw);
    results[positions[i]] = {
      vector,
      modelId: client.modelId,
      input: inputs[i],
    };
  });

  return results;
}
