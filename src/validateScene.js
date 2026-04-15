function asFiniteNumber(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeHexGrid(hexGrid) {
  if (!Array.isArray(hexGrid)) return [];

  return hexGrid
    .map((cell) => ({
      q: Math.trunc(asFiniteNumber(cell?.q, 0)),
      r: Math.trunc(asFiniteNumber(cell?.r, 0)),
      enabled: Boolean(cell?.enabled),
      tileType: typeof cell?.tileType === 'string' ? cell.tileType : 'blank',
    }))
    .filter((cell) => Number.isFinite(cell.q) && Number.isFinite(cell.r));
}

function normalizeObjects(objects) {
  if (!Array.isArray(objects)) return [];

  return objects
    .map((obj, index) => {
      const pos = Array.isArray(obj?.position) ? obj.position : [0, 0, 0];
      return {
        id: typeof obj?.id === 'string' && obj.id.length > 0 ? obj.id : `obj-${index + 1}`,
        type: typeof obj?.type === 'string' ? obj.type : 'tree',
        position: [
          asFiniteNumber(pos[0], 0),
          asFiniteNumber(pos[1], 0),
          asFiniteNumber(pos[2], 0),
        ],
        rotationY: asFiniteNumber(obj?.rotationY, 0),
        objectScale: clamp(asFiniteNumber(obj?.objectScale, 1), 0.1, 5),
      };
    })
    .filter((obj) => obj.position.every((n) => Number.isFinite(n)));
}

function normalizeScenePayload(input) {
  const source = input && typeof input === 'object' ? input : {};
  const gridCols = Math.max(1, Math.trunc(asFiniteNumber(source.gridCols, 14)));
  const gridRows = Math.max(1, Math.trunc(asFiniteNumber(source.gridRows, 10)));
  const hexGrid = normalizeHexGrid(source.hexGrid);
  const objects = normalizeObjects(source.objects);

  return {
    gridCols,
    gridRows,
    hexGrid,
    objects,
  };
}

module.exports = {
  normalizeScenePayload,
};

