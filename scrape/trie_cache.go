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
	"sync"

	"github.com/prometheus/common/model"
	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/model/metadata"
	"github.com/prometheus/prometheus/storage"
)

// trieNode represents a node in the trie data structure.
type trieNode struct {
	children map[byte]*trieNode // Child nodes indexed by byte
	entry    *cacheEntry         // Non-nil only at terminal nodes for series
	iterPtr  *uint64             // For droppedSeries, pointer to iteration
	isEnd    bool                // Marks end of a key
}

// trieScrapeCache is a memory-efficient alternative to map-based scrapeCache.
// It uses a trie data structure to store metric strings, sharing common prefixes
// to reduce memory usage for targets with many similar metric names.
type trieScrapeCache struct {
	iter            uint64
	successfulCount int

	// Trie structures for string-keyed data
	seriesRoot        *trieNode // Replaces map[string]*cacheEntry
	droppedSeriesRoot *trieNode // Replaces map[string]*uint64

	// Keep hash-based maps as-is (no benefit from trie)
	seriesCur  map[storage.SeriesRef]*cacheEntry
	seriesPrev map[storage.SeriesRef]*cacheEntry

	metaMtx  sync.Mutex
	metadata map[string]*metaEntry // Could be optimized in future
	metrics  *scrapeMetrics

	// For concurrent access protection
	trieMtx sync.RWMutex
}

func newTrieNode() *trieNode {
	return &trieNode{
		children: make(map[byte]*trieNode),
	}
}

func newTrieScrapeCache(metrics *scrapeMetrics) *trieScrapeCache {
	return &trieScrapeCache{
		seriesRoot:        newTrieNode(),
		droppedSeriesRoot: newTrieNode(),
		seriesCur:         make(map[storage.SeriesRef]*cacheEntry),
		seriesPrev:        make(map[storage.SeriesRef]*cacheEntry),
		metadata:          make(map[string]*metaEntry),
		metrics:           metrics,
	}
}

// get retrieves a cache entry by metric string.
func (c *trieScrapeCache) get(met []byte) (*cacheEntry, bool, bool) {
	c.trieMtx.RLock()
	node := c.seriesRoot
	for _, b := range met {
		child, exists := node.children[b]
		if !exists {
			c.trieMtx.RUnlock()
			return nil, false, false
		}
		node = child
	}

	if !node.isEnd || node.entry == nil {
		c.trieMtx.RUnlock()
		return nil, false, false
	}

	// Check if already scraped in this iteration
	alreadyScraped := node.entry.lastIter == c.iter
	entry := node.entry
	c.trieMtx.RUnlock()
	
	// Update lastIter outside of lock (safe since we're only modifying a field of existing object)
	// This matches the map implementation which doesn't lock at all
	entry.lastIter = c.iter
	return entry, true, alreadyScraped
}

// getDropped checks if a metric string is in the dropped series cache.
func (c *trieScrapeCache) getDropped(met []byte) bool {
	c.trieMtx.RLock()
	node := c.droppedSeriesRoot
	for _, b := range met {
		child, exists := node.children[b]
		if !exists {
			c.trieMtx.RUnlock()
			return false
		}
		node = child
	}

	if !node.isEnd || node.iterPtr == nil {
		c.trieMtx.RUnlock()
		return false
	}

	iterPtr := node.iterPtr
	c.trieMtx.RUnlock()
	
	// Update iteration pointer outside of lock (safe since we're only modifying a field)
	*iterPtr = c.iter
	return true
}

// addRef adds or updates a series cache entry.
func (c *trieScrapeCache) addRef(met []byte, ref storage.SeriesRef, lset labels.Labels, hash uint64) *cacheEntry {
	if ref == 0 {
		return nil
	}

	c.trieMtx.Lock()
	defer c.trieMtx.Unlock()

	node := c.seriesRoot
	for _, b := range met {
		child, exists := node.children[b]
		if !exists {
			child = newTrieNode()
			node.children[b] = child
		}
		node = child
	}

	if node.entry == nil {
		node.entry = &cacheEntry{}
	}

	node.entry.ref = ref
	node.entry.lastIter = c.iter
	node.entry.hash = hash
	node.entry.lset = lset
	node.isEnd = true

	return node.entry
}

