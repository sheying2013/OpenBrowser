'use strict';

/**
 * Window arrangement planner.
 *
 * Computes where each window should go for a given screen, supporting:
 *   - `tile`    : evenly distributed grid, balancing the last row
 *   - `stack`   : overlapping windows with a fixed horizontal offset
 *   - `custom`  : caller-chosen rows/size, optionally letting windows overflow
 *
 * The module is pure computation — it takes screen geometry as plain data and
 * returns rectangles. Nothing here touches a windowing toolkit, so the planner
 * can be unit-tested and reused across platforms.
 */

const LAYOUT = {
  MARGIN_X: 15,
  MARGIN_Y: 10,
  GAP_X: 15,
  GAP_Y: 10,
  STACK_GAP_X: 80,
  MIN_WIDTH: 500,
  MIN_HEIGHT: 200,
  MIN_HEIGHT_DARWIN: 375,
  ABSOLUTE_MIN_WIDTH: 50,
  ABSOLUTE_MIN_HEIGHT: 50,
  GRID_2X2_THRESHOLD: 4,
  TWO_ROW_BALANCE_THRESHOLD: 2,
};

/** Minimum usable window height for a platform. */
function minHeightFor(platform) {
  return platform === 'darwin' ? LAYOUT.MIN_HEIGHT_DARWIN : LAYOUT.MIN_HEIGHT;
}

/** Usable area inside a display once margins are removed. */
function availableArea(display, margins = {}) {
  const marginX = margins.x == null ? LAYOUT.MARGIN_X : margins.x;
  const marginY = margins.y == null ? LAYOUT.MARGIN_Y : margins.y;
  const width = Number(display.width) || 0;
  const height = Number(display.height) || 0;
  return {
    availableWidth: Math.max(0, width - marginX * 2),
    availableHeight: Math.max(0, height - marginY * 2),
  };
}

/**
 * Choose a window size for a grid of `totalWindows` windows.
 * Prefers keeping every window on one row; falls back to a balanced grid.
 */
function planTile({ totalWindows, availableWidth, availableHeight, minWidth, minHeight, gapX, gapY }) {
  const gx = gapX == null ? LAYOUT.GAP_X : gapX;
  const gy = gapY == null ? LAYOUT.GAP_Y : gapY;

  if (totalWindows <= 1) {
    return {
      winWidth: Math.max(minWidth, availableWidth),
      winHeight: Math.max(minHeight, availableHeight),
      gapX: gx, gapY: gy, colNum: 1, rowNum: 1,
    };
  }

  // A 2x2 grid is the sweet spot for four windows when space allows.
  const wideEnough = availableWidth > minWidth * 2 + gx;
  const tallEnough = availableHeight > minHeight * 2 + gy;
  if (wideEnough && tallEnough && totalWindows === LAYOUT.GRID_2X2_THRESHOLD) {
    const winWidth = Math.max(minWidth, Math.floor((availableWidth - gx) / 2));
    const winHeight = Math.max(minHeight, Math.floor((availableHeight - gy) / 2));
    return { winWidth, winHeight, gapX: gx, gapY: gy, colNum: 2, rowNum: 2 };
  }

  // Every column count is searched below, including a single row, so that
  // "the minimums happen to fit on one line" is not on its own enough to
  // choose one. It used to be, and five windows on a wide display came back
  // as five very narrow strips even though a two-row grid was available.

  // Search every column count and keep the roomiest feasible grid.
  // Scoring by area first and aspect ratio second avoids both cramped squares
  // whose last row is nearly empty, and stretched cells that waste space.
  let best = null;
  for (let cols = 1; cols <= totalWindows; cols += 1) {
    const rows = Math.ceil(totalWindows / cols);
    const cellWidth = Math.floor((availableWidth - gx * (cols - 1)) / cols);
    const cellHeight = Math.floor((availableHeight - gy * (rows - 1)) / rows);
    if (cellWidth < minWidth || cellHeight < minHeight) continue;

    const area = cellWidth * cellHeight;
    const aspect = Math.max(cellWidth / cellHeight, cellHeight / cellWidth);
    // Scoring has to weigh shape against space on the same scale. Subtracting
    // a flat amount per unit of aspect ratio leaves the term irrelevant next
    // to an area in the hundreds of thousands, so a single run of very narrow
    // windows wins purely by covering more pixels. Dividing by the squared
    // ratio keeps the two comparable: a grid twice as stretched needs twice
    // the usable area to be preferred.
    const score = area / (aspect * aspect);
    if (!best || score > best.score) {
      best = { cols, rows, cellWidth, cellHeight, score };
    }
  }

  if (best) {
    const leftoverY = availableHeight - best.cellHeight * best.rows;
    const effectiveGapY = best.rows > 1 ? Math.floor(leftoverY / (best.rows - 1)) : gy;
    return {
      winWidth: best.cellWidth,
      winHeight: best.cellHeight,
      gapX: gx,
      gapY: effectiveGapY,
      colNum: best.cols,
      rowNum: best.rows,
    };
  }

  // Nothing fits at the requested minimums; fall back to the widest grid that
  // at least avoids an extra row, letting the caller see it does not fit.
  const fallbackCols = Math.max(1, Math.min(totalWindows, Math.floor((availableWidth + gx) / (minWidth + gx)) || 1));
  const fallbackRows = Math.ceil(totalWindows / fallbackCols);
  return {
    winWidth: Math.max(minWidth, Math.floor((availableWidth - gx * (fallbackCols - 1)) / fallbackCols)),
    winHeight: Math.max(minHeight, Math.floor((availableHeight - gy * (fallbackRows - 1)) / fallbackRows)),
    gapX: gx,
    gapY: gy,
    colNum: fallbackCols,
    rowNum: fallbackRows,
    overcrowded: true,
  };
}

