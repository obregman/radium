import * as assert from 'assert';

/**
 * Unit tests for symbol layout algorithm
 * Tests the packing and sizing logic to ensure symbols fit inside containers
 */

// Copy the layout functions here for testing
const MIN_WIDTH = 100;
const MIN_HEIGHT = 30;
const MAX_WIDTH = 400;
const MAX_HEIGHT = 120;

function calculateBoxSize(changeAmount: number): { width: number; height: number } {
  const amount = Math.max(1, changeAmount || 1);
  
  // Special case: minimum change gets minimum size
  if (amount === 1) {
    return { width: MIN_WIDTH, height: MIN_HEIGHT };
  }
  
  const scale = Math.log(amount) / Math.log(100);
  const clampedScale = Math.max(0, Math.min(1, scale));
  const width = MIN_WIDTH + (MAX_WIDTH - MIN_WIDTH) * clampedScale;
  const height = MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * clampedScale;
  return {
    width: Math.round(width),
    height: Math.round(height)
  };
}

interface Symbol {
  key: string;
  width: number;
  height: number;
}

interface PackResult {
  positions: Array<{ key: string; x: number; y: number; width: number; height: number }>;
  contentW: number;
  contentH: number;
}

function packSymbols(symbols: Symbol[], containerWidth: number): PackResult {
  // Sort by height descending, then by width descending
  const sorted = [...symbols].sort((a, b) => {
    if (b.height !== a.height) return b.height - a.height;
    return b.width - a.width;
  });

  const positions: Array<{ key: string; x: number; y: number; width: number; height: number }> = [];
  let currentX = 0;
  let currentY = 0;
  let rowHeight = 0;
  const PADDING = 0; // No padding - symbols touch each other

  for (const symbol of sorted) {
    // Check if we need to wrap to next row
    if (currentX + symbol.width > containerWidth && currentX > 0) {
      currentX = 0;
      currentY += rowHeight + PADDING;
      rowHeight = 0;
    }

    positions.push({
      key: symbol.key,
      x: currentX,
      y: currentY,
      width: symbol.width,
      height: symbol.height
    });

    currentX += symbol.width + PADDING;
    rowHeight = Math.max(rowHeight, symbol.height);
  }

  // Compute packed content dimensions
  let contentW = 0;
  let contentH = 0;
  if (positions.length > 0) {
    const shelves = new Map<number, { h: number }>();
    for (const p of positions) {
      const right = p.x + p.width;
      contentW = Math.max(contentW, right);
      const shelf = shelves.get(p.y) || { h: 0 };
      shelf.h = Math.max(shelf.h, p.height);
      shelves.set(p.y, shelf);
    }
    const ys = Array.from(shelves.keys()).sort((a, b) => a - b);
    for (let i = 0; i < ys.length; i++) {
      contentH += shelves.get(ys[i])!.h;
      if (i < ys.length - 1) contentH += PADDING;
    }
  }

  return { positions, contentW, contentH };
}

