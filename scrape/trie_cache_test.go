// Copyright The Prometheus Authors
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package scrape

import (
	"fmt"
	"testing"

	"github.com/prometheus/common/model"
	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/storage"
	"github.com/stretchr/testify/require"
)

func TestTrieCacheBasicOperations(t *testing.T) {
	cache := newTrieScrapeCache(nil)

	// Test addRef and get
	met := []byte(`http_requests_total{method="GET"}`)
	entry := cache.addRef(met, 123, labels.Labels{}, 456)
	require.NotNil(t, entry)
	require.Equal(t, storage.SeriesRef(123), entry.ref)
	require.Equal(t, uint64(456), entry.hash)

	retrieved, ok, alreadyScraped := cache.get(met)
	require.True(t, ok)
	require.Equal(t, entry, retrieved)
	// When we add and then immediately get in the same iteration, alreadyScraped is true
	// because lastIter == c.iter
	require.True(t, alreadyScraped)

	// Test getDropped and addDropped
	droppedMet := []byte(`dropped_metric{label="value"}`)
	require.False(t, cache.getDropped(droppedMet))

	cache.addDropped(droppedMet)
	require.True(t, cache.getDropped(droppedMet))
}

func TestTrieCacheCleanup(t *testing.T) {
	cache := newTrieScrapeCache(nil)

	met1 := []byte(`metric1`)
	met2 := []byte(`metric2`)

	cache.addRef(met1, 1, labels.Labels{}, 1)
	cache.iter = 5
	cache.addRef(met2, 2, labels.Labels{}, 2)

	// After iterDone, met1 should be pruned (iter 0 vs current 5)
	cache.iterDone(false)

	_, ok, _ := cache.get(met1)
	require.False(t, ok, "Old entry should be pruned")

	_, ok, _ = cache.get(met2)
	require.True(t, ok, "Recent entry should remain")
}

func TestTrieCacheCommonPrefixes(t *testing.T) {
	cache := newTrieScrapeCache(nil)

	// Add metrics with common prefixes
	metrics := [][]byte{
		[]byte(`http_request_duration_seconds_bucket{le="0.05"}`),
		[]byte(`http_request_duration_seconds_bucket{le="0.1"}`),
		[]byte(`http_request_duration_seconds_bucket{le="0.2"}`),
		[]byte(`http_request_duration_seconds_bucket{le="0.5"}`),
	}

	for i, met := range metrics {
		// Use i+1 to avoid ref=0 which is treated as invalid
		cache.addRef(met, storage.SeriesRef(i+1), labels.Labels{}, uint64(i))
	}

	// Verify all can be retrieved immediately after adding
	for i, met := range metrics {
		entry, ok, _ := cache.get(met)
		require.True(t, ok, "Metric %d should be in cache", i)
		require.Equal(t, storage.SeriesRef(i+1), entry.ref)
	}
}

func TestTrieCacheMetadata(t *testing.T) {
	cache := newTrieScrapeCache(nil)

	mfName := []byte("test_metric")
	help := []byte("Test help")
	unit := []byte("seconds")

	// Set metadata
	_, meta1 := cache.setType(mfName, model.MetricTypeCounter)
	require.NotNil(t, meta1)
	require.Equal(t, model.MetricTypeCounter, meta1.Type)

	_, meta2 := cache.setHelp(mfName, help)
	require.NotNil(t, meta2)
	require.Equal(t, string(help), meta2.Help)

	_, meta3 := cache.setUnit(mfName, unit)
	require.NotNil(t, meta3)
	require.Equal(t, string(unit), meta3.Unit)

	// Get metadata
	md, ok := cache.GetMetadata("test_metric")
	require.True(t, ok)
	require.Equal(t, model.MetricTypeCounter, md.Type)
	require.Equal(t, string(help), md.Help)
	require.Equal(t, string(unit), md.Unit)

	// List metadata
	list := cache.ListMetadata()
	require.Len(t, list, 1)
	require.Equal(t, "test_metric", list[0].MetricFamily)
}

