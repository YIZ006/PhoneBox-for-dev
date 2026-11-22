import { $, API, D, LEVEL_COLOR, LOCALE, mediaHtml, METRICS, PANEL_HEADERS, PREVIEW, Q_STYLE, S_ORDER, ago, api, averageColor, bridge, buzz, cfg, cfgVersion, chart, color, cssVar, curPage, currentProcessesSort, emit, fillIcon, fmtClock, fmtDur, fmtHM, fmtMem, fmtReset, fmtTime, fmtValue, gotoProcesses, gpuMem, gpusOf, h, haptic, hasProcessesPage, hist, hour12, keyButton, levelOf, media, metricText, online, openSheet, paceInfo, pad, pages, prRow, pushView, quotaProviders, r1, registerProcessesSorter, renderStatus, ringSvg, setArtColor, setMediaState, setVolDragging, shortDur, shortGpu, store, streaming, t, tick, toast, volDragging, wxBlock, wxIcon } from '../main.js';
import { W } from '../registry.js';
import { invalidateDeckState } from './controls.js';

function bindProcessLink(box, sortTarget) {
  if (!hasProcessesPage()) return;
  box.style.cursor = 'pointer';
  box.addEventListener('click', () => {
    if (!hasProcessesPage()) return;
    haptic();
    gotoProcesses(sortTarget);
  });
}

// ================================================================= widgets
// Each widget: { needs: [data kinds], bare?: no card background, create(box, ctx) -> { update(kind) } }
// Data kinds: tick (every second), fast (4×/s), state, weather, quotas, work, procs, push, notes.

W.clock = {
  bare: true, needs: ['tick', 'state', 'weather', 'quotas', 'work'],
  create(box, { o }) {
    const status = o.status !== false ? h('div', 'status') : null;
    const hh = h('span', 'hh', '--'), mm = h('span', 'mm', '--'), ss = h('span', 'sec'), ap = h('span', 'ap');
    const date = o.date !== false ? h('div', 'date') : null;
    const wx = o.weather !== false ? wxBlock() : null;
    box.append(status || '', h('div', 'clock', hh, h('span', 'colon', ':'), mm, ss, ap), date || '', wx || '');
    box.style.setProperty('--tf', (0.84 - (status ? 0.1 : 0) - (date ? 0.11 : 0) - (wx ? 0.2 : 0)).toFixed(2));
    return {
      // without the weather line the clock must not make the panel fetch the weather
      needs: wx ? W.clock.needs : W.clock.needs.filter((k) => k !== 'weather'),
      update(kind) {
        if (kind === 'tick') {
          const now = new Date();
          const H = now.getHours(), h12 = hour12();
          hh.textContent = h12 ? String(H % 12 || 12) : pad(H);
          ap.textContent = h12 ? (H < 12 ? 'AM' : 'PM') : '';
          mm.textContent = pad(now.getMinutes());
          ss.textContent = cfg.display?.showSeconds === false ? '' : pad(now.getSeconds());
          if (date) date.textContent = now.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
          if (status && now.getSeconds() % 30 === 0) renderStatus(status); // battery
        } else if (kind === 'weather') wx?.update();
        else if (status) renderStatus(status);
      },
    };
  },
};

W.weather = {
  needs: ['weather'],
  create(box) {
    const wx = wxBlock();
    box.append(wx);
    return { update: () => wx.update() };
  },
};

W.forecast = {
  needs: ['weather'],
  create(box, { o }) {
    const daily = o.mode === 'daily';
    const row = h('div', 'fc');
    box.append(h('div', 'w-title', daily ? '7-day forecast' : 'Next hours', h('span', 'w-sub', '')), row);
    return {
      update() {
        const w = D.weather;
        if (!w?.hourly || !w?.daily) { row.replaceChildren(h('div', 'empty', D.weather === null ? t('w.loading') : t('w.weatherUnavailable'))); return; }
        box.querySelector('.w-sub').textContent = cfg.weather?.city || '';
        const vertical = box.clientHeight > box.clientWidth * 0.9;
        const room = vertical ? box.clientHeight - 30 : box.clientWidth - 16;
        const n = Math.max(3, Math.min(daily ? 7 : 12, Math.floor(room / (vertical ? 30 : 50))));
        row.classList.toggle('vert', vertical);
        const cells = [];
        if (daily) {
          const d = w.daily;
          for (let i = 0; i < Math.min(n, d.time.length); i++) {
            const day = i === 0 ? t('time.today') : new Date(d.time[i] + 'T12:00').toLocaleDateString(LOCALE, { weekday: 'short' });
            const rain = d.precipitation_probability_max?.[i];
            cells.push(h('div', 'fc-i', h('span', 'fc-t', day), h('span', 'fc-ic', wxIcon(d.weather_code[i])),
              h('span', 'fc-v', Math.round(d.temperature_2m_max[i]) + '°', h('small', null, ' ' + Math.round(d.temperature_2m_min[i]) + '°')),
              h('span', 'fc-r', rain >= 20 ? `💧${rain}%` : '')));
          }
        } else {
          const hr = w.hourly;
          let start = hr.time.indexOf((w.current?.time || '').slice(0, 13) + ':00');
          if (start < 0) start = 0;
          const step = n >= 10 ? 1 : 2;
          for (let k = 0; k < n; k++) {
            const i = start + k * step;
            if (i >= hr.time.length) break;
            const rain = hr.precipitation_probability?.[i];
            cells.push(h('div', 'fc-i', h('span', 'fc-t', k === 0 ? 'Now' : hr.time[i].slice(11, 13)), h('span', 'fc-ic', wxIcon(hr.weather_code[i], hr.is_day?.[i])),
              h('span', 'fc-v', Math.round(hr.temperature_2m[i]) + '°'), h('span', 'fc-r', rain >= 20 ? `💧${rain}%` : '')));
          }
        }
        row.replaceChildren(...cells);
      },
    };
  },
};

const DEFAULT_AMBIENT_PAL = [
  [36, 16, 58],    // deep base
  [184, 52, 132],  // primary vibrant
  [244, 126, 178], // bright highlight
  [76, 68, 214],   // secondary contrast
];

function boostRgb(r, g, b, sat = 1.45, minMax = 95, capMax = 245) {
  const avg = (r + g + b) / 3;
  r = avg + (r - avg) * sat;
  g = avg + (g - avg) * sat;
  b = avg + (b - avg) * sat;
  const mx = Math.max(r, g, b, 1);
  if (mx < minMax) { const k = minMax / mx; r *= k; g *= k; b *= k; }
  else if (mx > capMax) { const k = capMax / mx; r *= k; g *= k; b *= k; }
  return [
    Math.round(Math.max(12, Math.min(255, r))),
    Math.round(Math.max(12, Math.min(255, g))),
    Math.round(Math.max(12, Math.min(255, b))),
  ];
}

function extractAmbientData(img) {
  try {
    const sz = 32;
    const cv = document.createElement('canvas');
    cv.width = sz; cv.height = sz;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, sz, sz);
    const d = ctx.getImageData(0, 0, sz, sz).data;

    // Sample colorful / bright / contrasting candidates so the gradient has real depth & motion
    let rSum = 0, gSum = 0, bSum = 0, cnt = 0;
    let bestSat = -1, c1 = [180, 60, 140];
    let bestLum = -1, c2 = [240, 140, 190];
    const samples = [];

    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      rSum += r; gSum += g; bSum += b; cnt++;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const chroma = mx - mn;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const satScore = chroma * (0.4 + lum / 255);
      if (satScore > bestSat && lum > 35) { bestSat = satScore; c1 = [r, g, b]; }
      const hiScore = lum * 0.7 + chroma * 0.9;
      if (hiScore > bestLum && lum < 248) { bestLum = hiScore; c2 = [r, g, b]; }
      if ((i & 12) === 0 && lum > 24) samples.push([r, g, b, chroma]);
    }

    // Pick c3 as the sample with largest color distance from c1 (guaranteed contrast wave)
    let bestDist = -1, c3 = [70, 90, 210];
    for (const [r, g, b, ch] of samples) {
      const dr = r - c1[0], dg = g - c1[1], db = b - c1[2];
      const dist = Math.sqrt(dr * dr + dg * dg + db * db) + ch * 0.65;
      if (dist > bestDist) { bestDist = dist; c3 = [r, g, b]; }
    }

    const avgR = rSum / Math.max(1, cnt), avgG = gSum / Math.max(1, cnt), avgB = bSum / Math.max(1, cnt);
    const base = boostRgb(avgR * 0.42, avgG * 0.42, avgB * 0.42, 1.3, 38, 72);
    const pal = [
      base,
      boostRgb(c1[0], c1[1], c1[2], 1.55, 145, 248),
      boostRgb(c2[0], c2[1], c2[2], 1.35, 180, 255),
      boostRgb(c3[0], c3[1], c3[2], 1.5, 130, 240),
    ];

    // Also keep a 64x64 offscreen bitmap for Apple-Music-style swirling blurred cover layers
    const snap = document.createElement('canvas');
    snap.width = 64; snap.height = 64;
    snap.getContext('2d').drawImage(img, 0, 0, 64, 64);
    return { pal, snap };
  } catch (_) {
    return null;
  }
}

