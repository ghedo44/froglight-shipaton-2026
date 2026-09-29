import {
  appendPage,
  boundedFrame,
  emptyNotebook,
  emptySurface,
  infiniteFrame,
  notebookPage,
  type SurfaceModel,
  type SurfaceObjectRecord,
  type ResourceTarget,
} from '@froglight/foundation';

// Original editable artwork: every line is a native stroke or Surface object.
const navy = '#22364d';
const teal = '#167d8d';
const orange = '#c16536';
const muted = '#63788b';

function canvas(title: string, width = 920, height = 540): SurfaceModel {
  const s = emptySurface(boundedFrame(width, height));
  s.unknownFields = {
    meta: {
      title,
      paper: { template: 'froglight.blank', paperColor: '#fffdf7' },
    },
  };
  return s;
}
function add(
  s: SurfaceModel,
  type: string,
  props: Record<string, unknown>,
): string {
  const id = `o${s.order.length + 1}`;
  s.objects[id] = { id, type: `froglight.${type}`, ...props };
  s.order.push(id);
  return id;
}
function text(
  s: SurfaceModel,
  x: number,
  y: number,
  value: string,
  size = 20,
  color = navy,
  wrapWidth = 760,
) {
  return add(s, 'text', {
    x,
    y,
    text: value,
    size,
    color,
    appearance: { wrapWidth },
  });
}
function line(
  s: SurfaceModel,
  x: number,
  y: number,
  x2: number,
  y2: number,
  color = teal,
  arrows?: string,
) {
  return add(s, 'line', {
    x,
    y,
    x2,
    y2,
    color,
    width: 2,
    ...(arrows ? { arrows } : {}),
  });
}
function stroke(
  s: SurfaceModel,
  points: number[][],
  color = navy,
  width = 2.4,
) {
  return add(s, 'ink.stroke', {
    points: points.map(([x, y], i) => ({
      x,
      y,
      pressure: 0.5 + 0.15 * Math.sin(i * 0.4),
      dt: i * 12,
    })),
    color,
    width,
    brush: { kind: 'ball' },
  });
}
function rect(
  s: SurfaceModel,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
) {
  return add(s, 'rectangle', {
    x,
    y,
    width,
    height,
    fill,
    stroke: '#c6d5db',
    strokeWidth: 1,
    shape: 'rounded',
    cornerRadius: 10,
  });
}
function ellipse(
  s: SurfaceModel,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  color = teal,
) {
  return add(s, 'ellipse', {
    x,
    y,
    width,
    height,
    fill,
    stroke: color,
    strokeWidth: 2,
  });
}
function curve(
  s: SurfaceModel,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  start = 0,
  end = Math.PI * 2,
  color = teal,
) {
  stroke(
    s,
    Array.from({ length: 121 }, (_, i) => {
      const a = start + ((end - start) * i) / 120;
      return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
    }),
    color,
  );
}
function header(
  s: SurfaceModel,
  number: string,
  title: string,
  subtitle: string,
) {
  text(s, 40, 24, `ASTERIA  /  ${number}`, 14, teal);
  text(s, 40, 55, title, 32);
  text(s, 40, 104, subtitle, 16, muted);
  line(s, 40, 140, 880, 140, '#c6d5db');
}

