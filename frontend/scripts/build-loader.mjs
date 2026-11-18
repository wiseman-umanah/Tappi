// Builds src/assets/tappi-loader.json, the Lottie animation behind the launch loader, from the
// Tappi mark (mobile/assets/images/brand/logo.svg). Run: node scripts/build-loader.mjs
//
// Timeline (60 fps, 300 frames = 5 s, loops): a blue pen draws each part of the mark, white fills
// in with a small bounce, the mark holds, then the pen erases it along the same path.
import { writeFileSync } from "node:fs";

const PARTS = [
  {
    name: "Stem",
    d: "M10.9073 32.576C10.2298 33.9311 8.84471 34.7871 7.32962 34.7871H7.21543C4.24187 34.7871 2.30789 31.6578 3.63776 28.9982L8.59076 19.0926C9.92063 16.433 7.98664 13.3037 5.01308 13.3037H0L2.8845 7.43641C3.55722 6.06805 4.94938 5.20117 6.47416 5.20117H8.41439C15.8482 5.20117 20.6832 13.0243 17.3587 19.6733L10.9073 32.576Z",
    draw: [0, 70],
    fill: [70, 100],
    erase: [215, 285],
  },
  {
    name: "Tick",
    d: "M33.3711 7.88965H28.1094L32.0547 0H25.4682C23.9531 0 22.5681 0.856009 21.8905 2.21114L19.3416 7.30891C17.3469 11.2983 20.2479 15.9922 24.7082 15.9922H27.1162C28.6855 15.9922 30.1099 15.0745 30.7585 13.6454L33.3711 7.88965Z",
    draw: [25, 85],
    fill: [85, 110],
    erase: [225, 290],
  },
];

const FPS = 60;
const END = 300;
const SIZE = 512;
const SCALE = 1000; // the mark is 34×35 units; 1000% makes it 340×350 on the 512 canvas
const PEN = [0.231, 0.51, 0.965, 1]; // brand blue #3b82f6
const INK = [1, 1, 1, 1];

/** SVG path (absolute M, L, H, V, C, Z) → Lottie bezier { v, i, o, c }. */
function toBezier(d) {
  const tokens = d.match(/[MLHVCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi);
  const v = [];
  const i = [];
  const o = [];
  let at = [0, 0];
  let k = 0;
  const num = () => Number(tokens[k++]);
  const push = (point, inTangent = [0, 0]) => {
    v.push(point);
    i.push(inTangent);
    o.push([0, 0]);
    at = point;
  };
  while (k < tokens.length) {
    const cmd = tokens[k++];
    if (cmd === "M" || cmd === "L") push([num(), num()]);
    else if (cmd === "H") push([num(), at[1]]);
    else if (cmd === "V") push([at[0], num()]);
    else if (cmd === "C") {
      const c1 = [num(), num()];
      const c2 = [num(), num()];
      const end = [num(), num()];
      o[o.length - 1] = [c1[0] - at[0], c1[1] - at[1]];
      push(end, [c2[0] - end[0], c2[1] - end[1]]);
    } else if (cmd === "Z") {
      const first = v[0];
      const last = v[v.length - 1];
      if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-3) {
        i[0] = i.pop();
        v.pop();
        o.pop();
      }
    } else throw new Error(`Unsupported path command ${cmd}`);
  }
  return { i, o, v, c: true };
}

const ease = { i: { x: [0.33], y: [1] }, o: { x: [0.67], y: [0] } };
/** Animated property from [frame, value] pairs. */
const anim = (...frames) => ({
  a: 1,
  k: frames.map(([t, s], n) => (n === frames.length - 1 ? { t, s: [s].flat() } : { t, s: [s].flat(), ...ease })),
});
const still = (value) => ({ a: 0, k: value });
const transform = () => ({
  ty: "tr",
  p: still([0, 0]),
  a: still([0, 0]),
  s: still([100, 100]),
  r: still(0),
  o: still(100),
  sk: still(0),
  sa: still(0),
});

const shapes = PARTS.flatMap((part) => {
  const path = { ty: "sh", nm: "Path", ks: still(toBezier(part.d)) };
  const [drawFrom, drawTo] = part.draw;
  const [fillFrom, fillTo] = part.fill;
  const [eraseFrom, eraseTo] = part.erase;
  return [
    {
      ty: "gr",
      nm: `${part.name} pen`,
      it: [
        path,
        {
          ty: "st",
          nm: "Pen",
          c: still(PEN),
          o: anim([fillTo, 100], [fillTo + 30, 0], [eraseFrom - 10, 0], [eraseFrom, 100]),
          w: still(0.7),
          lc: 2,
          lj: 2,
          ml: 4,
        },
        {
          ty: "tm",
          nm: "Trim",
          s: anim([eraseFrom, 0], [eraseTo, 100]),
          e: anim([drawFrom, 0], [drawTo, 100]),
          o: still(0),
          m: 1,
        },
        transform(),
      ],
    },
    {
      ty: "gr",
      nm: `${part.name} fill`,
      it: [
        path,
        { ty: "fl", nm: "Ink", c: still(INK), o: anim([fillFrom, 0], [fillTo, 100], [eraseFrom - 5, 100], [eraseFrom + 20, 0]), r: 1 },
        transform(),
      ],
    },
  ];
});

const pop = SCALE * 1.06;
const animation = {
  v: "5.7.4",
  fr: FPS,
  ip: 0,
  op: END,
  w: SIZE,
  h: SIZE,
  nm: "Tappi loader",
  ddd: 0,
  assets: [],
  layers: [
    {
      ddd: 0,
      ind: 1,
      ty: 4,
      nm: "Tappi mark",
      sr: 1,
      ks: {
        o: still(100),
        r: still(0),
        p: still([SIZE / 2, SIZE / 2, 0]),
        a: still([17, 17.4, 0]),
        s: anim([90, [SCALE, SCALE, 100]], [108, [pop, pop, 100]], [130, [SCALE, SCALE, 100]]),
      },
      ao: 0,
      shapes,
      ip: 0,
      op: END,
      st: 0,
      bm: 0,
    },
  ],
};

const out = new URL("../src/assets/tappi-loader.json", import.meta.url);
writeFileSync(out, JSON.stringify(animation));
console.log(`Wrote ${out.pathname}`);