function createAmbientEngine(bgCanvas, edgeCanvas, box) {
  const W = 160, H = 90;
  bgCanvas.width = W; bgCanvas.height = H;
  const ctx = bgCanvas.getContext('2d');

  const EW = 360, EH = 170;
  edgeCanvas.width = EW; edgeCanvas.height = EH;
  const ectx = edgeCanvas.getContext('2d');

  let curPal = DEFAULT_AMBIENT_PAL.map((c) => c.slice());
  let tgtPal = DEFAULT_AMBIENT_PAL.map((c) => c.slice());
  let artSnap = null;
  let playing = false;
  let idle = true;
  let fxMode = 'edge'; // 'edge' | 'ambient' | 'calm'
  let phase = Math.random() * 20;
  let raf = 0;
  let lastFrame = 0;
  let dead = false;

  // Real-time audio-reactive state (fed by 48-band WASAPI FFT @ 30fps)
  let rawBass = 0, rawMid = 0, rawHigh = 0, specAt = 0;
  let bass = 0, mid = 0, high = 0;
  let bassAvg = 0.1;
  let bassMax = 0.35;
  let beatPulse = 0;
  let edgeMaster = 0;

  // 1D COUPLED SHALLOW-WATER LIQUID WAVE ENGINE (user-tuned: tint 87%, tide 7%, height 28%, blur 5px, spread 0.20)
  // 2 overlapping continuous Bezier liquid surfaces driven by 6 real-time FFT frequency splash zones!
  const CORE_TINT = 0.87;
  const TIDE_PCT = 0.07;
  const HEIGHT_PCT = 0.28;
  const SPREAD_K = 0.20;
  const WN = 36;

  const makeWater = (tension, damping) => ({
    y: new Float32Array(WN),
    v: new Float32Array(WN),
    tension,
    damping,
  });
  const backWater = makeWater(0.022, 0.048);
  const frontWater = makeWater(0.036, 0.056);

  const splashWater = (water, posNorm, force, radius = 4) => {
    const center = Math.round(Math.max(0, Math.min(1, posNorm)) * (WN - 1));
    for (let i = Math.max(0, center - radius); i <= Math.min(WN - 1, center + radius); i++) {
      const d = Math.abs(i - center) / (radius + 0.5);
      const w = Math.cos(d * Math.PI * 0.5);
      water.v[i] += force * w * w;
    }
  };

  const stepWater = (water, spread) => {
    const { y, v, tension, damping } = water;
    for (let i = 0; i < WN; i++) {
      v[i] += -tension * y[i] - damping * v[i];
      y[i] += v[i];
    }
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < WN; i++) {
        if (i > 0) v[i - 1] += spread * (y[i] - y[i - 1]);
        if (i < WN - 1) v[i + 1] += spread * (y[i] - y[i + 1]);
      }
    }
    for (let i = 0; i < WN; i++) {
      if (y[i] < -0.35) y[i] = -0.35;
      if (y[i] > 1.35) y[i] = 1.35;
    }
  };

  // 6 real-time FFT splash injectors positioned organically across the liquid surface
  const ZONES = [
    { pos: 0.18, drift: 0.08, spd: 0.55, ph: 0.4, b0: 0,  b1: 4,  r: 4, gain: 0.24 }, // sub-bass
    { pos: 0.34, drift: 0.09, spd: 0.68, ph: 2.0, b0: 3,  b1: 9,  r: 4, gain: 0.26 }, // kick punch
    { pos: 0.50, drift: 0.10, spd: 0.52, ph: 3.8, b0: 8,  b1: 15, r: 4, gain: 0.22 }, // bassline
    { pos: 0.65, drift: 0.09, spd: 0.76, ph: 1.1, b0: 15, b1: 24, r: 3, gain: 0.20 }, // vocal body
    { pos: 0.78, drift: 0.08, spd: 0.84, ph: 4.9, b0: 24, b1: 35, r: 3, gain: 0.18 }, // synth/snare
    { pos: 0.86, drift: 0.06, spd: 0.63, ph: 2.7, b0: 34, b1: 46, r: 3, gain: 0.16 }, // hi-hat/air
  ];
  const zoneRaw = new Float32Array(ZONES.length);
  const zoneEnv = new Float32Array(ZONES.length);
  const zoneAvg = new Float32Array(ZONES.length).fill(0.12);
  const zoneMax = new Float32Array(ZONES.length).fill(0.32);
  const zonePrev = new Float32Array(ZONES.length);

  const rgba = (c, a) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
  const mixCol = (a, b, k) => [
    a[0] + (b[0] - a[0]) * k,
    a[1] + (b[1] - a[1]) * k,
    a[2] + (b[2] - a[2]) * k,
  ];

  const drawOrb = (x, y, rad, col, alpha, comp = 'screen') => {
    ctx.globalCompositeOperation = comp;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, rgba(col, alpha));
    g.addColorStop(0.52, rgba(col, alpha * 0.46));
    g.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fill();
  };

  // Render ONE continuous smooth Bezier liquid ribbon with color-tinted core (zero hardcoded white!)
  const drawLiquidLayer = (water, baseTide, maxSurge, colTop, colMid, colBot, colCore, phaseShift, alpha, t) => {
    const baseH = EH * baseTide;
    const surgeH = EH * maxSurge;
    const pts = [];
    let peakY = EH;
    for (let i = 0; i < WN; i++) {
      const u = i / (WN - 1);
      const edgeFade = Math.sin(u * Math.PI);
      const env = 0.32 + 0.68 * Math.pow(edgeFade, 0.45);
      const slosh = Math.sin(u * 5.2 + t * 1.45 + phaseShift) * 2.2
                  + Math.sin(u * 9.5 - t * 2.1 + phaseShift * 1.7) * 1.2;
      const h = Math.max(2, (baseH + Math.max(-baseH * 0.4, water.y[i] * surgeH)) * env + slosh);
      const py = EH - h;
      if (py < peakY) peakY = py;
      pts.push([u * EW, py]);
    }

    ectx.beginPath();
    ectx.moveTo(0, EH);
    ectx.lineTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) * 0.5;
      const my = (pts[i][1] + pts[i + 1][1]) * 0.5;
      ectx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ectx.lineTo(EW, pts[pts.length - 1][1]);
    ectx.lineTo(EW, EH);
    ectx.closePath();

    const grad = ectx.createLinearGradient(0, Math.max(0, peakY - 6), 0, EH);
    grad.addColorStop(0, rgba(colTop, alpha * 0.12));
    grad.addColorStop(0.28, rgba(colMid, alpha * 0.62));
    grad.addColorStop(0.72, rgba(colBot, alpha * 0.88));
    grad.addColorStop(1, rgba(colCore, alpha * 0.96));
    ectx.fillStyle = grad;
    ectx.fill();
  };

  const drawEdgeLighting = (t, dt, freshSpec, master) => {
    ectx.clearRect(0, 0, EW, EH);
    if (fxMode !== 'edge' || master <= 0.006) return;

    // Inject real-time FFT splashes into the 2 coupled liquid surfaces
    for (let i = 0; i < ZONES.length; i++) {
      const z = ZONES[i];
      const tgt = freshSpec ? zoneRaw[i] : 0;
      zoneEnv[i] += (tgt - zoneEnv[i]) * Math.min(1, dt * (tgt > zoneEnv[i] ? 32 : 11));
      if (zoneEnv[i] > zoneMax[i]) zoneMax[i] = zoneEnv[i];
      else zoneMax[i] = Math.max(0.20, zoneMax[i] - dt * 0.08);

      const norm = Math.min(1, zoneEnv[i] / zoneMax[i]);
      zoneAvg[i] += (norm - zoneAvg[i]) * Math.min(1, dt * 2.2);
      const rise = Math.max(0, norm - zonePrev[i]);
      zonePrev[i] = norm;

      // Splash on onset transients + gentle sustained swell on strong energy
      const punch = Math.max(0, norm - zoneAvg[i] * 1.02);
      const impulse = (rise * 1.65 + punch * 0.65) * z.gain;
      if (freshSpec && impulse > 0.012) {
        const p = z.pos + z.drift * Math.sin(t * z.spd + z.ph);
        const pBack = Math.min(0.9, Math.max(0.1, p + ((i & 1) ? 0.16 : -0.16)));
        splashWater(frontWater, p, Math.min(0.28, impulse), z.r);
        splashWater(backWater, pBack, Math.min(0.22, impulse * 0.78), z.r + 1);
      }
    }

    // Step coupled shallow-water physics (2 sub-steps per ~30fps frame for silky 60Hz-equivalent fluidity)
    for (let s = 0; s < 2; s++) {
      stepWater(backWater, SPREAD_K * 0.85);
      stepWater(frontWater, SPREAD_K);
    }

    // Adaptive color-tinted liquid core (CORE_TINT = 0.87 -> rich album color inside, never flat white!)
    const deep = curPal[3];
    const main = curPal[1];
    const bright = curPal[2];
    const whiteLift = Math.max(0.06, 1 - CORE_TINT);
    const innerBody = mixCol(main, [255, 255, 255], whiteLift * 0.75);
    const innerCore = mixCol(bright, [255, 255, 255], whiteLift * 0.85);

    // Layer 1 (source-over): rich tinted back liquid swell (preserves true album color saturation)
    ectx.globalCompositeOperation = 'source-over';
    drawLiquidLayer(backWater, TIDE_PCT * 1.18, HEIGHT_PCT * 1.12, deep, main, innerBody, innerCore, 0.0, 0.62 * master, t * 2.2);

    // Layer 2 (screen): luminous front ripple tinted with album color
    ectx.globalCompositeOperation = 'screen';
    drawLiquidLayer(frontWater, TIDE_PCT * 0.88, HEIGHT_PCT * 0.96, main, bright, innerBody, innerCore, 2.1, 0.72 * master, t * 2.8);

    // Layer 3: subtle tinted bottom waterline shimmer
    const rimH = EH * (TIDE_PCT * 0.92);
    const rim = ectx.createLinearGradient(0, EH - rimH, 0, EH);
    rim.addColorStop(0, rgba(main, 0));
    rim.addColorStop(1, rgba(innerCore, 0.48 * master));
    ectx.fillStyle = rim;
    ectx.fillRect(0, EH - rimH, EW, rimH);

    ectx.globalCompositeOperation = 'source-over';
  };

  const render = (now) => {
    if (dead) return;
    raf = requestAnimationFrame(render);
    if (document.hidden) { lastFrame = now; return; }
    if (lastFrame && now - lastFrame < 32) return; // smooth ~30fps
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0.033;
    lastFrame = now;

    // Live audio-reactive smoothing & beat onset detection (works whenever PC plays audio!)
    const reactiveOn = fxMode !== 'calm';
    const freshSpec = reactiveOn && (now - specAt < 750);
    const tgtBass = freshSpec ? rawBass : 0;
    const tgtMid = freshSpec ? rawMid : 0;
    const tgtHigh = freshSpec ? rawHigh : 0;

    // Fast snappy attack, crisp rhythmic decay so every kick drum visibly pumps
    bass += (tgtBass - bass) * Math.min(1, dt * (tgtBass > bass ? 30 : 10.5));
    mid += (tgtMid - mid) * Math.min(1, dt * (tgtMid > mid ? 22 : 9));
    high += (tgtHigh - high) * Math.min(1, dt * (tgtHigh > high ? 24 : 11));

    // Adaptive auto-gain ceiling so quiet and loud songs both hit full dramatic range
    if (bass > bassMax) bassMax = bass;
    else bassMax = Math.max(0.22, bassMax - dt * 0.08);
    const normBass = Math.min(1, bass / bassMax);

    bassAvg += (normBass - bassAvg) * Math.min(1, dt * 2.4);
    const punch = freshSpec ? Math.max(0, (normBass - Math.max(0.14, bassAvg * 1.04)) * 3.4) : 0;
    if (punch > beatPulse) {
      beatPulse = Math.min(1, punch);
    } else {
      beatPulse = Math.max(0, beatPulse - dt * 4.8);
    }

    const soundActive = freshSpec && (bass > 0.025 || mid > 0.025 || high > 0.025);
    const tgtMaster = (fxMode === 'edge' && reactiveOn && soundActive) ? 1.0 : 0;
    edgeMaster += (tgtMaster - edgeMaster) * Math.min(1, dt * (tgtMaster > edgeMaster ? 8.0 : 3.0));

    // Background stays completely calm & steady in 'edge' (Viền nhịp) and 'calm' modes!
    // Only reacts to music when user explicitly selects 'ambient' (Chỉ nền) mode.
    const bgReactive = fxMode === 'ambient' && soundActive;
    const bgBass = bgReactive ? normBass : 0;
    const bgMid = bgReactive ? mid : 0;
    const bgPulse = bgReactive ? beatPulse : 0;

    // Feed beat pulse into CSS var so album cover still bounces cleanly to bass in 'edge' & 'ambient' modes
    const coverBeat = (reactiveOn && soundActive) ? Math.min(1, normBass * 0.45 + beatPulse * 0.72) : 0;
    box.style.setProperty('--beat', coverBeat.toFixed(3));
    box.style.setProperty('--glow-rgb', `${Math.round(curPal[1][0])},${Math.round(curPal[1][1])},${Math.round(curPal[1][2])}`);

    // Advance phase smoothly (calm gentle drift in 'edge' and 'calm' modes!)
    const speed = idle ? 0.22 : (playing ? (bgReactive ? 0.85 + bgBass * 1.05 + bgPulse * 1.15 : 0.82) : 0.26);
    phase += dt * speed;

    // Smooth palette crossfade on track change
    const lerpK = Math.min(1, dt * 2.4);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 3; j++) {
        curPal[i][j] += (tgtPal[i][j] - curPal[i][j]) * lerpK;
      }
    }

    // 1) Deep moody shadow base (darker center makes the luminous edge bloom pop!)
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, `rgb(${Math.round(curPal[0][0] * 0.78)},${Math.round(curPal[0][1] * 0.78)},${Math.round(curPal[0][2] * 0.78)})`);
    bg.addColorStop(1, `rgb(${Math.round(curPal[0][0] * 0.42)},${Math.round(curPal[0][1] * 0.42)},${Math.round(curPal[0][2] * 0.42)})`);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 2) Apple Music / ColorOS counter-rotating blurred album cover layers (calm & silky!)
    if (artSnap) {
      const baseAlpha = idle ? 0.24 : (playing ? Math.min(0.76, 0.50 + bgBass * 0.18 + bgPulse * 0.12) : 0.40);
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = baseAlpha;
      const ax = W * (0.5 + 0.16 * Math.sin(phase * 0.42));
      const ay = H * (0.5 + 0.16 * Math.cos(phase * 0.35));
      ctx.translate(ax, ay);
      ctx.rotate(phase * 0.22);
      const sA = W * (1.28 + 0.12 * Math.sin(phase * 0.5) + bgBass * 0.14);
      ctx.drawImage(artSnap, -sA / 2, -sA / 2, sA, sA);
      ctx.restore();

      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = baseAlpha * (0.42 + bgMid * 0.22);
      const bx = W * (0.5 + 0.2 * Math.cos(phase * 0.31 + 1.4));
      const by = H * (0.5 + 0.2 * Math.sin(phase * 0.44 + 0.7));
      ctx.translate(bx, by);
      ctx.rotate(-phase * 0.17 + 1.2);
      const sB = W * (1.42 + 0.14 * Math.cos(phase * 0.38) + bgMid * 0.12);
      ctx.drawImage(artSnap, -sB / 2, -sB / 2, sB, sB);
      ctx.restore();
    }

    // 3) Three wide-sweeping aura blobs (steady & calm in 'edge' mode)
    const reactBoost = bgReactive ? (0.78 + bgBass * 0.34 + bgPulse * 0.32) : 0.84;
    const sizeBoost = bgReactive ? (1 + bgBass * 0.18 + bgPulse * 0.14) : 1.0;
    const energy = (idle ? 0.32 : (playing ? 0.66 : 0.44)) * reactBoost;
    drawOrb(
      W * (0.5 + 0.38 * Math.sin(phase * 0.68)),
      H * (0.5 + 0.36 * Math.cos(phase * 0.51)),
      W * (0.52 + 0.08 * Math.sin(phase * 0.9)) * sizeBoost,
      curPal[1], Math.min(0.82, 0.52 * energy), 'screen',
    );
    drawOrb(
      W * (0.5 + 0.36 * Math.cos(phase * 0.55 + 2.1)),
      H * (0.5 + 0.38 * Math.sin(phase * 0.73 + 1.0)),
      W * (0.46 + 0.09 * Math.cos(phase * 0.82)) * (1 + bgMid * 0.18),
      curPal[2], Math.min(0.76, 0.44 * energy), 'screen',
    );
    drawOrb(
      W * (0.5 + 0.4 * Math.sin(phase * 0.47 + 4.0)),
      H * (0.5 + 0.34 * Math.cos(phase * 0.62 + 2.6)),
      W * (0.54 + 0.08 * Math.sin(phase * 0.64 + 1.5)) * sizeBoost,
      curPal[3], Math.min(0.8, 0.48 * energy), 'screen',
    );

    // 4) Drifting soft shadow pocket for depth
    drawOrb(
      W * (0.5 + 0.34 * Math.cos(phase * 0.49 + 3.4)),
      H * (0.5 + 0.32 * Math.sin(phase * 0.41 + 4.2)),
      W * 0.54,
      [6, 5, 12], 0.46, 'source-over',
    );
    ctx.globalCompositeOperation = 'source-over';

    // 5) Audio-Reactive Uneven Multi-Band Edge Bloom Visualizer (Realme GT 8 Pro style!)
    drawEdgeLighting(phase, dt, freshSpec, edgeMaster);
  };

  raf = requestAnimationFrame(render);
  return {
    setArt(data) {
      if (data) {
        tgtPal = data.pal;
        artSnap = data.snap;
      } else {
        tgtPal = DEFAULT_AMBIENT_PAL.map((c) => c.slice());
        artSnap = null;
      }
    },
    setState(isPlaying, isIdle) {
      playing = !!isPlaying;
      idle = !!isIdle;
    },
    setMode(mode) {
      fxMode = mode;
      if (mode !== 'edge') ectx.clearRect(0, 0, EW, EH);
    },
    feedSpectrum(bands) {
      if (!Array.isArray(bands) || bands.length < 16) return;
      // 48 log-spaced bands from 40 Hz..16 kHz
      let bSum = 0, bPeak = 0, mSum = 0, hSum = 0;
      const bEnd = Math.min(13, bands.length);
      const mEnd = Math.min(29, bands.length);
      for (let i = 0; i < bEnd; i++) {
        const v = (bands[i] || 0) / 100;
        const w = i < 7 ? 1.35 : 0.9;
        bSum += v * w;
        if (v > bPeak) bPeak = v;
      }
      for (let i = bEnd; i < mEnd; i++) mSum += (bands[i] || 0) / 100;
      for (let i = mEnd; i < bands.length; i++) hSum += (bands[i] || 0) / 100;

      const bAvg = bSum / (bEnd * 1.12);
      rawBass = Math.min(1, bAvg * 0.55 + bPeak * 0.55);
      rawMid = Math.min(1, mSum / Math.max(1, mEnd - bEnd));
      rawHigh = Math.min(1, hSum / Math.max(1, bands.length - mEnd));

      // Feed each of the 6 liquid splash zones its own independent FFT frequency slice
      for (let k = 0; k < ZONES.length; k++) {
        const z = ZONES[k];
        const i0 = Math.min(bands.length - 1, z.b0);
        const i1 = Math.min(bands.length, Math.max(i0 + 1, z.b1));
        let sum = 0, pk = 0;
        for (let i = i0; i < i1; i++) {
          const v = (bands[i] || 0) / 100;
          sum += v;
          if (v > pk) pk = v;
        }
        zoneRaw[k] = Math.min(1, (sum / (i1 - i0)) * 0.45 + pk * 0.65);
      }
      specAt = performance.now();
    },
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
    },
  };
}