export function orbitSketch(): SurfaceModel {
  const s = canvas('Orbit geometry');
  header(
    s,
    'FLIGHT DYNAMICS',
    'One orbit. Many constraints.',
    'Circular reference orbit · 500 km altitude · schematic, not to scale',
  );
  ellipse(s, 235, 245, 170, 170, '#deedf1');
  curve(s, 320, 330, 82, 30, 0, Math.PI * 2, '#9bbbc4');
  curve(s, 320, 330, 36, 82, 0, Math.PI * 2, '#9bbbc4');
  curve(s, 320, 330, 240, 145);
  text(s, 278, 310, 'EARTH', 19);
  rect(s, 461, 200, 35, 26, '#f0c97c');
  line(s, 320, 330, 478, 213, orange);
  text(s, 350, 242, 'r = R + h', 17, orange, 180);
  line(s, 478, 210, 565, 255, teal, 'end');
  text(s, 531, 192, 'v = 7.61 km/s', 18, teal, 260);
  text(s, 624, 285, '94.6 min', 34, teal, 250);
  text(s, 624, 337, 'approximate period', 16, muted, 260);
  text(
    s,
    624,
    383,
    'Eclipse sets the battery task.\nGround passes set the data task.',
    18,
    navy,
    250,
  );
  text(
    s,
    40,
    488,
    'MODEL: spherical Earth + two-body motion; no drag or oblateness.',
    15,
    muted,
  );
  return s;
}
export function spacecraftSketch(): SurfaceModel {
  const s = canvas('Spacecraft architecture');
  header(
    s,
    'SYSTEMS',
    'A small spacecraft, drawn out.',
    '6U concept · exploded thinking, not a manufacturing drawing',
  );
  rect(s, 72, 232, 210, 155, '#d9e9f2');
  rect(s, 608, 232, 210, 155, '#d9e9f2');
  for (let x = 92; x < 280; x += 35) line(s, x, 241, x, 378, '#7398b3');
  for (let x = 628; x < 815; x += 35) line(s, x, 241, x, 378, '#7398b3');
  for (const y of [276, 320, 364]) {
    line(s, 82, y, 272, y, '#7398b3');
    line(s, 618, y, 808, y, '#7398b3');
  }
  stroke(s, [
    [330, 217],
    [472, 217],
    [542, 179],
    [402, 179],
    [330, 217],
    [330, 409],
    [472, 409],
    [542, 369],
    [542, 179],
  ]);
  stroke(s, [
    [472, 217],
    [472, 409],
  ]);
  line(s, 283, 309, 330, 309, navy);
  line(s, 543, 309, 608, 309, navy);
  ellipse(s, 359, 246, 80, 80, '#22364d');
  ellipse(s, 375, 262, 48, 48, '#c0e4e5');
  text(s, 353, 347, 'AVIONICS\n+ BATTERY', 15, navy, 120);
  line(s, 399, 243, 398, 163, orange);
  text(s, 439, 153, 'optical payload', 16, orange, 240);
  text(s, 111, 423, 'deployable array', 17, teal, 240);
  text(s, 597, 423, 'power ↔ pointing trade', 17, teal, 280);
  text(
    s,
    40,
    489,
    'Draw a new antenna concept here, then return to Mission Control to see the embed update.',
    15,
    muted,
  );
  return s;
}
export function controlSketch(): SurfaceModel {
  const s = canvas('Attitude control loop');
  header(
    s,
    'GUIDANCE & CONTROL',
    'Point. Measure. Correct.',
    'Closed-loop attitude control · conceptual signal flow',
  );
  const boxes = [
    [60, 'TARGET', 'desired angle'],
    [280, 'CONTROLLER', 'error → torque'],
    [510, 'SPACECRAFT', 'inertia + wheels'],
    [735, 'SENSOR', 'measured angle'],
  ] as const;
  for (const [x, title, body] of boxes) {
    rect(s, x, 230, 155, 110, '#e5eff0');
    text(s, x + 12, 251, title, 16, teal, 138);
    text(s, x + 12, 294, body, 15, navy, 138);
  }
  for (const [x, x2] of [
    [216, 275],
    [436, 505],
    [666, 730],
  ])
    line(s, x!, 285, x2!, 285, teal, 'end');
  stroke(
    s,
    [
      [812, 345],
      [812, 399],
      [250, 399],
      [250, 285],
    ],
    orange,
  );
  line(s, 250, 285, 277, 285, orange, 'end');
  text(s, 400, 414, 'negative feedback', 18, orange, 260);
  text(
    s,
    60,
    475,
    'Trade: sharper images need steadier pointing; steady pointing consumes energy.',
    18,
    navy,
  );
  return s;
}
export function energySketch(): SurfaceModel {
  const s = canvas('Eclipse energy budget');
  header(
    s,
    'POWER',
    'Survive the dark. Recover in the light.',
    'Illustrative battery trajectory · relative energy, not flight telemetry',
  );
  rect(s, 350, 180, 255, 250, '#e8eaf1');
  text(s, 430, 192, 'ECLIPSE', 16, muted, 170);
  line(s, 90, 425, 840, 425, navy, 'end');
  line(s, 90, 425, 90, 184, navy, 'end');
  stroke(
    s,
    [
      [95, 270],
      [180, 238],
      [270, 211],
      [348, 211],
      [410, 247],
      [475, 282],
      [540, 319],
      [605, 355],
      [685, 319],
      [758, 276],
      [823, 239],
    ],
    teal,
    4,
  );
  line(s, 95, 382, 823, 382, orange);
  text(s, 627, 387, 'reserve floor', 14, orange, 210);
  text(s, 152, 441, 'charge', 17, teal, 150);
  text(s, 418, 441, 'discharge', 17, teal, 180);
  text(s, 713, 441, 'recover', 17, teal, 170);
  text(
    s,
    40,
    489,
    'Sizing case: 12 W × 0.60 h ÷ (0.80 efficiency × 0.30 usable fraction) = 30 Wh.',
    17,
  );
  return s;
}