// addDropped adds a metric to the dropped series cache.
func (c *trieScrapeCache) addDropped(met []byte) {
	c.trieMtx.Lock()
	defer c.trieMtx.Unlock()

	node := c.droppedSeriesRoot
	for _, b := range met {
		child, exists := node.children[b]
		if !exists {
			child = newTrieNode()
			node.children[b] = child
		}
		node = child
	}

	if node.iterPtr == nil {
		iter := c.iter
		node.iterPtr = &iter
	} else {
		*node.iterPtr = c.iter
	}
	node.isEnd = true
}

// iterDone performs cleanup of old entries.
func (c *trieScrapeCache) iterDone(flushCache bool) {
	c.metaMtx.Lock()
	seriesCount := c.countTrieEntries(c.seriesRoot)
	droppedCount := c.countTrieEntries(c.droppedSeriesRoot)
	metadataCount := len(c.metadata)
	count := seriesCount + droppedCount + metadataCount
	c.metaMtx.Unlock()

	switch {
	case flushCache:
		c.successfulCount = count
	case count > c.successfulCount*2+1000:
		// If a target had varying labels in scrapes that ultimately failed,
		// the caches would grow indefinitely. Force a flush when this happens.
		flushCache = true
		if c.metrics != nil {
			c.metrics.targetScrapeCacheFlushForced.Inc()
		}
	}

	if flushCache {
		// All caches may grow over time through series churn
		// or multiple string representations of the same metric. Clean up entries
		// that haven't appeared in the last scrape.
		c.trieMtx.Lock()
		c.flushTrieEntries(c.seriesRoot, c.iter, true)
		c.flushTrieEntries(c.droppedSeriesRoot, c.iter, false)
		c.trieMtx.Unlock()

		c.metaMtx.Lock()
		for m, e := range c.metadata {
			// Keep metadata around for 10 scrapes after its metric disappeared.
			if c.iter-e.lastIter > 10 {
				delete(c.metadata, m)
			}
		}
		c.metaMtx.Unlock()
	} else {
		// Prune old entries (iter - lastIter > 2 for series, > 2 for dropped)
		c.trieMtx.Lock()
		c.pruneTrieEntries(c.seriesRoot, c.iter, true)
		c.pruneTrieEntries(c.droppedSeriesRoot, c.iter, false)
		c.trieMtx.Unlock()

		c.metaMtx.Lock()
		for m, e := range c.metadata {
			if c.iter-e.lastIter > 10 {
				delete(c.metadata, m)
			}
		}
		c.metaMtx.Unlock()
	}

	// Swap current and previous series then clear the new current, to save allocations.
	c.seriesPrev, c.seriesCur = c.seriesCur, c.seriesPrev
	clear(c.seriesCur)

	c.iter++
}

// countTrieEntries counts entries in trie (for metrics).
func (c *trieScrapeCache) countTrieEntries(node *trieNode) int {
	if node == nil {
		return 0
	}

	count := 0
	if node.isEnd {
		count = 1
	}

	for _, child := range node.children {
		count += c.countTrieEntries(child)
	}

	return count
}

// pruneTrieEntries prunes old entries from trie.
func (c *trieScrapeCache) pruneTrieEntries(node *trieNode, currentIter uint64, isSeries bool) {
	if node == nil {
		return
	}

	// Check if this node should be pruned
	if node.isEnd {
		if isSeries && node.entry != nil {
			if currentIter-node.entry.lastIter > 2 {
				node.entry = nil
				node.isEnd = false
			}
		} else if !isSeries && node.iterPtr != nil {
			if currentIter-*node.iterPtr > 2 {
				node.iterPtr = nil
				node.isEnd = false
			}
		}
	}

	// Recursively prune children
	for b, child := range node.children {
		c.pruneTrieEntries(child, currentIter, isSeries)
		// Remove child if it has no children and is not an end node
		if len(child.children) == 0 && !child.isEnd {
			delete(node.children, b)
		}
	}
}

// flushTrieEntries removes entries that weren't seen in the current iteration.
func (c *trieScrapeCache) flushTrieEntries(node *trieNode, currentIter uint64, isSeries bool) {
	if node == nil {
		return
	}

	// Check if this node should be flushed
	if node.isEnd {
		if isSeries && node.entry != nil {
			if currentIter != node.entry.lastIter {
				node.entry = nil
				node.isEnd = false
			}
		} else if !isSeries && node.iterPtr != nil {
			if currentIter != *node.iterPtr {
				node.iterPtr = nil
				node.isEnd = false
			}
		}
	}

	// Recursively flush children
	for b, child := range node.children {
		c.flushTrieEntries(child, currentIter, isSeries)
		// Remove child if it has no children and is not an end node
		if len(child.children) == 0 && !child.isEnd {
			delete(node.children, b)
		}
	}
}