const MEDIA_PILL_SVG = {
  sparkles: '<svg class="m-pill-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>',
  waves: '<svg class="m-pill-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/></svg>',
  moon: '<svg class="m-pill-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>',
  speaker: '<svg class="m-pill-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
  speakerOff: '<svg class="m-pill-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>',
};

const MUSIC_FX_MODES = [
  { id: 'edge', label: 'Viền nhịp', icon: 'sparkles' },
  { id: 'ambient', label: 'Chỉ nền', icon: 'waves' },
  { id: 'calm', label: 'Êm dịu', icon: 'moon' },
];

W.media = {
  needs: ['state', 'fast', 'tick'],
  create(box, { o, w, page } = {}) {
    const isFull = !!(o?.fullscreen || (w && w.w >= 8 && w.h >= 5));
    if (isFull) {
      box.classList.add('m-full');
      requestAnimationFrame(() => box.closest('.page')?.classList.add('page-immersive'));
    }
    const toolsHtml = isFull ? `
      <div class="m-tools">
        <button type="button" class="m-pill m-spk-btn" title="Phát nhạc PC qua điện thoại (tắt tiếng loa PC)"></button>
        <button type="button" class="m-pill m-fx-btn" title="Đổi hiệu ứng theo nhạc"></button>
      </div>` : '';
    box.innerHTML =
      '<div class="m-ambient" aria-hidden="true"><canvas class="m-canvas"></canvas><div class="m-scrim"></div></div>'
      + '<canvas class="m-edge-canvas" aria-hidden="true"></canvas>'
      + toolsHtml
      + mediaHtml();
    const q = (s) => box.querySelector(s);
    const img = q('.art'), vol = q('.volr');
    const sourceIcon = q('.m-source-icon');
    const ambient = createAmbientEngine(q('.m-canvas'), q('.m-edge-canvas'), box);

    // Saved audio-reactive visual mode ('edge' | 'ambient' | 'calm')
    let fxMode = store.get('pb-music-fx', 'edge');
    if (!MUSIC_FX_MODES.some((m) => m.id === fxMode)) fxMode = 'edge';
    ambient.setMode(fxMode);
    box.dataset.fxMode = fxMode;

    const fxBtn = q('.m-fx-btn');
    const spkBtn = q('.m-spk-btn');

    const paintFxBtn = () => {
      if (!fxBtn) return;
      const cur = MUSIC_FX_MODES.find((m) => m.id === fxMode) || MUSIC_FX_MODES[0];
      fxBtn.innerHTML = `${MEDIA_PILL_SVG[cur.icon] || ''}<span>${cur.label}</span>`;
      fxBtn.classList.toggle('on', fxMode !== 'calm');
    };
    paintFxBtn();

    if (fxBtn) {
      fxBtn.addEventListener('click', () => {
        haptic();
        const idx = MUSIC_FX_MODES.findIndex((m) => m.id === fxMode);
        fxMode = MUSIC_FX_MODES[(idx + 1) % MUSIC_FX_MODES.length].id;
        store.set('pb-music-fx', fxMode);
        ambient.setMode(fxMode);
        box.dataset.fxMode = fxMode;
        paintFxBtn();
      });
    }

    let lastSpkSig = '';
    const syncSpeakerBtn = () => {
      if (!spkBtn) return;
      if (!bridge?.speakerSet || !bridge?.micState) { spkBtn.hidden = true; return; }
      try {
        const st = JSON.parse(bridge.micState()) || {};
        const on = !!st.speakerOn;
        const live = !!st.speakerLive;
        const sig = `${on}:${live}`;
        if (sig === lastSpkSig) return;
        lastSpkSig = sig;
        spkBtn.classList.toggle('on', on);
        spkBtn.classList.toggle('live', live);
        const ico = on ? MEDIA_PILL_SVG.speaker : MEDIA_PILL_SVG.speakerOff;
        const lbl = on ? (live ? 'Nhạc Live' : 'Đang nối…') : 'Loa PC';
        spkBtn.innerHTML = `${ico}<span>${lbl}</span>`;
      } catch (_) {}
    };
    if (spkBtn) {
      syncSpeakerBtn();
      spkBtn.addEventListener('click', () => {
        haptic();
        if (!bridge?.speakerSet || !bridge?.micState) return;
        try {
          const st = JSON.parse(bridge.micState()) || {};
          bridge.speakerSet(!st.speakerOn);
          setTimeout(syncSpeakerBtn, 160);
        } catch (_) {}
      });
    }

    // Live PC audio FFT spectrum feed (only while this page is visible and reactive mode is ON)
    const onSpectrumEvent = (e) => {
      if (e?.detail?.b) ambient.feedSpectrum(e.detail.b);
    };
    window.addEventListener('phonebox-spectrum', onSpectrumEvent);

    let specTimer = 0, specAlive = true, lastSpecKeep = 0;
    const isVisibleOnScreen = () => !document.body.classList.contains('night')
      && box.isConnected
      && (!page || pages[curPage] === page)
      && !box.closest('.stack-item:not(.active)');

    const keepSpectrum = async () => {
      if (!specAlive) return;
      let fast = false;
      if (fxMode !== 'calm' && isVisibleOnScreen()) {
        const stream = streaming();
        fast = !stream;
        if (!stream || Date.now() - lastSpecKeep >= 2000) {
          try {
            const r = await api('/spectrum', 'GET', 1500);
            lastSpecKeep = Date.now();
            if (r?.b) ambient.feedSpectrum(r.b);
          } catch (_) {}
        }
      }
      if (specAlive) specTimer = setTimeout(keepSpectrum, fast ? 45 : 300);
    };
    specTimer = setTimeout(keepSpectrum, 350);

    const applyAmbient = (data) => {
      ambient.setArt(data);
      box.classList.toggle('has-art', !!data);
    };
    const sourceIcons = {
      YouTube: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="4" width="22" height="16" rx="5" fill="#ff0033"/><path d="m10 8 6 4-6 4z" fill="#fff"/></svg>',
      'YouTube Music': '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#ff0033"/><circle cx="12" cy="12" r="6.5" fill="none" stroke="#fff" stroke-width="1.4"/><path d="m10 8.5 5.5 3.5-5.5 3.5z" fill="#fff"/></svg>',
      'Internet Radio': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.2 6.8 18.5 2a1 1 0 0 1 .7 1.9L10.8 7H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2.2zm1.8 5.2a3 3 0 1 0 0 6 3 3 0 0 0 0-6zm6 1.5v1.8h4v-1.8h-4zm0 3.2v1.8h4v-1.8h-4z" fill="#38bdf8"/></svg>',
    };
    let artId = -1, volTimer = 0, volumeRelease = 0;
    img.addEventListener('load', () => {
      img.classList.add('on');
      setArtColor(averageColor(img));
      applyAmbient(extractAmbientData(img));
    });
    img.addEventListener('error', () => { img.classList.remove('on'); applyAmbient(null); });
    box.querySelectorAll('[data-media]').forEach((btn) => btn.addEventListener('click', async () => {
      haptic();
      const action = btn.dataset.media;
      if (action === 'playpause' && media) {
        media.playing = !media.playing; // optimistic update
        media.at = performance.now();
        box.classList.toggle('playing', media.playing);
        ambient.setState(media.playing, false);
      }
      try {
        const res = await api('/media/' + action, 'POST');
        if (res && typeof res === 'object' && 'media' in res) setMediaState(res.media);
        invalidateDeckState();
        emit('tick');
      } catch (_) {}
    }));
    q('.bar').addEventListener('click', async (e) => {
      if (!media || !media.durMs || !media.canSeek) return;
      const r = e.currentTarget.getBoundingClientRect();
      const ms = Math.round(((e.clientX - r.left) / r.width) * media.durMs);
      haptic();
      media.posMs = ms; media.at = performance.now();
      try { await api('/media/seek?ms=' + ms, 'POST'); } catch (_) {}
    });
    const paintVol = (v) => { vol.style.setProperty('--p', v + '%'); q('.vol-val').textContent = v; };
    const cancelVolumeDrag = () => {
      clearTimeout(volTimer);
      clearTimeout(volumeRelease);
      setVolDragging(vol, false);
    };
    // Prevent #pager horizontal swipe from stealing volume slider or seek bar drags
    const stopSwipe = (e) => e.stopPropagation();
    vol.addEventListener('pointerdown', stopSwipe);
    vol.addEventListener('touchstart', stopSwipe, { passive: true });
    q('.bar').addEventListener('pointerdown', stopSwipe);
    q('.bar').addEventListener('touchstart', stopSwipe, { passive: true });
    vol.addEventListener('input', () => {
      clearTimeout(volumeRelease);
      setVolDragging(vol, true);
      paintVol(vol.value);
      clearTimeout(volTimer);
      volTimer = setTimeout(() => api('/volume?level=' + vol.value, 'POST').catch(() => {}), 60);
    });
    vol.addEventListener('change', () => {
      clearTimeout(volTimer);
      api('/volume?level=' + vol.value, 'POST').catch(() => {});
      clearTimeout(volumeRelease);
      volumeRelease = setTimeout(() => setVolDragging(vol, false), 600);
    });
    vol.addEventListener('pointercancel', cancelVolumeDrag);
    q('.mute').addEventListener('click', async () => {
      haptic();
      if ((!D.state?.audio || D.state.audio.canControl === false)) return;
      try { const a = await api('/volume?op=mute', 'POST'); D.state.audio = a; emit('state'); } catch (_) {}
    });

    return {
      update(kind) {
        if (kind === 'tick') { syncSpeakerBtn(); return; }
        if (kind === 'fast') {
          if (!media) return;
          if (media.durMs > 0) {
            const pos = Math.min(media.durMs, media.posMs + (media.playing ? performance.now() - media.at : 0));
            q('.fill').style.width = (pos / media.durMs) * 100 + '%';
            q('.m-pos').textContent = fmtTime(pos);
          } else if (media.app === 'Internet Radio') {
            const pos = Math.max(0, (media.posMs || 0) + (media.playing ? performance.now() - media.at : 0));
            q('.fill').style.width = media.playing ? '100%' : '0';
            q('.m-pos').textContent = fmtTime(pos);
          }
          return;
        }
        syncSpeakerBtn();
        const m = D.state?.media, a = D.state?.audio;
        vol.disabled = (!a || a.canControl === false);
        box.classList.toggle('volume-unavailable', (!a || a.canControl === false));
        q('.mute').disabled = (!a || a.canControl === false);
        box.classList.toggle('muted-on', !!a?.muted);
        if (a) {
          if (!volDragging) { vol.value = a.volume; paintVol(a.volume); }
        } else q('.vol-val').textContent = 'n/a';
        box.classList.toggle('idle', !m);
        if (!m) {
          box.classList.remove('playing');
          ambient.setState(false, true);
          q('.m-app-name').textContent = 'Media';
          sourceIcon.replaceChildren();
          q('.m-title').textContent = t('w.nothingPlaying');
          q('.m-artist').textContent = t('w.pressToResume');
          q('.fill').style.width = '0';
          q('.m-pos').textContent = q('.m-dur').textContent = '0:00';
          if (artId !== 0) { artId = 0; img.classList.remove('on'); setArtColor(null); applyAmbient(null); }
          return;
        }
        box.classList.toggle('playing', m.playing);
        ambient.setState(m.playing, false);
        q('.m-app-name').textContent = m.app || 'Media';
        sourceIcon.innerHTML = sourceIcons[m.app] || '';
        q('.m-title').textContent = m.title || 'Unknown track';
        q('.m-artist').textContent = [m.artist, m.album].filter(Boolean).join(' · ') || '—';
        if (m.app === 'Internet Radio' && !(m.durMs > 0)) {
          q('.fill').style.width = m.playing ? '100%' : '0';
          q('.m-pos').textContent = fmtTime(m.posMs || 0);
          q('.m-dur').textContent = m.playing ? 'LIVE' : '0:00';
        } else {
          q('.m-dur').textContent = fmtTime(m.durMs);
        }
        if (m.artId !== artId) {
          artId = m.artId;
          if (m.artId) img.src = `${API}/art?id=${m.artId}`;
          else { img.classList.remove('on'); setArtColor(null); applyAmbient(null); }
        }
      },
      destroy() {
        specAlive = false;
        clearTimeout(specTimer);
        window.removeEventListener('phonebox-spectrum', onSpectrumEvent);
        cancelVolumeDrag();
        ambient.destroy();
      },
    };
  },
};

