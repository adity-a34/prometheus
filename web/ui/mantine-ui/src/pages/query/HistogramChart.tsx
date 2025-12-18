import React, { FC, useMemo } from "react";
import { Histogram } from "../../types/types";
import {
  detectHistogramSchema,
  extractNHCBBuckets,
  calculateDefaultExpBucketWidth,
  findMinPositive,
  findMaxNegative,
  findZeroAxisLeft,
  showZeroAxis,
  findZeroBucket,
  bucketRangeString,
  validateHistogramBuckets,
  classifyBucket,
  calculateExpBucketWidth,
  safeLog,
  formatBoundary,
} from "./HistogramHelpers";
import classes from "./HistogramChart.module.css";
import { Tooltip, Alert } from "@mantine/core";

interface HistogramChartProps {
  histogram: Histogram;
  index: number;
  scale: string;
}

const HistogramChart: FC<HistogramChartProps> = ({
  index,
  histogram,
  scale,
}) => {
  interface NativeHistogram extends Histogram {
    schema?: number;
    positiveBuckets?: unknown;
    negativeBuckets?: unknown;
  }
  
  const histogramSchema = useMemo(() => 
    detectHistogramSchema(histogram as NativeHistogram), [histogram]);
  const { processedBuckets, extractionError } = useMemo(() => {
    try {
      if (histogramSchema.type === "nhcb") {
        return { processedBuckets: extractNHCBBuckets(histogram as NativeHistogram), extractionError: null };
      }
      return { processedBuckets: histogram.buckets || [], extractionError: null };
    } catch (e) {
      return { processedBuckets: [], extractionError: (e as Error).message };
    }
  }, [histogram, histogramSchema]);

  if (extractionError) {
    return (
      <Alert color="red" title="Invalid Histogram" mt="sm">
        {extractionError}
      </Alert>
    );
  }

  if (!processedBuckets || processedBuckets.length === 0) {
    return <Alert color="gray">No data</Alert>;
  }

  const buckets = processedBuckets;

  // Validate histogram buckets
  const validationError = validateHistogramBuckets(buckets);
  if (validationError) {
    return (
      <Alert color="red" title="Invalid Histogram" mt="sm">
        {validationError}
      </Alert>
    );
  }

  const formatter = Intl.NumberFormat("en", { notation: "compact" });

  // For linear scales, the count of a histogram bucket is represented by its area rather than its height. This means it considers
  // both the count and the range (width) of the bucket. For this, we can set the height of the bucket proportional
  // to its frequency density (fd). The fd is the count of the bucket divided by the width of the bucket.
  const fds = [];
  for (const bucket of buckets) {
    const left = parseFloat(bucket[1]);
    const right = parseFloat(bucket[2]);
    const count = parseFloat(bucket[3]);
    const width = right - left;

    // This happens when a user want observations of precisely zero to be included in the zero bucket
    if (width === 0) {
      fds.push(0);
      continue;
    }
    fds.push(count / width);
  }
  const fdMax = Math.max(...fds);

  const first = buckets[0];
  const last = buckets[buckets.length - 1];

  const rangeMax = parseFloat(last[2]);
  const rangeMin = parseFloat(first[1]);
  const countMax = Math.max(...buckets.map((b) => parseFloat(b[3])));

  const defaultExpBucketWidth = calculateDefaultExpBucketWidth(last, buckets);

  const maxPositive = rangeMax > 0 ? rangeMax : 0;
  const minPositive = findMinPositive(buckets);
  const maxNegative = findMaxNegative(buckets);
  const minNegative = parseFloat(first[1]) < 0 ? parseFloat(first[1]) : 0;

  // Calculate the borders of positive and negative buckets in the exponential scale from left to right
  // Use safeLog to handle 0 and Inf cases
  const startNegative = minNegative !== 0 ? safeLog(minNegative, true) : 0;
  const endNegative = maxNegative !== 0 ? safeLog(maxNegative, true) : 0;
  const startPositive = minPositive !== 0 ? safeLog(minPositive, false) : 0;
  const endPositive = maxPositive !== 0 ? safeLog(maxPositive, false) : 0;

  // Calculate the width of negative, positive, and all exponential bucket ranges on the x-axis
  const xWidthNegative = endNegative - startNegative;
  const xWidthPositive = endPositive - startPositive;
  const xWidthTotal = xWidthNegative + defaultExpBucketWidth + xWidthPositive;

  const zeroBucketIdx = findZeroBucket(buckets);
  const zeroAxisLeft = findZeroAxisLeft(
    scale,
    rangeMin,
    rangeMax,
    minPositive,
    maxNegative,
    zeroBucketIdx,
    xWidthNegative,
    xWidthTotal,
    defaultExpBucketWidth,
  );
  const zeroAxis = showZeroAxis(zeroAxisLeft);

  return (
    <div className={classes.histogramYWrapper}>
      {histogramSchema.type === "nhcb" && scale === "exponential" && (
        <div
          style={{
            padding: "8px 12px",
            backgroundColor: "#fff3cd",
            border: "1px solid #ffc107",
            borderRadius: "4px",
            marginBottom: "8px",
            fontSize: "14px",
          }}
        >
          ℹ️ Custom bucket histogram (NHCB). Linear scale is recommended for accurate visualization.
        </div>
      )}
      <div className={classes.histogramYLabels}>
        {[1, 0.75, 0.5, 0.25].map((i) => (
          <div key={i} className={classes.histogramYLabel}>
            {scale === "linear" ? "" : formatter.format(countMax * i)}
          </div>
        ))}
        <div key={0} className={classes.histogramYLabel} style={{ height: 0 }}>
          0
        </div>
      </div>
      <div className={classes.histogramXWrapper}>
        <div className={classes.histogramContainer}>
          {[0, 0.25, 0.5, 0.75, 1].map((i) => (
            <React.Fragment key={i}>
              <div
                className={classes.histogramYGrid}
                style={{ bottom: i * 100 + "%" }}
              ></div>
              <div
                className={classes.histogramYTick}
                style={{ bottom: i * 100 + "%" }}
              ></div>
              <div
                className={classes.histogramXGrid}
                style={{ left: i * 100 + "%" }}
              ></div>
            </React.Fragment>
          ))}
          <div className={classes.histogramXTick} style={{ left: "0%" }}></div>
          <div
            className={classes.histogramXTick}
            style={{ left: zeroAxisLeft }}
          ></div>
          <div
            className={classes.histogramXGrid}
            style={{ left: zeroAxisLeft }}
          ></div>
          <div
            className={classes.histogramXTick}
            style={{ left: "100%" }}
          ></div>

          <RenderHistogramBars
            buckets={buckets}
            scale={scale}
            rangeMin={rangeMin}
            rangeMax={rangeMax}
            index={index}
            fds={fds}
            fdMax={fdMax}
            countMax={countMax}
            defaultExpBucketWidth={defaultExpBucketWidth}
            minPositive={minPositive}
            maxNegative={maxNegative}
            startPositive={startPositive}
            startNegative={startNegative}
            xWidthNegative={xWidthNegative}
            xWidthTotal={xWidthTotal}
          />

          <div className={classes.histogramAxes}></div>
        </div>
        <div className={classes.histogramXLabels}>
          <div className={classes.histogramXLabel}>
            <React.Fragment>
              <div style={{ position: "absolute", left: 0 }}>
                {formatBoundary(rangeMin)}
              </div>
              {rangeMin < 0 && zeroAxis && (
                <div style={{ position: "absolute", left: zeroAxisLeft }}>
                  0
                </div>
              )}
              <div style={{ position: "absolute", right: 0 }}>
                {formatBoundary(rangeMax)}
              </div>
            </React.Fragment>
          </div>
        </div>
      </div>
    </div>
  );
};

