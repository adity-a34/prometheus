export type ScaleType = 'linear' | 'exponential';

// Calculates a default width of exponential histogram bucket ranges. If the last bucket is [0, 0],
// the width is calculated using the second to last bucket. returns error if the last bucket is [-0, 0],
export function calculateDefaultExpBucketWidth(
  last: [number, string, string, string],
  buckets: [number, string, string, string][]
): number {
  const lastLeft = parseFloat(last[1]);
  const lastRight = parseFloat(last[2]);

  // Handle Inf boundaries - use a reasonable default width
  if (!isFinite(lastLeft) || !isFinite(lastRight)) {
    // If we have other buckets, calculate from them
    if (buckets.length > 1) {
      const prevBucket = buckets[buckets.length - 2];
      const prevLeft = parseFloat(prevBucket[1]);
      const prevRight = parseFloat(prevBucket[2]);
      if (isFinite(prevLeft) && isFinite(prevRight) && prevLeft !== 0 && prevRight !== 0) {
        return Math.abs(safeLog(prevRight, prevRight < 0) - safeLog(prevLeft, prevLeft < 0));
      }
    }
    // Default reasonable width for Inf buckets
    return 1.0;
  }

  if (lastRight === 0 || lastLeft === 0) {
    if (buckets.length > 1) {
      const prevBucket = buckets[buckets.length - 2];
      const prevLeft = parseFloat(prevBucket[1]);
      const prevRight = parseFloat(prevBucket[2]);
      if (isFinite(prevLeft) && isFinite(prevRight) && prevLeft !== 0 && prevRight !== 0) {
        return Math.abs(safeLog(prevRight, prevRight < 0) - safeLog(prevLeft, prevLeft < 0));
      }
    } else {
      throw new Error('Only one bucket in histogram ([-0, 0]). Cannot calculate defaultExpBucketWidth.');
    }
  }

  return Math.abs(safeLog(lastRight, lastRight < 0) - safeLog(lastLeft, lastLeft < 0));
}

// Finds the lowest positive value from the bucket ranges
// Returns 0 if no positive values are found or if there are no buckets.
export function findMinPositive(buckets: [number, string, string, string][]) {
  if (!buckets || buckets.length === 0) {
    return 0; // no buckets
  }
  for (let i = 0; i < buckets.length; i++) {
    const right = parseFloat(buckets[i][2]);
    const left = parseFloat(buckets[i][1]);

    if (left > 0) {
      return left;
    }
    if (left < 0 && right > 0) {
      return right;
    }
    if (i === buckets.length - 1) {
      if (right > 0) {
        return right;
      }
    }
  }
  return 0; // all buckets are negative
}

// Finds the lowest negative value from the bucket ranges
// Returns 0 if no negative values are found or if there are no buckets.
export function findMaxNegative(buckets: [number, string, string, string][]) {
  if (!buckets || buckets.length === 0) {
    return 0; // no buckets
  }
  for (let i = 0; i < buckets.length; i++) {
    const right = parseFloat(buckets[i][2]);
    const left = parseFloat(buckets[i][1]);
    const prevRight = i > 0 ? parseFloat(buckets[i - 1][2]) : 0;

    if (right >= 0) {
      if (i === 0) {
        if (left < 0) {
          return left; // return the first negative bucket
        }
        return 0; // all buckets are positive
      }
      return prevRight; // return the last negative bucket
    }
  }
  console.log('findmaxneg returning: ', buckets[buckets.length - 1][2]);
  return parseFloat(buckets[buckets.length - 1][2]); // all buckets are negative
}

// Calculates the left position of the zero axis as a percentage string.
export function findZeroAxisLeft(
  scale: ScaleType,
  rangeMin: number,
  rangeMax: number,
  minPositive: number,
  maxNegative: number,
  zeroBucketIdx: number,
  widthNegative: number,
  widthTotal: number,
  expBucketWidth: number
): string {
  if (scale === 'linear') {
    return ((0 - rangeMin) / (rangeMax - rangeMin)) * 100 + '%';
  } else {
    if (maxNegative === 0) {
      return '0%';
    }
    if (minPositive === 0) {
      return '100%';
    }
    if (zeroBucketIdx === -1) {
      // if there is no zero bucket, we must zero axis between buckets around zero
      return (widthNegative / widthTotal) * 100 + '%';
    }
    if ((widthNegative + 0.5 * expBucketWidth) / widthTotal > 0) {
      return ((widthNegative + 0.5 * expBucketWidth) / widthTotal) * 100 + '%';
    } else {
      return '0%';
    }
  }
}

// Determines if the zero axis should be shown such that the zero label does not overlap with the range labels.
// The zero axis is shown if it is between 5% and 95% of the graph.
export function showZeroAxis(zeroAxisLeft: string) {
  const axisNumber = parseFloat(zeroAxisLeft.slice(0, -1));
  if (5 < axisNumber && axisNumber < 95) {
    return true;
  }
  return false;
}

// Finds the index of the bucket whose range includes zero
export function findZeroBucket(buckets: [number, string, string, string][]): number {
  for (let i = 0; i < buckets.length; i++) {
    const left = parseFloat(buckets[i][1]);
    const right = parseFloat(buckets[i][2]);
    if (left <= 0 && right >= 0) {
      return i;
    }
  }
  return -1;
}

