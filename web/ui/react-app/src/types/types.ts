import { Alert, RuleState } from '../pages/alerts/AlertContents';

export interface Metric {
  [key: string]: string;
}

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

export interface Exemplar {
  labels: { [key: string]: string };
  value: string;
  timestamp: number;
}

export interface QueryParams {
  startTime: number;
  endTime: number;
  resolution: number;
}

export type Rule = {
  alerts: Alert[];
  annotations: Record<string, string>;
  duration: number;
  keepFiringFor: number;
  evaluationTime: string;
  health: string;
  labels: Record<string, string>;
  lastError?: string;
  lastEvaluation: string;
  name: string;
  query: string;
  state: RuleState;
  type: string;
};

export interface WALReplayData {
  min: number;
  max: number;
  current: number;
}

export interface WALReplayStatus {
  data?: WALReplayData;
}

export type ExemplarData = Array<{ seriesLabels: Metric; exemplars: Exemplar[] }> | undefined;