function notebookSheet(
  n: number,
  title: string,
  subtitle: string,
): SurfaceModel {
  const s = canvas(title, 920, 1220);
  header(s, `FIELD NOTES  /  0${n}`, title, subtitle);
  line(s, 40, 1153, 880, 1153, '#c6d5db');
  text(
    s,
    40,
    1170,
    'AEROSPACE DESIGN STUDIO  ·  ASTERIA  ·  SEPTEMBER 2026',
    13,
    muted,
  );
  text(s, 834, 1170, `0${n}`, 15, teal, 40);
  return s;
}
function inset(
  s: SurfaceModel,
  source: SurfaceModel,
  x: number,
  y: number,
  scale: number,
) {
  // Reuse our authored geometry, excluding the standalone plate heading/footer.
  for (const oldId of source.order) {
    const original = source.objects[oldId]!;
    if (
      typeof original.y === 'number' &&
      (original.y < 150 || original.y > 480)
    )
      continue;
    const object: SurfaceObjectRecord = structuredClone(original);
    for (const key of ['x', 'x2'])
      if (typeof object[key] === 'number')
        object[key] = x + object[key] * scale;
    for (const key of ['y', 'y2'])
      if (typeof object[key] === 'number')
        object[key] = y + (object[key] - 150) * scale;
    for (const key of ['width', 'height', 'size'])
      if (typeof object[key] === 'number') object[key] *= scale;
    if (Array.isArray(object.points))
      object.points = object.points.map((p: { x: number; y: number }) => ({
        ...p,
        x: x + p.x * scale,
        y: y + (p.y - 150) * scale,
      }));
    if (object.appearance && typeof object.appearance === 'object') {
      const a = object.appearance as { wrapWidth?: number };
      if (a.wrapWidth) a.wrapWidth *= scale;
    }
    add(s, object.type.slice('froglight.'.length), {
      ...object,
      id: `o${s.order.length + 1}`,
    });
  }
}
export function fieldNotebook() {
  const book = emptyNotebook('Asteria — Field notebook');
  const a = notebookSheet(
    1,
    'Start with the orbit.',
    'Lecture 01  /  Two-body motion & the mission clock',
  );
  text(a, 48, 171, 'QUESTION', 14, teal);
  text(
    a,
    48,
    201,
    'What does a 500 km orbit ask of the rest of the spacecraft?',
    24,
    navy,
    810,
  );
  inset(a, orbitSketch(), 0, 268, 1);
  text(a, 48, 620, '01  Balance acceleration', 22, teal);
  text(a, 70, 663, 'μ / r² = v² / r    →    v = √(μ / r)', 27);
  text(a, 70, 713, 'r = 6,378 + 500 = 6,878 km     μ = 398,600 km³/s²', 19);
  text(a, 48, 780, '02  Turn geometry into time', 22, teal);
  text(a, 70, 824, 'T = 2π √(r³ / μ) ≈ 5,676 s ≈ 94.6 min', 27);
  stroke(
    a,
    [
      [67, 867],
      [287, 872],
      [562, 869],
    ],
    orange,
    3,
  );
  rect(a, 48, 930, 824, 142, '#e5eff0');
  text(a, 69, 948, 'THE CONNECTION', 14, teal);
  text(
    a,
    69,
    982,
    'Orbit geometry becomes an energy problem in eclipse,\na scheduling problem over a ground station, and a thermal cycle.',
    22,
    navy,
    770,
  );
  const b = notebookSheet(
    2,
    'Budget the uncomfortable case.',
    'Lecture 02  /  Electrical power & eclipse survival',
  );
  text(b, 48, 172, 'DESIGN CASE', 14, teal);
  text(b, 48, 207, '36 minutes in shadow. 12 watts to keep the bus alive.', 25);
  inset(b, energySketch(), 0, 278, 1);
  text(b, 48, 644, 'Known', 21, teal);
  text(b, 280, 644, 'Working', 21, teal);
  text(b, 48, 691, 'P = 12 W\nt = 0.60 h\nη = 0.80\nf = 0.30', 23, navy, 200);
  text(
    b,
    280,
    691,
    'Eload = P × t = 7.2 Wh\nEpack ≥ Eload / (η × f)\nEpack ≥ 30 Wh',
    27,
    navy,
    540,
  );
  stroke(
    b,
    [
      [277, 805],
      [604, 808],
      [673, 804],
    ],
    orange,
    3,
  );
  text(b, 48, 877, 'Do not spend the same margin twice.', 25, orange);
  text(
    b,
    48,
    927,
    'The 30 Wh result is a simplified lower bound. Aging, cold capacity,\npeak current and safe-mode recovery still need separate checks.',
    21,
  );
  text(
    b,
    48,
    1034,
    'NEXT EXPERIMENT  →  replay a cold eclipse on the battery emulator.',
    18,
    teal,
  );
  const c = notebookSheet(
    3,
    'Close the loop.',
    'Lecture 03  /  Pointing, image quality & systems thinking',
  );
  text(
    c,
    48,
    174,
    'An image is only as good as the attitude history behind it.',
    25,
  );
  inset(c, controlSketch(), 0, 277, 1);
  text(c, 48, 649, 'Small-angle model', 22, teal);
  text(c, 70, 697, 'I θ̈ = τ     e = θref − θ\nτ = Kp e + Kd ė', 28);
  text(c, 48, 812, 'Before raising the gain…', 23, orange);
  text(
    c,
    70,
    860,
    '1. Check sensor noise and sample timing.\n2. Check actuator saturation and wheel momentum.\n3. Check structural modes and image smear.',
    22,
  );
  rect(c, 48, 1010, 824, 93, '#e5eff0');
  text(
    c,
    68,
    1030,
    'SYNTHESIS  /  Pointing → image quality → data volume → radio energy.\nThe interesting decisions live between subjects.',
    21,
  );
  for (const [i, s] of [a, b, c].entries())
    appendPage(
      book,
      notebookPage(`lecture-${i + 1}`, {
        label: [
          'Orbit & mission clock',
          'Eclipse & energy',
          'Attitude & image quality',
        ][i],
        template: 'froglight.dots',
        paper: { spacing: 28, paperColor: '#fffdf7' },
        surface: s,
      }),
    );
  return book;
}
export function missionWhiteboard(target: ResourceTarget): SurfaceModel {
  const s = emptySurface(infiniteFrame());
  s.unknownFields = {
    meta: {
      title: 'Asteria — Design room',
      paper: { template: 'froglight.dots', spacing: 28, paperColor: '#fffdf7' },
    },
  };
  text(s, 55, 34, 'ASTERIA  /  DESIGN ROOM', 17, teal);
  text(
    s,
    55,
    72,
    'What has to be true for this mission to work?',
    36,
    navy,
    1400,
  );
  text(
    s,
    55,
    130,
    'Concept review · 24 September 2026 · working hypotheses, not flight results',
    19,
    muted,
    1400,
  );
  const cols = [55, 415, 775, 1135];
  const headings = [
    '01  PURPOSE',
    '02  CONSTRAINTS',
    '03  EXPERIMENTS',
    '04  DECISIONS',
  ];
  const notes = [
    [
      'Observe coastal change\n\nUseful images, not merely a camera in orbit.',
      'Who uses the result?\n\nA student science team comparing repeated observations.',
      'Success metric\n\nReturn one calibrated image and explain its uncertainty.',
    ],
    [
      'Energy is finite\n\n36 min eclipse drives the survival case.',
      'Pointing couples everything\n\nSolar incidence, image smear and antenna gain.',
      'Data has a cost\n\nMore pixels → more storage → longer radio passes.',
    ],
    [
      'Cold eclipse replay\n\nCan the bus recover without exhausting reserve?',
      'Pointing bench\n\nSweep gains; record settling, overshoot and saturation.',
      'Downlink rehearsal\n\nInject packet loss and measure useful payload delivery.',
    ],
    [
      'BASELINE\n\n500 km reference orbit; store-and-forward operations.',
      'KEEP OPEN\n\nBody-mounted vs. deployable arrays until the energy test.',
      'NEXT REVIEW\n\nBring traces, margins and one falsified assumption.',
    ],
  ];
  const fills = ['#e2edf0', '#faecd5', '#e7ecdd', '#ede6f1'];
  const ids: string[][] = [];
  for (const [col, x] of cols.entries()) {
    text(s, x, 210, headings[col]!, 21, teal, 325);
    ids[col] = [];
    for (let row = 0; row < 3; row++)
      ids[col]!.push(
        add(s, 'card', {
          x,
          y: 267 + row * 212,
          width: 305,
          height: 172,
          text: notes[col]![row],
          fill: fills[col],
          stroke: '#d1d6d4',
          size: 21,
          color: navy,
        }),
      );
  }
  for (let col = 0; col < 3; col++)
    add(s, 'line', {
      x: cols[col]! + 305,
      y: 353,
      x2: cols[col + 1]!,
      y2: 353,
      source: { objectId: ids[col]![0], anchor: 'e' },
      target: { objectId: ids[col + 1]![0], anchor: 'w' },
      path: 'curved',
      arrows: 'end',
      color: orange,
      width: 2.5,
    });
  stroke(
    s,
    [
      [59, 925],
      [385, 915],
      [725, 926],
      [1080, 918],
      [1442, 925],
    ],
    teal,
    3,
  );
  text(s, 55, 960, 'PARKING LOT', 18, teal);
  text(
    s,
    55,
    1000,
    'What if the first useful result is a better question?\nKeep alternatives visible. Move a card. Draw the missing connection.',
    24,
    navy,
    660,
  );
  add(s, 'resource-embed', {
    x: 795,
    y: 976,
    width: 640,
    height: 376,
    target,
    cachedTitle: 'Spacecraft architecture',
    cachedKind: 'froglight.ink',
  });
  return s;
}
