// ---------------------------------------------------------------------------
// A sprawling test city made of basic blocks, for swinging around.
// Returns plain layout data; main.js turns each entry into a static body.
// ---------------------------------------------------------------------------

const PITCH = 34;          // distance between block centres (m)
const GRID = 4;            // blocks from the centre in each direction, so 9x9 blocks
const CENTRE = { x: 0, z: -110 };
const KEEP_CLEAR = 28;     // no buildings within this distance of the spawn point

const PALETTE = [0x8d99ae, 0xa0a0a0, 0xb08968, 0x6c757d, 0x7f8c8d, 0x5c6b73, 0xc9ada7];

export function cityBlocks() {
  // Seeded random so the city is the same every time
  let seed = 20240612;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  const buildings = [];
  for (let i = -GRID; i <= GRID; i++) {
    for (let j = -GRID; j <= GRID; j++) {
      const bx = CENTRE.x + i * PITCH;
      const bz = CENTRE.z + j * PITCH;
      if (Math.hypot(bx, bz) < KEEP_CLEAR) continue;

      // One main tower per block, offset a little within its lot
      const w = 11 + rand() * 6;
      const d = 11 + rand() * 6;
      const tall = rand() > 0.82;
      const h = tall ? 55 + rand() * 30 : 8 + rand() * 30;
      buildings.push({
        x: bx + (rand() - 0.5) * 6,
        z: bz + (rand() - 0.5) * 6,
        w, h, d,
        color: PALETTE[Math.floor(rand() * PALETTE.length)],
      });

      // Sometimes a smaller building beside it
      if (rand() > 0.55) {
        buildings.push({
          x: bx + 11 + rand() * 4,
          z: bz - 9 + rand() * 4,
          w: 6 + rand() * 3,
          d: 6 + rand() * 3,
          h: 5 + rand() * 14,
          color: PALETTE[Math.floor(rand() * PALETTE.length)],
        });
      }
    }
  }
  return buildings;
}
