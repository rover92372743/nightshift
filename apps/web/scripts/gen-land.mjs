import fs from 'node:fs';
import * as tc from 'topojson-client';
const topo = JSON.parse(fs.readFileSync('node_modules/world-atlas/land-50m.json','utf8'));
const land = tc.feature(topo, topo.objects.land);
const polys = [];
for (const f of land.features) {
  const g = f.geometry;
  const mp = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const p of mp) polys.push(p); // p = [outer, ...holes]
}
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// bbox per polygon for speed
const boxes = polys.map((p) => { let a=180,b=90,c=-180,d=-90; for (const [x,y] of p[0]) { a=Math.min(a,x); b=Math.min(b,y); c=Math.max(c,x); d=Math.max(d,y);} return [a,b,c,d]; });
function isLand(lon, lat) {
  for (let i = 0; i < polys.length; i++) {
    const [a,b,c,d] = boxes[i];
    if (lon < a || lon > c || lat < b || lat > d) continue;
    const p = polys[i];
    if (!inRing([lon, lat], p[0])) continue;
    let hole = false;
    for (let k = 1; k < p.length; k++) if (inRing([lon, lat], p[k])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}
const STEP = 1.9; // degrees of latitude between rows
const out = [];
for (let lat = -58; lat <= 84; lat += STEP) {
  const n = Math.max(1, Math.round((360 / STEP) * Math.cos((lat * Math.PI) / 180)));
  for (let i = 0; i < n; i++) {
    const lon = -180 + (i + 0.5) * (360 / n);
    if (isLand(lon, lat)) out.push(Math.round(lat * 10), Math.round(lon * 10));
  }
}
console.log('points', out.length / 2);
// pack as Int16 → base64
const buf = Buffer.alloc(out.length * 2);
out.forEach((v, i) => buf.writeInt16LE(v, i * 2));
const b64 = buf.toString('base64');
fs.writeFileSync('/home/claude/nightshift/apps/web/src/lib/land.ts',
`// Dotted land mask for the globe: ${out.length / 2} points on a ${STEP}° grid, equal-area
// spaced per row, generated from Natural Earth land (world-atlas 50m) by
// scripts/gen-land.mjs. Each point is [lat*10, lon*10] as little-endian int16.
const PACKED = '${b64}';

export function landPoints(): Float32Array {
  const bin = atob(PACKED);
  const n = bin.length / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    if (v & 0x8000) v -= 0x10000;
    out[i] = v / 10;
  }
  return out; // [lat0, lon0, lat1, lon1, ...]
}
`);
