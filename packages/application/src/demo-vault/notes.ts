import { markdownModel } from '@froglight/foundation';

// Original teaching notes; all mission values are explicit fictional assumptions.
const notes: readonly [string, string, string, string, readonly string[]][] = [
  [
    '01 Mission as a system',
    'A spacecraft is a conversation between budgets',
    'A payload does not succeed independently of its bus. A sharper image can demand tighter pointing, more processing, longer transmission and therefore more energy. A useful design review follows these couplings instead of reviewing each subsystem in isolation.',
    'For Asteria, begin with one calibrated coastal image. Trace that outcome backwards through downlink, storage, pointing, illumination and orbit. At each boundary, name the quantity being exchanged and who owns its limit. The earliest useful artifact is often an interface sketch rather than a component shopping list.',
    [
      '02 Circular orbit',
      '06 Energy balance',
      '10 Pointing and image smear',
      '15 Verification ladder',
    ],
  ],
  [
    '02 Circular orbit',
    'An orbit turns distance into a clock',
    String.raw`In a two-body circular model, gravity supplies centripetal acceleration: $\mu/r^2 = v^2/r$. Thus $v = \sqrt{\mu/r}$ and $T = 2\pi\sqrt{r^3/\mu}$. Radius is measured from the centre of Earth, not from the surface.`,
    String.raw`Use $\mu = 398600\,\mathrm{km^3\,s^{-2}}$ and an illustrative equatorial radius of 6378 km. At $h = 500\,\mathrm{km}$, $r = 6878\,\mathrm{km}$, $v \approx 7.61\,\mathrm{km/s}$ and $T \approx 94.6\,\mathrm{min}$. This calculation is a reference case: atmospheric drag, oblateness and the actual injection state are omitted. A compact model earns its place by exposing scale before adding detail.

$$
\begin{aligned}v &= \sqrt{\frac{\mu}{r}} \approx 7.61\,\mathrm{km\,s^{-1}} \\ T &= 2\pi\sqrt{\frac{r^3}{\mu}} \approx 94.6\,\mathrm{min}\end{aligned}
$$`,
    [
      '03 Eclipse geometry',
      '04 Ground contact',
      '05 Drag and lifetime',
      '17 Dimensional reasoning',
    ],
  ],
  [
    '03 Eclipse geometry',
    'The shadow is an electrical requirement',
    'Eclipse duration depends on orbital geometry and Sun direction. A nearly circular orbit alone is insufficient to determine the worst shadow interval; the Sun–orbit geometry matters. Asteria uses 36 minutes as a conservative classroom sizing case, not a propagated prediction.',
    'Separate the survival case from the payload case. During shadow the battery supports bus loads; after exit the array must operate the spacecraft and repay the energy debt. A design can survive one eclipse yet fail after repeated orbits if it never fully recovers. Carry the shadow assumption into both the energy and thermal models.',
    [
      '02 Circular orbit',
      '06 Energy balance',
      '07 Battery reserve',
      '08 Thermal balance',
    ],
  ],
  [
    '04 Ground contact',
    'A pass is a short opportunity, not continuous service',
    'Store-and-forward operations decouple image capture from transmission. Contact time depends on station position, orbit geometry, elevation mask and scheduling. An orbit period is not a downlink duration.',
    String.raw`Asteria assumes a useful 300 s pass and 1 Mbit/s payload rate for arithmetic only. Before overhead, that yields $300\,\mathrm{Mbit} = 37.5\,\mathrm{MB}$ using decimal units. Protocol overhead, coding and missed acquisitions reduce useful delivery. Ask whether the daily data queue drains under the worst credible contact schedule.

$$
D_{\mathrm{pass}} = R_b\,t_{\mathrm{pass}} = 1\,\mathrm{Mbit/s}\times 300\,\mathrm{s} = 37.5\,\mathrm{MB}
$$`,
    [
      '02 Circular orbit',
      '11 Link budget',
      '12 Data volume',
      '16 Fault recovery',
    ],
  ],
  [
    '05 Drag and lifetime',
    'A clean orbit sketch hides a changing atmosphere',
    String.raw`Drag acceleration depends on density, speed relative to the atmosphere, reference area, drag coefficient and mass. The familiar dynamic pressure $q = \rho v^2/2$ helps connect orbital decay with introductory aerodynamics, but the rarefied-flow coefficient is not a wing coefficient.`,
    String.raw`The ratio $m/(C_D A)$ is a useful ballistic-coefficient convention. A deployable array can improve power collection while changing projected area and drag torque. Density is uncertain and time dependent; do not turn a single reference density into a credible lifetime guarantee. Asteria leaves disposal and lifetime verification as open analysis tasks.`,
    [
      '02 Circular orbit',
      '09 Solar incidence',
      '13 Lift and drag',
      '18 Uncertainty',
    ],
  ],
  [
    '06 Energy balance',
    'Close the energy budget over time',
    'Power is an instantaneous rate. Energy is its integral. An average-power budget can hide an impossible peak current, and a peak-power budget can hide an energy deficit. Both checks are necessary.',
    String.raw`For the demo survival case, $E_{\mathrm{load}} = 12\,\mathrm{W} \times 0.60\,\mathrm{h} = 7.2\,\mathrm{Wh}$. With 0.80 discharge-path efficiency and a 0.30 usable capacity fraction, the simplified installed capacity lower bound is 30 Wh. Then test recovery: the next sunlit arc must replace the energy withdrawn while serving active loads. The figures are assumptions for teaching, not hardware selection.

$$
\begin{aligned}E_{\mathrm{load}} &= \int_0^{t_e} P(t)\,\mathrm{d}t = 7.2\,\mathrm{Wh} \\ E_{\mathrm{pack}} &\geq \frac{E_{\mathrm{load}}}{\eta f} = \frac{7.2}{0.80\times 0.30} = 30\,\mathrm{Wh}\end{aligned}
$$`,
    [
      '03 Eclipse geometry',
      '07 Battery reserve',
      '09 Solar incidence',
      '12 Data volume',
    ],
  ],
  [
    '07 Battery reserve',
    'Reserve is a policy as well as a number',
    'A battery capacity rating does not directly describe available mission energy. Temperature, age, discharge rate, allowed depth of discharge and conversion losses change what the system can use.',
    'State the reserve policy before applying factors. In this demo, only 30% of nominal capacity is available to the eclipse task and 80% of that energy reaches the loads. These are different effects. Do not subtract a second unexplained “safety factor” from an already derated usable-energy figure. Reserve should remain visible in the operations timeline.',
    [
      '06 Energy balance',
      '08 Thermal balance',
      '16 Fault recovery',
      '18 Uncertainty',
    ],
  ],
  [
    '08 Thermal balance',
    'Temperature is a system state, not a component label',
    'A lumped node stores heat while absorbing sunlight, exchanging radiation and conducting heat through interfaces. In vacuum, an exposed spacecraft surface does not cool by external air convection. Passive thermal approaches can be valuable where power and volume are scarce.',
    String.raw`For a teaching model, $C\,\mathrm{d}T/\mathrm{d}t = Q_{\mathrm{in}} - \epsilon\sigma A T^4$, with the environment and view-factor assumptions stated separately. Eclipse alters $Q_{\mathrm{in}}$; transmitter use adds internal dissipation; battery performance depends on temperature. Begin with one node to understand signs and timescales, then add the nodes needed to answer a specific design question.

$$
C\frac{\mathrm{d}T}{\mathrm{d}t} = Q_{\mathrm{in}}(t) - \epsilon\sigma A T^4
$$`,
    [
      '03 Eclipse geometry',
      '07 Battery reserve',
      '11 Link budget',
      '18 Uncertainty',
    ],
  ],
  [
    '09 Solar incidence',
    'Pointing changes the energy supply',
    String.raw`For a flat illuminated panel, projected collection area scales with $\cos\theta$, where $\theta$ is measured from the panel normal. This geometric model omits cell temperature, shadowing, electrical losses and degradation.`,
    'Asteria cannot assume maximum array power while simultaneously demanding arbitrary payload and antenna pointing. Sketch the body axes, panel normal and Sun vector on the same page. A deployable array is a geometry decision, a mechanism decision and an attitude-control decision before it becomes an entry in a power spreadsheet.',
    [
      '06 Energy balance',
      '10 Pointing and image smear',
      '05 Drag and lifetime',
      '14 Trade studies',
    ],
  ],
  [
    '10 Pointing and image smear',
    'Image quality remembers motion during exposure',
    'Pointing accuracy and pointing stability answer different questions. Accuracy concerns where the line of sight lands; stability concerns its variation over the relevant interval. A camera may point correctly on average and still smear an image during exposure.',
    String.raw`For a small angular rate $\omega$ and exposure $t$, the angular motion is approximately $\omega t$. Compare that motion with angular pixel scale to estimate smear in pixels. This first-order model is a prompt for a bench experiment, not an optical calibration. Tightening exposure trades smear against collected light and signal-to-noise.

$$
n_{\mathrm{smear}} \approx \frac{|\omega|\,t_{\mathrm{exp}}}{\alpha_{\mathrm{pixel}}}
$$`,
    [
      '09 Solar incidence',
      '19 Feedback control',
      '12 Data volume',
      '18 Uncertainty',
    ],
  ],
  [
    '11 Link budget',
    'Radio margin connects geometry to electrical power',
    'A link budget accounts for gains and losses between transmitter and receiver. Keep the logarithmic quantities consistent: power in dBW, gains in dBi and losses in dB can be added; linear watts cannot simply be added to decibels.',
    String.raw`Under a free-space far-field model, path loss is $20\log_{10}(4\pi R/\lambda)$. Distance, wavelength, antenna pointing and noise all matter. A stronger transmitter may help the received signal while worsening the energy and thermal cases. Evaluate useful delivered bits and required margin under a declared geometry, rather than celebrating a nominal radio data rate.

$$
L_{\mathrm{fs}} = 20\log_{10}\!\left(\frac{4\pi R}{\lambda}\right)\quad[\mathrm{dB}]
$$`,
    [
      '04 Ground contact',
      '06 Energy balance',
      '08 Thermal balance',
      '17 Dimensional reasoning',
    ],
  ],
  [
    '12 Data volume',
    'Pixels spend more than memory',
    String.raw`A $2048 \times 2048$ image sampled at 12 bits per pixel contains 50331648 bits, or about 6.29 MB before metadata and packing overhead. “Megapixels” alone is not a storage budget.`,
    String.raw`At the fictional useful payload rate of 1 Mbit/s, that raw payload needs about 50.3 seconds. Compression can reduce the volume, but its ratio depends on scene and quality policy. A science decision about bit depth therefore crosses processing, storage, radio, energy and ground operations. Keep the raw-data calculation visible even when using compressed products.

$$
D_{\mathrm{image}} = N_x N_y b = 2048^2\times 12 = 50\,331\,648\,\mathrm{bits}
$$`,
    [
      '04 Ground contact',
      '10 Pointing and image smear',
      '11 Link budget',
      '06 Energy balance',
    ],
  ],
  [
    '13 Lift and drag',
    'A shared equation can teach different regimes',
    String.raw`In introductory aerodynamics, $L = C_L q S$ and $D = C_D q S$, where $q = \rho V^2/2$. Coefficients package the effects of shape and flow conditions; they are not universal constants.`,
    String.raw`This is a useful bridge from aircraft coursework to spacecraft drag. The algebraic structure is familiar, while the physical regime changes. Ask what the coefficient means and which reference area was chosen before comparing two numbers. Lift-to-drag ratio and ballistic coefficient answer different engineering questions.

$$
\begin{aligned}L &= C_L\frac{\rho V^2}{2}S \\ D &= C_D\frac{\rho V^2}{2}S\end{aligned}
$$`,
    ['05 Drag and lifetime', '17 Dimensional reasoning', '18 Uncertainty'],
  ],
  [
    '14 Trade studies',
    'A weighted score should reveal an argument',
    'A trade matrix makes preferences explicit. It does not make the result objective simply by containing arithmetic. Record criteria, weight choices and the evidence behind each score.',
    'For body-mounted versus deployable arrays, compare collection area, mechanism complexity, pointing freedom, mass and confidence in the estimate. Sweep the weights. If a tiny change flips the winner, the useful result may be the next experiment rather than a frozen baseline. Keep rejected alternatives and the reason for rejection close to the decision.',
    [
      '09 Solar incidence',
      '15 Verification ladder',
      '18 Uncertainty',
      '20 Decision log',
    ],
  ],
  [
    '15 Verification ladder',
    'Build evidence in steps that can fail cheaply',
    'Analysis, bench testing and integrated testing expose different classes of error. A calculation can check scale; a component experiment can check a model parameter; an integrated rehearsal can expose interface assumptions.',
    'Asteria follows a simple ladder: calculate eclipse energy, replay the load on an emulator, measure the real power path, then rehearse a full operational orbit. Each step has a recorded acceptance statement. Passing an earlier step is evidence for the next step, not a substitute for it.',
    [
      '01 Mission as a system',
      '07 Battery reserve',
      '19 Feedback control',
      '20 Decision log',
    ],
  ],
  [
    '16 Fault recovery',
    'Safe mode must be reachable with the resources left',
    'A recovery concept is incomplete if the vehicle cannot afford to execute it after the initiating fault. Detection, transition and recovery all consume time and energy.',
    'Try this tabletop case: the spacecraft misses a downlink, remains in a high-load state and enters eclipse below its expected state of charge. Which loads are shed, which sensor remains available and what condition allows science to resume? The answer belongs in the energy model and the operations notebook, not only in software pseudocode.',
    [
      '04 Ground contact',
      '07 Battery reserve',
      '19 Feedback control',
      '20 Decision log',
    ],
  ],
  [
    '17 Dimensional reasoning',
    'Units catch mistakes before simulation does',
    String.raw`A result should first have the right dimensions and then a plausible magnitude. In $v = \sqrt{\mu/r}$, km³/s² divided by km becomes km²/s²; taking the root yields km/s.`,
    'Do not mix metres and kilometres inside one gravitational calculation. Do not confuse watts with watt-hours or bits with bytes. Write the conversion beside the number, especially at subsystem boundaries. A transparent hand calculation is often a better first review artifact than an unexplained plot.',
    [
      '02 Circular orbit',
      '06 Energy balance',
      '11 Link budget',
      '13 Lift and drag',
    ],
  ],
  [
    '18 Uncertainty',
    'A margin is not an uncertainty model',
    'Uncertainty describes what is not known; margin is an allocated allowance. Both deserve names and neither should silently stand in for the other. Model-form uncertainty is different from measurement noise.',
    String.raw`For a first-order estimate with independent inputs, propagate variances using local sensitivities. If dependence is important, covariance terms matter. For the orbit relation $v \propto r^{-1/2}$, a small fractional radius change gives approximately half as large an opposite fractional speed change. In mission planning, an uncertain atmospheric model may dominate a precisely measured mass.

$$
\sigma_y^2 \approx \sum_i\left(\frac{\partial y}{\partial x_i}\right)^2\sigma_{x_i}^2\qquad\text{(independent inputs)}
$$`,
    [
      '05 Drag and lifetime',
      '08 Thermal balance',
      '14 Trade studies',
      '17 Dimensional reasoning',
    ],
  ],
  [
    '19 Feedback control',
    'More gain is not automatically more control',
    String.raw`Feedback acts on an error between a reference and a measurement. A simple attitude model $I\ddot{\theta} = \tau$ makes it tempting to increase proportional gain until the response looks fast. The physical plant includes delays, noise, actuator limits and flexible modes.`,
    String.raw`Use a bench sweep with recorded settling time, overshoot and saturation. A derivative term can provide damping but may amplify noisy measurements. Compare controller performance against image smear during exposure and energy use over a manoeuvre. The best-looking step response is not necessarily the best mission response.

$$
I\ddot{\theta} = K_p(\theta_{\mathrm{ref}}-\theta)-K_d\dot{\theta}
$$`,
    [
      '10 Pointing and image smear',
      '09 Solar incidence',
      '15 Verification ladder',
      '16 Fault recovery',
    ],
  ],
  [
    '20 Decision log',
    'Keep the reason beside the result',
    'A decision record is most useful when a future reader can reconstruct its context without remembering the meeting. Name the question, alternatives, chosen baseline, evidence and trigger for reconsideration.',
    'Asteria baseline D-01: use a 500 km circular reference orbit for the first coupled budgets. Reason: one explicit common case is more useful than incompatible subsystem assumptions. This is not a launch commitment. Revisit after injection constraints, drag/lifetime analysis and ground coverage are available. Baseline D-02: defer the array mechanism choice until the eclipse-recovery experiment.',
    [
      '01 Mission as a system',
      '14 Trade studies',
      '15 Verification ladder',
      '16 Fault recovery',
    ],
  ],
];