/**
 * Overlapping layout: every window gets the full height and they are offset
 * horizontally by a fixed amount so each title bar stays reachable.
 */
function planStack({ totalWindows, availableWidth, availableHeight, minWidth, stackOffset }) {
  const offset = stackOffset == null ? LAYOUT.STACK_GAP_X : stackOffset;
  if (totalWindows <= 0) return { winWidth: minWidth, winHeight: availableHeight, gapX: 0, gapY: 0, colNum: 0 };
  if (totalWindows === 1) {
    return { winWidth: availableWidth, winHeight: availableHeight, gapX: 0, gapY: 0, colNum: 1 };
  }

  const winWidth = availableWidth - (totalWindows - 1) * offset;
  if (winWidth < minWidth) {
    // Too tight to overlap cleanly: fall back to a negative gap that still fits.
    const colNum = totalWindows;
    return {
      winWidth: minWidth,
      winHeight: availableHeight,
      gapX: Math.floor((availableWidth - minWidth * colNum) / (colNum - 1)),
      gapY: 0,
      colNum,
    };
  }

  return {
    winWidth,
    winHeight: availableHeight,
    gapX: -(availableWidth - totalWindows * offset),
    gapY: 0,
    colNum: totalWindows,
  };
}

/**
 * Caller-driven layout: fixed row count (and optionally fixed size).
 * Overflow flags allow windows to extend past the screen instead of shrinking.
 */
function planCustom({
  totalWindows, availableWidth, availableHeight,
  minWidth, minHeight, rowNum, width, height,
  horizontalOverflow = false, verticalOverflow = false,
  gapX = LAYOUT.GAP_X, gapY = LAYOUT.GAP_Y,
}) {
  const rows = Math.max(1, Number(rowNum) || 1);
  const colNum = Math.ceil(totalWindows / rows);
  const needInitSize = !width || !height;

  let winWidth = needInitSize ? minWidth : Math.max(minWidth, Number(width));
  let winHeight = needInitSize ? minHeight : Math.max(minHeight, Number(height));
  let gx = gapX;
  let gy = gapY;

  const fitsHorizontally = (winWidth + gx) * colNum - gx < availableWidth;
  const fitsVertically = (winHeight + gy) * rows - gy < availableHeight;

  if (!fitsHorizontally && !horizontalOverflow) {
    if (colNum > 1) gx = Math.floor((availableWidth - winWidth * colNum) / (colNum - 1));
  } else if (needInitSize) {
    winWidth = Math.max(minWidth, Math.floor((availableWidth - gx * (colNum - 1)) / colNum));
  }

  if (!fitsVertically && !verticalOverflow) {
    if (rows > 1) gy = Math.floor((availableHeight - winHeight * rows) / (rows - 1));
  } else if (needInitSize) {
    winHeight = Math.max(minHeight, Math.floor((availableHeight - gy * (rows - 1)) / rows));
  }

  return { winWidth, winHeight, gapX: gx, gapY: gy, colNum, rowNum: rows };
}

/** Turn a plan into concrete rectangles anchored at the display origin. */
function placeWindows({
  totalWindows, display, plan,
  originX = LAYOUT.MARGIN_X, originY = LAYOUT.MARGIN_Y,
}) {
  const baseX = (Number(display.x) || 0) + originX;
  const baseY = (Number(display.y) || 0) + originY;
  const positions = [];

  for (let index = 0; index < totalWindows; index += 1) {
    const col = plan.colNum > 0 ? index % plan.colNum : 0;
    const row = plan.colNum > 0 ? Math.floor(index / plan.colNum) : 0;
    positions.push({
      displayId: display.id,
      x: Math.round(baseX + col * (plan.winWidth + plan.gapX)),
      y: Math.round(baseY + row * (plan.winHeight + plan.gapY)),
      width: Math.round(plan.winWidth),
      height: Math.round(plan.winHeight),
      index,
    });
  }
  return positions;
}

