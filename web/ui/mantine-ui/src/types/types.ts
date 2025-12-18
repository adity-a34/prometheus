export interface Span {
  offset: number;
  length: number;
}

export interface Histogram {
  count: string | number;
  sum: string | number;
  buckets?: [number, string, string, string][];
  // Optional NHCB/custom bucket fields (schema -53)
  schema?: number;
  customValues?: number[];
  positiveBuckets?: number[];
  negativeBuckets?: number[];
  positiveSpans?: Span[];
  negativeSpans?: Span[];
  zeroThreshold?: number;
  zeroCount?: number;
}
