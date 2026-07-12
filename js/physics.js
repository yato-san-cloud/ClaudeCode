// ============================================================
//  Bomberman — Physics
//
//  Pure AABB / grid collision math. NO references to GameMap or
//  Game — all solidity is decided by an `isSolid(col, row)`
//  predicate supplied by the caller. Classic <script>: declares
//  one top-level `const Physics`.
//
//  Coordinate model (see project spec):
//    - entity.x / entity.y  = pixels of the TOP-LEFT corner in
//      play-field space (HUD offset is NOT included here).
//    - entity.size          = ENTITY_SIZE (square AABB).
//    - Cell (col,row) covers the pixel rect
//        [col*TILE, (col+1)*TILE) x [row*TILE, (row+1)*TILE).
//    - cell of pixel p: col = floor(px/TILE), row = floor(py/TILE).
// ============================================================

const Physics = (function () {
  // Small epsilon so flush edges (an AABB whose edge exactly meets a
  // cell boundary) do NOT count as overlapping — this keeps an entity
  // that is clamped flush against a wall from being considered "inside"
  // the next cell, and lets it slip cleanly past corners.
  const EPS = 1e-6;

  // Does the entity's AABB overlap cell (col,row) with a strict
  // (epsilon-guarded) interior overlap?
  function overlapsCell(entity, col, row) {
    const ex0 = entity.x;
    const ey0 = entity.y;
    const ex1 = entity.x + entity.size;
    const ey1 = entity.y + entity.size;

    const cx0 = col * TILE;
    const cy0 = row * TILE;
    const cx1 = cx0 + TILE;
    const cy1 = cy0 + TILE;

    return (
      ex0 < cx1 - EPS &&
      ex1 > cx0 + EPS &&
      ey0 < cy1 - EPS &&
      ey1 > cy0 + EPS
    );
  }

  // Every grid cell the AABB currently overlaps (1..4 cells for a
  // sub-tile-sized entity). Uses the epsilon guard so a flush edge is
  // NOT counted, matching overlapsCell.
  function cellsOverlapped(entity) {
    const ex0 = entity.x;
    const ey0 = entity.y;
    const ex1 = entity.x + entity.size;
    const ey1 = entity.y + entity.size;

    const c0 = Math.floor((ex0 + EPS) / TILE);
    const c1 = Math.floor((ex1 - EPS) / TILE);
    const r0 = Math.floor((ey0 + EPS) / TILE);
    const r1 = Math.floor((ey1 - EPS) / TILE);

    const out = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        out.push({ col: c, row: r });
      }
    }
    return out;
  }

  // Resolve a move with axis separation. `isSolid(col,row)` returns
  // true for cells the entity cannot enter. Per-frame |dx|,|dy| are
  // assumed < TILE (the main loop clamps dt), so a single leading
  // column/row check per axis is enough — no tunnelling.
  //
  // Returns { blockedX, blockedY, movedX, movedY }.
  function moveAABB(entity, dx, dy, isSolid) {
    const size = entity.size;
    let blockedX = false;
    let blockedY = false;

    const startX = entity.x;
    const startY = entity.y;

    // ---- X axis ----------------------------------------------
    if (dx !== 0) {
      let nx = entity.x + dx;

      // Rows the AABB's vertical extent spans (at its CURRENT y).
      const r0 = Math.floor((entity.y + EPS) / TILE);
      const r1 = Math.floor((entity.y + size - EPS) / TILE);

      if (dx > 0) {
        // Leading (right) edge after the move.
        const leadCol = Math.floor((nx + size - EPS) / TILE);
        let hit = false;
        for (let r = r0; r <= r1; r++) {
          if (isSolid(leadCol, r)) { hit = true; break; }
        }
        if (hit) {
          // Clamp flush to the left boundary of the blocking column.
          nx = leadCol * TILE - size;
          blockedX = true;
        }
      } else {
        // dx < 0 — leading (left) edge after the move.
        const leadCol = Math.floor((nx + EPS) / TILE);
        let hit = false;
        for (let r = r0; r <= r1; r++) {
          if (isSolid(leadCol, r)) { hit = true; break; }
        }
        if (hit) {
          // Clamp flush to the right boundary of the blocking column.
          nx = (leadCol + 1) * TILE;
          blockedX = true;
        }
      }
      entity.x = nx;
    }

    // ---- Y axis ----------------------------------------------
    // Use the (already resolved) x extent so diagonal moves collide
    // consistently.
    if (dy !== 0) {
      let ny = entity.y + dy;

      const c0 = Math.floor((entity.x + EPS) / TILE);
      const c1 = Math.floor((entity.x + size - EPS) / TILE);

      if (dy > 0) {
        const leadRow = Math.floor((ny + size - EPS) / TILE);
        let hit = false;
        for (let c = c0; c <= c1; c++) {
          if (isSolid(c, leadRow)) { hit = true; break; }
        }
        if (hit) {
          ny = leadRow * TILE - size;
          blockedY = true;
        }
      } else {
        const leadRow = Math.floor((ny + EPS) / TILE);
        let hit = false;
        for (let c = c0; c <= c1; c++) {
          if (isSolid(c, leadRow)) { hit = true; break; }
        }
        if (hit) {
          ny = (leadRow + 1) * TILE;
          blockedY = true;
        }
      }
      entity.y = ny;
    }

    return {
      blockedX,
      blockedY,
      movedX: entity.x - startX,
      movedY: entity.y - startY,
    };
  }

  return { overlapsCell, cellsOverlapped, moveAABB, EPS };
})();