W.stat = {
  needs: ['state'],
  create(box, { o }) {
    const m = METRICS[o.metric] || METRICS.cpu;
    const c = color(m.color);
    box.style.setProperty('--c', c);
    const canvas = h('canvas');
    const lbl = h('div', 't-label', m.label);
    const val = h('b', null, '—'), unit = h('small'), sub = h('div', 't-sub', ' ');
    box.append(canvas, lbl, h('div', 't-val', val, unit), sub);
    if (o.metric === 'cpu' || o.metric === 'ram') bindProcessLink(box, o.metric === 'cpu' ? 'cpu' : 'mem');
    return {
      update() {
        const s = D.state;
        if (!s) return;
        const [v, u] = metricText(m, s);
        val.textContent = v;
        unit.textContent = u;
        const pctVal = m.pct?.(s);
        lbl.textContent = pctVal != null && m.label === 'RAM' ? `RAM (${Math.round(pctVal)}%)` : m.label;
        sub.textContent = m.sub?.(s) || ' ';
        chart(canvas, [{ data: hist[m.hist || o.metric] || hist.cpu, color: c, max: m.max(s) }]);
      },
    };
  },
};

W.gauge = {
  needs: ['state'],
  create(box, { o }) {
    const m = METRICS[o.metric] || METRICS.cpu;
    box.style.setProperty('--q', color(m.color));
    const dial = h('div', 'g-dial'), pct = h('div', 'g-val'), sub = h('div', 'g-sub');
    box.append(dial, h('div', 'g-label', m.label), sub);
    dial.append(pct);
    if (o.metric === 'cpu' || o.metric === 'ram') bindProcessLink(box, o.metric === 'cpu' ? 'cpu' : 'mem');
    let svg = null;
    return {
      update() {
        const s = D.state;
        if (!s) return;
        const raw = m.pct ? m.pct(s) : m.val(s);
        const p = raw == null ? 0 : (raw / (m.pct ? 100 : m.max(s))) * 100;
        const warn = m.hot ? (raw > m.hot[1] ? '#ef4444' : raw > m.hot[0] ? '#f59e0b' : '') : (p >= 95 ? '#ef4444' : p >= 85 ? '#f59e0b' : '');
        dial.style.setProperty('--qc', warn || 'var(--q)');
        if (svg) svg.remove();
        dial.insertAdjacentHTML('afterbegin', ringSvg(p));
        svg = dial.firstElementChild;
        const [v, u] = metricText(m, s);
        pct.replaceChildren(v, h('small', null, u));
        sub.textContent = m.sub?.(s) || '';
      },
    };
  },
};

W.chart = {
  needs: ['state'],
  create(box, { o }) {
    // a list of only unknown names falls back like no list at all; own keys only, so "constructor" is unknown too
    const keys = (Array.isArray(o.metrics) && o.metrics.length ? o.metrics : ['cpu']).filter((k) => Object.prototype.hasOwnProperty.call(METRICS, k));
    if (!keys.length) keys.push('cpu');
    const single = keys.length === 1 ? METRICS[keys[0]] : null;
    const isNet = keys.every((k) => k === 'down' || k === 'up');
    const label = single ? single.name : isNet ? 'Network' : keys.map((k) => METRICS[k].name).join(' · ');
    box.style.setProperty('--c', color((single || METRICS[keys[0]]).color));
    const head = h('div', 's-head', h('span', 's-label', label), h('span', 's-name', ''));
    const main = h('div', 's-main');
    const canvas = h('canvas');
    box.append(head, main, canvas);
    if (keys.includes('cpu') || keys.includes('ram')) bindProcessLink(box, keys.includes('cpu') ? 'cpu' : 'mem');
    return {
      update() {
        const s = D.state;
        if (!s) return;
        if (single) {
          const [v, u] = metricText(single, s);
          main.replaceChildren(h('b', null, v), h('small', null, u), h('span', 'chips', single.sub?.(s) ? h('span', 'chip', single.sub(s)) : ''));
          head.lastChild.textContent = single.title?.(s) || '';
        } else {
          main.replaceChildren(...keys.map((k) => {
            const mm = METRICS[k];
            const [v, u] = metricText(mm, s);
            const e = h('span', 'multi', (k === 'down' ? '↓ ' : k === 'up' ? '↑ ' : mm.label + ' '), h('b', null, v + ' ' + u));
            e.style.color = color(mm.color);
            return e;
          }));
          head.lastChild.textContent = isNet && s.ping ? `Ping ${s.ping.ms != null ? Math.round(s.ping.ms) + ' ms' : '—'} · loss ${s.ping.lossPct}%` : '';
        }
        chart(canvas, keys.map((k) => ({ data: hist[METRICS[k].hist || k], color: color(METRICS[k].color), max: METRICS[k].max(s) })), { grid: true });
      },
    };
  },
};

W.meters = {
  needs: ['state'],
  create(box) {
    box.style.setProperty('--c', cssVar('--ram'));
    const up = h('span', 's-name');
    const list = h('div', 'meters');
    box.append(h('div', 's-head', h('span', 's-label', t('w.memory')), up), list);
    bindProcessLink(box, 'mem');
    const meter = (name, txt, pct, c) => {
      const e = h('div', 'meter', h('div', 'm-row', h('span', null, name), h('span', null, txt)), h('div', 'track', h('i')));
      e.querySelector('i').style.width = Math.min(100, pct) + '%';
      if (c) e.style.setProperty('--c', c);
      return e;
    };
    return {
      update() {
        const pc = D.state?.pc;
        if (!pc) return;
        const s = pc.uptimeSec, d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
        up.textContent = 'Up ' + (d ? `${d} d ${hr} h` : hr ? `${hr} h ${m} min` : `${m} min`);
        const rows = [meter('RAM', `${r1(pc.ramUsedGb)} / ${Math.round(pc.ramTotalGb)} GB`, (pc.ramUsedGb / pc.ramTotalGb) * 100)];
        // one row per GPU (the integrated one counts its shared memory); named once there is more than one
        const gpus = gpusOf(D.state);
        for (const g of gpus) {
          const m = gpuMem(g);
          if (m) rows.push(meter(gpus.length > 1 ? `${m.label === 'VRAM' ? 'VRAM' : 'GPU'} · ${shortGpu(g.name)}` : m.label === 'VRAM' ? 'VRAM' : 'GPU MEMORY',
            `${r1(m.used)} / ${Math.round(m.total)} GB`, (m.used / m.total) * 100, cssVar('--gpu')));
        }
        const disks = h('div', 'disks', ...(pc.disks || []).map((dk) => meter(dk.name === '/' ? 'DISK' : dk.name, Math.round((dk.usedGb / dk.totalGb) * 100) + '%', (dk.usedGb / dk.totalGb) * 100, '#94a3b8')));
        list.replaceChildren(...rows, disks);
      },
    };
  },
};