// trackStaleness adds series to current tracking.
func (c *trieScrapeCache) trackStaleness(ref storage.SeriesRef, ce *cacheEntry) {
	c.seriesCur[ref] = ce
}

// forEachStale iterates over stale series.
func (c *trieScrapeCache) forEachStale(f func(storage.SeriesRef, labels.Labels) bool) {
	for ref, ce := range c.seriesPrev {
		if _, ok := c.seriesCur[ref]; !ok {
			if !f(ce.ref, ce.lset) {
				break
			}
		}
	}
}

// setType sets the type metadata for a metric family.
func (c *trieScrapeCache) setType(mfName []byte, t model.MetricType) ([]byte, *metaEntry) {
	c.metaMtx.Lock()
	defer c.metaMtx.Unlock()

	mfNameStr := yoloString(mfName)
	e, ok := c.metadata[mfNameStr]
	if !ok {
		e = &metaEntry{Metadata: metadata.Metadata{Type: model.MetricTypeUnknown}}
		c.metadata[mfNameStr] = e
	}
	if e.Type != t {
		e.Type = t
		e.lastIterChange = c.iter
	}
	e.lastIter = c.iter
	return mfName, e
}

// setHelp sets the help metadata for a metric family.
func (c *trieScrapeCache) setHelp(mfName, help []byte) ([]byte, *metaEntry) {
	c.metaMtx.Lock()
	defer c.metaMtx.Unlock()

	mfNameStr := yoloString(mfName)
	e, ok := c.metadata[mfNameStr]
	if !ok {
		e = &metaEntry{Metadata: metadata.Metadata{Type: model.MetricTypeUnknown}}
		c.metadata[mfNameStr] = e
	}
	if e.Help != string(help) {
		e.Help = string(help)
		e.lastIterChange = c.iter
	}
	e.lastIter = c.iter
	return mfName, e
}

// setUnit sets the unit metadata for a metric family.
func (c *trieScrapeCache) setUnit(mfName, unit []byte) ([]byte, *metaEntry) {
	c.metaMtx.Lock()
	defer c.metaMtx.Unlock()

	mfNameStr := yoloString(mfName)
	e, ok := c.metadata[mfNameStr]
	if !ok {
		e = &metaEntry{Metadata: metadata.Metadata{Type: model.MetricTypeUnknown}}
		c.metadata[mfNameStr] = e
	}
	if e.Unit != string(unit) {
		e.Unit = string(unit)
		e.lastIterChange = c.iter
	}
	e.lastIter = c.iter
	return mfName, e
}

// GetMetadata returns metadata given the metric family name.
func (c *trieScrapeCache) GetMetadata(mfName string) (MetricMetadata, bool) {
	c.metaMtx.Lock()
	defer c.metaMtx.Unlock()

	m, ok := c.metadata[mfName]
	if !ok {
		return MetricMetadata{}, false
	}
	return MetricMetadata{
		MetricFamily: mfName,
		Type:         m.Type,
		Help:         m.Help,
		Unit:         m.Unit,
	}, true
}

// ListMetadata lists metadata.
func (c *trieScrapeCache) ListMetadata() []MetricMetadata {
	c.metaMtx.Lock()
	defer c.metaMtx.Unlock()

	res := make([]MetricMetadata, 0, len(c.metadata))

	for m, e := range c.metadata {
		res = append(res, MetricMetadata{
			MetricFamily: m,
			Type:         e.Type,
			Help:         e.Help,
			Unit:         e.Unit,
		})
	}
	return res
}

// SizeMetadata returns the size of the metadata cache.
func (c *trieScrapeCache) SizeMetadata() (s int) {
	c.metaMtx.Lock()
	defer c.metaMtx.Unlock()
	for _, e := range c.metadata {
		s += e.size()
	}

	return s
}

// LengthMetadata returns the number of metadata entries in the cache.
func (c *trieScrapeCache) LengthMetadata() int {
	c.metaMtx.Lock()
	defer c.metaMtx.Unlock()

	return len(c.metadata)
}

// getIter returns the current scrape iteration.
func (c *trieScrapeCache) getIter() uint64 {
	return c.iter
}