func TestTrieCacheStaleness(t *testing.T) {
	cache := newTrieScrapeCache(nil)

	met1 := []byte(`metric1`)
	met2 := []byte(`metric2`)

	entry1 := cache.addRef(met1, 1, labels.FromStrings("__name__", "metric1"), 1)
	entry2 := cache.addRef(met2, 2, labels.FromStrings("__name__", "metric2"), 2)

	// Track staleness
	cache.trackStaleness(1, entry1)
	cache.trackStaleness(2, entry2)

	// Move to next iteration (this swaps seriesCur and seriesPrev)
	cache.iterDone(false)

	// Now add entry1 again to current, but not entry2
	cache.trackStaleness(1, entry1)

	// Check for stale entries
	staleCount := 0
	cache.forEachStale(func(ref storage.SeriesRef, lset labels.Labels) bool {
		staleCount++
		require.Equal(t, storage.SeriesRef(2), ref)
		return true
	})
	require.Equal(t, 1, staleCount)
}

func TestTrieCacheFlush(t *testing.T) {
	cache := newTrieScrapeCache(nil)

	met1 := []byte(`metric1`)
	met2 := []byte(`metric2`)

	cache.addRef(met1, 1, labels.Labels{}, 1)
	cache.addRef(met2, 2, labels.Labels{}, 2)
	cache.addDropped([]byte(`dropped1`))

	// Move to next iteration so entries have lastIter != c.iter
	cache.iterDone(false) // Now c.iter = 1, entries have lastIter = 0

	// Flush cache - removes entries where lastIter != c.iter (i.e., lastIter == 0)
	cache.iterDone(true)

	// All entries should be gone after flush since they weren't seen in iteration 1
	_, ok, _ := cache.get(met1)
	require.False(t, ok, "Entry should be flushed")
	_, ok, _ = cache.get(met2)
	require.False(t, ok, "Entry should be flushed")
	require.False(t, cache.getDropped([]byte(`dropped1`)), "Dropped entry should be flushed")
}

func TestTrieCacheAlreadyScraped(t *testing.T) {
	cache := newTrieScrapeCache(nil)

	met := []byte(`metric1`)
	cache.addRef(met, 1, labels.Labels{}, 1)

	// First get after addRef - already scraped because lastIter was set to c.iter in addRef
	_, ok, alreadyScraped := cache.get(met)
	require.True(t, ok)
	require.True(t, alreadyScraped, "First get after addRef should show alreadyScraped=true")

	// Second get in same iteration - still already scraped
	_, ok, alreadyScraped = cache.get(met)
	require.True(t, ok)
	require.True(t, alreadyScraped)
}

func TestTrieCacheIteration(t *testing.T) {
	cache := newTrieScrapeCache(nil)

	require.Equal(t, uint64(0), cache.getIter())

	cache.iterDone(false)
	require.Equal(t, uint64(1), cache.getIter())

	cache.iterDone(false)
	require.Equal(t, uint64(2), cache.getIter())
}

// Benchmark comparison
func BenchmarkMapCache(b *testing.B) {
	cache := newScrapeCache(nil, false) // map-based
	benchmarkCache(b, cache)
}

func BenchmarkTrieCache(b *testing.B) {
	cache := newScrapeCache(nil, true) // trie-based
	benchmarkCache(b, cache)
}

func benchmarkCache(b *testing.B, cache scrapeCache) {
	metrics := generateTestMetrics(1000)

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		met := metrics[i%len(metrics)]
		// Use i+1 to avoid ref=0 which is treated as invalid
		cache.addRef(met, storage.SeriesRef(i+1), labels.Labels{}, uint64(i))
		cache.get(met)
	}
}

func generateTestMetrics(n int) [][]byte {
	// Generate realistic metric names with common prefixes
	metrics := make([][]byte, n)
	for i := 0; i < n; i++ {
		metrics[i] = []byte(fmt.Sprintf(
			`http_request_duration_seconds_bucket{method="GET",path="/api/v1/query",le="%d.%d"}`,
			i/10, i%10,
		))
	}
	return metrics
}
