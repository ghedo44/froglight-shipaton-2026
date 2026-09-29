import {
  emptyBlockPage,
  type ResourceTarget,
  type BlockRecord,
} from '@froglight/foundation';

export function missionControl(target: (path: string) => ResourceTarget) {
  const page = emptyBlockPage({
    title: 'Asteria — Mission Control',
    tags: ['aerospace', 'demo', 'mission-design'],
  });
  function block(
    type: string,
    fields: Record<string, unknown>,
    id = `b${page.rootOrder.length + 1}`,
  ) {
    const b: BlockRecord = { id, type: `froglight.${type}`, ...fields };
    page.blocks[id] = b;
    page.rootOrder.push(id);
    return id;
  }
  const runs = (text: string) => [{ text }];
  const p = (text: string) => block('paragraph', { runs: runs(text) });
  const h = (text: string, level = 2) =>
    block('heading', { level, runs: runs(text) });
  const embed = (path: string, label: string) =>
    block('resource-embed', {
      target: target(path),
      label,
      presentation: { showTitle: true },
    });
  const link = (path: string, label: string) =>
    block('resource-link', { target: target(path), label });
  h('ASTERIA', 1);
  block('paragraph', {
    runs: [
      { text: 'AEROSPACE DESIGN STUDIO', marks: ['bold'] },
      {
        text: '  /  Shipaton Next Gen 2026  /  Concept review 01',
        marks: ['italic'],
      },
    ],
  });
  block('quote', {
    runs: runs('From the first pencil stroke to a mission you can explain.'),
  });
  p(
    'One student workspace. Six ways to think. Asteria is a fictional CubeSat study that turns lecture notes, sketches and calculations into a connected engineering argument. Explore, draw, change a number, follow a link: these are your local documents.',
  );
  block('callout', {
    icon: '✦',
    tone: 'info',
    runs: runs(
      'START HERE · Follow the mission budgets, explore the connected notes, or jump into a drawing and make the mission your own.',
    ),
  });
  block('divider', {});
  h('01 / The question worth answering');
  p(
    'Can a small student spacecraft return one calibrated coastal image and explain its uncertainty? The camera is only the beginning. The image must survive every interface between orbit, power, pointing, memory, radio and the ground.',
  );
  embed(
    'Sketches/Spacecraft architecture.ink',
    'An editable spacecraft concept — open the source to draw',
  );
  block('paragraph', {
    runs: [
      { text: 'This sketch is a live reference. ', marks: ['bold'] },
      {
        text: 'Edit the original drawing and return here: the source stays the source.',
      },
    ],
  });
  block('list', {
    ordered: false,
    items: [
      'Payload: a notional optical camera for coastal observations.',
      'Platform: a 6U CubeSat concept with deployable-array options.',
      'Operations: store images, then transmit during selected ground passes.',
      'Success: a defensible result and a traceable chain of assumptions.',
    ].map((text) => ({ runs: runs(text) })),
  });
  h('02 / One shared reference case');
  block('table', {
    columnCount: 4,
    header: true,
    align: ['left', 'right', 'left', 'left'],
    rows: [
      ['Quantity', 'Value', 'Basis', 'Why it matters'],
      [
        'Altitude',
        '500 km',
        'Reference assumption',
        'Orbit clock and coverage',
      ],
      [
        'Circular speed',
        '7.61 km/s',
        'Two-body estimate',
        'Scale of the motion',
      ],
      ['Orbit period', '94.6 min', 'Two-body estimate', 'Operations timeline'],
      ['Eclipse', '36 min', 'Sizing assumption', 'Survival energy'],
      ['Bus load', '12 W', 'Illustrative load', '7.2 Wh delivered in eclipse'],
      [
        'Capacity lower bound',
        '30 Wh',
        'η = 0.80; usable fraction = 0.30',
        'Before aging/cold checks',
      ],
      [
        'Raw image',
        '6.29 MB',
        '2048² pixels × 12 bits',
        'Storage and radio time',
      ],
    ].map((row) => ({ cells: row.map(runs) })),
  });
  block('math', {
    source: String.raw`v=\sqrt{\frac{\mu}{R+h}}\qquad T=2\pi\sqrt{\frac{(R+h)^3}{\mu}}`,
  });
  embed('Sketches/Orbit geometry.ink', 'Geometry becomes time');
  block('callout', {
    icon: '↗',
    tone: 'warning',
    runs: runs(
      'MODEL BOUNDARY · The 36-minute eclipse is an explicit teaching assumption, not an orbit propagation result. This reference case omits drag, oblateness and injection uncertainty.',
    ),
  });
  link('Asteria design notes.tex', 'Read the complete LaTeX design study');
  h('03 / Energy is the common language');
  p(
    'An orbit gives you an illumination schedule. The schedule gives you an energy problem. The solution constrains when the camera, radio and actuators can run. Keep the quantities separate: power is a rate; energy is an integral.',
  );
  block('math', {
    source: String.raw`E_{\mathrm{pack}}\geq\frac{P\,t}{\eta f}=\frac{12\times0.60}{0.80\times0.30}=30\;\mathrm{Wh}`,
  });
  embed(
    'Sketches/Eclipse energy budget.ink',
    'The battery has to recover, not merely survive',
  );
  block('transclusion', {
    target: {
      ...target('Zettelkasten/06 Energy balance.md'),
      address: 'working-note',
    },
    label: 'From the permanent note: close the energy budget',
  });
  h('04 / Decisions live between subjects');
  block('diagram', {
    source:
      'flowchart LR\n  Orbit[Orbit geometry] --> Shadow[Eclipse]\n  Shadow --> Energy[Energy budget]\n  Pointing[Attitude control] --> Image[Image quality]\n  Image --> Data[Data volume]\n  Data --> Radio[Downlink]\n  Radio --> Energy\n  Energy --> Pointing',
  });
  block('paragraph', {
    runs: [
      { text: 'Follow the reasoning: ' },
      {
        text: 'solar incidence',
        marks: [
          {
            type: 'resource',
            target: target('Zettelkasten/09 Solar incidence.md'),
          },
        ],
      },
      { text: ' changes available power, while ' },
      {
        text: 'pointing stability',
        marks: [
          {
            type: 'resource',
            target: target('Zettelkasten/10 Pointing and image smear.md'),
          },
        ],
      },
      { text: ' changes the quality of the image you can return.' },
    ],
  });
  embed(
    'Sketches/Attitude control loop.ink',
    'A control loop with a mission consequence',
  );
  block('toggle', {
    runs: runs('Review question: should we deploy the solar arrays?'),
    children: ['trade-detail', 'trade-actions'],
  });
  page.blocks['trade-detail'] = {
    id: 'trade-detail',
    type: 'froglight.paragraph',
    runs: runs(
      'More collection area may improve recovery after eclipse, but mechanisms add uncertainty and the new geometry changes inertia and drag. Keep both options alive until the energy replay tells us whether the extra area is necessary.',
    ),
  };
  page.blocks['trade-actions'] = {
    id: 'trade-actions',
    type: 'froglight.list',
    ordered: false,
    items: [
      'Sweep pointing assumptions.',
      'Replay the cold eclipse load.',
      'Compare recovery time and remaining reserve.',
    ].map((text) => ({ runs: runs(text) })),
  };
  link(
    'Design room.whiteboard',
    'Enter the design room: move cards and connect hypotheses',
  );
  h('05 / The lab book stays close');
  p(
    'Three pages connect hand-drawn geometry with typed derivations. The notebook moves from orbit to energy to attitude, leaving room for the next annotation. Its ink, text and shapes remain editable.',
  );
  embed(
    'Field notebook.notebook',
    'Field notebook — orbit, eclipse and pointing',
  );
  h('06 / A small calculation you can inspect');
  block('code', {
    language: 'python',
    text: '# Illustrative image payload; decimal MB\nwidth = height = 2048\nbits_per_pixel = 12\npayload_bits = width * height * bits_per_pixel\npayload_mb = payload_bits / 8 / 1_000_000\nseconds = payload_bits / 1_000_000\nprint(f"{payload_mb:.2f} MB; {seconds:.1f} s at 1 Mbit/s")\n# 6.29 MB; 50.3 s at 1 Mbit/s',
  });
  p(
    'The same number can be an optics choice, a storage constraint, a radio task and an energy cost. The code is a readable worked example, not an executable notebook cell.',
  );
  h('07 / Review board');
  block('list', {
    ordered: false,
    items: [
      { runs: runs('Write down one common reference orbit.'), checked: true },
      {
        runs: runs(
          'Connect the eclipse energy calculation to its source note.',
        ),
        checked: true,
      },
      {
        runs: runs('Keep the alternative array concepts visible.'),
        checked: true,
      },
      {
        runs: runs('Replay the cold eclipse case on a bench emulator.'),
        checked: false,
      },
      {
        runs: runs('Measure pointing stability during a camera exposure.'),
        checked: false,
      },
      {
        runs: runs('Rehearse useful data delivery with packet loss.'),
        checked: false,
      },
    ],
  });
  block('quote', {
    runs: runs(
      'Review exit: bring a trace, a margin and one assumption you managed to falsify.',
    ),
  });
  h('08 / Build your own trail');
  block('list', {
    ordered: true,
    start: 1,
    items: [
      'Open a linked note and follow a connection outside its subject.',
      'Open the Graph panel to see the shared neighbours.',
      'Add a stroke to an ink plate and revisit its embed.',
      'Save, close the vault and reopen it to continue locally.',
    ].map((text) => ({ runs: runs(text) })),
  });
  link(
    'Zettelkasten/01 Mission as a system.md',
    'Begin with the mission as a system',
  );
  link('Zettelkasten/20 Decision log.md', 'Read the baseline decisions');
  link('Reading room.md', 'Primary reading and model limits');
  block('divider', {});
  block('paragraph', {
    runs: [
      {
        text: 'Asteria is an original fictional teaching project. ',
        marks: ['italic'],
      },
      {
        text: 'No account, remote media or network connection is required to explore this vault.',
      },
    ],
  });
  return page;
}