interface RenderHistogramProps {
  buckets: [number, string, string, string][];
  scale: string;
  rangeMin: number;
  rangeMax: number;
  index: number;
  fds: number[];
  fdMax: number;
  countMax: number;
  defaultExpBucketWidth: number;
  minPositive: number;
  maxNegative: number;
  startPositive: number;
  startNegative: number;
  xWidthNegative: number;
  xWidthTotal: number;
}

const RenderHistogramBars: FC<RenderHistogramProps> = ({
  buckets,
  scale,
  rangeMin,
  rangeMax,
  index,
  fds,
  fdMax,
  countMax,
  defaultExpBucketWidth,
  minPositive,
  maxNegative,
  startPositive,
  startNegative,
  xWidthNegative,
  xWidthTotal,
}) => {
  return (
    <React.Fragment>
      {buckets.map((b, bIdx) => {
        const left = parseFloat(b[1]);
        const right = parseFloat(b[2]);
        const count = parseFloat(b[3]);
        const bucketIdx = `bucket-${index}-${bIdx}-${Math.ceil(parseFloat(b[3]) * 100)}`;

        let bucketWidth = "";
        let bucketLeft = "";
        let bucketHeight = "";

        switch (scale) {
          case "linear": {
            bucketWidth = ((right - left) / (rangeMax - rangeMin)) * 100 + "%";
            bucketLeft =
              ((left - rangeMin) / (rangeMax - rangeMin)) * 100 + "%";
            if (left === 0 && right === 0) {
              bucketLeft = "0%"; // do not render zero-width zero bucket
              bucketWidth = "0%";
            }
            bucketHeight = (fds[bIdx] / fdMax) * 100 + "%";
            break;
          }
          case "exponential": {
            // Classify using ORIGINAL boundaries before clamping
            const bucketType = classifyBucket(left, right);

            // Clamp bucket boundaries to visible range for positioning calculations
            const clampedLeft = Math.max(left, rangeMin);
            const clampedRight = Math.min(right, rangeMax);

            // Skip buckets completely outside the visible range AFTER clamping
            if (clampedLeft >= clampedRight) {
              bucketLeft = '0%';
              bucketWidth = '0%';
              bucketHeight = '0%';
              break;
            }

            // Skip invalid buckets
            if (bucketType === 'invalid') {
              bucketLeft = '0%';
              bucketWidth = '0%';
              bucketHeight = '0%';
              break;
            }

            // Calculate exponential width using helper function (use original boundaries for width)
            const expBucketWidth = calculateExpBucketWidth(left, right, bucketType, defaultExpBucketWidth, buckets, bIdx);

            let adjust = 0; // if buckets are all positive/negative, we need to remove the width of the zero bucket
            if (minPositive === 0 || maxNegative === 0) {
              adjust = defaultExpBucketWidth;
            }

            bucketWidth = (expBucketWidth / (xWidthTotal - adjust)) * 100 + "%";

            // Calculate bucket position based on type
            if (bucketType === 'zero-crossing') {
              // Zero-crossing bucket: position at zero axis
              bucketLeft = (xWidthNegative / xWidthTotal) * 100 + "%";
            } else if (bucketType === 'inf-left') {
              // -Inf boundary: position at far left (0%)
              bucketLeft = "0%";
            } else if (bucketType === 'inf-right') {
              // +Inf boundary: position at far right
              bucketLeft = ((xWidthTotal - expBucketWidth - adjust) / (xWidthTotal - adjust)) * 100 + "%";
            } else if (bucketType === 'zero-adjacent-left') {
              // [0, x]: Position at zero axis boundary (after negative range + zero bucket spacer)
              bucketLeft = ((xWidthNegative + defaultExpBucketWidth) / (xWidthTotal - adjust)) * 100 + "%";
            } else if (bucketType === 'zero-adjacent-right') {
              // [x, 0]: position such that bucket ends at zero axis
              // Position = (xWidthNegative - expBucketWidth) / xWidthTotal
              bucketLeft = ((xWidthNegative - expBucketWidth) / (xWidthTotal - adjust)) * 100 + "%";
            } else if (clampedLeft < 0) {
              // Regular negative bucket
              // Calculate position within negative range first, then map to total range
              const logLeft = safeLog(clampedLeft, true);

              // Position within [0, 1] in the negative range
              const negativeRangePosition = (logLeft - startNegative) / xWidthNegative;

              // Map to percentage of total range
              bucketLeft = (negativeRangePosition * (xWidthNegative / (xWidthTotal - adjust))) * 100 + "%";
            } else {
              // Regular positive bucket
              // Total position = (negative range) + (zero bucket) + (offset within positive range)
              const logLeft = safeLog(clampedLeft, false);
              const positiveOffset = logLeft - startPositive;

              bucketLeft =
                ((xWidthNegative + defaultExpBucketWidth + positiveOffset - adjust) / (xWidthTotal - adjust)) * 100 +
                "%";
            }

            if (left === 0 && right === 0) {
              // do not render zero width zero bucket
              bucketLeft = "0%";
              bucketWidth = "0%";
            }

            // Clamp bucket position to ensure it stays within 0-100%
            const leftPercent = parseFloat(bucketLeft);
            if (leftPercent < 0) {
              bucketLeft = "0%";
            } else if (leftPercent > 100) {
              bucketLeft = "100%";
            }

            bucketHeight = (count / countMax) * 100 + "%";
            break;
          }
          default:
            throw new Error("Invalid scale");
        }

        return (
          <Tooltip label={`range: ${bucketRangeString(b)}`} key={bIdx}>
            <div
              id={bucketIdx}
              className={classes.histogramBucketSlot}
              style={{
                left: bucketLeft,
                width: bucketWidth,
              }}
            >
              <div
                id={bucketIdx}
                className={classes.histogramBucket}
                style={{
                  height: bucketHeight,
                }}
              ></div>
            </div>
          </Tooltip>
        );
      })}
    </React.Fragment>
  );
};

export default HistogramChart;