export const demoNotes = notes.map(([name, title, thesis, working, links]) => ({
  path: `Zettelkasten/${name}.md`,
  model: markdownModel(
    `---\ntitle: "${title}"\ntags: [aerospace, asteria, permanent-note]\n---\n\n# ${title}\n\n> ${thesis}\n\n## Working note\n\n${working}\n\n## Connections\n\n${links.map((link, i) => `- [[${link}]] — ${['follow the physical dependency', 'compare the governing assumption', 'trace the system consequence', 'carry this into the next review'][i]}.`).join('\n')}\n\n## Recall prompt\n\nWhat would change elsewhere in the mission if this assumption were wrong? Sketch the dependency before opening a calculator.\n\n${name.startsWith('02') ? '![[Sketches/Orbit geometry.ink]]\n' : name.startsWith('06') ? '![[Sketches/Eclipse energy budget.ink]]\n' : name.startsWith('19') ? '![[Sketches/Attitude control loop.ink]]\n' : ''}\n*Original teaching material for the fictional Asteria study. See [[Reading room]] for source material and model limits.*\n`,
  ),
}));

export const readingRoom = markdownModel(
  `# Reading room\n\nAsteria is an original, fictional student mission created to explore Froglight. It is unrelated to any real spacecraft bearing a similar name. Numbers are worked examples and declared assumptions, not measurements or flight requirements.\n\n## Primary reading\n\n- [NASA — State of the Art of Small Spacecraft Technology](https://www.nasa.gov/smallsat-institute/sst-soa/): starting point for subsystem research.\n- [NASA — Electrical Power](https://www.nasa.gov/smallsat-institute/sst-soa/power-subsystems/): follow up the questions in [[06 Energy balance]] and [[07 Battery reserve]].\n- [NASA — Thermal Control](https://www.nasa.gov/smallsat-institute/sst-soa/thermal-control/): context for [[08 Thermal balance]].\n- [NASA Glenn — Lift Equation](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/lift-equation/): the introductory relation used in [[13 Lift and drag]].\n\n## Model register\n\n| Model | Included | Deliberately omitted |\n| --- | --- | --- |\n| Circular reference orbit | Spherical Earth, two-body gravity | Drag, oblateness, injection uncertainty |\n| Eclipse energy | Constant 12 W load, 36 min shadow | Detailed load timeline, aging, cold capacity |\n| Data sizing | 2048² pixels, 12 bits/pixel | Headers, coding, compression |\n| Attitude sketch | One-axis rigid-body dynamics | Flexibility, detailed actuators, estimator |\n\n## Reading practice\n\nCapture one claim per note. Write the assumption in your own words. Link the note to a different subject before filing it. When a model changes, update its source note and inspect the backlinks.\n\nStart with [[01 Mission as a system]], then follow [[03 Eclipse geometry]] → [[06 Energy balance]] → [[19 Feedback control]].\n`,
);