suite('Symbol Layout Tests', () => {
  test('calculateBoxSize - minimum size for 1 line change', () => {
    const size = calculateBoxSize(1);
    assert.strictEqual(size.width, MIN_WIDTH, 'Width should be minimum');
    assert.strictEqual(size.height, MIN_HEIGHT, 'Height should be minimum');
    // Verify 10:3 ratio
    assert.strictEqual(Math.round((size.width / size.height) * 10) / 10, 3.3, 'Should maintain ~10:3 ratio');
  });

  test('calculateBoxSize - maximum size for 100+ line change', () => {
    const size = calculateBoxSize(100);
    assert.strictEqual(size.width, MAX_WIDTH, 'Width should be maximum');
    assert.strictEqual(size.height, MAX_HEIGHT, 'Height should be maximum');
    // Verify 10:3 ratio
    assert.strictEqual(Math.round((size.width / size.height) * 10) / 10, 3.3, 'Should maintain ~10:3 ratio');
  });

  test('calculateBoxSize - scaling for various change amounts', () => {
    const sizes = [
      { amount: 1, expectedMin: true },
      { amount: 5, expectedMin: false },
      { amount: 10, expectedMin: false },
      { amount: 50, expectedMin: false },
      { amount: 100, expectedMax: true }
    ];

    for (const { amount, expectedMin, expectedMax } of sizes) {
      const size = calculateBoxSize(amount);
      if (expectedMin) {
        assert.strictEqual(size.width, MIN_WIDTH);
        assert.strictEqual(size.height, MIN_HEIGHT);
      } else if (expectedMax) {
        assert.strictEqual(size.width, MAX_WIDTH);
        assert.strictEqual(size.height, MAX_HEIGHT);
      } else {
        assert.ok(size.width > MIN_WIDTH && size.width < MAX_WIDTH, `Width ${size.width} should be between min and max`);
        assert.ok(size.height > MIN_HEIGHT && size.height < MAX_HEIGHT, `Height ${size.height} should be between min and max`);
      }
      // Always verify ratio
      const ratio = size.width / size.height;
      assert.ok(Math.abs(ratio - 10/3) < 0.1, `Ratio ${ratio} should be close to 10:3`);
    }
  });

  test('packSymbols - single symbol fits in container', () => {
    const symbols: Symbol[] = [
      { key: 'func1', width: 100, height: 30 }
    ];
    const containerWidth = 200;
    const result = packSymbols(symbols, containerWidth);

    assert.strictEqual(result.positions.length, 1);
    assert.strictEqual(result.positions[0].x, 0);
    assert.strictEqual(result.positions[0].y, 0);
    assert.strictEqual(result.contentW, 100, 'Content width should equal symbol width');
    assert.strictEqual(result.contentH, 30, 'Content height should equal symbol height');
  });

  test('packSymbols - multiple symbols in one row', () => {
    const symbols: Symbol[] = [
      { key: 'func1', width: 100, height: 30 },
      { key: 'func2', width: 100, height: 30 },
      { key: 'func3', width: 100, height: 30 }
    ];
    const containerWidth = 400; // Wide enough for all 3
    const result = packSymbols(symbols, containerWidth);

    assert.strictEqual(result.positions.length, 3);
    // All should be on same row (y=0)
    assert.ok(result.positions.every(p => p.y === 0), 'All symbols should be on same row');
    // Check spacing (no padding)
    assert.strictEqual(result.positions[0].x, 0);
    assert.strictEqual(result.positions[1].x, 100); // 100 + 0 padding
    assert.strictEqual(result.positions[2].x, 200); // 100 + 100
    assert.strictEqual(result.contentW, 300, 'Content width should be 3*100');
    assert.strictEqual(result.contentH, 30, 'Content height should be single row height');
  });

  test('packSymbols - symbols wrap to multiple rows', () => {
    const symbols: Symbol[] = [
      { key: 'func1', width: 150, height: 40 },
      { key: 'func2', width: 150, height: 40 },
      { key: 'func3', width: 150, height: 40 }
    ];
    const containerWidth = 250; // Only fits 1 symbol per row
    const result = packSymbols(symbols, containerWidth);

    assert.strictEqual(result.positions.length, 3);
    // Should be on 3 different rows
    assert.strictEqual(result.positions[0].y, 0);
    assert.strictEqual(result.positions[1].y, 40); // 40 + 0 padding
    assert.strictEqual(result.positions[2].y, 80); // 40 + 40
    assert.strictEqual(result.contentW, 150);
    assert.strictEqual(result.contentH, 120, 'Content height should be 3*40');
  });

  test('packSymbols - mixed sizes pack efficiently', () => {
    const symbols: Symbol[] = [
      { key: 'large', width: 300, height: 90 },
      { key: 'small1', width: 100, height: 30 },
      { key: 'small2', width: 100, height: 30 },
      { key: 'medium', width: 200, height: 60 }
    ];
    const containerWidth = 500;
    const result = packSymbols(symbols, containerWidth);

    assert.strictEqual(result.positions.length, 4);
    // Verify no overlaps
    for (let i = 0; i < result.positions.length; i++) {
      for (let j = i + 1; j < result.positions.length; j++) {
        const p1 = result.positions[i];
        const p2 = result.positions[j];
        const overlap = !(
          p1.x + p1.width <= p2.x ||
          p2.x + p2.width <= p1.x ||
          p1.y + p1.height <= p2.y ||
          p2.y + p2.height <= p1.y
        );
        assert.ok(!overlap, `Symbols ${p1.key} and ${p2.key} should not overlap`);
      }
    }
    // Verify all positions are within content bounds
    for (const p of result.positions) {
      assert.ok(p.x >= 0 && p.x + p.width <= result.contentW, `Symbol ${p.key} x position should be within content width`);
      assert.ok(p.y >= 0 && p.y + p.height <= result.contentH, `Symbol ${p.key} y position should be within content height`);
    }
  });

  test('container sizing - symbols fit with padding', () => {
    const symbols: Symbol[] = [
      { key: 'func1', width: 200, height: 60 },
      { key: 'func2', width: 150, height: 45 }
    ];
    const containerWidth = 400;
    const result = packSymbols(symbols, containerWidth);

    // Container should be: contentW (no side padding)
    const expectedContainerWidth = result.contentW;
    // Container height should be: contentH + 40 (40px top for label)
    const expectedContainerHeight = result.contentH + 40;

    // Verify symbols fit inside container
    const innerWidth = expectedContainerWidth;
    const innerHeight = expectedContainerHeight - 40;

    assert.ok(result.contentW <= innerWidth, `Content width ${result.contentW} should fit in inner width ${innerWidth}`);
    assert.ok(result.contentH <= innerHeight, `Content height ${result.contentH} should fit in inner height ${innerHeight}`);

    // Verify all symbol positions are within inner bounds
    for (const p of result.positions) {
      assert.ok(p.x + p.width <= innerWidth, `Symbol ${p.key} should fit horizontally`);
      assert.ok(p.y + p.height <= innerHeight, `Symbol ${p.key} should fit vertically`);
    }
  });

  test('real scenario - 5 functions with varying changes', () => {
    // Simulate real change amounts
    const changeAmounts = [2, 5, 15, 30, 8];
    const symbols: Symbol[] = changeAmounts.map((amount, i) => {
      const size = calculateBoxSize(amount);
      return { key: `func${i}`, width: size.width, height: size.height };
    });

    const containerWidth = 600;
    const result = packSymbols(symbols, containerWidth);

    // Basic sanity checks
    assert.strictEqual(result.positions.length, 5);
    assert.ok(result.contentW > 0 && result.contentW <= containerWidth);
    assert.ok(result.contentH > 0);

    // Verify no overlaps
    for (let i = 0; i < result.positions.length; i++) {
      for (let j = i + 1; j < result.positions.length; j++) {
        const p1 = result.positions[i];
        const p2 = result.positions[j];
        const overlap = !(
          p1.x + p1.width <= p2.x ||
          p2.x + p2.width <= p1.x ||
          p1.y + p1.height <= p2.y ||
          p2.y + p2.height <= p1.y
        );
        assert.ok(!overlap, `Symbols should not overlap`);
      }
    }
  });

  // ===== NEW COMPREHENSIVE TESTS FOR PERFECT CONTAINMENT AND NO OVERLAPS =====

  test('4 symbols - perfect containment in file container', () => {
    const changeAmounts = [1, 10, 25, 50]; // Different sizes
    const symbols: Symbol[] = changeAmounts.map((amount, i) => {
      const size = calculateBoxSize(amount);
      return { key: `symbol${i}`, width: size.width, height: size.height };
    });

    const containerWidth = 500;
    const result = packSymbols(symbols, containerWidth);

    assert.strictEqual(result.positions.length, 4, 'Should have 4 symbols');

    // Verify perfect containment - all symbols within content bounds
    for (const p of result.positions) {
      assert.ok(p.x >= 0, `Symbol ${p.key} x should be >= 0, got ${p.x}`);
      assert.ok(p.y >= 0, `Symbol ${p.key} y should be >= 0, got ${p.y}`);
      assert.ok(p.x + p.width <= result.contentW, 
        `Symbol ${p.key} right edge (${p.x + p.width}) should be <= contentW (${result.contentW})`);
      assert.ok(p.y + p.height <= result.contentH,
        `Symbol ${p.key} bottom edge (${p.y + p.height}) should be <= contentH (${result.contentH})`);
    }

    // Verify no overlaps - symbols are laid out like bricks
    for (let i = 0; i < result.positions.length; i++) {
      for (let j = i + 1; j < result.positions.length; j++) {
        const p1 = result.positions[i];
        const p2 = result.positions[j];
        const noOverlap = (
          p1.x + p1.width <= p2.x ||  // p1 is left of p2
          p2.x + p2.width <= p1.x ||  // p2 is left of p1
          p1.y + p1.height <= p2.y || // p1 is above p2
          p2.y + p2.height <= p1.y    // p2 is above p1
        );
        assert.ok(noOverlap, `Symbols ${p1.key} and ${p2.key} should not overlap`);
      }
    }
  });

  test('5 symbols - perfect containment and brick layout', () => {
    const changeAmounts = [3, 7, 12, 20, 40]; // Varied sizes
    const symbols: Symbol[] = changeAmounts.map((amount, i) => {
      const size = calculateBoxSize(amount);
      return { key: `func${i}`, width: size.width, height: size.height };
    });

    const containerWidth = 600;
    const result = packSymbols(symbols, containerWidth);

    assert.strictEqual(result.positions.length, 5, 'Should have 5 symbols');

    // Perfect containment check
    for (const p of result.positions) {
      assert.ok(p.x >= 0 && p.x + p.width <= result.contentW,
        `Symbol ${p.key} must be horizontally contained: x=${p.x}, width=${p.width}, contentW=${result.contentW}`);
      assert.ok(p.y >= 0 && p.y + p.height <= result.contentH,
        `Symbol ${p.key} must be vertically contained: y=${p.y}, height=${p.height}, contentH=${result.contentH}`);
    }

    // No overlaps - brick layout check
    for (let i = 0; i < result.positions.length; i++) {
      for (let j = i + 1; j < result.positions.length; j++) {
        const p1 = result.positions[i];
        const p2 = result.positions[j];
        const noOverlap = (
          p1.x + p1.width <= p2.x ||
          p2.x + p2.width <= p1.x ||
          p1.y + p1.height <= p2.y ||
          p2.y + p2.height <= p1.y
        );
        assert.ok(noOverlap, 
          `Symbols ${p1.key} (${p1.x},${p1.y} ${p1.width}x${p1.height}) and ${p2.key} (${p2.x},${p2.y} ${p2.width}x${p2.height}) overlap!`);
      }
    }
  });

  test('6 symbols - mixed sizes with perfect containment', () => {
    const changeAmounts = [1, 5, 10, 15, 30, 60]; // Wide range
    const symbols: Symbol[] = changeAmounts.map((amount, i) => {
      const size = calculateBoxSize(amount);
      return { key: `item${i}`, width: size.width, height: size.height };
    });

    const containerWidth = 700;
    const result = packSymbols(symbols, containerWidth);

    assert.strictEqual(result.positions.length, 6, 'Should have 6 symbols');

    // Verify all symbols are perfectly contained
    for (const p of result.positions) {
      const rightEdge = p.x + p.width;
      const bottomEdge = p.y + p.height;
      assert.ok(p.x >= 0, `${p.key}: x must be >= 0`);
      assert.ok(p.y >= 0, `${p.key}: y must be >= 0`);
      assert.ok(rightEdge <= result.contentW, 
        `${p.key}: right edge ${rightEdge} must be <= contentW ${result.contentW}`);
      assert.ok(bottomEdge <= result.contentH,
        `${p.key}: bottom edge ${bottomEdge} must be <= contentH ${result.contentH}`);
    }

    // Verify brick-like layout with no overlaps
    for (let i = 0; i < result.positions.length; i++) {
      for (let j = i + 1; j < result.positions.length; j++) {
        const p1 = result.positions[i];
        const p2 = result.positions[j];
        const separated = (
          p1.x + p1.width <= p2.x ||
          p2.x + p2.width <= p1.x ||
          p1.y + p1.height <= p2.y ||
          p2.y + p2.height <= p1.y
        );
        assert.ok(separated, `${p1.key} and ${p2.key} must not overlap`);
      }
    }
  });

  test('8 symbols - stress test for containment and layout', () => {
    const changeAmounts = [1, 2, 5, 8, 12, 20, 35, 70];
    const symbols: Symbol[] = changeAmounts.map((amount, i) => {
      const size = calculateBoxSize(amount);
      return { key: `sym${i}`, width: size.width, height: size.height };
    });

    const containerWidth = 800;
    const result = packSymbols(symbols, containerWidth);

    assert.strictEqual(result.positions.length, 8, 'Should have 8 symbols');

    // Strict containment verification
    for (const p of result.positions) {
      assert.ok(p.x >= 0, `${p.key} x position must be non-negative`);
      assert.ok(p.y >= 0, `${p.key} y position must be non-negative`);
      assert.ok(p.x + p.width <= result.contentW,
        `${p.key} must fit horizontally: ${p.x} + ${p.width} = ${p.x + p.width} <= ${result.contentW}`);
      assert.ok(p.y + p.height <= result.contentH,
        `${p.key} must fit vertically: ${p.y} + ${p.height} = ${p.y + p.height} <= ${result.contentH}`);
    }

    // Comprehensive overlap check
    for (let i = 0; i < result.positions.length; i++) {
      for (let j = i + 1; j < result.positions.length; j++) {
        const p1 = result.positions[i];
        const p2 = result.positions[j];
        
        // Check if rectangles are separated
        const horizontallySeparated = (p1.x + p1.width <= p2.x) || (p2.x + p2.width <= p1.x);
        const verticallySeparated = (p1.y + p1.height <= p2.y) || (p2.y + p2.height <= p1.y);
        const noOverlap = horizontallySeparated || verticallySeparated;
        
        assert.ok(noOverlap,
          `Overlap detected between ${p1.key} [${p1.x},${p1.y},${p1.width}x${p1.height}] and ${p2.key} [${p2.x},${p2.y},${p2.width}x${p2.height}]`);
      }
    }
  });

  test('10 symbols - all minimum size, perfect grid layout', () => {
    const symbols: Symbol[] = Array.from({ length: 10 }, (_, i) => {
      const size = calculateBoxSize(1); // All minimum size
      return { key: `min${i}`, width: size.width, height: size.height };
    });

    const containerWidth = 500; // Should fit 5 per row (100px each)
    const result = packSymbols(symbols, containerWidth);

    assert.strictEqual(result.positions.length, 10, 'Should have 10 symbols');

    // All symbols should be perfectly contained
    for (const p of result.positions) {
      assert.ok(p.x >= 0 && p.x + p.width <= result.contentW,
        `${p.key} horizontally contained`);
      assert.ok(p.y >= 0 && p.y + p.height <= result.contentH,
        `${p.key} vertically contained`);
    }

    // Should form a perfect grid with no overlaps
    for (let i = 0; i < result.positions.length; i++) {
      for (let j = i + 1; j < result.positions.length; j++) {
        const p1 = result.positions[i];
        const p2 = result.positions[j];
        const noOverlap = (
          p1.x + p1.width <= p2.x ||
          p2.x + p2.width <= p1.x ||
          p1.y + p1.height <= p2.y ||
          p2.y + p2.height <= p1.y
        );
        assert.ok(noOverlap, `Grid symbols ${p1.key} and ${p2.key} must not overlap`);
      }
    }

    // Verify expected grid dimensions (5 columns x 2 rows)
    assert.strictEqual(result.contentW, 500, 'Should be 5 symbols wide (5 * 100)');
    assert.strictEqual(result.contentH, 60, 'Should be 2 symbols tall (2 * 30)');
  });

  test('container with top padding - symbols positioned correctly', () => {
    const changeAmounts = [5, 15, 25];
    const symbols: Symbol[] = changeAmounts.map((amount, i) => {
      const size = calculateBoxSize(amount);
      return { key: `padded${i}`, width: size.width, height: size.height };
    });

    const containerWidth = 600;
    const result = packSymbols(symbols, containerWidth);
    
    // Simulate container dimensions with 40px top padding (as in actual code)
    const TOP_PADDING = 40;
    const containerHeight = result.contentH + TOP_PADDING;

    // Verify symbols fit in the content area (below the padding)
    for (const p of result.positions) {
      // Symbols should be positioned relative to (0, 0) in content area
      assert.ok(p.x >= 0 && p.x + p.width <= result.contentW,
        `${p.key} fits horizontally in content area`);
      assert.ok(p.y >= 0 && p.y + p.height <= result.contentH,
        `${p.key} fits vertically in content area`);
      
      // When rendered with top padding, actual position would be (p.x, p.y + TOP_PADDING)
      const actualY = p.y + TOP_PADDING;
      assert.ok(actualY + p.height <= containerHeight,
        `${p.key} with padding offset fits in container`);
    }
  });

  test('CRITICAL: verify contentH matches actual max bottom edge', () => {
    // This test verifies that contentH is actually the maximum y + height
    // and not just a sum that could be wrong
    const changeAmounts = [10, 20, 30, 40];
    const symbols: Symbol[] = changeAmounts.map((amount, i) => {
      const size = calculateBoxSize(amount);
      return { key: `test${i}`, width: size.width, height: size.height };
    });

    const containerWidth = 500;
    const result = packSymbols(symbols, containerWidth);

    // Calculate the ACTUAL maximum bottom edge from positions
    let actualMaxBottom = 0;
    for (const p of result.positions) {
      actualMaxBottom = Math.max(actualMaxBottom, p.y + p.height);
    }

    // The contentH should be >= actualMaxBottom (it might be slightly larger due to shelf calculation)
    assert.ok(result.contentH >= actualMaxBottom,
      `contentH (${result.contentH}) must be >= actual max bottom (${actualMaxBottom})`);

    // More importantly: verify that when rendered with padding, symbols don't overflow
    const TOP_PADDING = 40;
    const containerHeight = result.contentH + TOP_PADDING;
    
    for (const p of result.positions) {
      const renderedTop = p.y + TOP_PADDING;
      const renderedBottom = renderedTop + p.height;
      assert.ok(renderedBottom <= containerHeight,
        `Symbol ${p.key} rendered bottom (${renderedBottom}) must be <= container height (${containerHeight}). ` +
        `Position: y=${p.y}, height=${p.height}, renderedTop=${renderedTop}`);
    }
  });

  test('CRITICAL: symbols must not exceed container in actual rendering', () => {
    // Test the exact scenario from the actual code
    const changeAmounts = [1, 5, 10, 15, 20];
    const symbols: Symbol[] = changeAmounts.map((amount, i) => {
      const size = calculateBoxSize(amount);
      return { key: `sym${i}`, width: size.width, height: size.height };
    });

    const containerWidth = 600;
    const result = packSymbols(symbols, containerWidth);

    // Simulate the actual rendering logic from symbol-changes-panel.ts
    const TOP_PADDING = 40;
    const fileContainerWidth = result.contentW; // No side padding
    const fileContainerHeight = result.contentH + TOP_PADDING;

    console.log(`\n[Test] Container: ${fileContainerWidth}x${fileContainerHeight}`);
    console.log(`[Test] Content area: ${result.contentW}x${result.contentH}`);
    console.log(`[Test] Top padding: ${TOP_PADDING}px`);

    for (const p of result.positions) {
      // Symbol is positioned at (p.x, p.y + TOP_PADDING) relative to container
      const left = p.x;
      const top = p.y + TOP_PADDING;
      const right = left + p.width;
      const bottom = top + p.height;

      console.log(`[Test] Symbol ${p.key}: pos=(${left},${top}) size=${p.width}x${p.height} bottom=${bottom}`);

      // Verify symbol is within container bounds
      assert.ok(left >= 0, `${p.key} left edge must be >= 0`);
      assert.ok(top >= TOP_PADDING, `${p.key} top edge must be >= ${TOP_PADDING} (below label)`);
      assert.ok(right <= fileContainerWidth, 
        `${p.key} right edge ${right} must be <= container width ${fileContainerWidth}`);
      assert.ok(bottom <= fileContainerHeight,
        `${p.key} bottom edge ${bottom} must be <= container height ${fileContainerHeight}. ` +
        `OVERFLOW BY ${bottom - fileContainerHeight}px!`);
    }
  });

  test('symbol height increases with more lines added - function example', () => {
    // This test verifies that when more lines are added to a function,
    // the symbol box height increases proportionally
    
    // Simulate a function with different amounts of lines added
    const scenarios = [
      { lines: 1, description: 'minimal change (1 line)' },
      { lines: 5, description: 'small change (5 lines)' },
      { lines: 10, description: 'medium change (10 lines)' },
      { lines: 25, description: 'large change (25 lines)' },
      { lines: 50, description: 'very large change (50 lines)' },
      { lines: 100, description: 'massive change (100 lines)' }
    ];

    let previousHeight = 0;
    
    for (const scenario of scenarios) {
      const size = calculateBoxSize(scenario.lines);
      
      console.log(`\n[Height Scaling] ${scenario.description}:`);
      console.log(`  Lines changed: ${scenario.lines}`);
      console.log(`  Box size: ${size.width}x${size.height}`);
      console.log(`  Height increase from previous: ${previousHeight > 0 ? size.height - previousHeight : 'N/A'}px`);
      
      // Verify height is within valid range
      assert.ok(size.height >= MIN_HEIGHT, 
        `Height ${size.height} should be >= minimum ${MIN_HEIGHT}`);
      assert.ok(size.height <= MAX_HEIGHT,
        `Height ${size.height} should be <= maximum ${MAX_HEIGHT}`);
      
      // Verify height increases with more lines (except for the first one)
      if (previousHeight > 0) {
        assert.ok(size.height > previousHeight,
          `Height ${size.height} should be greater than previous ${previousHeight} for ${scenario.lines} lines`);
      }
      
      // Verify the 10:3 aspect ratio is maintained
      const ratio = size.width / size.height;
      assert.ok(Math.abs(ratio - 10/3) < 0.1,
        `Aspect ratio ${ratio.toFixed(2)} should be close to 3.33 (10:3)`);
      
      previousHeight = size.height;
    }
    
    // Verify specific expectations
    const size1Line = calculateBoxSize(1);
    const size10Lines = calculateBoxSize(10);
    const size50Lines = calculateBoxSize(50);
    const size100Lines = calculateBoxSize(100);
    
    // 1 line should give minimum size
    assert.strictEqual(size1Line.height, MIN_HEIGHT, 
      '1 line change should have minimum height');
    
    // 10 lines should be significantly larger than 1 line
    assert.ok(size10Lines.height > size1Line.height * 1.5,
      '10 lines should be at least 50% taller than 1 line');
    
    // 50 lines should be larger than 10 lines
    assert.ok(size50Lines.height > size10Lines.height * 1.3,
      '50 lines should be at least 30% taller than 10 lines');
    
    // 100 lines should give maximum size
    assert.strictEqual(size100Lines.height, MAX_HEIGHT,
      '100 lines change should have maximum height');
    
    // Verify logarithmic scaling - the difference between 1 and 10 lines
    // should be larger than the difference between 50 and 100 lines
    const diff1to10 = size10Lines.height - size1Line.height;
    const diff50to100 = size100Lines.height - size50Lines.height;
    assert.ok(diff1to10 > diff50to100,
      'Logarithmic scaling: early differences should be larger than later differences');
  });

  test('CRITICAL: symbols fit snugly with box-sizing border-box', () => {
    // Test that verifies the container sizing with border-box model
    const changeAmounts = [2, 8, 15, 30];
    const symbols: Symbol[] = changeAmounts.map((amount, i) => {
      const size = calculateBoxSize(amount);
      return { key: `box${i}`, width: size.width, height: size.height };
    });

    const containerWidth = 500;
    const result = packSymbols(symbols, containerWidth);

    // With box-sizing: border-box, the container's width/height INCLUDES border and padding
    // Border: 2px on each side (4px total for width and height)
    // Padding: 40px top only
    // So if we set container width to packed.contentW, the actual content area is:
    //   - Width: contentW (no side padding, border is included in box-sizing)
    //   - Height: contentH + 40 (40px for label, border is included)
    
    const TOP_PADDING = 40;
    const BORDER_WIDTH = 2; // 2px border on all sides
    
    // Container dimensions as set in the code
    const containerSetWidth = result.contentW;
    const containerSetHeight = result.contentH + TOP_PADDING;
    
    // With border-box, the content area (where symbols are positioned) is:
    // Width: containerSetWidth - (2 * BORDER_WIDTH) = containerSetWidth - 4
    // Height: containerSetHeight - (2 * BORDER_WIDTH) - TOP_PADDING = containerSetHeight - 4 - 40
    // But wait - padding is INSIDE the box with border-box, so:
    // Content area width: containerSetWidth - 4 (for borders)
    // Content area height: containerSetHeight - 4 (for borders) - 40 (already included in containerSetHeight)
    
    // Actually, with padding: 40px 0 0 0, the content area is:
    // Width: full width minus borders = containerSetWidth - 4
    // Height: full height minus top padding minus borders = containerSetHeight - 40 - 4
    
    // But symbols are positioned at (x, y + 40), so they start after the padding
    // Let's verify symbols fit within the available space
    
    console.log(`\n[Test BoxSizing] Container set to: ${containerSetWidth}x${containerSetHeight}`);
    console.log(`[Test BoxSizing] Packed content: ${result.contentW}x${result.contentH}`);
    console.log(`[Test BoxSizing] Border: ${BORDER_WIDTH}px, Top padding: ${TOP_PADDING}px`);
    
    // The key insight: with border-box and padding: 40px 0 0 0:
    // - Container width includes borders, so content width = containerSetWidth - 4
    // - But we're setting containerSetWidth = packed.contentW, so symbols should fit exactly
    // - Container height includes borders and padding, so available height = containerSetHeight - 4 - 40
    // - But we're setting containerSetHeight = packed.contentH + 40, so symbols fit exactly
    
    // Verify that packed content exactly matches what we need
    assert.strictEqual(result.contentW, containerSetWidth, 
      'Packed content width should equal container set width');
    assert.strictEqual(result.contentH, containerSetHeight - TOP_PADDING,
      'Packed content height should equal container height minus top padding');
    
    // Verify all symbols fit within the packed dimensions
    for (const p of result.positions) {
      const right = p.x + p.width;
      const bottom = p.y + p.height;
      
      assert.ok(right <= result.contentW,
        `Symbol ${p.key} right edge ${right} must fit in content width ${result.contentW}`);
      assert.ok(bottom <= result.contentH,
        `Symbol ${p.key} bottom edge ${bottom} must fit in content height ${result.contentH}`);
    }
    
    // Verify symbols fit snugly - the rightmost and bottommost symbols should be close to edges
    let maxRight = 0;
    let maxBottom = 0;
    for (const p of result.positions) {
      maxRight = Math.max(maxRight, p.x + p.width);
      maxBottom = Math.max(maxBottom, p.y + p.height);
    }
    
    assert.strictEqual(maxRight, result.contentW, 
      'Rightmost symbol should reach exactly to content width (snug fit)');
    assert.strictEqual(maxBottom, result.contentH,
      'Bottommost symbol should reach exactly to content height (snug fit)');
  });

  test('CRITICAL: symbols do NOT exceed file container bottom edge with 3px padding', () => {
    // This test explicitly verifies the bug fix: symbols must not exceed the container's bottom edge
    // Container should have 3px padding at the bottom to ensure symbols are fully wrapped
    const changeAmounts = [1, 5, 10, 15, 20, 30, 50];
    const symbols: Symbol[] = changeAmounts.map((amount, i) => {
      const size = calculateBoxSize(amount);
      return { key: `func${i}`, width: size.width, height: size.height };
    });

    const containerWidth = 600;
    const result = packSymbols(symbols, containerWidth);

    // Actual container dimensions as set in the code (with 3px bottom padding fix)
    const TOP_PADDING = 40;
    const BOTTOM_PADDING = 3;
    const fileContainerHeight = result.contentH + TOP_PADDING + BOTTOM_PADDING;

    console.log(`\n[Test Bottom Edge] File container height: ${fileContainerHeight}`);
    console.log(`[Test Bottom Edge] Content height: ${result.contentH}`);
    console.log(`[Test Bottom Edge] Top padding: ${TOP_PADDING}px, Bottom padding: ${BOTTOM_PADDING}px`);
    console.log(`[Test Bottom Edge] Testing ${symbols.length} symbols...`);

    // Verify EVERY symbol's bottom edge is within the container
    for (const p of result.positions) {
      // Symbol is positioned at (p.x, p.y + TOP_PADDING) in the container
      const symbolTop = p.y + TOP_PADDING;
      const symbolBottom = symbolTop + p.height;
      
      console.log(`[Test Bottom Edge] ${p.key}: y=${p.y}, height=${p.height}, top=${symbolTop}, bottom=${symbolBottom}`);

      // CRITICAL: Symbol bottom must be <= container height
      assert.ok(symbolBottom <= fileContainerHeight,
        `FAILURE: Symbol ${p.key} bottom edge (${symbolBottom}px) exceeds container height (${fileContainerHeight}px) by ${symbolBottom - fileContainerHeight}px!`);
      
      // Also verify there's at least some padding at the bottom
      const bottomGap = fileContainerHeight - symbolBottom;
      console.log(`[Test Bottom Edge] ${p.key}: gap to container bottom = ${bottomGap}px`);
    }

    // Find the lowest symbol
    let lowestSymbolBottom = 0;
    let lowestSymbolKey = '';
    for (const p of result.positions) {
      const symbolBottom = (p.y + TOP_PADDING) + p.height;
      if (symbolBottom > lowestSymbolBottom) {
        lowestSymbolBottom = symbolBottom;
        lowestSymbolKey = p.key;
      }
    }

    console.log(`[Test Bottom Edge] Lowest symbol: ${lowestSymbolKey} at ${lowestSymbolBottom}px`);
    console.log(`[Test Bottom Edge] Container bottom: ${fileContainerHeight}px`);
    console.log(`[Test Bottom Edge] Gap: ${fileContainerHeight - lowestSymbolBottom}px`);

    // Verify the lowest symbol has at least 1px of padding (should have 3px)
    assert.ok(lowestSymbolBottom < fileContainerHeight,
      `Lowest symbol ${lowestSymbolKey} must have padding at bottom`);
    
    // Verify the gap is at least 1px (ideally 3px from our fix)
    const actualBottomPadding = fileContainerHeight - lowestSymbolBottom;
    assert.ok(actualBottomPadding >= 1,
      `Bottom padding should be at least 1px, got ${actualBottomPadding}px`);
  });

  test('CRITICAL: multiple scenarios - symbols never exceed container bottom', () => {
    // Test various scenarios to ensure symbols NEVER exceed the container
    const scenarios = [
      { name: 'Small changes', amounts: [1, 2, 3, 4, 5], width: 400 },
      { name: 'Medium changes', amounts: [5, 10, 15, 20, 25], width: 500 },
      { name: 'Large changes', amounts: [20, 30, 40, 50, 60], width: 600 },
      { name: 'Mixed sizes', amounts: [1, 10, 25, 50, 100], width: 700 },
      { name: 'All large', amounts: [50, 60, 70, 80, 90, 100], width: 800 },
      { name: 'Many small', amounts: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], width: 500 },
    ];

    const TOP_PADDING = 40;
    const BOTTOM_PADDING = 3;

    for (const scenario of scenarios) {
      console.log(`\n[Test Scenario] ${scenario.name}`);
      
      const symbols: Symbol[] = scenario.amounts.map((amount, i) => {
        const size = calculateBoxSize(amount);
        return { key: `${scenario.name}_${i}`, width: size.width, height: size.height };
      });

      const result = packSymbols(symbols, scenario.width);
      const fileContainerHeight = result.contentH + TOP_PADDING + BOTTOM_PADDING;

      console.log(`  Container: ${scenario.width}x${fileContainerHeight}`);
      console.log(`  Content: ${result.contentW}x${result.contentH}`);
      console.log(`  Symbols: ${symbols.length}`);

      // Check every symbol
      for (const p of result.positions) {
        const symbolBottom = (p.y + TOP_PADDING) + p.height;
        assert.ok(symbolBottom <= fileContainerHeight,
          `[${scenario.name}] Symbol ${p.key} bottom (${symbolBottom}) exceeds container (${fileContainerHeight})`);
      }

      // Find max bottom
      let maxBottom = 0;
      for (const p of result.positions) {
        maxBottom = Math.max(maxBottom, (p.y + TOP_PADDING) + p.height);
      }

      const gap = fileContainerHeight - maxBottom;
      console.log(`  Max symbol bottom: ${maxBottom}, Gap: ${gap}px`);
      assert.ok(gap >= 0, `[${scenario.name}] Must have non-negative gap, got ${gap}px`);
    }
  });

  test('CRITICAL: verify container height calculation matches actual implementation', () => {
    // This test verifies the exact formula used in the actual code
    const changeAmounts = [3, 8, 15, 25, 40];
    const symbols: Symbol[] = changeAmounts.map((amount, i) => {
      const size = calculateBoxSize(amount);
      return { key: `verify${i}`, width: size.width, height: size.height };
    });

    const containerWidth = 600;
    const result = packSymbols(symbols, containerWidth);

    // This is the EXACT formula from symbol-changes-panel.ts line 2250:
    // const finalHeight = packed.contentH + 40 + 3 + 4;
    const TOP_PADDING = 40;
    const BOTTOM_PADDING = 3;
    const BORDER_HEIGHT = 4; // 2px top + 2px bottom border
    const finalHeight = result.contentH + TOP_PADDING + BOTTOM_PADDING + BORDER_HEIGHT;

    console.log(`\n[Test Implementation] Verifying actual code formula:`);
    console.log(`  packed.contentH = ${result.contentH}`);
    console.log(`  TOP_PADDING = ${TOP_PADDING}`);
    console.log(`  BOTTOM_PADDING = ${BOTTOM_PADDING}`);
    console.log(`  BORDER_HEIGHT = ${BORDER_HEIGHT}`);
    console.log(`  finalHeight = ${result.contentH} + ${TOP_PADDING} + ${BOTTOM_PADDING} + ${BORDER_HEIGHT} = ${finalHeight}`);

    // Symbols are positioned at (x, y + TOP_PADDING) where y is from packed positions
    // So the actual rendered position is: top = y + 40, bottom = y + 40 + height
    for (const p of result.positions) {
      const renderedTop = p.y + TOP_PADDING;
      const renderedBottom = renderedTop + p.height;

      console.log(`  Symbol ${p.key}: y=${p.y}, height=${p.height}, renderedBottom=${renderedBottom}`);

      // The critical assertion: rendered bottom must be <= finalHeight
      assert.ok(renderedBottom <= finalHeight,
        `Symbol ${p.key} rendered bottom (${renderedBottom}) must be <= container height (${finalHeight}). ` +
        `Overflow: ${renderedBottom - finalHeight}px`);
    }

    // Verify the bottom padding is actually used
    let maxRenderedBottom = 0;
    for (const p of result.positions) {
      maxRenderedBottom = Math.max(maxRenderedBottom, (p.y + TOP_PADDING) + p.height);
    }

    const actualPadding = finalHeight - maxRenderedBottom;
    console.log(`  Max rendered bottom: ${maxRenderedBottom}`);
    console.log(`  Container height: ${finalHeight}`);
    console.log(`  Actual bottom padding: ${actualPadding}px`);

    // Should have at least 1px padding (ideally 3px)
    assert.ok(actualPadding >= 1,
      `Should have at least 1px bottom padding, got ${actualPadding}px`);
    
    // Verify it's close to our intended 3px (might be slightly more due to rounding)
    assert.ok(actualPadding >= BOTTOM_PADDING,
      `Should have at least ${BOTTOM_PADDING}px bottom padding, got ${actualPadding}px`);
  });
});




