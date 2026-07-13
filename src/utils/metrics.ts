export interface SystemMetrics {
  requestsTotal: number;
  errorsTotal: number;
  errors4xx: number;
  errors5xx: number;
  latencies: number[];
  startTime: number;
}

export const metrics: SystemMetrics = {
  requestsTotal: 0,
  errorsTotal: 0,
  errors4xx: 0,
  errors5xx: 0,
  latencies: [],
  startTime: Date.now()
};

export const getPercentile = (data: number[], percentile: number): number => {
  if (data.length === 0) return 0;
  const sorted = [...data].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return Math.round(sorted[index] * 100) / 100;
};