// Validates histogram buckets for invalid boundaries
export function validateHistogramBuckets(buckets: [number, string, string, string][]): string | null {
  for (const bucket of buckets) {
    const left = parseFloat(bucket[1]);
    const right = parseFloat(bucket[2]);

    // Check for NaN boundaries
    if (isNaN(left) || isNaN(right)) {
      return 'Invalid histogram: bucket boundaries contain NaN';
    }

    // Check for invalid range (lower > upper, excluding -Inf/+Inf cases)
    if (!isFinite(left) && !isFinite(right)) {
      // Both are infinite - this is invalid unless it's the only bucket
      if (left === right) {
        continue; // [-Inf, -Inf] or [+Inf, +Inf] might be edge case
      }
    } else if (isFinite(left) && isFinite(right) && left > right) {
      return 'Invalid histogram: bucket boundaries are invalid (lower > upper)';
    }
  }
  return null;
}

// Classifies a bucket type for exponential rendering
export type BucketType =
  | 'normal'
  | 'zero-crossing'
  | 'inf-left'
  | 'inf-right'
  | 'zero-adjacent-left'
  | 'zero-adjacent-right'
  | 'invalid';

export function classifyBucket(left: number, right: number): BucketType {
  // Check for invalid bucket
  if (isNaN(left) || isNaN(right) || (isFinite(left) && isFinite(right) && left > right)) {
    return 'invalid';
  }

  // Check for zero-crossing bucket
  if (left < 0 && right > 0) {
    return 'zero-crossing';
  }

  // Check for -Inf boundary
  if (!isFinite(left) && left < 0) {
    return 'inf-left';
  }

  // Check for +Inf boundary
  if (!isFinite(right) && right > 0) {
    return 'inf-right';
  }

  // Check for zero-adjacent buckets
  if (left === 0 && right > 0) {
    return 'zero-adjacent-left';
  }
  if (left < 0 && right === 0) {
    return 'zero-adjacent-right';
  }

  return 'normal';
}

// Safely calculates log value, handling 0 and Inf cases
// For exponential view, this creates logarithmic spacing with symmetry around zero
export function safeLog(value: number, isNegative = false): number {
  if (value === 0) {
    // For zero, use a small positive value to avoid -Inf
    return Math.log(1e-10);
  }
  if (!isFinite(value)) {
    if (value > 0) {
      // +Inf: use a large value
      return 20; // log(1e8) ≈ 18.4, using 20 as reasonable upper bound
    } else {
      // -Inf: use a large negative value
      return -20;
    }
  }
  const absValue = Math.abs(value);
  const logValue = Math.log(absValue);

  // For exponential view, negative values should have NEGATIVE log position
  // This creates symmetry: -10 maps to -log(10), -1 maps to -log(1)=0
  // And positive values map to positive log: 1 maps to log(1)=0, 10 maps to log(10)
  // This ensures logarithmic spacing on both sides of zero
  if (isNegative && value < 0) {
    // For negative values in negative range: return -log(abs(value))
    // This puts -10 further left than -1 on exponential scale
    return -logValue;
  }

  return logValue;
}

// Calculates exponential bucket width, handling special cases
export function calculateExpBucketWidth(
  left: number,
  right: number,
  bucketType: BucketType,
  defaultExpBucketWidth: number,
  _buckets: [number, string, string, string][],
  _bucketIdx: number
): number {
  if (bucketType === 'invalid') {
    return 0;
  }

  if (bucketType === 'zero-crossing') {
    // Use reasonable width: min of absolute values converted to log scale
    const minAbs = Math.min(Math.abs(left), Math.abs(right));
    if (minAbs === 0) {
      return defaultExpBucketWidth;
    }
    // Calculate width based on the smaller absolute value
    // This gives a reasonable width without infinite log scale issues
    const logMinAbs = Math.log(minAbs);
    // Use a reasonable multiplier to make it visible
    return Math.max(defaultExpBucketWidth, Math.abs(logMinAbs) * 0.5);
  }

  if (bucketType === 'inf-left' || bucketType === 'inf-right') {
    // Use 1.5x the widest regular bucket or 10-15% of viewport (approximated as 1.5x default)
    return defaultExpBucketWidth * 1.5;
  }

  if (bucketType === 'zero-adjacent-left') {
    // For [0, x], treat 0 as small positive value
    const logRight = safeLog(right, false);
    const logLeft = safeLog(0, false); // Will use 1e-10 internally
    return Math.abs(logRight - logLeft);
  }

  if (bucketType === 'zero-adjacent-right') {
    // For [x, 0], treat 0 as small positive value
    const logRight = safeLog(0, false); // Will use 1e-10 internally
    const logLeft = safeLog(left, true);
    return Math.abs(logRight - logLeft);
  }

  // Normal bucket
  const logLeft = safeLog(left, left < 0);
  const logRight = safeLog(right, right < 0);
  const width = Math.abs(logRight - logLeft);
  return width === 0 ? defaultExpBucketWidth : width;
}

// Formats boundary value for x-axis labels, handling Inf
export function formatBoundary(value: number): string {
  if (!isFinite(value)) {
    if (value > 0) {
      return '+Inf';
    } else {
      return '-Inf';
    }
  }
  const formatter = Intl.NumberFormat('en', { notation: 'compact' });
  return formatter.format(value);
}