W.quotas = {
  needs: ['quotas', 'tick'],
  /**
   * Creates the AI Quotas widget instance with optional paged provider rotation.
   */
  create(box, { o }) {
    const tokens = (n) => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
    const grid = h('div', 'q-grid', h('div', 'empty', 'Quota data arrives once the computer is connected.'));
    const cxPicker = h('div', 'ag-picker cx-picker hidden');
    const cxPickerHead = h('div', 'ag-picker-head');
    const cxTitleImg = new Image();
    cxTitleImg.className = 'ag-title-icon';
    cxTitleImg.alt = '';
    cxTitleImg.src = `${API}/shortcuts/icon?id=codex`;
    const cxPickerTitle = h('span', 'ag-picker-title cx-picker-title', cxTitleImg, h('span', null, 'Mở phiên Codex trên PC (codex://)'));
    const cxPickerClose = h('button', 'ag-picker-close', '✕');
    cxPickerClose.type = 'button';
    cxPickerHead.append(cxPickerTitle, cxPickerClose);
    const cxFilterRow = h('div', 'ag-filter-row');
    const cxConvoList = h('div', 'ag-convo-list');
    cxConvoList.addEventListener('pointerdown', (e) => e.stopPropagation(), { passive: true });
    cxConvoList.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    cxConvoList.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
    cxPicker.append(cxPickerHead, cxFilterRow, cxConvoList);
    box.append(grid, cxPicker);

    let cxData = { currentConvId: '', projects: [], conversations: [] };
    let cxFilter = 'Tất cả';

    const renderCodexPicker = () => {
      const projs = cxData.projects && cxData.projects.length ? cxData.projects : ['Tất cả'];
      cxFilterRow.replaceChildren(...projs.map((pr) => {
        const chip = h('button', 'ag-filter-chip' + (pr === cxFilter ? ' on' : ''), pr);
        chip.type = 'button';
        chip.addEventListener('click', (e) => {
          e.stopPropagation();
          haptic();
          cxFilter = pr;
          renderCodexPicker();
        });
        return chip;
      }));
      const convos = (cxData.conversations || []).filter((c) => {
        if (cxFilter === 'Tất cả') return true;
        return (c.projectName || 'General').toLowerCase() === cxFilter.toLowerCase();
      });
      if (!convos.length) {
        cxConvoList.replaceChildren(h('div', 'ag-empty', 'Không tìm thấy phiên Codex nào'));
        return;
      }
      cxConvoList.replaceChildren(...convos.map((c) => {
        const it = h('button', 'ag-convo-item' + (c.isActive ? ' active' : ''));
        it.type = 'button';
        it.addEventListener('click', async (e) => {
          e.stopPropagation();
          haptic();
          cxPicker.classList.add('hidden');
          try {
            const r = await fetch(`${API}/codex/select?convId=${encodeURIComponent(c.id)}`, { method: 'POST', headers: PANEL_HEADERS });
            const res = r.ok ? await r.json().catch(() => null) : null;
            if (r.ok && res?.openedDesktop) {
              toast(`Đã mở Codex PC: ${c.title || 'Thread'}`);
            } else if (r.ok) {
              toast(`Đã chọn phiên: ${c.title || 'Thread'}`);
            } else {
              toast('Không mở được phiên Codex', 'err');
            }
          } catch (_) {
            toast('Lỗi kết nối PC Agent', 'err');
          }
        });
        let dateStr = '';
        try {
          const d = new Date(c.lastModified);
          dateStr = `${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        } catch (_) {}
        const top = h('div', 'ag-convo-top',
          h('span', 'ag-convo-tag', c.projectName || 'General'),
          h('div', 'ag-convo-name', c.title || 'Untitled'));
        const meta = h('div', 'ag-convo-meta',
          dateStr ? h('span', null, dateStr) : null,
          c.stepCount ? h('span', null, `${c.stepCount} tin nhắn`) : null);
        it.append(h('div', 'ag-convo-item-body', top, meta));
        if (c.isActive) it.append(h('span', 'ag-convo-check', '✓'));
        return it;
      }));
    };

    const openCodexPicker = async () => {
      cxPicker.classList.remove('hidden');
      cxConvoList.replaceChildren(h('div', 'ag-empty', 'Đang tải danh sách phiên Codex…'));
      try {
        const r = await fetch(`${API}/codex/conversations`, { cache: 'no-store', headers: PANEL_HEADERS });
        if (r.ok) {
          cxData = await r.json();
          renderCodexPicker();
        } else {
          cxConvoList.replaceChildren(h('div', 'ag-empty', 'Không tải được danh sách phiên'));
        }
      } catch (_) {
        cxConvoList.replaceChildren(h('div', 'ag-empty', 'Lỗi kết nối PC Agent'));
      }
    };

    cxPickerClose.addEventListener('click', (e) => {
      e.stopPropagation();
      cxPicker.classList.add('hidden');
    });
    let last = 0;
    let offset = 0;
    let lastRotate = Date.now();

    const isRotateEnabled = () => {
      if (o.rotate !== undefined && o.rotate !== null) return !!o.rotate;
      if (cfg.codexBar?.rotate !== undefined && cfg.codexBar?.rotate !== null) return !!cfg.codexBar.rotate;
      return true;
    };

    const getPageSize = () => {
      if (o.pageSize !== undefined && o.pageSize !== null && o.pageSize !== '') {
        const n = Number(o.pageSize);
        return Number.isFinite(n) ? Math.max(0, Math.min(6, Math.floor(n))) : 2;
      }
      return cfg.codexBar?.pageSize ?? 2;
    };

    const getRotateInterval = () => {
      if (!isRotateEnabled()) return 0;
      if (o.rotateInterval !== undefined && o.rotateInterval !== null && o.rotateInterval !== '') {
        const n = Number(o.rotateInterval);
        return Number.isFinite(n) ? Math.max(2, Math.min(300, n)) : 8;
      }
      return cfg.codexBar?.rotateInterval ?? 8;
    };

    const getProviders = () => {
      if (Array.isArray(o.providers)) return o.providers;
      if (Array.isArray(cfg.codexBar?.providers)) return cfg.codexBar.providers;
      return ['claude', 'codex', 'antigravity'];
    };

    const isOverviewEnabled = () => o.showOverview === true;

    const getItems = () => {
      const want = getProviders();
      const items = quotaProviders().filter((p) => want.includes(p.id));
      if (isOverviewEnabled() && D.quotas?.overview) {
        return [{ id: '__overview__', isOverview: true, overview: D.quotas.overview }, ...items];
      }
      return items;
    };

    const fmtCurrency = (amount, code = 'USD') => {
      const n = Number(amount || 0);
      const cur = (code || 'USD').toUpperCase();
      try { return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: cur }).format(n); }
      catch (_) { return `${cur === 'USD' ? '$' : cur + ' '}${n.toFixed(2)}`; }
    };

    const renderOverviewCard = (ov, flexVal) => {
      const card = h('div', 'q-card q-overview-card');
      card.style.setProperty('--q', '#f97316');
      card.style.flex = flexVal;
      const days = ov.windowDays || 30;
      const age = ov.updatedAt ? Math.max(0, Date.now() - ov.updatedAt) : null;
      const updStr = age != null ? `checked ${age < 60_000 ? 'just now' : fmtDur(age) + ' ago'}` : '';
      card.appendChild(h('div', 'q-head',
        h('span', 'q-logo', '📊'),
        h('span', 'q-name', 'Overview'),
        h('span', 'q-plan', `${days}-day spend`),
        updStr ? h('span', 'q-upd', updStr) : null
      ));
      const summary = h('div', 'q-ov-hero',
        h('div', 'q-ov-stat', h('span', 'q-ov-lbl', 'Estimated spend'), h('strong', 'q-ov-val', fmtCurrency(ov.totalCost, ov.currencyCode))),
        h('div', 'q-ov-stat', h('span', 'q-ov-lbl', 'Recorded tokens'), h('strong', 'q-ov-val', tokens(ov.totalTokens || 0)))
      );
      card.appendChild(summary);
      const details = h('div', 'q-details q-ov-details');
      for (const s of (ov.subscriptions || []).slice(0, 3)) {
        details.appendChild(h('div', 'q-detail',
          h('span', null, s.name),
          h('strong', null, `${tokens(s.tokens)} · ${fmtCurrency(s.cost, s.currencyCode || ov.currencyCode)}`)
        ));
      }
      for (const m of (ov.topModels || []).slice(0, 2)) {
        details.appendChild(h('div', 'q-detail q-breakdown',
          h('span', null, m.modelName || m.name),
          h('strong', null, fmtCurrency(m.cost, m.currencyCode || ov.currencyCode))
        ));
      }
      if (details.childNodes.length) card.appendChild(details);
      const count = ov.providerCount ?? (ov.subscriptions || []).length;
      card.appendChild(h('div', 'q-foot', h('span', null, `${count} ${count === 1 ? 'provider' : 'providers'}`), h('span')));
      return card;
    };

    const render = () => {
      if (!D.quotas) return;
      const want = getProviders();
      const list = getItems();
      grid.replaceChildren();
      if (!list.length) { grid.appendChild(h('div', 'empty', want.length ? 'Quota data is unavailable for the selected providers' : 'No quota providers enabled')); return; }

      const ps = getPageSize();
      const needsPaging = isRotateEnabled() && ps > 0 && list.length > ps;
      if (offset >= list.length) offset = 0;

      let visible = list;
      if (needsPaging) {
        visible = [];
        for (let i = 0; i < ps; i++) {
          visible.push(list[(offset + i) % list.length]);
        }
      }

      for (const p of visible) {
        if (p.isOverview) {
          grid.appendChild(renderOverviewCard(p.overview, needsPaging && ps === 2 ? '1 1 0' : '1.5'));
          continue;
        }
        const st = Q_STYLE[p.id] || { color: '#94a3b8', logo: '●' };
        const compact = p.limits.length >= 4;
        const five = p.limits.length >= 5;
        const card = h('div', 'q-card' + (compact ? ' q-card-compact' : ''));
        card.style.setProperty('--q', st.color);
        card.style.flex = needsPaging && ps === 2 ? '1 1 0' : String(Math.max(1, p.limits.length) + 0.3);
        const logoEl = h('span', 'q-logo', st.logo);
        if (st.iconId) {
          const img = new Image();
          img.className = 'q-logo-img';
          img.alt = '';
          img.onload = () => { logoEl.replaceChildren(img); logoEl.classList.add('q-logo-has-img'); };
          img.src = `${API}/shortcuts/icon?id=${encodeURIComponent(st.iconId)}`;
        }
        let cxSessBtn = null;
        if (p.id === 'codex') {
          cxSessBtn = h('button', 'cx-sess-btn');
          cxSessBtn.type = 'button';
          cxSessBtn.innerHTML = '<svg class="cx-sess-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>Chọn phiên</span>';
          cxSessBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            haptic();
            openCodexPicker();
          });
        }
        card.appendChild(h('div', 'q-head', logoEl, h('span', 'q-name', p.name), h('span', 'q-plan', p.plan), cxSessBtn,
          p.updatedAt ? h('span', 'q-upd', fmtDur(Date.now() - p.updatedAt) + ' ago') : null));
        const rings = h('div', 'q-rings' + (five ? ' q-rings-5' : compact ? ' q-rings-grid' : ''));
        for (const l of p.limits) {
          const pace = paceInfo(l);
          const dial = h('div', 'q-dial');
          if (compact && !five) {
            dial.style.width = '86px';
            dial.style.height = '86px';
          }
          if (l.percent >= 95 || l.severity === 'critical') dial.style.setProperty('--qc', '#ef4444');
          else if (l.percent >= 80 || l.severity === 'warning') dial.style.setProperty('--qc', '#f59e0b');
          dial.innerHTML = ringSvg(l.percent, pace?.elapsed); // numbers only
          const pctEl = h('div', 'q-pct', String(Math.round(l.percent)), h('small', null, '%'));
          if (compact && !five) pctEl.style.fontSize = 'calc(22px * var(--widget-font-scale, 1))';
          dial.appendChild(pctEl);
          rings.appendChild(h('div', 'q-ring', dial, h('div', 'q-label', l.label), p.id === 'codex' ? h('div', 'q-left', `${Math.max(0, Math.round(100 - l.percent))}% left`) : null, h('div', 'q-reset', fmtReset(l.resetsAt)),
            pace ? h('div', 'q-pace ' + pace.cls, pace.text) : null));
        }
        if (!p.limits.length) rings.appendChild(h('div', 'q-reset', 'No data'));
        card.append(rings);
        if (p.id === 'codex' && p.codex) {
          const c = p.codex;
          const details = h('div', 'q-details');
          if (c.model) details.append(h('div', 'q-detail', h('span', null, 'Latest local session'), h('strong', null, c.model + (c.effort ? ` · ${c.effort}` : ''))));
          if (c.totalTokens != null) details.append(h('div', 'q-detail', h('span', null, 'Session tokens'), h('strong', null, tokens(c.totalTokens))));
          if (c.totalInput != null || c.totalOutput != null) details.append(h('div', 'q-detail q-breakdown', `In ${tokens(c.totalInput)} · Out ${tokens(c.totalOutput)} · Cached ${tokens(c.totalCached)} · Reasoning ${tokens(c.totalReasoning)}`));
          if (c.lastInput != null && c.contextWindow) details.append(h('div', 'q-detail q-breakdown', `Last input ${tokens(c.lastInput)} / ${tokens(c.contextWindow)} context window`));
          if (details.childNodes.length) card.append(details);
        }
        card.append(h('div', 'q-foot', h('span', p.extra?.startsWith('Limit reached') ? 'q-alert' : null, p.extra || ''), p.error ? h('span', 'q-err', p.error) : h('span')));

        grid.appendChild(card);
      }

      if (needsPaging) {
        const dots = h('div', 'q-dots');
        for (let i = 0; i < list.length; i++) {
          const dot = h('span', 'q-dot' + (i === offset ? ' active' : ''));
          dot.onclick = (e) => {
            e.stopPropagation();
            offset = i;
            lastRotate = Date.now();
            render();
            haptic();
          };
          dots.appendChild(dot);
        }
        grid.appendChild(dots);
      }
    };

    grid.onclick = () => {
      const ps = getPageSize();
      const list = getItems();
      if (ps > 0 && list.length > ps) {
        offset = (offset + 1) % list.length;
        lastRotate = Date.now();
        render();
        haptic();
      }
    };

    /**
     * Checks whether an enclosing Smart Stack widget has paused rotation.
     */
    const isStackPaused = () => box.closest('.w-stack')?.dataset.stackPaused === '1';

    return {
      /**
       * Updates quota display and advances paged provider rotation on ticks.
       */
      update(kind) {
        if (kind === 'tick') {
          const sec = getRotateInterval();
          if (isStackPaused()) {
            lastRotate = Date.now();
          } else if (sec > 0 && Date.now() - lastRotate >= sec * 1000) {
            const ps = getPageSize();
            const list = getItems();
            if (ps > 0 && list.length > ps) {
              offset = (offset + 1) % list.length;
              lastRotate = Date.now();
              render();
            }
          }
          if (Date.now() - last > 30_000) { last = Date.now(); render(); }
          return;
        }
        last = Date.now();
        render();
      },
    };
  },
};

W.codexbar = W.quotas;

W.sessions = {
  needs: ['work', 'tick'],
  create(box) {
    const sum = h('span', 'w-sum');
    const list = h('div', 's-list', h('div', 'empty', t('sess.waitingData')));
    box.append(h('div', 'w-head', h('span', 's-label', t('w.sessions')), sum), list);
    box.style.setProperty('--c', '#d97757');
    const tokens = (n) => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
    const statusText = (s) => s.status === 'busy' ? t('sess.working') : s.status === 'waiting' ? t('sess.waiting') : s.status === 'shell' ? t('sess.shell') : s.outcome === 'completed' ? t('sess.completed') : s.outcome === 'aborted' ? t('sess.aborted') : t('sess.idle');
    const ageText = (since) => Date.now() - since < 60_000 ? 'just now' : shortDur(Date.now() - since) + ' ago';
    const openDetails = (s) => {
      haptic();
      const backdrop = h('div', 'session-backdrop');
      const panel = h('div', 'session-panel');
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      const title = h('h2', null, s.project || s.name);
      const close = h('button', 'session-close', '✕');
      close.setAttribute('aria-label', 'Close session details');
      const onKey = (e) => { if (e.key === 'Escape') dismiss(); };
      const dismiss = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
      close.addEventListener('click', dismiss);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) dismiss(); });
      panel.append(h('div', 'session-panel-head', h('span', null, s.tool === 'codex' ? '◎ Codex' : '✳ Claude Code'), close), title);
      const rows = [
        ['Status', statusText(s)],
        ['Started', s.startedAt ? ageText(s.startedAt) : null],
        ['Last activity', s.since ? ageText(s.since) : null],
        ['Current turn', s.status === 'busy' && s.turnStartedAt ? shortDur(Date.now() - s.turnStartedAt) : null],
        ['Model', s.model], ['Reasoning', s.effort],
        ['Session tokens', s.totalTokens != null ? tokens(s.totalTokens) : null],
        ['Input / output', s.inputTokens != null || s.outputTokens != null ? `${tokens(s.inputTokens)} / ${tokens(s.outputTokens)}` : null],
        ['Cached input', s.cachedInputTokens != null ? tokens(s.cachedInputTokens) : null],
        ['Reasoning output', s.reasoningTokens != null ? tokens(s.reasoningTokens) : null],
        ['Last input / context window', s.lastInputTokens != null && s.contextWindow ? `${tokens(s.lastInputTokens)} / ${tokens(s.contextWindow)}` : null],
        ['Recent tool', s.lastTool],
      ];
      for (const [label, value] of rows) if (value != null) panel.append(h('div', 'session-detail-row', h('span', null, label), h('strong', null, value)));
      if (s.tool === 'codex') panel.append(h('p', 'session-note', 'Token totals are for this local session, not your account allowance.'));
      backdrop.append(panel);
      document.body.append(backdrop);
      close.focus();
      document.addEventListener('keydown', onKey);
    };
    return {
      update() {
        const sessions = D.work?.sessions;
        if (!sessions) return;
        const counts = { waiting: 0, busy: 0, shell: 0, idle: 0 };
        sessions.forEach((s) => (counts[s.status] = (counts[s.status] || 0) + 1));
        sum.textContent = [
          counts.busy + counts.shell ? `${counts.busy + counts.shell} working` : '',
          counts.waiting ? `${counts.waiting} waiting` : '',
          counts.idle ? `${counts.idle} idle` : '',
        ].filter(Boolean).join(' · ') || t('w.noOpenSessions');
        const sorted = [...sessions].sort((a, b) => (S_ORDER[a.status] ?? 9) - (S_ORDER[b.status] ?? 9) || b.since - a.since);
        const rows = sorted.length ? sorted.map((s) => {
          const row = h('button', 'sess ' + s.status,
            h('span', 'st'), h('span', 'tl ' + s.tool, s.tool === 'claude' ? '✳' : '◎'),
            h('span', 'sess-main', h('span', 'nm', s.project || s.name), h('span', 'sess-meta', [s.model, s.effort].filter(Boolean).join(' · ') || statusText(s))),
            h('span', 'ds', shortDur(Date.now() - s.since)));
          row.type = 'button';
          row.addEventListener('click', () => openDetails(s));
          return row;
        }) : [h('div', 'empty', t('w.noAiSessions'))];
        list.replaceChildren(...rows);
      },
    };
  },
};

W.github = {
  needs: ['work'],
  create(box) {
    box.style.setProperty('--c', '#c9d1d9');
    const user = h('span', 'w-sum'), bell = h('span', 'gh-bell');
    const rc = h('b'), mc = h('b'), rev = h('div', 'gh-list'), mine = h('div', 'gh-list'), err = h('div', 'gh-err', 'Waiting for GitHub data…');
    box.append(h('div', 'w-head', h('span', 's-label', 'GitHub'), user, bell),
      h('div', 'gh-sec', h('span', null, 'Review requests'), rc), rev,
      h('div', 'gh-sec', h('span', null, 'My pull requests'), mc), mine, err);
    return {
      update() {
        const g = D.work?.github;
        if (!g) return;
        const rows = Math.max(1, Math.floor((box.clientHeight - 90) / 25));
        user.textContent = g.user ? '@' + g.user : '';
        bell.textContent = `🔔 ${g.notifications >= 50 ? '50+' : g.notifications}`;
        rc.textContent = g.reviewRequests.length;
        mc.textContent = g.myPrs.length;
        const nRev = Math.min(g.reviewRequests.length || 1, Math.max(1, Math.floor(rows / 2)));
        rev.replaceChildren(...(g.reviewRequests.length ? g.reviewRequests.slice(0, nRev).map((p) => prRow(p, false)) : [h('div', 'gh-pr', t('w.noReviews'))]));
        mine.replaceChildren(...(g.myPrs.length ? g.myPrs.slice(0, Math.max(1, rows - nRev)).map((p) => prRow(p, true)) : [h('div', 'gh-pr', t('w.noPrs'))]));
        err.textContent = g.error ? 'GitHub: ' + g.error : '';
      },
    };
  },
};

W.processes = {
  needs: ['procs', 'state'],
  create(box, { o }) {
    const canKill = o.allowKill !== false;
    let sort = currentProcessesSort();
    const sum = h('span', 'p-sum');
    const seg = h('div', 'seg', h('button', sort === 'cpu' ? 'on' : null, 'CPU'), h('button', sort === 'mem' ? 'on' : null, 'RAM'));
    const grid = h('div', 'p-grid', h('div', 'empty', t('w.procsWait')));
    box.style.setProperty('--c', '#f472b6');
    box.append(h('div', 'p-head', h('span', 's-label', t('w.processes')), sum, seg), grid);
    const els = new Map();
    const rowEl = (g) => {
      let e = els.get(g.name);
      if (e) return e;
      e = h('div', 'proc');
      e.innerHTML = '<div class="p-ico"></div><div class="p-info"><div class="p-title"><span class="p-t"></span><span class="p-count"></span><span class="p-lock"></span></div>' +
        '<div class="p-bar"><i></i></div></div><div class="p-nums"><b></b><small></small></div>';
      fillIcon(e.querySelector('.p-ico'), g);
      e.addEventListener('click', () => { haptic(); openSheet(e._g, canKill); });
      els.set(g.name, e);
      return e;
    };
    const render = () => {
      const data = D.procs;
      if (!data) return;
      if (!data.groups.length) { sum.textContent = ''; grid.replaceChildren(h('div', 'empty', t('w.measuring'))); return; }
      const cols = box.clientWidth > 460 ? 2 : 1;
      const rows = Math.max(1, Math.floor((box.clientHeight - 46) / 40));
      grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
      const list = [...data.groups].sort((a, b) => (sort === 'cpu' ? b.cpu - a.cpu || b.memMb - a.memMb : b.memMb - a.memMb)).slice(0, cols * rows);
      const max = Math.max(0.1, ...list.map((g) => (sort === 'cpu' ? g.cpu : g.memMb)));
      const pc = D.state?.pc;
      const cpuPct = pc && pc.cpu != null ? Math.round(pc.cpu) : null;
      const ramPct = pc && pc.ramTotalGb ? Math.round((pc.ramUsedGb / pc.ramTotalGb) * 100) : null;
      const ramStr = ramPct != null && pc.ramUsedGb != null && pc.ramTotalGb != null
        ? `Total RAM ${ramPct}% (${Math.round(pc.ramUsedGb)}/${Math.round(pc.ramTotalGb)} GB) · `
        : (ramPct != null ? `Total RAM ${ramPct}% · ` : '');
      const loadPart = sort === 'cpu'
        ? (cpuPct != null ? `Total CPU ${cpuPct}% · ` : '')
        : ramStr;
      sum.textContent = box.clientWidth > 380 ? loadPart + t('w.procsSummary', { n: data.total, apps: data.groupCount ?? data.groups.length }) : loadPart + t('w.procsSummaryShort', { n: data.total });
      if (grid.querySelector('.empty')) grid.replaceChildren();
      const keep = new Set(list.map((g) => g.name));
      for (const [n, e] of els) if (!keep.has(n)) { e.remove(); els.delete(n); }
      for (const g of list) {
        const e = rowEl(g);
        e._g = g;
        e.querySelector('.p-t').textContent = g.title;
        e.querySelector('.p-count').textContent = g.count > 1 ? '×' + g.count : '';
        e.querySelector('.p-lock').textContent = g.locked ? '🔒' : '';
        e.querySelector('.p-bar i').style.width = ((sort === 'cpu' ? g.cpu : g.memMb) / max) * 100 + '%';
        e.querySelector('.p-nums b').textContent = sort === 'cpu' ? g.cpu.toFixed(1) + '%' : fmtMem(g.memMb);
        e.querySelector('.p-nums small').textContent = sort === 'cpu' ? fmtMem(g.memMb) : g.cpu.toFixed(1) + '%';
        grid.appendChild(e); // keeps the order
      }
    };
    const setSort = (s) => {
      sort = s === 'mem' ? 'mem' : 'cpu';
      [...seg.children].forEach((x, i) => x.classList.toggle('on', (i === 0 ? 'cpu' : 'mem') === sort));
      render();
    };
    registerProcessesSorter(setSort);
    [...seg.children].forEach((b, i) => b.addEventListener('click', () => {
      haptic();
      setSort(i === 0 ? 'cpu' : 'mem');
    }));
    return { update: render };
  },
};

// On / off keys light up from the agent's state (D.state.toggles: { id: true | false }).
export function applyToggles(root) {
  const t = D.state?.toggles || {};
  root.querySelectorAll('.key.toggle').forEach((b) => b.classList.toggle('on', t[b.dataset.id] === true));
}

W.shortcuts = {
  needs: ['state'],
  create(box, { o }) {
    const all = cfg.shortcuts || [];
    const ids = Array.isArray(o.ids) && o.ids.length ? o.ids : null;
    const list = ids ? ids.map((id) => all.find((s) => s.id === id)).filter(Boolean) : all;
    if (!list.length) {
      box.append(h('div', 'empty', all.length ? t('w.shortcutsMissing') : t('w.shortcutsWait')));
      return {};
    }
    const cols = Math.min(8, Math.max(1, o.columns || 4));
    const grid = h('div', 'deck-grid', ...list.map(keyButton));
    grid.style.gridTemplateColumns = `repeat(${Math.min(cols, list.length)}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${Math.ceil(list.length / cols)}, 1fr)`;
    box.append(grid);
    return { update: () => applyToggles(box) };
  },
};

W.button = {
  bare: true, needs: ['state'],
  create(box, { o }) {
    const s = (cfg.shortcuts || []).find((x) => x.id === o.id) || (cfg.shortcuts || [])[0];
    box.append(s ? keyButton(s) : h('div', 'empty', t('w.pickShortcut')));
    return { update: () => applyToggles(box) };
  },
};

W.worldclock = {
  needs: ['tick'],
  create(box, { o }) {
    const zones = (Array.isArray(o.zones) && o.zones.length ? o.zones : ['Tallinn=Europe/Tallinn', 'Istanbul=Europe/Istanbul', 'London=Europe/London', 'New York=America/New_York', 'Tokyo=Asia/Tokyo'])
      .map((z) => { const i = z.indexOf('='); return i > 0 ? [z.slice(0, i).trim(), z.slice(i + 1).trim()] : [z.split('/').pop().replace(/_/g, ' '), z.trim()]; });
    const items = zones.map(([name, tz]) => {
      let fmt = null;
      try { fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch (_) {}
      const t = h('div', 'wc-t', fmt ? '--:--' : '??'), s = h('div', 'wc-s', fmt ? '' : 'unknown zone');
      return { fmt, t, s, el: h('div', 'wc', h('div', 'wc-n', name), t, s) };
    });
    const row = h('div', 'wc-row', items.map((i) => i.el));
    box.append(row);
    let shown = -1;
    return {
      update() {
        // once a minute, and at once after ticks were missed (the page was not visible, the night screen was on)
        const minute = Math.floor(Date.now() / 60000);
        if (minute === shown) return;
        shown = minute;
        const now = new Date();
        const localUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
        row.classList.toggle('vert', box.clientHeight > box.clientWidth * 1.1);
        row.classList.toggle('h12', hour12());
        for (const it of items) {
          if (!it.fmt) continue;
          const p = Object.fromEntries(it.fmt.formatToParts(now).map((x) => [x.type, x.value]));
          const [hm, ap] = fmtClock(+p.hour % 24, +p.minute).split(' ');
          it.t.replaceChildren(hm, ap ? h('span', 'wc-ap', ' ' + ap) : '');
          const zoneUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
          const diffH = Math.round((zoneUtc - localUtc) / 360000) / 10;
          const dayDiff = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
          const day = dayDiff > 0 ? t('time.tomorrow') : dayDiff < 0 ? t('time.yesterday') : t('time.today');
          it.s.textContent = diffH === 0 ? day : `${day}, ${diffH > 0 ? '+' : '−'}${Math.abs(diffH)}h`;
        }
      },
    };
  },
};

W.calendar = {
  needs: ['tick'],
  create(box) {
    let shown = '';
    return {
      update() {
        const now = new Date();
        const key = now.toDateString();
        if (key === shown) return;
        shown = key;
        const y = now.getFullYear(), m = now.getMonth();
        const first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate();
        const lead = (first.getDay() + 6) % 7; // Monday first
        const cells = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => h('span', 'cal-h' + (i > 4 ? ' we' : ''), d));
        const prevDays = new Date(y, m, 0).getDate();
        for (let i = 0; i < lead; i++) cells.push(h('span', 'cal-d out', prevDays - lead + 1 + i));
        for (let d = 1; d <= days; d++) {
          const wd = (lead + d - 1) % 7;
          cells.push(h('span', 'cal-d' + (d === now.getDate() ? ' today' : '') + (wd > 4 ? ' we' : ''), d));
        }
        const total = Math.ceil(cells.length / 7) * 7;
        for (let d = 1; cells.length < total; d++) cells.push(h('span', 'cal-d out', d));
        const grid = h('div', 'cal', cells);
        grid.style.gridTemplateRows = `auto repeat(${total / 7 - 1}, 1fr)`;
        box.replaceChildren(h('div', 'w-title', now.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' }),
          h('span', 'w-sub', 'Week ' + isoWeek(now))), grid);
      },
    };
  },
};

export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
}

/**
 * A Pomodoro sequence from text such as "25 focus, 5 break, 25 focus, 15 long" ("focus 25", "25 min long break" and
 * "f / b / l" work too). Returns { steps, bad }: steps is null when the text is empty or not understood.
 */
export function parsePomodoro(text) {
  const kindOf = (k) => (/^l/i.test(k) ? 'long' : /^(b|s)/i.test(k) ? 'break' : 'focus');
  const KIND = '(focus|work|f|short\\s*break|break|b|long\\s*break|long|l)';
  const re = new RegExp(`^(?:${KIND}\\s*(\\d{1,3})\\s*(?:m|min|minutes?)?|(\\d{1,3})\\s*(?:m|min|minutes?)?\\s*${KIND})$`, 'i');
  const steps = [];
  for (const raw of String(text || '').split(/[,;\n]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(re);
    const min = m ? +(m[2] || m[3]) : 0;
    if (!m || min < 1 || min > 600) return { steps: null, bad: part };
    steps.push({ kind: kindOf(m[1] || m[4]), ms: min * 60_000 });
    if (steps.length > 48) return { steps: null, bad: 'more than 48 steps' };
  }
  return { steps: steps.length ? steps : null, bad: null };
}

W.pomodoro = {
  needs: ['tick'],
  always: true, // the alarm goes off on whatever page is showing
  create(box, { o, page, w }) {
    const key = `pomo:${page.id}/${w.id}`;
    const minutes = (v, d, max) => Math.min(max, Math.max(1, +v || d)) * 60_000;
    const focus = { kind: 'focus', ms: minutes(o.focus, 25, 180) }, brk = { kind: 'break', ms: minutes(o.break, 5, 60) };
    const long = { kind: 'long', ms: minutes(o.longBreak, 15, 120) };
    const every = Math.min(12, Math.max(0, Math.floor(+o.longEvery || 0)));
    const rounds = Math.min(99, Math.max(0, Math.floor(+o.rounds || 0)));
    const custom = parsePomodoro(o.sequence);
    // the plan: the own sequence, or focus / break with a long break after every N focus sessions
    let plan = custom.steps;
    if (!plan) {
      plan = [];
      if (!every) plan.push(focus, brk);
      else for (let i = 0; i < every; i++) plan.push(focus, i === every - 1 ? long : brk);
    }
    const sig = plan.map((s) => `${s.kind[0]}${s.ms / 60_000}`).join(' ') + `/${rounds}`;
    const focusTotal = plan.filter((s) => s.kind === 'focus').length;
    const today = new Date().toDateString();
    let st = store.get(key, null);
    if (!st || typeof st !== 'object') st = { phase: 'focus', endsAt: null, left: plan[0].ms, count: 0, day: today };
    if (st.sig === undefined) {
      // state from before sequences (focus / break only): keep a running timer where it is
      st.step = st.phase === 'break' && plan.length > 1 ? 1 : 0;
      st.round = 0;
      st.sig = sig;
    } else if (st.sig !== sig) {
      // the sequence was changed in the settings: start it from the beginning
      Object.assign(st, { step: 0, round: 0, endsAt: null, left: plan[0].ms, sig });
    }
    if (!(st.step >= 0 && st.step < plan.length)) st.step = 0;
    if (st.day !== today) { st.count = 0; st.day = today; }
    const save = () => { st.phase = plan[st.step].kind; store.set(key, st); };
    save();
    const dial = h('div', 'g-dial'), time = h('div', 'g-val'), phase = h('div', 'g-label'), count = h('div', 'g-sub');
    const play = h('button', 'pb main', '▶'), reset = h('button', 'pb', '↺'), skip = h('button', 'pb', '⏭');
    dial.append(time);
    box.append(dial, phase, count, h('div', 'pomo-btns', reset, play, skip));
    let svg = null;
    const total = () => plan[st.step].ms;
    const remaining = () => (st.endsAt ? Math.max(0, st.endsAt - Date.now()) : st.left);
    /** Moves to the next step; returns true when the last round of the sequence is over (the timer then stops). */
    const advance = (manual) => {
      if (plan[st.step].kind === 'focus' && !manual) st.count++;
      st.step++;
      if (st.step >= plan.length) { st.step = 0; st.round = (st.round || 0) + 1; }
      st.left = total();
      const finished = rounds > 0 && st.round >= rounds;
      if (finished) st.round = 0;
      st.endsAt = manual || finished ? null : Date.now() + st.left;
      save();
      return finished;
    };
    const label = () => {
      const s = plan[st.step];
      if (s.kind === 'long') return t('w.longBreak');
      if (s.kind === 'break') return t('w.break');
      const n = plan.slice(0, st.step + 1).filter((x) => x.kind === 'focus').length;
      return focusTotal > 1 ? `${t('w.focus')} ${n}/${focusTotal}` : t('w.focus');
    };
    const render = () => {
      // "today" starts over at midnight also while the panel stays open
      const day = new Date().toDateString();
      if (st.day !== day) { st.count = 0; st.day = day; save(); }
      if (st.endsAt && remaining() <= 0) {
        const was = plan[st.step].kind;
        const finished = advance(false);
        buzz(finished ? '0,200,120,200,120,200,120,600' : '0,200,120,200,120,400');
        const next = plan[st.step].kind;
        toast(finished ? 'Sequence finished, well done'
          : next === 'long' ? 'Time for a long break' : next === 'break' ? 'Time for a break'
            : was === 'focus' ? 'Next focus session' : 'Back to focus', 'ok', '🍅 Pomodoro', 5);
      }
      const left = remaining();
      const kind = plan[st.step].kind;
      box.classList.toggle('brk', kind !== 'focus');
      box.classList.toggle('long', kind === 'long');
      box.classList.toggle('run', !!st.endsAt);
      if (svg) svg.remove();
      dial.insertAdjacentHTML('afterbegin', ringSvg(100 * (1 - left / total())));
      svg = dial.firstElementChild;
      time.textContent = fmtTime(left + 999);
      phase.textContent = label();
      const tomatoes = st.count ? '🍅'.repeat(Math.min(st.count, 6)) + (st.count > 6 ? ` ×${st.count}` : '') : t('w.noSessionsToday');
      count.textContent = custom.bad ? `Sequence not understood: "${custom.bad}"`
        : rounds > 1 ? `Round ${(st.round || 0) + 1}/${rounds} · ${tomatoes}` : tomatoes;
      play.textContent = st.endsAt ? '⏸' : '▶';
    };
    play.addEventListener('click', () => {
      haptic();
      if (st.endsAt) { st.left = remaining(); st.endsAt = null; } else st.endsAt = Date.now() + st.left;
      save(); render();
    });
    // ↺ restarts this step; pressed again on a step that has not started, it goes back to the start of the sequence
    reset.addEventListener('click', () => {
      haptic();
      if (!st.endsAt && st.left === total()) { st.step = 0; st.round = 0; }
      st.endsAt = null; st.left = total(); save(); render();
    });
    skip.addEventListener('click', () => { haptic(); advance(true); render(); });
    return { update: render };
  },
};

W.countdown = {
  needs: ['tick'],
  create(box, { o }) {
    const m = String(o.target || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?$/);
    let target = NaN;
    if (m) {
      const [, year, month, day, hour = '0', minute = '0'] = m;
      const date = new Date(0);
      date.setFullYear(+year, +month - 1, +day);
      date.setHours(+hour, +minute, 0, 0);
      if (date.getFullYear() === +year && date.getMonth() === +month - 1 &&
          date.getDate() === +day && +hour < 24 && +minute < 60) {
        // the time is checked as numbers: one the clocks skip (spring forward) still counts, moved on like before
        target = date.getTime();
      }
    }
    const big = h('div', 'cd-v'), sub = h('div', 'cd-s');
    box.append(h('div', 'cd-l', o.label || 'Countdown'), big, sub);
    if (Number.isNaN(target)) { big.textContent = '—'; sub.textContent = t('w.setDateFormat'); return {}; }
    sub.textContent = new Date(target).toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ', ' + fmtHM(new Date(target));
    return {
      update() {
        let d = target - Date.now();
        const past = d < 0;
        d = Math.abs(d);
        const days = Math.floor(d / 86400000), hrs = Math.floor((d % 86400000) / 3600000), mins = Math.floor((d % 3600000) / 60000), secs = Math.floor((d % 60000) / 1000);
        big.textContent = (past ? '+' : '') + (days ? `${days}d ${hrs}h` : hrs ? `${hrs}h ${pad(mins)}m` : `${mins}:${pad(secs)}`);
        box.classList.toggle('past', past);
      },
    };
  },
};

const NOTE_MAX = 500;

W.note = {
  bare: true, needs: [],
  create(box, { o, page, w }) {
    let savedVersion = null;
    const paint = () => {
      const text = String(o.text ?? '');
      box.style.setProperty('--n', o.color || '#fbbf24');
      box.style.setProperty('--nf', text.length < 25 ? 15 : text.length < 70 ? 10.5 : text.length < 160 ? 8 : 6.5);
      box.replaceChildren(h('div', 'note-t', text));
    };
    paint();
    if (PREVIEW || String(w.id).includes(':')) return {};
    box.addEventListener('click', () => {
      if (!$('overview').hidden) return;
      haptic();
      const wrap = h('div', 'note-edit');
      wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
      const card = h('div', 'note-card');
      const ta = document.createElement('textarea');
      ta.className = 'note-ta';
      ta.value = String(o.text ?? '');
      const opened = savedVersion ?? cfgVersion;
      ta.maxLength = NOTE_MAX;
      ta.rows = 6;
      const row = h('div', 'note-actions');
      const cancel = h('button', 'btn sm', t('w.note.cancel'));
      cancel.onclick = () => wrap.remove();
      const save = h('button', 'btn primary sm', t('w.note.save'));
      save.onclick = async () => {
        const submitted = ta.value;
        save.disabled = true;
        ta.disabled = true;
        try {
          const res = await fetch(API + '/widget/' + encodeURIComponent(page.id) + '/' + encodeURIComponent(w.id) + '/note?text=' + encodeURIComponent(submitted) + '&version=' + encodeURIComponent(opened ?? ''), {
            method: 'POST',
            cache: 'no-store',
            headers: PANEL_HEADERS,
          });
          if (res.status === 409) {
            wrap.remove();
            toast(t('w.note.changed'));
            return;
          }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          savedVersion = (await res.json().catch(() => ({}))).version ?? null;
          o.text = submitted;
          paint();
          wrap.remove();
        } catch (_) {
          save.disabled = false;
          ta.disabled = false;
          toast(t('w.note.failed'));
        }
      };
      row.append(cancel, save);
      card.append(ta, row);
      wrap.append(card);
      document.body.append(wrap);
      ta.focus();
    });
    return {};
  },
};

W.label = {
  bare: true, needs: [],
  create(box, { o }) {
    box.append(h('div', 'lbl-t', o.text || ''));
    return {};
  },
};

W.command = {
  needs: ['tick'],
  create(box, { o, page, w }) {
    const out = h('div', 'cmd-o', '…'), foot = h('div', 'cmd-f', '');
    box.append(h('div', 'w-title', o.title || 'Command'), out, foot);
    let last = 0, busy = false, res = null;
    const load = async (force) => {
      if (busy) return;
      busy = true;
      try {
        res = await api(`/widget/${encodeURIComponent(page.id)}/${encodeURIComponent(w.id)}${force ? '?force=true' : ''}`, 'GET', 4000);
        const text = res.output ?? '';
        out.textContent = text || (res.running ? t('w.running') : t('w.noOutput'));
        const short = text.length <= 14 && !text.includes('\n');
        out.classList.toggle('big', short);
        box.classList.toggle('bad', res.ok === false);
      } catch (_) { if (!res) out.textContent = online ? t('w.unavailable') : '—'; }
      busy = false;
    };
    box.addEventListener('click', () => { haptic(); last = Date.now(); load(true).then(() => setTimeout(() => load(false), 1500)); });
    return {
      update() {
        if (res?.at) foot.textContent = (res.running ? 'refreshing · ' : '') + ago(res.at) + (res.durationMs ? ` · ${Math.round(res.durationMs)} ms` : '');
        if (!online || Date.now() - last < (res?.running || !res?.at ? 2000 : 5000)) return;
        last = Date.now();
        load(false);
      },
    };
  },
};

W.push = {
  needs: ['push', 'tick'],
  create(box, { o }) {
    const key = o.key || '';
    let lastAt = -1;
    const render = () => {
      const item = D.push[key];
      if (!item) {
        if (lastAt === 0) return;
        lastAt = 0;
        box.style.removeProperty('--c');
        box.replaceChildren(h('div', 'w-title', o.title || key), h('div', 'push-empty', t('w.noDataYet'), h('code', null, `POST /api/push/${key}`)));
        return;
      }
      const ageEl = box.querySelector('.push-age');
      if (item.at === lastAt) { if (ageEl) ageEl.textContent = ago(item.at); return; }
      lastAt = item.at;
      const v = pushView(item);
      const lvl = levelOf(v);
      const c = v.color || LEVEL_COLOR[lvl] || '';
      if (c) box.style.setProperty('--c', c); else box.style.removeProperty('--c');
      const unit = v.unit ?? o.unit ?? '';
      const style = o.style && o.style !== 'auto' ? o.style : v.items ? 'list' : 'big';
      const iconId = o.iconId || v.iconId;
      let titleIcon = v.icon ? v.icon + ' ' : null;
      if (iconId) {
        const img = new Image();
        img.className = 'push-title-icon';
        img.alt = '';
        img.src = `${API}/shortcuts/icon?id=${encodeURIComponent(iconId)}`;
        img.onerror = () => img.remove();
        titleIcon = img;
      }
      const title = h('div', 'w-title push-title-wrap', titleIcon, h('span', null, o.title || v.title || key), h('span', 'push-age w-sub', ago(item.at)));
      let body;
      if (style === 'list') {
        const items = v.items || (v.value != null ? [v.value] : []);
        body = h('div', 'push-list', items.slice(0, 30).map((x) => {
          if (x && typeof x === 'object') {
            const li = h('div', 'pl-i', h('span', 'pl-l', x.label ?? x.title ?? x.name ?? ''), h('span', 'pl-v', fmtValue(x.value ?? x.status ?? '')));
            const lc = LEVEL_COLOR[x.level || levelOf({ value: x.value ?? x.status })];
            if (lc) li.style.setProperty('--lc', lc);
            return li;
          }
          return h('div', 'pl-i', h('span', 'pl-l', fmtValue(x)));
        }));
      } else if (style === 'gauge') {
        const min = v.min ?? (typeof o.min === 'number' ? o.min : 0), max = v.max ?? (typeof o.max === 'number' ? o.max : 100);
        const num = typeof v.value === 'number' ? v.value : parseFloat(v.value);
        const pct = v.progress != null ? v.progress * 100 : Number.isFinite(num) ? ((num - min) / (max - min || 1)) * 100 : 0;
        const dial = h('div', 'g-dial');
        dial.innerHTML = ringSvg(pct);
        dial.appendChild(h('div', 'g-val', fmtValue(v.value ?? Math.round(pct)), h('small', null, unit)));
        box.style.setProperty('--q', c || 'var(--cpu)');
        body = h('div', 'push-gauge', dial, v.sub ? h('div', 'g-sub', v.sub) : null);
      } else {
        body = h('div', 'push-big', h('div', 'pv', fmtValue(v.value), unit ? h('small', null, unit) : null),
          v.sub ? h('div', 'ps', String(v.sub)) : null,
          v.progress != null ? h('div', 'track', h('i')) : null);
        const bar = body.querySelector('.track i');
        if (bar) bar.style.width = Math.max(0, Math.min(100, v.progress * 100)) + '%';
      }
      box.className = box.className.replace(/\bps-\w+/g, '') + ' ps-' + style;
      box.replaceChildren(title, body);
    };
    return { update: render };
  },
};

W.inbox = {
  needs: ['notes', 'tick'],
  create(box) {
    const list = h('div', 'inbox');
    const clear = h('button', 'mini-btn', 'Clear');
    clear.addEventListener('click', () => { haptic(); D.notes = []; store.set('notes', []); emit('notes'); });
    box.append(h('div', 'w-title', 'Notifications', clear), list);
    let shown = '';
    return {
      update(kind) {
        const key = D.notes.length + ':' + (D.notes[0]?.at || 0) + ':' + Math.floor(Date.now() / 60000);
        if (key === shown && kind === 'tick') return;
        shown = key;
        list.replaceChildren(...(D.notes.length ? D.notes.map((n) => {
          const e = h('div', 'ib-i', h('div', 'ib-h', h('b', null, n.title || n.text), h('span', null, ago(n.at))), n.title && n.text ? h('div', 'ib-t', n.text) : null);
          e.style.setProperty('--lc', LEVEL_COLOR[n.level] || 'var(--dim)');
          return e;
        }) : [h('div', 'empty', t('w.notifyEmpty'))]));
      },
    };
  },
};