/** Split `total` items across displays proportionally to usable width. */
function distributeAcrossDisplays(total, displays) {
  if (!displays.length || total <= 0) return [];
  const weights = displays.map((d) => Math.max(1, Number(d.width) || 1));
  const sum = weights.reduce((a, b) => a + b, 0);

  const allocation = displays.map(() => 0);
  let assigned = 0;
  for (let i = 0; i < displays.length; i += 1) {
    const share = Math.floor((total * weights[i]) / sum);
    allocation[i] = share;
    assigned += share;
  }
  // Hand out any remainder to the widest displays first.
  const order = displays
    .map((d, i) => ({ i, width: Number(d.width) || 0 }))
    .sort((a, b) => b.width - a.width);
  let cursor = 0;
  while (assigned < total) {
    allocation[order[cursor % order.length].i] += 1;
    assigned += 1;
    cursor += 1;
  }
  return allocation;
}

/**
 * Plan positions for `totalWindows` windows across one or more displays.
 *
 * @param {object} params
 * @param {number} params.totalWindows
 * @param {Array<{id:*, width:number, height:number, x?:number, y?:number}>} params.displays
 * @param {'tile'|'stack'|'custom'} [params.layout]
 * @param {string} [params.platform]
 * @returns {Array<{displayId:*, x:number, y:number, width:number, height:number}>}
 */
function arrange({ totalWindows, displays, layout = 'tile', platform = process.platform, options = {} }) {
  if (!Array.isArray(displays) || displays.length === 0) return [];
  if (totalWindows <= 0) return [];

  const minWidth = options.minWidth == null ? LAYOUT.MIN_WIDTH : options.minWidth;
  const minHeight = options.minHeight == null ? minHeightFor(platform) : options.minHeight;
  const margins = options.margins;

  const allocation = distributeAcrossDisplays(totalWindows, displays);
  const result = [];

  for (let i = 0; i < displays.length; i += 1) {
    const count = allocation[i];
    if (count <= 0) continue;
    const display = displays[i];
    const { availableWidth, availableHeight } = availableArea(display, margins);

    let plan;
    if (layout === 'stack') {
      plan = planStack({
        totalWindows: count,
        availableWidth,
        availableHeight,
        minWidth,
        stackOffset: options.stackOffset,
      });
    } else if (layout === 'custom') {
      plan = planCustom({
        totalWindows: count,
        availableWidth,
        availableHeight,
        minWidth,
        minHeight,
        rowNum: options.rowNum,
        width: options.width,
        height: options.height,
        horizontalOverflow: options.horizontalOverflow,
        verticalOverflow: options.verticalOverflow,
        gapX: options.gapX,
        gapY: options.gapY,
      });
    } else {
      plan = planTile({
        totalWindows: count,
        availableWidth,
        availableHeight,
        minWidth,
        minHeight,
        gapX: options.gapX,
        gapY: options.gapY,
      });
    }

    result.push(...placeWindows({
      totalWindows: count,
      display,
      plan,
      originX: options.marginX == null ? LAYOUT.MARGIN_X : options.marginX,
      originY: options.marginY == null ? LAYOUT.MARGIN_Y : options.marginY,
    }));
  }

  return result;
}

/** True when every rectangle stays inside its display. */
function withinDisplays(positions, displays) {
  const byId = new Map(displays.map((d) => [d.id, d]));
  return positions.every((p) => {
    const display = byId.get(p.displayId);
    if (!display) return false;
    const left = Number(display.x) || 0;
    const top = Number(display.y) || 0;
    return p.x >= left
      && p.y >= top
      && p.x + p.width <= left + Number(display.width)
      && p.y + p.height <= top + Number(display.height);
  });
}

/**
 * Choose the grid for a work area, applying the floor a window manager will
 * enforce on the result.
 *
 * This is the decision a caller should not make by hand: a near-square grid
 * derived from the window count can come out shorter than a window is allowed
 * to be, and the minimum is then applied anyway, so the rows overlap. Pass the
 * same minimums the bounds clamp uses.
 *
 * @param {{totalWindows:number, workArea:{width:number,height:number},
 *          minWidth?:number, minHeight?:number, platform?:string}} options
 * @returns {{cols:number, rows:number, winWidth:number, winHeight:number,
 *            overcrowded:boolean}}
 */
function planGridFor(options = {}) {
  const total = Number(options.totalWindows);
  const work = options.workArea || {};
  if (!Number.isFinite(total) || total <= 0) {
    return { cols: 0, rows: 0, winWidth: 0, winHeight: 0, overcrowded: false };
  }
  const platformMin = minHeightFor(options.platform || process.platform);
  const plan = planTile({
    totalWindows: total,
    availableWidth: Math.max(0, Number(work.width) || 0),
    availableHeight: Math.max(0, Number(work.height) || 0),
    minWidth: options.minWidth == null ? LAYOUT.MIN_WIDTH : options.minWidth,
    minHeight: options.minHeight == null ? platformMin : options.minHeight,
  });
  return {
    cols: Math.max(1, plan.colNum),
    rows: Math.max(1, plan.rowNum),
    winWidth: plan.winWidth,
    winHeight: plan.winHeight,
    overcrowded: plan.overcrowded === true,
  };
}

module.exports = {
  arrange,
  planTile,
  planStack,
  planCustom,
  planGridFor,
  placeWindows,
  distributeAcrossDisplays,
  availableArea,
  withinDisplays,
  minHeightFor,
  LAYOUT,
};
