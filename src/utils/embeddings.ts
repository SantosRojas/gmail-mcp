import type { FeatureExtractionPipeline } from '@xenova/transformers';
import { DEFAULT_SEMANTIC_MODEL } from './semantic.js';

type EmbedFn = (texts: string[]) => Promise<number[][]>;

let extractor: FeatureExtractionPipeline | null = null;
let modelId = DEFAULT_SEMANTIC_MODEL;
let testOverride: EmbedFn | null = null;

/** Test seam: replaces the real model with a stub. Never used in production paths. */
export function setTestEmbedder(fn: EmbedFn | null): void {
  testOverride = fn;
}

async function loadExtractor(id: string): Promise<FeatureExtractionPipeline> {
  if (!extractor || modelId !== id) {
    // Lazy import: keeps MCP startup fast (avoids loading transformers/onnx
    // on every `node dist/index.js` spawn; only paid on first semantic search).
    const { pipeline } = await import('@xenova/transformers');
    extractor = (await pipeline('feature-extraction', id)) as FeatureExtractionPipeline;
    modelId = id;
  }
  return extractor;
}

export async function embedTexts(texts: string[], model: string = DEFAULT_SEMANTIC_MODEL): Promise<number[][]> {
  if (testOverride) return testOverride(texts);
  const active = await loadExtractor(model);
  const vectors: number[][] = [];
  for (const text of texts) {
    const output = await active(text.slice(0, 512), { pooling: 'mean', normalize: true });
    vectors.push(Array.from(output.data as Float32Array));
  }
  return vectors;
}
