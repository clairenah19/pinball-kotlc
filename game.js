/* =====================================================================
   LOST CITIES PINBALL
   A portrait-first pinball game inspired by Keeper of the Lost Cities.
   Plain JS, no build step. All artwork and audio are generated in code.

   File map (search for the banner comments):
     1. CONFIG        every tuning value lives here
     2. Helpers / state
     3. Table geometry (walls, bumpers, targets, ramps, scoops)
     4. Audio (Web Audio, generated)
     5. Game rules (scoring, modes, multiball, wizard)
     6. Physics (fixed timestep, sub-stepping, flippers)
     7. Rendering (static background + dynamic layer + effects)
     8. Input, screens, HUD, main loop
   ===================================================================== */
(function () {
'use strict';

/* ===================================================================
   1. CONFIG: tweak the feel and the scoring here
   =================================================================== */
const CONFIG = {
  palette: { indigo: '#1E2360', teal: '#5FD3C6', gold: '#E8C66A', violet: '#9B78E0', silver: '#DDE2F0', ink: '#0B0D26' },

  table: { width: 400, height: 760, pixelRatioCap: 3 },

  physics: {
    gravity: 900,          // px/s^2. Higher = heavier, faster ball.
    step: 1 / 240,         // fixed simulation step (s). 4 sub-steps per 60fps frame.
    maxFrame: 0.05,        // longest frame we will try to catch up (s)
    ballRadius: 8,
    maxSpeed: 1500,        // px/s. At 1/240s a step moves <= 6.3px, well under the ball radius, so no tunnelling.
    wallBounce: 0.5,       // restitution of walls
    restSpeed: 90,         // impacts slower than this lose all bounce (stops jitter)
    airDrag: 0.05,         // fraction of speed lost per second
    ballBounce: 0.9        // ball to ball restitution (multiball)
  },

  flipper: {
    length: 64, baseRadius: 9, tipRadius: 5.5,
    restAngle: 0.5,        // radians, positive = pointing down
    upAngle: -0.5,
    swingUp: 24,           // rad/s when pressed. Surface speed at the tip = length * this.
    swingDown: 12,         // rad/s when released
    bounce: 0.2,           // restitution of flipper surface (on top of its swing speed)
    left:  { x: 118, y: 662 },
    right: { x: 282, y: 662 }
  },

  launch: { x: 377, y: 686, speed: 1560, delay: 0.9, jitter: 25, settleTime: 0.7 },
  ballSave: 7,             // seconds of ball save at the start of each ball
  startBalls: 3,
  maxMult: 5,

  bumper: { radius: 22, kick: 330, minOut: 430 },   // kick is added along the bounce normal
  sling:  { kick: 280, minImpact: 220 },            // the lower guides kick like slingshots
  spinner: { spinPerSpeed: 0.06, friction: 2.2, spinsForBonus: 20 },

  scores: {
    bumper: 100, sling: 10, crystal: 500, lightLeap: 5000, ability: 300, abilitySet: 4000,
    ramp: 2500, jackpot: 8000, spin: 50, spinAlicorn: 200, swan: 1000, lock: 3000,
    neverseenWin: 15000, neverseenPot: 10000, wizardShot: 5000, wizardEnd: 50000, alicornEnd: 2000
  },

  modes: {
    bumperHitsForNeverseen: 12,  // bumper hits that summon the Neverseen
    neverseenTime: 25,           // seconds
    neverseenHits: 3,            // flashing shots needed
    alicornTime: 15,
    wizardTime: 35,
    locksForMultiball: 3,
    multiballBalls: 3
  },

  fx: { shake: 1, flash: 1, particles: 1, maxParticles: 320 }
};

/* ===================================================================
   2. Helpers / state
   =================================================================== */
const W = CONFIG.table.width, H = CONFIG.table.height, BR = CONFIG.physics.ballRadius;
const PAL = CONFIG.palette, SC = CONFIG.scores, MD = CONFIG.modes;
const $ = (id) => document.getElementById(id);
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const TAU = Math.PI * 2;
const BUMPER_COLORS = [PAL.teal, PAL.violet, PAL.gold, '#F59BCB', PAL.silver];
const MODE_KEYS = ['leap', 'ability', 'foxfire', 'neverseen', 'alicorn'];
const MODE_NAMES = { leap: 'Light Leap', ability: 'Abilities', foxfire: 'Foxfire', neverseen: 'Neverseen', alicorn: 'Alicorn' };

const store = {
  get(k, d) { try { const v = localStorage.getItem('lcp-' + k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('lcp-' + k, String(v)); } catch (e) { /* private mode */ } }
};

const G = {
  phase: 'title',            // title | play | paused | over
  time: 0, score: 0, display: 0, best: parseInt(store.get('best', '0'), 10) || 0,
  ballsLeft: 3, ballNo: 1, mult: 1,
  balls: [],                 // balls on the table
  locked: 0, multiball: false,
  saveT: 0, overT: 0,
  bumperHits: 0, spinAcc: 0, spins: 0, rampHits: 0,
  modes: { leap: false, ability: false, foxfire: false, neverseen: false, alicorn: false },
  nev: null,                 // Neverseen hurry-up state
  alicornT: 0, wizardT: 0, dark: 0,
  shake: 0, flash: 0, beam: 0,
  newBest: false
};
const R = { reduced: false };   // reduced motion toggle

/* ===================================================================
   3. Table geometry
   =================================================================== */
const segs = [];
function addSeg(ax, ay, bx, by, o) {
  segs.push(Object.assign({ ax, ay, bx, by, e: CONFIG.physics.wallBounce, kick: 0, minImpact: 0, glow: 0 }, o || {}));
}
const ARCH = { cx: 200, cy: 200, r: 192 };
(function buildWalls() {
  const n = 48; let px = ARCH.cx - ARCH.r, py = ARCH.cy;
  for (let i = 1; i <= n; i++) {                         // top arch
    const a = Math.PI + Math.PI * i / n, x = ARCH.cx + ARCH.r * Math.cos(a), y = ARCH.cy + ARCH.r * Math.sin(a);
    addSeg(px, py, x, y, { arch: true }); px = x; py = y;
  }
  addSeg(8, 200, 8, 570);                                // left wall
  addSeg(392, 200, 392, 706);                            // right wall (outside of the launch lane)
  addSeg(362, 250, 362, 706);                            // inner lane wall
  addSeg(362, 706, 392, 706);                            // lane floor
  addSeg(8, 570, 118, 662, { kick: CONFIG.sling.kick, minImpact: CONFIG.sling.minImpact, sling: true, e: 0.35 });   // left guide / slingshot
  addSeg(362, 252, 392, 226, { oneWay: true, gate: true, e: 0.3 });   // one-way launch gate: lets the ball out, never back in
  addSeg(362, 570, 282, 662, { kick: CONFIG.sling.kick, minImpact: CONFIG.sling.minImpact, sling: true, e: 0.35 }); // right guide / slingshot
})();

const bumpers = [[150, 236], [250, 236], [200, 296]].map((p, i) => ({ x: p[0], y: p[1], r: CONFIG.bumper.radius, flash: 0, ci: i, ring: 0 }));
const crystals = [120, 160, 200, 240, 280].map((x, i) => ({ x, y: 98, r: 10, lit: false, flash: 0, note: i, cd: 0 }));
const ORB_DEFS = [
  { x: 62, y: 330, name: 'TELEPATH', ch: 'T' }, { x: 62, y: 392, name: 'EMPATH', ch: 'E' },
  { x: 338, y: 330, name: 'TELEPORTER', ch: 'Tp' }, { x: 338, y: 392, name: 'CONJURER', ch: 'C' }
];
const orbs = ORB_DEFS.map((o) => ({ x: o.x, y: o.y, r: 10, name: o.name, ch: o.ch, lit: false, flash: 0, cd: 0 }));
const spinner = { x: 200, y: 158, r: 18, angle: 0, w: 0 };
const scoops = {
  swan:  { id: 'swan',  x: 50,  y: 214, r: 17, evx: 240, evy: 150 },
  tower: { id: 'tower', x: 322, y: 214, r: 17, evx: -240, evy: 150 }
};
const ramps = {
  rampL: { id: 'rampL', ex: 30,  ey: 470, r: 15, p1: { x: 40, y: 130 },  p2: { x: 300, y: 150 }, vx: -90, vy: 230, dur: 0.9 },
  rampR: { id: 'rampR', ex: 332, ey: 470, r: 15, p1: { x: 360, y: 130 }, p2: { x: 100, y: 150 }, vx: 90,  vy: 230, dur: 0.9 }
};
const SHOTS = {                                       // where each hurry-up shot lives (for lights)
  rampL: { x: 30, y: 470 }, rampR: { x: 332, y: 470 }, swan: { x: 50, y: 214 }, tower: { x: 322, y: 214 }
};
const flippers = ['left', 'right'].map((side, i) => {
  const c = CONFIG.flipper;
  return { x: c[side].x, y: c[side].y, s: i === 0 ? 1 : -1, a: c.restAngle, omega: 0, len: c.length, press: false, glow: 0 };
});

/* ===================================================================
   4. Audio: Web Audio, everything generated. Starts after the first tap.
   =================================================================== */
const SFX = (function () {
  let ac = null, master = null, noiseBuf = null, muted = store.get('muted', '0') === '1', drone = null, pad = null;
  const PENTA = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2, 9 / 4, 5 / 2];

  function init() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ac = new AC();
    master = ac.createGain(); master.gain.value = muted ? 0 : 0.8;
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp); comp.connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    startPad();
  }
  function setMuted(m) { muted = m; store.set('muted', m ? '1' : '0'); if (master) master.gain.setTargetAtTime(m ? 0 : 0.8, ac.currentTime, 0.03); }
  function now() { return ac.currentTime; }

  // A decaying tone. detune/glide give the shimmering, chime-like body.
  function tone(freq, o) {
    if (!ac) return; o = o || {};
    const t = now() + (o.when || 0), g = ac.createGain(), osc = ac.createOscillator();
    osc.type = o.type || 'sine'; osc.frequency.setValueAtTime(freq, t);
    if (o.glide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * o.glide), t + (o.a || 0.005) + (o.d || 0.4));
    if (o.detune) osc.detune.value = o.detune;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.vol || 0.15), t + (o.a || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + (o.a || 0.005) + (o.d || 0.4));
    osc.connect(g); g.connect(o.dest || master);
    osc.start(t); osc.stop(t + (o.a || 0.005) + (o.d || 0.4) + 0.05);
  }
  // Filtered noise burst, optionally sweeping (whispers, whooshes, clicks).
  function noise(o) {
    if (!ac) return;
    const t = now() + (o.when || 0), src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = noiseBuf; src.loop = true;
    f.type = o.type || 'bandpass'; f.Q.value = o.q || 1; f.frequency.setValueAtTime(o.f0 || 1000, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + (o.a || 0.01) + o.d);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.vol || 0.1), t + (o.a || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t + (o.a || 0.01) + o.d);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t, Math.random() * 0.5); src.stop(t + (o.a || 0.01) + o.d + 0.05);
  }
  const chime = (n, vol, when) => {                                // crystal chime: a note plus two airy partials
    const f = 523.25 * PENTA[n % PENTA.length] * (n >= PENTA.length ? 2 : 1);
    tone(f, { vol: vol || 0.16, d: 0.9, when }); tone(f * 2.01, { vol: (vol || 0.16) * 0.4, d: 0.6, when, detune: 6 }); tone(f * 3.98, { vol: (vol || 0.16) * 0.15, d: 0.35, when });
  };
  function startPad() {                                            // very quiet shimmering pad under everything
    const g = ac.createGain(); g.gain.value = 0.0001; g.connect(master);
    const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 0.12; lg.gain.value = 0.012; lfo.connect(lg); lg.connect(g.gain);
    [110, 164.81, 220.5].forEach((f, i) => { const o = ac.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.detune.value = i * 4; o.connect(g); o.start(); });
    g.gain.setTargetAtTime(0.02, now(), 2); lfo.start(); pad = g;
  }
  function droneOn() {                                             // deep Neverseen tone
    if (!ac || drone) return;
    const g = ac.createGain(); g.gain.value = 0.0001; const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
    const os = [55, 58.3, 82.4].map((f) => { const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(lp); o.start(); return o; });
    const lfo = ac.createOscillator(), lg = ac.createGain(); lfo.frequency.value = 3.2; lg.gain.value = 0.03; lfo.connect(lg); lg.connect(g.gain); lfo.start();
    lp.connect(g); g.connect(master); g.gain.setTargetAtTime(0.1, now(), 0.4);
    drone = { g, os, lfo };
  }
  function droneOff() {
    if (!ac || !drone) return; const d = drone; drone = null;
    d.g.gain.setTargetAtTime(0.0001, now(), 0.3);
    setTimeout(() => { d.os.forEach((o) => { try { o.stop(); } catch (e) {} }); try { d.lfo.stop(); } catch (e) {} }, 1500);
  }
  return {
    init, setMuted, get muted() { return muted; }, droneOn, droneOff,
    crystal(n) { chime(n, 0.18); },
    bumper() { chime(Math.floor(Math.random() * 6), 0.12); tone(180, { type: 'sine', vol: 0.22, d: 0.18, glide: 0.5 }); },
    orb() { chime(4 + Math.floor(Math.random() * 3), 0.14); tone(300, { vol: 0.08, d: 0.3, glide: 1.5 }); },
    flipper() { noise({ type: 'bandpass', f0: 1800, q: 1.2, d: 0.05, vol: 0.12 }); tone(95, { vol: 0.25, d: 0.09, glide: 0.6 }); },
    sling() { noise({ type: 'highpass', f0: 2500, d: 0.06, vol: 0.12 }); tone(240, { vol: 0.1, d: 0.1, glide: 0.5 }); },
    wall(v) { tone(380, { vol: clamp(v / 4000, 0.01, 0.07), d: 0.05, type: 'triangle' }); },
    launch() { noise({ type: 'bandpass', f0: 300, f1: 2400, q: 0.9, d: 0.5, vol: 0.2 }); },
    spin() { tone(1200 + Math.random() * 300, { vol: 0.04, d: 0.04, type: 'triangle' }); },
    leap() {                                                       // soft hum + rising shimmer
      tone(146.8, { type: 'sawtooth', vol: 0.06, a: 0.15, d: 1.2 }); tone(220, { type: 'sine', vol: 0.14, a: 0.1, d: 1.3, glide: 2 });
      [0, 1, 2, 3, 4, 5].forEach((i) => chime(i + 1, 0.12, i * 0.07));
    },
    hum() { tone(180, { type: 'sine', vol: 0.12, a: 0.08, d: 0.8, glide: 1.6 }); tone(182, { type: 'sine', vol: 0.08, a: 0.08, d: 0.8, glide: 1.6 }); },
    whisper(syl) {                                                 // whispered-style sweeps: airy noise with moving formants
      for (let i = 0; i < (syl || 3); i++) {
        const w = i * 0.12, f = rand(1400, 3200);
        noise({ type: 'bandpass', f0: f, f1: f * rand(0.6, 1.5), q: 3.5, a: 0.03, d: 0.16, vol: 0.09, when: w });
        noise({ type: 'bandpass', f0: rand(500, 900), q: 4, a: 0.03, d: 0.14, vol: 0.05, when: w });
      }
    },
    lock() { [0, 2, 4].forEach((n, i) => chime(n, 0.14, i * 0.08)); tone(98, { vol: 0.25, d: 0.5, glide: 0.5 }); },
    multiball() { for (let i = 0; i < 10; i++) chime(i % 8, 0.12, i * 0.06); tone(130, { type: 'sawtooth', vol: 0.06, a: 0.2, d: 1.2, glide: 2 }); },
    scoop() { tone(200, { vol: 0.2, d: 0.2, glide: 2.5 }); chime(3, 0.1, 0.1); },
    eject() { noise({ type: 'bandpass', f0: 500, f1: 2800, q: 1, d: 0.2, vol: 0.18 }); },
    dark() { tone(55, { type: 'sawtooth', vol: 0.12, a: 0.2, d: 1.5, glide: 0.8 }); noise({ type: 'lowpass', f0: 400, f1: 80, d: 1.2, vol: 0.2 }); },
    win() { [0, 2, 4, 5, 7].forEach((n, i) => chime(n, 0.16, i * 0.09)); },
    fail() { tone(220, { type: 'sawtooth', vol: 0.08, d: 0.8, glide: 0.4 }); tone(165, { type: 'sawtooth', vol: 0.08, d: 0.8, glide: 0.4 }); },
    drain() { tone(80, { vol: 0.3, d: 0.6, glide: 0.4 }); noise({ type: 'lowpass', f0: 600, f1: 100, d: 0.5, vol: 0.2 }); },
    extra() { for (let i = 0; i < 5; i++) chime(i + 2, 0.14, i * 0.07); },
    ui() { chime(2, 0.1); }
  };
})();

function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* unsupported */ } }

/* ===================================================================
   5. Game rules
   =================================================================== */
const particles = [], popups = [], callQueue = [];
let call = null;                    // current big call-out
const srEl = $('sr');

function fxScale() { return R.reduced ? 0.25 : 1; }
function shake(n) { G.shake = Math.min(1.5, Math.max(G.shake, n * CONFIG.fx.shake * fxScale())); }
function flash(n) { G.flash = Math.max(G.flash, n * CONFIG.fx.flash * (R.reduced ? 0.3 : 1)); }

function burst(x, y, color, n, speed, kind) {
  n = Math.ceil(n * CONFIG.fx.particles * (R.reduced ? 0.4 : 1));
  for (let i = 0; i < n && particles.length < CONFIG.fx.maxParticles; i++) {
    const a = rand(0, TAU), v = rand(0.3, 1) * (speed || 200);
    particles.push({ k: kind || 0, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (kind === 1 ? 60 : 0), life: 0, max: rand(0.35, 0.8), c: color, s: kind === 1 ? rand(2, 5) : rand(1, 2.4) });
  }
}
function popup(x, y, text, color) { popups.push({ x, y, text, color: color || PAL.silver, t: 0 }); if (popups.length > 12) popups.shift(); }
function callout(text, sub, color, syl) {
  callQueue.push({ text, sub, color: color || PAL.gold, t: 0, dur: 1.7 });
  if (srEl) srEl.textContent = text + (sub ? '. ' + sub : '');
  if (syl !== 0) SFX.whisper(syl || Math.min(5, Math.ceil(text.length / 4)));
}
function addScore(base, x, y, noMult, color) {
  const pts = Math.round(base * (noMult ? 1 : G.mult));
  G.score += pts;
  if (x !== undefined && pts >= 100) popup(x, y, '+' + fmt(pts), color);
  return pts;
}

function setMult(m) { G.mult = clamp(m, 1, CONFIG.maxMult); }

/* ----- ball lifecycle ----- */
function newBallObj(st) { return { x: CONFIG.launch.x, y: CONFIG.launch.y, vx: 0, vy: 0, st: st || 'held', t: CONFIG.launch.delay, trail: [], idle: 0, still: 0, cool: 0, lastRamp: 0, rt: 0 }; }
function serve(paid) {
  const b = newBallObj('held'); G.balls.push(b);
  if (paid) G.saveT = CONFIG.ballSave;
  return b;
}
function launchBall(b) {
  b.st = 'play'; b.x = CONFIG.launch.x; b.y = CONFIG.launch.y;
  b.vx = rand(-CONFIG.launch.jitter, CONFIG.launch.jitter) - 8; b.vy = -CONFIG.launch.speed; b.idle = 0; b.still = 0; b.cool = 0.3;
  SFX.launch(); vibrate(12);
}

function newGame() {
  Object.assign(G, {
    phase: 'play', time: 0, score: 0, display: 0, ballsLeft: CONFIG.startBalls, ballNo: 1, mult: 1, balls: [], locked: 0, multiball: false,
    saveT: 0, overT: 0, bumperHits: 0, spinAcc: 0, spins: 0, rampHits: 0, nev: null, alicornT: 0, wizardT: 0, dark: 0, shake: 0, flash: 0, beam: 0, newBest: false
  });
  MODE_KEYS.forEach((k) => (G.modes[k] = false));
  crystals.forEach((c) => (c.lit = false)); orbs.forEach((o) => (o.lit = false));
  particles.length = 0; popups.length = 0; callQueue.length = 0; call = null;
  SFX.droneOff();
  showScreen(null);
  serve(true);
  callout('BALL 1', 'Hold both sides to play', PAL.teal, 2);
  updateHudFull();
}

function ballDrained(b) {
  G.balls.splice(G.balls.indexOf(b), 1);
  if (G.balls.length > 0) {                          // other balls still alive
    if (G.multiball && G.balls.length === 1) { G.multiball = false; callout('MULTIBALL OVER', '', PAL.silver, 0); }
    return;
  }
  if (G.saveT > 0) {                                  // ball save
    serve(false); G.saveT = Math.max(G.saveT, 1.5);
    callout('BALL SAVED', 'The light carries you back', PAL.teal, 3); SFX.eject(); return;
  }
  SFX.drain(); shake(0.8); vibrate([30, 40, 30]);
  if (G.nev) endNeverseen(false);
  G.multiball = false;
  G.ballsLeft--;
  if (G.ballsLeft <= 0) { G.overT = 1.3; callout('GAME OVER', '', PAL.violet, 3); return; }
  G.ballNo++; serve(true);
  callout('BALL ' + G.ballNo, '', PAL.teal, 2);
  updateHudFull();
}

function gameOver() {
  G.phase = 'over'; SFX.droneOff();
  if (G.score > G.best) { G.best = G.score; G.newBest = true; store.set('best', G.best); }
  $('overScore').textContent = fmt(G.score); $('overBest').textContent = fmt(G.best); $('newBest').hidden = !G.newBest;
  $('overModes').innerHTML = MODE_KEYS.map((k) => '<span class="' + (G.modes[k] ? 'done' : '') + '">' + MODE_NAMES[k] + '</span>').join('');
  $('best').textContent = fmt(G.best); $('titleBest').textContent = fmt(G.best);
  showScreen('screenOver');
}

/* ----- crystals: Light Leap ----- */
function hitCrystal(c) {
  if (c.cd > 0) return; c.cd = 0.15; c.flash = 1;
  burst(c.x, c.y, PAL.gold, 10, 220); SFX.crystal(c.note); vibrate(8);
  const wasLit = c.lit; c.lit = true;
  addScore(wasLit ? SC.crystal * 0.4 : SC.crystal, c.x, c.y + 18, false, PAL.gold);
  if (G.wizardT > 0) addScore(SC.wizardShot * 0.2, c.x, c.y + 32, false, PAL.violet);
  if (crystals.every((k) => k.lit)) lightLeap();
}
function lightLeap() {
  crystals.forEach((k) => { k.lit = false; k.flash = 1; });
  setMult(G.mult + 1); G.modes.leap = true;
  addScore(SC.lightLeap, 200, 300, true, PAL.gold);
  G.beam = 1; flash(1); shake(1); SFX.leap(); vibrate([20, 30, 40]);
  callout('LIGHT LEAP!', 'x' + G.mult + ' score', PAL.teal, 4);
  burst(200, 98, PAL.teal, 40, 360, 0); burst(200, 98, '#fff', 20, 300, 0);
  updateHudFull();
}

/* ----- ability orbs ----- */
function hitOrb(o) {
  if (o.cd > 0) return; o.cd = 0.15; o.flash = 1; o.lit = true;
  burst(o.x, o.y, PAL.violet, 8, 200); SFX.orb(); vibrate(8);
  addScore(SC.ability, o.x, o.y + 18, false, PAL.violet);
  callout(o.name, '', PAL.violet, 2);
  if (orbs.every((k) => k.lit)) {
    orbs.forEach((k) => { k.lit = false; k.flash = 1; });
    setMult(G.mult + 1); G.modes.ability = true;
    addScore(SC.abilitySet, 200, 380, true, PAL.violet);
    callout('ABILITIES UNLOCKED', 'x' + G.mult + ' score', PAL.violet, 5);
    SFX.hum(); flash(0.6); shake(0.6); burst(200, 360, PAL.violet, 30, 300);
    updateHudFull();
  }
}

/* ----- spinner / Alicorn bonus ----- */
function spinCounted() {
  G.spins++;
  addScore(G.alicornT > 0 ? SC.spinAlicorn : SC.spin); SFX.spin();
  if (G.wizardT > 0) addScore(300);
  if (G.alicornT <= 0 && G.spins >= CONFIG.spinner.spinsForBonus) startAlicorn();
}
function startAlicorn() {
  G.spins = 0; G.alicornT = MD.alicornTime; G.modes.alicorn = true;
  callout('ALICORN BONUS!', 'Bumpers and spins pay double', PAL.silver, 4); SFX.hum(); flash(0.5); updateHudFull();
}

/* ----- shots (ramps and scoops) ----- */
function shotHit(id, b) {
  const pos = SHOTS[id]; let pts = id.indexOf('ramp') === 0 ? SC.ramp : id === 'swan' ? SC.swan : SC.lock;
  if (id.indexOf('ramp') === 0) {
    G.rampHits++;
    const unlit = crystals.filter((c) => !c.lit); if (unlit.length > 1) { unlit[0].lit = true; unlit[0].flash = 1; }   // leaps feed the crystals
    SFX.hum(); if (G.multiball) pts = SC.jackpot;
    if (G.multiball) callout('JACKPOT!', '', PAL.gold, 3);
  }
  if (G.wizardT > 0) { addScore(SC.wizardShot, pos.x, pos.y, false, PAL.gold); callout('KEEPER SHOT!', '', PAL.gold, 2); burst(pos.x, pos.y, PAL.gold, 20, 300); return; }
  if (G.nev && G.nev.lit.indexOf(id) >= 0) { nevCollect(id); return; }
  addScore(pts, pos.x, pos.y + 20, false, PAL.teal);
}

/* Black Swan scoop: a random clue or award */
function swanAward() {
  const picks = ['points', 'extra', 'hint', 'hint', 'crystal', 'mult', 'neverseen', 'spins'];
  const pick = picks[Math.floor(Math.random() * picks.length)];
  const hints = [
    ['LIGHT ALL FIVE', 'Light every crystal to leap'], ['THREE LOCKS', 'Lock the Foxfire tower for multiball'],
    ['THE WING SPINS', 'Spin the Alicorn wing for a timed bonus'], ['SHADOWS GATHER', 'The bumpers draw the Neverseen out'],
    ['ABILITIES', 'Wake every ability orb for a multiplier']
  ];
  if (pick === 'neverseen' && (G.nev || G.multiball || G.wizardT > 0)) return swanAward();
  switch (pick) {
    case 'points': addScore(5000, 50, 250, false, PAL.gold); callout('BLACK SWAN', '+5,000', PAL.gold, 3); break;
    case 'extra': G.ballsLeft = Math.min(6, G.ballsLeft + 1); callout('EXTRA BALL', 'The swan smiles', PAL.gold, 3); SFX.extra(); updateHudFull(); break;
    case 'crystal': { const u = crystals.filter((c) => !c.lit); if (u.length > 1) { u[0].lit = true; u[0].flash = 1; } callout('BLACK SWAN', 'A crystal wakes', PAL.teal, 3); break; }
    case 'mult': setMult(G.mult + 1); callout('BLACK SWAN', 'Multiplier x' + G.mult, PAL.gold, 3); updateHudFull(); break;
    case 'spins': G.spins += 10; callout('BLACK SWAN', 'The wing hums', PAL.silver, 3); break;
    case 'neverseen': callout('BLACK SWAN', 'They found you', PAL.violet, 3); startNeverseen(); break;
    default: { const h = hints[Math.floor(Math.random() * hints.length)]; callout(h[0], h[1], PAL.silver, 4); }
  }
}

/* ----- Foxfire tower lock and multiball ----- */
function towerLock(b) {
  G.balls.splice(G.balls.indexOf(b), 1); G.locked++;
  addScore(SC.lock, scoops.tower.x, scoops.tower.y + 22, false, PAL.gold); SFX.lock(); flash(0.4); vibrate(25);
  if (G.locked >= MD.locksForMultiball) { startMultiball(); return; }
  callout('BALL LOCKED', G.locked + ' of ' + MD.locksForMultiball, PAL.gold, 3);
  if (G.balls.length === 0) { serve(false); G.saveT = Math.max(G.saveT, 3); }
}
function startMultiball() {
  G.locked = 0; G.multiball = true; G.modes.foxfire = true;
  for (let i = 0; i < MD.multiballBalls; i++) {
    const b = newBallObj('scoop'); b.t = 0.5 + i * 0.7; b.x = scoops.tower.x; b.y = scoops.tower.y; b.scoop = scoops.tower; G.balls.push(b);
  }
  callout('MULTIBALL!', 'Foxfire is open', PAL.gold, 5); SFX.multiball(); flash(0.8); shake(1); updateHudFull();
}

/* ----- Neverseen hurry-up ----- */
function startNeverseen() {
  if (G.nev || G.multiball || G.wizardT > 0) return;
  const shots = ['rampL', 'rampR', 'swan', 'tower'].sort(() => Math.random() - 0.5);
  G.nev = { t: MD.neverseenTime, hits: 0, lit: shots.slice(0, 2), pot: SC.neverseenPot };
  G.bumperHits = 0; SFX.dark(); SFX.droneOn(); shake(0.7); flash(0.3);
  callout('NEVERSEEN!', 'Hit the flashing shots', PAL.violet, 5);
}
function nevCollect(id) {
  const n = G.nev, pos = SHOTS[id]; const pts = Math.round(n.pot);
  addScore(pts, pos.x, pos.y, true, '#fff'); n.hits++; n.lit.splice(n.lit.indexOf(id), 1);
  burst(pos.x, pos.y, PAL.violet, 26, 320); SFX.win(); shake(0.5); vibrate(25);
  if (n.hits >= MD.neverseenHits) { endNeverseen(true); return; }
  const pool = Object.keys(SHOTS).filter((k) => n.lit.indexOf(k) < 0 && k !== id); n.lit.push(pool[Math.floor(Math.random() * pool.length)]);
  callout('GOT ' + fmt(pts), (MD.neverseenHits - n.hits) + ' to go', PAL.violet, 2);
}
function endNeverseen(won) {
  G.nev = null; SFX.droneOff();
  if (won) { G.modes.neverseen = true; addScore(SC.neverseenWin, 200, 400, true, PAL.gold); callout('THEY FLEE!', '+' + fmt(SC.neverseenWin), PAL.gold, 4); SFX.leap(); flash(0.8); updateHudFull(); }
  else { callout('THEY ESCAPED!', 'with your points', PAL.violet, 3); SFX.fail(); }
}

/* ----- Wizard mode ----- */
function startWizard() {
  G.wizardT = MD.wizardTime; flash(1); shake(1.2); SFX.multiball(); SFX.leap();
  callout('KEEPER OF THE LOST CITIES', 'Every shot scores', PAL.gold, 6);
  crystals.forEach((c) => (c.lit = true));
}
function endWizard() {
  G.wizardT = 0; addScore(SC.wizardEnd, 200, 380, true, PAL.gold);
  MODE_KEYS.forEach((k) => (G.modes[k] = false)); crystals.forEach((c) => (c.lit = false));
  callout('KEEPER COMPLETE', '+' + fmt(SC.wizardEnd), PAL.gold, 5); SFX.win(); updateHudFull();
}

/* ===================================================================
   6. Physics
   =================================================================== */
const DT = CONFIG.physics.step, GRAV = CONFIG.physics.gravity, REST = CONFIG.physics.restSpeed;

// Ball vs capsule (segment with a radius at each end). Returns the impact speed or 0.
function collideSeg(b, ax, ay, bx, by, r0, r1, e, fl) {
  const abx = bx - ax, aby = by - ay, len2 = abx * abx + aby * aby;
  let t = ((b.x - ax) * abx + (b.y - ay) * aby) / len2; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + abx * t, cy = ay + aby * t, rad = BR + r0 + (r1 - r0) * t;
  const dx = b.x - cx, dy = b.y - cy, d2 = dx * dx + dy * dy;
  if (d2 >= rad * rad) return 0;
  let d = Math.sqrt(d2), nx, ny;
  if (d < 1e-6) { const l = Math.sqrt(len2) || 1; nx = -aby / l; ny = abx / l; } else { nx = dx / d; ny = dy / d; }
  b.x = cx + nx * rad; b.y = cy + ny * rad;
  let sx = 0, sy = 0;
  if (fl) { const dist = t * fl.len; sx = fl.omega * dist * (-fl.s * Math.sin(fl.a)); sy = fl.omega * dist * Math.cos(fl.a); }   // surface velocity at the contact point
  const rvn = (b.vx - sx) * nx + (b.vy - sy) * ny;
  if (rvn >= 0) return 0;
  const imp = -rvn, ee = imp < REST ? 0 : e;
  b.vx -= (1 + ee) * rvn * nx; b.vy -= (1 + ee) * rvn * ny;
  b._nx = nx; b._ny = ny;
  return imp;
}
function collideCircle(b, cx0, cy0, r, e, kick, minOut) {
  const dx = b.x - cx0, dy = b.y - cy0, rad = r + BR, d2 = dx * dx + dy * dy;
  if (d2 >= rad * rad) return 0;
  const d = Math.sqrt(d2) || 0.0001, nx = dx / d, ny = dy / d;
  b.x = cx0 + nx * rad; b.y = cy0 + ny * rad;
  const vn = b.vx * nx + b.vy * ny;
  if (vn < 0) { b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny; }
  if (kick) { b.vx += nx * kick; b.vy += ny * kick; }
  if (minOut) { const o = b.vx * nx + b.vy * ny; if (o < minOut) { b.vx += nx * (minOut - o); b.vy += ny * (minOut - o); } }
  return Math.abs(vn) + 1;
}

function updateFlippers(dt) {
  const F = CONFIG.flipper;
  flippers.forEach((f) => {
    const target = f.press ? F.upAngle : F.restAngle, rate = (f.press ? F.swingUp : F.swingDown) * dt;
    let da = target - f.a; da = da > rate ? rate : da < -rate ? -rate : da;
    f.a += da; f.omega = da / dt;
  });
}
function flipperTip(f) { return [f.x + f.s * Math.cos(f.a) * f.len, f.y + Math.sin(f.a) * f.len]; }

function onRamp(b, rp) {
  b.st = 'ramp'; b.rp = rp; b.rt = 0; b.lastRamp = rp.id; shotHit(rp.id, b); SFX.hum(); vibrate(15);
  burst(rp.ex, rp.ey, PAL.teal, 12, 220);
}
function bez(rp, t) {
  const u = 1 - t, p0x = rp.ex, p0y = rp.ey;
  return [u * u * p0x + 2 * u * t * rp.p1.x + t * t * rp.p2.x, u * u * p0y + 2 * u * t * rp.p1.y + t * t * rp.p2.y];
}

function stepBall(b, dt) {
  if (b.st === 'held') { b.t -= dt; b.x = CONFIG.launch.x; b.y = CONFIG.launch.y; if (b.t <= 0) launchBall(b); return; }
  if (b.st === 'ramp') {
    b.rt += dt / b.rp.dur; const t = Math.min(1, b.rt), e = t * t * (3 - 2 * t), p = bez(b.rp, e); b.x = p[0]; b.y = p[1]; b.lift = 12 * e;   // the ramp deck rises 12px
    if (b.rt >= 1) { b.lift = 0; b.st = 'play'; b.vx = b.rp.vx; b.vy = b.rp.vy; b.cool = 0.4; SFX.eject(); }
    return;
  }
  if (b.st === 'scoop') {
    b.t -= dt; b.x = b.scoop.x; b.y = b.scoop.y;
    if (b.t <= 0) { b.st = 'play'; b.vx = b.scoop.evx + rand(-40, 40); b.vy = b.scoop.evy; b.cool = 0.5; SFX.eject(); burst(b.x, b.y, PAL.gold, 12, 220); vibrate(15); }
    return;
  }
  // free ball
  b.cool -= dt;
  b.vy += GRAV * dt;
  const drag = 1 - CONFIG.physics.airDrag * dt; b.vx *= drag; b.vy *= drag;
  let sp = Math.hypot(b.vx, b.vy); if (sp > CONFIG.physics.maxSpeed) { const k = CONFIG.physics.maxSpeed / sp; b.vx *= k; b.vy *= k; sp = CONFIG.physics.maxSpeed; }
  b.x += b.vx * dt; b.y += b.vy * dt;

  for (let i = 0; i < segs.length; i++) {                      // walls, arch, guides
    const s = segs[i]; if (s.oneWay && b.vy < 0) continue;
    const imp = collideSeg(b, s.ax, s.ay, s.bx, s.by, 0, 0, s.e, null);
    if (imp) {
      if (s.kick && imp > s.minImpact) { b.vx += b._nx * s.kick; b.vy += b._ny * s.kick; s.glow = 1; addScore(SC.sling); SFX.sling(); vibrate(10); burst(b.x, b.y, PAL.gold, 5, 150); }
      else if (imp > 250) { SFX.wall(imp); }
    }
  }
  for (let i = 0; i < flippers.length; i++) {                  // flippers: swing speed transfers to the ball
    const f = flippers[i], tip = flipperTip(f);
    collideSeg(b, f.x, f.y, tip[0], tip[1], CONFIG.flipper.baseRadius, CONFIG.flipper.tipRadius, CONFIG.flipper.bounce, f);
  }
  for (let i = 0; i < bumpers.length; i++) {
    const bm = bumpers[i];
    if (collideCircle(b, bm.x, bm.y, bm.r, 0.8, CONFIG.bumper.kick, CONFIG.bumper.minOut)) {
      bm.flash = 1; bm.ring = 1; bm.ci = (bm.ci + 1) % BUMPER_COLORS.length;
      addScore(SC.bumper * (G.alicornT > 0 ? 2 : 1) * (G.wizardT > 0 ? 3 : 1), bm.x, bm.y - bm.r - 4, false, BUMPER_COLORS[bm.ci]);
      burst(b.x, b.y, BUMPER_COLORS[bm.ci], 8, 220); burst(bm.x, bm.y - bm.r * 0.6, '#fff', 4, 70, 1);
      SFX.bumper(); vibrate(12); shake(0.12);
      G.bumperHits++;
      if (G.bumperHits >= MD.bumperHitsForNeverseen) startNeverseen();
    }
  }
  for (let i = 0; i < crystals.length; i++) { const c = crystals[i]; if (collideCircle(b, c.x, c.y, c.r, 0.6, 60, 0)) hitCrystal(c); }
  for (let i = 0; i < orbs.length; i++) { const o = orbs[i]; if (collideCircle(b, o.x, o.y, o.r, 0.7, 40, 0)) hitOrb(o); }

  // spinner (sensor): the faster you pass, the more it spins
  const sdx = b.x - spinner.x, sdy = b.y - spinner.y;
  if (sdx * sdx + sdy * sdy < spinner.r * spinner.r) {
    if (!b.inSpin) { b.inSpin = true; spinner.w = Math.min(45, spinner.w + Math.abs(b.vy) * CONFIG.spinner.spinPerSpeed); b.vy *= 0.97; }
  } else b.inSpin = false;

  // ramps (sensors; need an upward shot)
  if (b.cool <= 0) {
    for (const k in ramps) { const rp = ramps[k], dx = b.x - rp.ex, dy = b.y - rp.ey; if (dx * dx + dy * dy < rp.r * rp.r && b.vy < -120) { onRamp(b, rp); return; } }
    for (const k in scoops) {
      const sc = scoops[k], dx = b.x - sc.x, dy = b.y - sc.y;
      if (dx * dx + dy * dy < sc.r * sc.r) {
        if (k === 'swan') { b.st = 'scoop'; b.scoop = sc; b.t = 1.0; shotHit('swan', b); SFX.scoop(); burst(sc.x, sc.y, PAL.silver, 14, 200); if (!G.nev && G.wizardT <= 0) swanAward(); return; }
        // tower
        if (G.nev || G.wizardT > 0 || G.multiball) { b.st = 'scoop'; b.scoop = sc; b.t = 0.7; shotHit('tower', b); SFX.scoop(); return; }
        towerLock(b); return;
      }
    }
  }

  // launch lane: re-launch if the ball ever settles there
  if (b.x > 362 && b.y > 300) {
    if (Math.hypot(b.vx, b.vy) < 70) { b.idle += dt; if (b.idle > CONFIG.launch.settleTime) { b.st = 'held'; b.t = 0.35; b.x = CONFIG.launch.x; b.y = CONFIG.launch.y; b.vx = b.vy = 0; b.idle = 0; } } else b.idle = 0;
  } else b.idle = 0;
  // anti-stall: a ball that stops mid table (not on a flipper) gets a nudge
  // a ball resting near the flippers while neither is held rolls to the centre drain
  if (sp < 15 && b.y >= 600 && b.x < 362 && !flippers[0].press && !flippers[1].press) { b.still += dt; if (b.still > 0.8) { b.vx += (b.x < 200 ? 1 : -1) * 120; b.vy += 60; b.still = 0; } }
  else if (sp < 8 && b.y < 600) { b.still += dt; if (b.still > 1.6) { b.vx += rand(-200, 200); b.vy -= 260; b.still = 0; } } else b.still = 0;
}

function ballVsBall() {
  const bs = G.balls;
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i], c = bs[j]; if (a.st !== 'play' || c.st !== 'play') continue;
    const dx = c.x - a.x, dy = c.y - a.y, d2 = dx * dx + dy * dy, min = BR * 2;
    if (d2 >= min * min) continue;
    const d = Math.sqrt(d2) || 0.001, nx = dx / d, ny = dy / d, ov = (min - d) / 2;
    a.x -= nx * ov; a.y -= ny * ov; c.x += nx * ov; c.y += ny * ov;
    const rv = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny; if (rv >= 0) continue;
    const j2 = -(1 + CONFIG.physics.ballBounce) * rv / 2;
    a.vx -= j2 * nx; a.vy -= j2 * ny; c.vx += j2 * nx; c.vy += j2 * ny;
  }
}

function stepWorld(dt) {
  G.time += dt;
  updateFlippers(dt);
  for (let i = G.balls.length - 1; i >= 0; i--) {
    const b = G.balls[i]; stepBall(b, dt);
    if (b.st === 'play' && (b.y > H + 14 || b.x < -20 || b.x > W + 20 || b.y < -40)) ballDrained(b);
  }
  if (G.balls.length > 1) ballVsBall();
  // spinner angle and counted spins
  if (spinner.w > 0.2) { spinner.angle += spinner.w * dt; G.spinAcc += spinner.w * dt; spinner.w *= 1 - CONFIG.spinner.friction * dt; while (G.spinAcc >= TAU) { G.spinAcc -= TAU; spinCounted(); } } else spinner.w = 0;
}

/* Slower, frame-rate-bound rule timers (modes, decay) */
function updateRules(dt) {
  if (G.saveT > 0) G.saveT -= dt;
  if (G.alicornT > 0) { G.alicornT -= dt; if (G.alicornT <= 0) { G.alicornT = 0; addScore(SC.alicornEnd, 200, 380, true); callout('ALICORN BONUS ENDS', '', PAL.silver, 0); } }
  if (G.wizardT > 0) { G.wizardT -= dt; if (G.wizardT <= 0) endWizard(); }
  if (G.nev) { G.nev.t -= dt; G.nev.pot = SC.neverseenPot * (0.25 + 0.75 * clamp(G.nev.t / MD.neverseenTime, 0, 1)); if (G.nev.t <= 0) endNeverseen(false); }
  G.dark += ((G.nev ? 1 : 0) - G.dark) * Math.min(1, dt * 3);
  if (!G.wizardT && !G.nev && !G.multiball && MODE_KEYS.every((k) => G.modes[k])) startWizard();
  if (G.overT > 0) { G.overT -= dt; if (G.overT <= 0) gameOver(); }
}

/* ===================================================================
   7. Rendering
   =================================================================== */
const canvas = $('table'), vctx = canvas.getContext('2d');                 // visible canvas: receives the perspective warp
const scene = document.createElement('canvas'), ctx = scene.getContext('2d');   // flat top-down render
const PERSP = { top: 0.8 };   // far end of the table is 80% as wide as the near end (2.5D tilt)
let bg = null, pxScale = 1, cssK = 1;
const glowCache = {}, userImg = {};

// Optional artwork: drop PNG/JPG files into assets/ and they load automatically.
['backdrop.png', 'backdrop.jpg', 'ball.png', 'crystal.png'].forEach((f) => {
  const im = new Image(); im.onload = () => { userImg[f.replace(/\.\w+$/, '')] = im; buildBackground(); }; im.src = 'assets/' + f;
});

function glowSprite(color) {
  if (glowCache[color]) return glowCache[color];
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32); rg.addColorStop(0, color); rg.addColorStop(0.35, color + '88'); rg.addColorStop(1, color + '00');
  g.fillStyle = rg; g.fillRect(0, 0, 64, 64); return (glowCache[color] = c);
}
function glow(x, y, r, color, a) { ctx.globalAlpha = a; ctx.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2); }
let ballSprite = null;
function makeBallSprite() {
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
  if (userImg.ball) { g.save(); g.beginPath(); g.arc(32, 32, 31, 0, TAU); g.clip(); g.drawImage(userImg.ball, 0, 0, s, s); g.restore(); return c; }
  // mirror-chrome: bright sky on top, dark horizon band, teal bounce light below
  const base = g.createRadialGradient(24, 20, 3, 32, 32, 31); base.addColorStop(0, '#ffffff'); base.addColorStop(0.35, '#dfe4f2'); base.addColorStop(0.7, '#7b84a2'); base.addColorStop(1, '#1d2140');
  g.fillStyle = base; g.beginPath(); g.arc(32, 32, 31, 0, TAU); g.fill();
  g.save(); g.beginPath(); g.arc(32, 32, 31, 0, TAU); g.clip();
  const hz = g.createLinearGradient(0, 28, 0, 46); hz.addColorStop(0, 'rgba(10,12,38,0)'); hz.addColorStop(0.5, 'rgba(10,12,38,0.75)'); hz.addColorStop(1, 'rgba(95,211,198,0.55)');
  g.fillStyle = hz; g.fillRect(0, 28, s, 36); g.restore();
  g.fillStyle = 'rgba(255,255,255,0.95)'; g.beginPath(); g.ellipse(22, 17, 7, 4, -0.5, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(221,226,240,0.6)'; g.lineWidth = 1.5; g.beginPath(); g.arc(32, 32, 30.5, 0, TAU); g.stroke();
  return c;
}

// Pseudo-random that is stable between rebuilds
function seeded(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646; }

function pathCrystalTower(g, x, base, w, h, col, edge) {
  g.fillStyle = col; g.beginPath(); g.moveTo(x - w / 2, base); g.lineTo(x - w / 2, base - h * 0.78); g.lineTo(x, base - h); g.lineTo(x + w / 2, base - h * 0.78); g.lineTo(x + w / 2, base); g.closePath(); g.fill();
  g.fillStyle = edge; g.beginPath(); g.moveTo(x, base - h); g.lineTo(x + w / 2, base - h * 0.78); g.lineTo(x + w / 2, base); g.lineTo(x, base); g.closePath(); g.fill();
}

// Everything that never moves is painted once into an offscreen canvas.
function buildBackground() {
  bg = document.createElement('canvas'); bg.width = canvas.width; bg.height = canvas.height;
  const g = bg.getContext('2d'); g.setTransform(pxScale, 0, 0, pxScale, 0, 0);
  const rnd = seeded(12345);
  // sky + table surface
  const sky = g.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#080A22'); sky.addColorStop(0.45, '#0F1442'); sky.addColorStop(1, PAL.indigo);
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  if (userImg.backdrop) { g.globalAlpha = 0.4; g.drawImage(userImg.backdrop, 0, 0, W, H); g.globalAlpha = 1; }
  // stars
  for (let i = 0; i < 90; i++) { const x = rnd() * W, y = rnd() * H * 0.8, r = rnd() * 1.3 + 0.3; g.fillStyle = 'rgba(221,226,240,' + (0.3 + rnd() * 0.6) + ')'; g.fillRect(x, y, r, r); }
  // aurora (soft stacked bands)
  [[PAL.teal, 90, 0.16], [PAL.violet, 130, 0.14], [PAL.teal, 60, 0.1]].forEach((a, i) => {
    const gr = g.createLinearGradient(0, a[1] - 60, 0, a[1] + 80); gr.addColorStop(0, a[0] + '00'); gr.addColorStop(0.5, a[0] + Math.round(a[2] * 255).toString(16).padStart(2, '0')); gr.addColorStop(1, a[0] + '00');
    g.fillStyle = gr; g.beginPath(); g.moveTo(0, a[1] + 40);
    for (let x = 0; x <= W; x += 20) g.lineTo(x, a[1] + Math.sin(x * 0.02 + i * 2) * 28 + Math.sin(x * 0.05 + i) * 10);
    g.lineTo(W, a[1] + 140); g.lineTo(0, a[1] + 140); g.closePath(); g.fill();
  });
  // skyline of crystal towers (lower half, behind the action)
  const base = 700;
  for (let layer = 0; layer < 2; layer++) {
    for (let x = 14; x < W - 10; x += 26 + rnd() * 20) {
      const h = (layer ? 90 : 140) + rnd() * 120, w = 18 + rnd() * 16;
      pathCrystalTower(g, x, base, w, h, layer ? 'rgba(46,60,140,0.35)' : 'rgba(95,211,198,0.14)', layer ? 'rgba(30,35,96,0.5)' : 'rgba(155,120,224,0.16)');
      for (let k = 0; k < 4; k++) if (rnd() > 0.5) { g.fillStyle = 'rgba(232,198,106,0.55)'; g.fillRect(x - w / 4 + rnd() * w / 2, base - h * 0.7 + k * 20 * rnd() + 6, 2, 3); }
    }
  }
  // low fog that melts the skyline into the table, then a soft vignette for depth
  const fog = g.createLinearGradient(0, 520, 0, 720); fog.addColorStop(0, 'rgba(30,35,96,0)'); fog.addColorStop(1, 'rgba(30,35,96,0.85)');
  g.fillStyle = fog; g.fillRect(0, 520, W, 220);
  const vig = g.createRadialGradient(200, 400, 120, 200, 400, 460); vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(3,4,16,0.6)');
  g.fillStyle = vig; g.fillRect(0, 0, W, H);
  // crescent moon glow behind the title
  const mg = g.createRadialGradient(200, 40, 2, 200, 40, 70); mg.addColorStop(0, 'rgba(255,243,214,0.35)'); mg.addColorStop(1, 'rgba(255,243,214,0)');
  g.fillStyle = mg; g.fillRect(100, 0, 200, 110);
  // compass-rose rings in the middle of the playfield
  g.strokeStyle = 'rgba(232,198,106,0.13)'; g.lineWidth = 1.2;
  [60, 92, 128].forEach((r) => { g.beginPath(); g.arc(200, 470, r, 0, TAU); g.stroke(); });
  g.beginPath(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; g.moveTo(200, 470); g.lineTo(200 + Math.cos(a) * 140, 470 + Math.sin(a) * 140); } g.stroke();
  // pools of coloured light under the pop bumpers, a faceted decal, and distance haze
  bumpers.forEach((bm, i) => { const pg = g.createRadialGradient(bm.x, bm.y, 4, bm.x, bm.y, 74); pg.addColorStop(0, BUMPER_COLORS[i] + '42'); pg.addColorStop(1, BUMPER_COLORS[i] + '00'); g.fillStyle = pg; g.fillRect(bm.x - 74, bm.y - 74, 148, 148); });
  g.save(); g.translate(200, 470);
  for (let i = 0; i < 8; i++) { const an = i * Math.PI / 4; g.fillStyle = i % 2 ? 'rgba(95,211,198,0.07)' : 'rgba(155,120,224,0.08)'; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(an - 0.2) * 66, Math.sin(an - 0.2) * 66); g.lineTo(Math.cos(an) * 130, Math.sin(an) * 130); g.lineTo(Math.cos(an + 0.2) * 66, Math.sin(an + 0.2) * 66); g.closePath(); g.fill(); g.strokeStyle = 'rgba(232,198,106,0.2)'; g.lineWidth = 1; g.stroke(); }
  g.restore();
  const haze = g.createLinearGradient(0, 0, 0, 380); haze.addColorStop(0, 'rgba(4,5,20,0.4)'); haze.addColorStop(1, 'rgba(4,5,20,0)'); g.fillStyle = haze; g.fillRect(0, 0, W, 380);

  // light-leap ramps: raised glass decks with rails, a cast shadow and an arched mouth
  Object.keys(ramps).forEach((k) => {
    const rp = ramps[k], pts = [], n = 36;
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t, x = u * u * rp.ex + 2 * u * t * rp.p1.x + t * t * rp.p2.x, y = u * u * rp.ey + 2 * u * t * rp.p1.y + t * t * rp.p2.y - 12 * t;   // deck rises 12px toward the exit
      const dx = 2 * u * (rp.p1.x - rp.ex) + 2 * t * (rp.p2.x - rp.p1.x), dy = 2 * u * (rp.p1.y - rp.ey) + 2 * t * (rp.p2.y - rp.p1.y), l = Math.hypot(dx, dy) || 1;
      pts.push([x, y, -dy / l, dx / l, 10 - 3 * t]);
    }
    const edge = (sg, ox, oy) => pts.map((p) => [p[0] + p[2] * p[4] * sg + ox, p[1] + p[3] * p[4] * sg + oy]);
    const poly = (A, B) => { g.beginPath(); A.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); B.slice().reverse().forEach((p) => g.lineTo(p[0], p[1])); g.closePath(); };
    poly(edge(1, 10, 15), edge(-1, 10, 15)); g.fillStyle = 'rgba(0,0,0,0.3)'; g.fill();                       // cast shadow on the playfield
    const L = edge(1, 0, 0), Rr = edge(-1, 0, 0);
    poly(L, Rr); const dg = g.createLinearGradient(rp.ex, rp.ey, rp.p2.x, rp.p2.y); dg.addColorStop(0, 'rgba(95,211,198,0.10)'); dg.addColorStop(1, 'rgba(184,242,234,0.30)'); g.fillStyle = dg; g.fill();
    [L, Rr].forEach((E) => {
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); E.forEach((p, i) => (i ? g.lineTo(p[0], p[1] + 4) : g.moveTo(p[0], p[1] + 4))); g.strokeStyle = '#124A6B'; g.lineWidth = 3.5; g.stroke();          // rail side face
      g.beginPath(); E.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.strokeStyle = '#CFF7F1'; g.lineWidth = 2.4; g.stroke();                  // rail top
    });
    for (let i = 3; i < n; i += 4) { g.strokeStyle = 'rgba(184,242,234,0.2)'; g.lineWidth = 1; g.beginPath(); g.moveTo(L[i][0], L[i][1]); g.lineTo(Rr[i][0], Rr[i][1]); g.stroke(); }  // deck ribs
    // arched mouth with two gold posts
    g.fillStyle = 'rgba(95,211,198,0.35)'; g.beginPath(); g.arc(rp.ex, rp.ey, rp.r - 2, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 4; g.beginPath(); g.arc(rp.ex + 5, rp.ey + 8, rp.r + 2, Math.PI, TAU); g.stroke();
    g.strokeStyle = '#7A5A14'; g.lineWidth = 5; g.beginPath(); g.arc(rp.ex, rp.ey + 3, rp.r + 2, Math.PI, TAU); g.stroke();
    g.strokeStyle = PAL.gold; g.lineWidth = 3.5; g.beginPath(); g.arc(rp.ex, rp.ey, rp.r + 2, Math.PI, TAU); g.stroke();
    [-1, 1].forEach((sg) => { const pg = g.createRadialGradient(rp.ex + sg * (rp.r + 2) - 1, rp.ey - 2, 1, rp.ex + sg * (rp.r + 2), rp.ey, 5); pg.addColorStop(0, '#FFF1C2'); pg.addColorStop(1, '#8A6A1C'); g.fillStyle = pg; g.beginPath(); g.arc(rp.ex + sg * (rp.r + 2), rp.ey, 4.5, 0, TAU); g.fill(); });
  });

  // walls: raised chrome rails with a cast shadow, a dark side face, a lit top and a gold inlay
  g.lineCap = 'round'; g.lineJoin = 'round';
  const wallsPath = () => { g.beginPath(); segs.forEach((sg) => { if (sg.sling || sg.gate) return; g.moveTo(sg.ax, sg.ay); g.lineTo(sg.bx, sg.by); }); };
  const strokeWalls = (color, w, ox, oy) => { wallsPath(); g.strokeStyle = color; g.lineWidth = w; g.save(); g.translate(ox, oy); g.stroke(); g.restore(); };
  strokeWalls('rgba(0,0,0,0.4)', 13, 5, 9);
  g.shadowColor = PAL.teal; g.shadowBlur = 14; strokeWalls('#0E2E52', 11, 0, 4); g.shadowBlur = 0;
  const rail = g.createLinearGradient(0, 0, W, 0); rail.addColorStop(0, '#D8FBF6'); rail.addColorStop(0.5, '#5FD3C6'); rail.addColorStop(1, '#2E8F86');
  strokeWalls(rail, 8.5, 0, 0); strokeWalls('rgba(255,255,255,0.85)', 1.6, -1.8, -1.8); strokeWalls('rgba(232,198,106,0.9)', 1, 0, 0);
  // slingshot guides: gold rubber bands
  const strokeSeg = (sg, ox, oy, color, w) => { g.strokeStyle = color; g.lineWidth = w; g.beginPath(); g.moveTo(sg.ax + ox, sg.ay + oy); g.lineTo(sg.bx + ox, sg.by + oy); g.stroke(); };
  segs.filter((sg) => sg.sling).forEach((sg) => { strokeSeg(sg, 5, 9, 'rgba(0,0,0,0.4)', 12); strokeSeg(sg, 0, 4, '#6B4A0F', 10); strokeSeg(sg, 0, 0, PAL.gold, 8); strokeSeg(sg, -1, -1.5, 'rgba(255,248,220,0.9)', 1.8); });
  // gold posts at the guide tops
  [[8, 570], [362, 570]].forEach((p) => { g.fillStyle = 'rgba(0,0,0,0.4)'; g.beginPath(); g.ellipse(p[0] + 5, p[1] + 8, 8, 5, 0, 0, TAU); g.fill(); const pg = g.createRadialGradient(p[0] - 2, p[1] - 3, 1, p[0], p[1], 8); pg.addColorStop(0, '#FFF7DA'); pg.addColorStop(1, '#8A6A1C'); g.fillStyle = pg; g.beginPath(); g.arc(p[0], p[1], 7, 0, TAU); g.fill(); });
  // gold rivets (little gems) on the arch
  for (let i = 4; i < 48; i += 4) { const a = Math.PI + Math.PI * i / 48; g.fillStyle = PAL.gold; g.beginPath(); g.arc(ARCH.cx + (ARCH.r + 6) * Math.cos(a), ARCH.cy + (ARCH.r + 6) * Math.sin(a), 1.8, 0, TAU); g.fill(); }
  // launch lane chevrons
  g.strokeStyle = 'rgba(95,211,198,0.35)'; g.lineWidth = 2;
  for (let y = 640; y > 300; y -= 46) { g.beginPath(); g.moveTo(369, y); g.lineTo(377, y - 8); g.lineTo(385, y); g.stroke(); }
  // title
  g.textAlign = 'center'; g.fillStyle = 'rgba(232,198,106,0.55)'; g.font = '700 15px Cinzel, Georgia, serif';
  g.fillText('LOST CITIES', 200, 60);
  g.fillStyle = 'rgba(221,226,240,0.35)'; g.font = '600 9px Cinzel, Georgia, serif'; g.fillText('P I N B A L L', 200, 74);
  // under-flipper apron
  const ap = g.createLinearGradient(0, 570, 0, H); ap.addColorStop(0, 'rgba(8,10,34,0.9)'); ap.addColorStop(1, '#05061A');
  g.fillStyle = ap; g.beginPath(); g.moveTo(110, 664); g.lineTo(174, 700); g.lineTo(174, H); g.lineTo(0, H); g.lineTo(0, 570); g.lineTo(8, 570); g.closePath(); g.fill();
  g.fillStyle = ap; g.beginPath(); g.moveTo(290, 660); g.lineTo(226, 700); g.lineTo(226, H); g.lineTo(362, H); g.lineTo(362, 570); g.closePath(); g.fill();
  // drain ornament: gold diamond and fine arcs
  g.strokeStyle = 'rgba(232,198,106,0.5)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(200, 716); g.lineTo(212, 732); g.lineTo(200, 748); g.lineTo(188, 732); g.closePath(); g.stroke();
  g.beginPath(); g.arc(200, 790, 70, Math.PI * 1.15, Math.PI * 1.85); g.stroke();
  // inlane rivet lights along the guides
  [[8, 570, 118, 662], [362, 570, 282, 662]].forEach((q) => { for (let i = 1; i < 6; i++) { const t = i / 6; g.fillStyle = 'rgba(95,211,198,0.75)'; g.beginPath(); g.arc(lerp(q[0], q[2], t) + (q[0] < 100 ? 7 : -7), lerp(q[1], q[3], t) + 9, 1.6, 0, TAU); g.fill(); } });
  ballSprite = makeBallSprite();
}

/* ----- dynamic drawing ----- */
/* ----- 2.5D helpers: light comes from the upper left, so shadows fall down and right ----- */
function castShadow(x, y, rx, ry, a) { ctx.fillStyle = 'rgba(0,0,0,' + (a || 0.38) + ')'; ctx.beginPath(); ctx.ellipse(x + 6, y + 9, rx, ry, 0, 0, TAU); ctx.fill(); }
function metalGrad(x0, x1, light, mid, dark) { const gr = ctx.createLinearGradient(x0, 0, x1, 0); gr.addColorStop(0, light); gr.addColorStop(0.5, mid); gr.addColorStop(1, dark); return gr; }
function drawCrystal(c, hue) {                      // a gem set in a gold collar, standing up from the table
  const lit = c.lit || G.wizardT > 0;
  castShadow(c.x, c.y + 6, 12, 5, 0.42);
  ctx.fillStyle = '#10153F'; ctx.beginPath(); ctx.ellipse(c.x, c.y + 14, 13, 5.5, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = metalGrad(c.x - 13, c.x + 13, '#FFF1C2', '#C9A24A', '#6E5418'); ctx.beginPath(); ctx.ellipse(c.x, c.y + 12, 12, 4.5, 0, 0, TAU); ctx.fill();
  ctx.save(); ctx.translate(0, -6); drawGem(c, hue); ctx.restore();
  if (lit) {
    const sp = 0.5 + 0.5 * Math.sin(G.time * 5 + c.note * 1.7), k = 3 + 4 * sp;
    ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = 'rgba(255,255,255,' + (0.35 + 0.5 * sp) + ')'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(c.x + 7 - k, c.y - 16); ctx.lineTo(c.x + 7 + k, c.y - 16); ctx.moveTo(c.x + 7, c.y - 16 - k); ctx.lineTo(c.x + 7, c.y - 16 + k); ctx.stroke(); ctx.globalCompositeOperation = 'source-over';
  }
}
function drawGem(c, hue) {
  const s = 11, lit = c.lit || G.wizardT > 0, fl = c.flash;
  let main = '#2A3278', hi = '#4756B8', lo = '#1B2160';
  if (lit) { main = PAL.gold; hi = '#FFF1C2'; lo = '#B78E2C'; }
  if (G.wizardT > 0) { main = 'hsl(' + hue + ',85%,62%)'; hi = '#fff'; lo = 'hsl(' + ((hue + 40) % 360) + ',70%,40%)'; }
  if (G.dark > 0.3 && !lit) { main = '#3A2C78'; hi = '#6A52B8'; lo = '#1E1650'; }
  if (lit) glow(c.x, c.y, 34 + fl * 12, G.wizardT > 0 ? '#FFFFFF' : PAL.gold, 0.55 + 0.25 * Math.sin(G.time * 6 + c.note));
  ctx.globalAlpha = 1;
  ctx.fillStyle = main; ctx.beginPath(); ctx.moveTo(c.x, c.y - s * 1.35); ctx.lineTo(c.x + s * 0.85, c.y - s * 0.3); ctx.lineTo(c.x + s * 0.85, c.y + s * 0.45); ctx.lineTo(c.x, c.y + s * 1.25); ctx.lineTo(c.x - s * 0.85, c.y + s * 0.45); ctx.lineTo(c.x - s * 0.85, c.y - s * 0.3); ctx.closePath(); ctx.fill();
  ctx.fillStyle = hi; ctx.beginPath(); ctx.moveTo(c.x, c.y - s * 1.35); ctx.lineTo(c.x + s * 0.85, c.y - s * 0.3); ctx.lineTo(c.x, c.y - s * 0.1); ctx.lineTo(c.x - s * 0.85, c.y - s * 0.3); ctx.closePath(); ctx.fill();
  ctx.fillStyle = lo; ctx.beginPath(); ctx.moveTo(c.x, c.y - s * 0.1); ctx.lineTo(c.x + s * 0.85, c.y - s * 0.3); ctx.lineTo(c.x + s * 0.85, c.y + s * 0.45); ctx.lineTo(c.x, c.y + s * 1.25); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(221,226,240,0.75)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(c.x, c.y - s * 1.35); ctx.lineTo(c.x + s * 0.85, c.y - s * 0.3); ctx.lineTo(c.x + s * 0.85, c.y + s * 0.45); ctx.lineTo(c.x, c.y + s * 1.25); ctx.lineTo(c.x - s * 0.85, c.y + s * 0.45); ctx.lineTo(c.x - s * 0.85, c.y - s * 0.3); ctx.closePath(); ctx.stroke();
  if (fl > 0.05) { ctx.fillStyle = 'rgba(255,255,255,' + fl * 0.8 + ')'; ctx.beginPath(); ctx.arc(c.x, c.y, s * (1 + (1 - fl)), 0, TAU); ctx.fill(); }
}
function drawBumper(b) {                            // a pop bumper: chrome base, coloured column, glass cap that pops up when hit
  const col = BUMPER_COLORS[b.ci], r = b.r, lift = 8 + 4 * b.flash, ty = b.y - lift, tr = r * (1 + 0.05 * b.flash);
  glow(b.x, b.y, r * 2.8, col, 0.25 + 0.5 * b.flash); ctx.globalAlpha = 1;
  castShadow(b.x, b.y, r + 6, r * 0.8 + 4, 0.42);
  ctx.fillStyle = metalGrad(b.x - r - 4, b.x + r + 4, '#F4F7FF', '#8791B0', '#232949'); ctx.beginPath(); ctx.arc(b.x, b.y, r + 4, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = PAL.gold; for (let i = 0; i < 10; i++) { const a = i / 10 * TAU + 0.3; ctx.beginPath(); ctx.arc(b.x + Math.cos(a) * (r + 2), b.y + Math.sin(a) * (r + 2), 1.2, 0, TAU); ctx.fill(); }
  ctx.fillStyle = col; ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, TAU); ctx.fill(); ctx.fillRect(b.x - r, ty, r * 2, b.y - ty);   // column
  const sg = ctx.createLinearGradient(b.x - r, 0, b.x + r, 0); sg.addColorStop(0, 'rgba(255,255,255,0.45)'); sg.addColorStop(0.4, 'rgba(255,255,255,0)'); sg.addColorStop(1, 'rgba(5,6,40,0.72)');
  ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(b.x, b.y, r, 0, TAU); ctx.fill(); ctx.fillRect(b.x - r, ty, r * 2, b.y - ty);
  const rg = ctx.createRadialGradient(b.x - tr * 0.35, ty - tr * 0.4, 2, b.x, ty, tr); rg.addColorStop(0, '#fff'); rg.addColorStop(0.3, col); rg.addColorStop(1, '#14173E');
  ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(b.x, ty, tr, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1;                                                                  // bubbles rising in the cap
  for (let i = 0; i < 3; i++) { const ph = (G.time * (0.5 + 0.2 * i) + i * 0.37 + b.x * 0.01) % 1; ctx.beginPath(); ctx.arc(b.x + Math.sin(ph * 6 + i) * tr * 0.4, ty + tr * 0.6 - ph * tr * 1.2, 1.5 + i * 0.8, 0, TAU); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(221,226,240,0.95)'; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.arc(b.x, ty, tr, 0, TAU); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.beginPath(); ctx.ellipse(b.x - tr * 0.35, ty - tr * 0.5, tr * 0.28, tr * 0.14, -0.5, 0, TAU); ctx.fill();
  if (b.ring > 0.02) { ctx.strokeStyle = col; ctx.globalAlpha = b.ring; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(b.x, b.y, b.r + 8 + (1 - b.ring) * 28, (b.r + 8 + (1 - b.ring) * 28) * 0.85, 0, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1; }
}
function drawOrb(o) {                               // ability orb: a domed drop-target on a hex base
  const lit = o.lit, col = G.dark > 0.3 ? '#B79BFF' : PAL.violet, hgt = 7;
  castShadow(o.x, o.y, o.r + 4, o.r * 0.8, 0.4);
  ctx.fillStyle = '#1B2060'; ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + Math.PI / 6; ctx.lineTo(o.x + Math.cos(a) * (o.r + 5), o.y + Math.sin(a) * (o.r + 5)); } ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(232,198,106,0.8)'; ctx.lineWidth = 1.2; ctx.stroke();
  if (lit) glow(o.x, o.y - hgt, 32 + o.flash * 10, col, 0.6);
  ctx.globalAlpha = 1;
  ctx.fillStyle = lit ? '#6C4DB8' : '#232A70'; ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fill(); ctx.fillRect(o.x - o.r, o.y - hgt, o.r * 2, hgt);
  const rg = ctx.createRadialGradient(o.x - 3, o.y - hgt - 4, 1, o.x, o.y - hgt, o.r + 1); rg.addColorStop(0, lit ? '#F1E8FF' : '#6A70C0'); rg.addColorStop(1, lit ? col : '#1C2056');
  ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(o.x, o.y - hgt, o.r, 0, TAU); ctx.fill();
  ctx.strokeStyle = lit ? '#fff' : 'rgba(221,226,240,0.65)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.beginPath(); ctx.ellipse(o.x - 3, o.y - hgt - 5, 3.5, 1.8, -0.5, 0, TAU); ctx.fill();
  ctx.fillStyle = lit ? '#2A1F55' : 'rgba(221,226,240,0.8)'; ctx.font = '700 9px Rajdhani, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(o.ch, o.x, o.y - hgt + 3.5);
  ctx.fillStyle = lit ? 'rgba(233,216,255,0.95)' : 'rgba(221,226,240,0.65)'; ctx.font = '700 8px Rajdhani, sans-serif'; ctx.fillText(o.name, o.x, o.y + o.r + 12);
}
function drawSpinner() {
  const s = spinner, open = Math.abs(Math.sin(s.angle)), hgt = 3 + 11 * open;
  ctx.save(); ctx.translate(s.x, s.y);
  ctx.strokeStyle = 'rgba(95,211,198,0.4)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, s.r, 0, TAU); ctx.stroke();
  const wg = ctx.createLinearGradient(-s.r, 0, s.r, 0); wg.addColorStop(0, '#9FB0E8'); wg.addColorStop(0.5, '#fff'); wg.addColorStop(1, '#9FB0E8');
  ctx.fillStyle = wg; ctx.beginPath(); ctx.moveTo(-s.r + 2, 0); ctx.quadraticCurveTo(-s.r * 0.4, -hgt, s.r - 2, -hgt * 0.15); ctx.quadraticCurveTo(s.r * 0.4, hgt, -s.r + 2, 0); ctx.fill();   // alicorn wing
  ctx.restore();
  if (G.alicornT > 0) glow(s.x, s.y, 40, PAL.silver, 0.5 + 0.3 * Math.sin(G.time * 8));
  ctx.globalAlpha = 1;
}
function drawScoops() {
  const sw = scoops.swan, tw = scoops.tower, pulse = 0.5 + 0.5 * Math.sin(G.time * 2);
  // Black Swan scoop: a dark pit in a chrome collar (only a faint swan hints at it)
  castShadow(sw.x, sw.y, sw.r + 3, sw.r * 0.8, 0.35);
  const rimg = ctx.createLinearGradient(sw.x - 20, sw.y - 20, sw.x + 20, sw.y + 20); rimg.addColorStop(0, '#F4F7FF'); rimg.addColorStop(1, '#3A4268');
  ctx.fillStyle = rimg; ctx.beginPath(); ctx.arc(sw.x, sw.y, sw.r + 3, 0, TAU); ctx.fill();
  const pit = ctx.createRadialGradient(sw.x + 3, sw.y + 3, 1, sw.x, sw.y, sw.r); pit.addColorStop(0, '#0B0E34'); pit.addColorStop(1, '#02030F');
  ctx.fillStyle = pit; ctx.beginPath(); ctx.arc(sw.x, sw.y, sw.r, 0, TAU); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.7)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(sw.x, sw.y, sw.r - 1.5, Math.PI * 0.75, Math.PI * 1.75); ctx.stroke();
  ctx.fillStyle = 'rgba(221,226,240,' + (0.22 + 0.2 * pulse) + ')';
  ctx.beginPath(); ctx.moveTo(sw.x - 7, sw.y + 4); ctx.quadraticCurveTo(sw.x - 8, sw.y - 6, sw.x - 1, sw.y - 5); ctx.quadraticCurveTo(sw.x + 3, sw.y - 9, sw.x + 4, sw.y - 3); ctx.quadraticCurveTo(sw.x + 8, sw.y + 2, sw.x + 3, sw.y + 5); ctx.closePath(); ctx.fill();

  // Foxfire tower: stone keep with a faceted glass roof, a lit window per locked ball and the lock door
  const x = tw.x, y = tw.y;
  castShadow(x + 6, y + 20, 30, 9, 0.42);
  ctx.fillStyle = '#0A0E33'; ctx.beginPath(); ctx.moveTo(x + 18, y + 24); ctx.lineTo(x + 28, y + 16); ctx.lineTo(x + 28, y - 30); ctx.lineTo(x + 18, y - 22); ctx.closePath(); ctx.fill();   // shaded side
  const st = ctx.createLinearGradient(x - 18, 0, x + 18, 0); st.addColorStop(0, '#4650A8'); st.addColorStop(1, '#222A72');
  ctx.fillStyle = st; ctx.fillRect(x - 18, y - 22, 36, 46);
  ctx.strokeStyle = 'rgba(221,226,240,0.14)'; ctx.lineWidth = 1; for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(x - 18, y - 22 + i * 9); ctx.lineTo(x + 18, y - 22 + i * 9); ctx.stroke(); }
  const rf = ctx.createLinearGradient(x - 20, y - 60, x + 20, y - 22); rf.addColorStop(0, '#C9FFF6'); rf.addColorStop(1, '#2E8F86');
  ctx.fillStyle = rf; ctx.beginPath(); ctx.moveTo(x - 21, y - 22); ctx.lineTo(x + 2, y - 64); ctx.lineTo(x + 20, y - 22); ctx.closePath(); ctx.fill();                       // roof, lit face
  ctx.fillStyle = '#1E6E69'; ctx.beginPath(); ctx.moveTo(x + 2, y - 64); ctx.lineTo(x + 20, y - 22); ctx.lineTo(x + 30, y - 30); ctx.closePath(); ctx.fill();                    // roof, shaded face
  ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x - 21, y - 22); ctx.lineTo(x + 2, y - 64); ctx.stroke();
  ctx.fillStyle = metalGrad(x - 22, x + 22, '#FFF1C2', '#C9A24A', '#6E5418'); ctx.fillRect(x - 21, y - 25, 42, 4);                                                           // gold band
  ctx.fillStyle = PAL.gold; ctx.beginPath(); ctx.moveTo(x + 2, y - 64); ctx.lineTo(x + 2, y - 74); ctx.lineTo(x + 11, y - 70); ctx.lineTo(x + 2, y - 67); ctx.fill();                // pennant
  for (let i = 0; i < 3; i++) { const lit = i < G.locked, wx = x - 11 + i * 11; if (lit) glow(wx, y - 14, 14, PAL.gold, 0.85); ctx.globalAlpha = 1; ctx.fillStyle = lit ? '#FFF1C2' : '#151A55'; ctx.beginPath(); ctx.moveTo(wx - 3, y - 10); ctx.lineTo(wx - 3, y - 17); ctx.quadraticCurveTo(wx, y - 21, wx + 3, y - 17); ctx.lineTo(wx + 3, y - 10); ctx.fill(); }
  const door = ctx.createRadialGradient(x, y + 6, 1, x, y + 4, 14); door.addColorStop(0, '#000'); door.addColorStop(1, '#070A28');
  ctx.fillStyle = door; ctx.beginPath(); ctx.ellipse(x, y + 4, 13, 12, 0, 0, TAU); ctx.fill();
  ctx.strokeStyle = PAL.gold; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = 'rgba(232,198,106,0.85)'; ctx.font = '700 8px Cinzel, serif'; ctx.textAlign = 'center'; ctx.fillText('FOXFIRE', x, y + 37);
}
function drawShotLights() {
  // Light-leap ramp arrows; during Neverseen the flashing shots are drawn separately
  Object.keys(ramps).forEach((k) => {
    const rp = ramps[k], flashing = G.nev && G.nev.lit.indexOf(k) >= 0; if (flashing) return;
    const on = 0.35 + 0.35 * Math.sin(G.time * 4 + (k === 'rampL' ? 0 : 2));
    glow(rp.ex, rp.ey, 26, PAL.teal, on); ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(184,242,234,' + (0.5 + on) + ')'; ctx.beginPath(); ctx.moveTo(rp.ex, rp.ey - 12); ctx.lineTo(rp.ex + 7, rp.ey + 2); ctx.lineTo(rp.ex - 7, rp.ey + 2); ctx.closePath(); ctx.fill();
  });
}
function drawVillain(x, y) {
  const bob = Math.sin(G.time * 5 + x) * 3, hue = 0.6 + 0.4 * Math.sin(G.time * 9);
  glow(x, y - 10, 34, PAL.violet, 0.6 + 0.3 * hue); ctx.globalAlpha = 1;
  ctx.fillStyle = '#0A0620'; ctx.beginPath(); ctx.moveTo(x, y - 24 + bob); ctx.quadraticCurveTo(x + 14, y - 8 + bob, x + 13, y + 14 + bob); ctx.lineTo(x + 6, y + 9 + bob); ctx.lineTo(x, y + 15 + bob); ctx.lineTo(x - 6, y + 9 + bob); ctx.lineTo(x - 13, y + 14 + bob); ctx.quadraticCurveTo(x - 14, y - 8 + bob, x, y - 24 + bob); ctx.fill();
  ctx.fillStyle = '#E9D8FF'; ctx.fillRect(x - 5, y - 11 + bob, 3, 2); ctx.fillRect(x + 2, y - 11 + bob, 3, 2);
}
function drawNevLights() {
  if (!G.nev) return;
  G.nev.lit.forEach((id) => {
    const p = SHOTS[id], on = 0.5 + 0.5 * Math.sin(G.time * 12);
    glow(p.x, p.y, 44, '#E9D8FF', 0.4 + 0.5 * on); ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(233,216,255,' + (0.5 + 0.5 * on) + ')'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, 22, 0, TAU); ctx.stroke();
    drawVillain(p.x + (p.x < 200 ? 34 : -34), p.y + 6);
  });
}
function flipperPath(f) {
  const tip = flipperTip(f), dx = tip[0] - f.x, dy = tip[1] - f.y, l = Math.hypot(dx, dy), nx = -dy / l, ny = dx / l, r0 = CONFIG.flipper.baseRadius, r1 = CONFIG.flipper.tipRadius, ang = Math.atan2(dy, dx);
  ctx.beginPath(); ctx.moveTo(f.x + nx * r0, f.y + ny * r0); ctx.lineTo(tip[0] + nx * r1, tip[1] + ny * r1);
  ctx.arc(tip[0], tip[1], r1, ang + Math.PI / 2, ang - Math.PI / 2, true); ctx.lineTo(f.x - nx * r0, f.y - ny * r0); ctx.arc(f.x, f.y, r0, ang - Math.PI / 2, ang + Math.PI / 2, true); ctx.closePath();
  return { tip, nx, ny };
}
function drawFlipper(f) {                           // a thick flipper: cast shadow, side wall, glassy top face
  const hot = f.glow, r0 = CONFIG.flipper.baseRadius, r1 = CONFIG.flipper.tipRadius;
  ctx.save(); ctx.translate(5, 10); flipperPath(f); ctx.fillStyle = 'rgba(0,0,0,0.42)'; ctx.fill(); ctx.restore();
  ctx.save(); ctx.translate(0, 6); flipperPath(f); ctx.fillStyle = hot > 0.3 ? '#7A5A14' : '#0F5566'; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
  const tip0 = flipperTip(f);
  if (hot > 0.02) glow((f.x + tip0[0]) / 2, (f.y + tip0[1]) / 2, 62, PAL.gold, hot * 0.7); ctx.globalAlpha = 1;
  const p = flipperPath(f), tip = p.tip, nx = p.nx, ny = p.ny;
  const gr = ctx.createLinearGradient(f.x + nx * r0, f.y + ny * r0, f.x - nx * r0, f.y - ny * r0); gr.addColorStop(0, '#fff'); gr.addColorStop(0.5, hot > 0.3 ? '#F6E3A8' : '#A9EEE6'); gr.addColorStop(1, hot > 0.3 ? '#B78E2C' : '#2E8F86');
  ctx.fillStyle = gr; ctx.fill(); ctx.strokeStyle = hot > 0.3 ? PAL.gold : PAL.teal; ctx.lineWidth = 2; ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(f.x + nx * r0 * 0.35, f.y + ny * r0 * 0.35); ctx.lineTo(tip[0] + nx * r1 * 0.25, tip[1] + ny * r1 * 0.25); ctx.stroke();
  const hub = ctx.createRadialGradient(f.x - 1.5, f.y - 2, 0.5, f.x, f.y, 5); hub.addColorStop(0, '#FFF7DA'); hub.addColorStop(1, '#8A6A1C'); ctx.fillStyle = hub; ctx.beginPath(); ctx.arc(f.x, f.y, 4.5, 0, TAU); ctx.fill();
}
function drawBall(b) {
  if (b.st === 'scoop') return;
  const s = b.st === 'ramp' ? 1.15 : 1, r = BR * s, lift = b.lift || 0;
  for (let i = 0; i < b.trail.length; i++) { const p = b.trail[i], a = (i + 1) / b.trail.length; ctx.globalAlpha = a * 0.35; ctx.fillStyle = G.dark > 0.3 ? PAL.violet : PAL.teal; ctx.beginPath(); ctx.arc(p[0], p[1] - lift, BR * (0.3 + 0.6 * a), 0, TAU); ctx.fill(); }
  if (b.st === 'held') glow(b.x, b.y, 26, PAL.teal, 0.35 + 0.25 * Math.sin(G.time * 8));
  const sg = ctx.createRadialGradient(b.x + 4 + lift * 0.6, b.y + 7 + lift, 1, b.x + 4 + lift * 0.6, b.y + 7 + lift, r * 1.5);   // soft shadow that drifts away as the ball rises
  sg.addColorStop(0, 'rgba(0,0,0,0.55)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalAlpha = 1; ctx.fillStyle = sg; ctx.beginPath(); ctx.ellipse(b.x + 4 + lift * 0.6, b.y + 7 + lift, r * 1.5, r * 1.1, 0, 0, TAU); ctx.fill();
  ctx.drawImage(ballSprite, b.x - r, b.y - lift - r, r * 2, r * 2);
}
function drawParticles(dt) {
  ctx.globalCompositeOperation = 'lighter';
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.life += dt; if (p.life >= p.max) { particles.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt; const a = 1 - p.life / p.max;
    if (p.k === 1) { p.vy -= 30 * dt; ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = 'rgba(255,255,255,' + a * 0.7 + ')'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, p.s * (1 + p.life), 0, TAU); ctx.stroke(); ctx.globalCompositeOperation = 'lighter'; }
    else { p.vy += 260 * dt; ctx.globalAlpha = a; ctx.strokeStyle = p.c; ctx.lineWidth = p.s; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035); ctx.stroke(); }
  }
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
}
function drawText(text, x, y, size, color, alpha, family, spacing) {
  ctx.globalAlpha = alpha; ctx.font = size + 'px ' + (family || 'Cinzel, Georgia, serif'); ctx.textAlign = 'center';
  if (spacing && 'letterSpacing' in ctx) ctx.letterSpacing = spacing + 'px';
  ctx.shadowColor = color; ctx.shadowBlur = R.reduced ? 4 : 14; ctx.fillStyle = color; ctx.fillText(text, x, y); ctx.shadowBlur = 0;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'; ctx.globalAlpha = 1;
}
function drawCallout() {
  if (!call) return;
  const t = call.t / call.dur, pop = t < 0.12 ? 0.6 + 0.4 * (t / 0.12) + 0.12 * Math.sin((t / 0.12) * Math.PI) : 1, a = t < 0.1 ? t / 0.1 : t > 0.75 ? Math.max(0, (1 - t) / 0.25) : 1;
  const y = 430 - (R.reduced ? 0 : t * 12);
  ctx.save(); ctx.translate(200, y); ctx.scale(pop, pop);
  const plate = ctx.createLinearGradient(-170, 0, 170, 0); plate.addColorStop(0, 'rgba(8,10,34,0)'); plate.addColorStop(0.5, 'rgba(8,10,34,0.62)'); plate.addColorStop(1, 'rgba(8,10,34,0)');
  ctx.globalAlpha = a; ctx.fillStyle = plate; ctx.fillRect(-170, -34, 340, call.sub ? 70 : 52);
  ctx.strokeStyle = 'rgba(232,198,106,0.55)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-120, -34); ctx.lineTo(120, -34); ctx.moveTo(-120, call.sub ? 36 : 18); ctx.lineTo(120, call.sub ? 36 : 18); ctx.stroke(); ctx.globalAlpha = 1;
  const size = call.text.length > 16 ? 22 : call.text.length > 11 ? 28 : 34;
  drawText(call.text, 0, 0, '700 ' + size, call.color, a);
  if (call.sub) drawText(call.sub.toUpperCase(), 0, 22, '600 13', '#E9D8FF', a * 0.9, 'Rajdhani, sans-serif', 3);
  ctx.restore();
}
function drawModeBanner() {
  let line = null, col = PAL.gold;
  if (G.nev) { line = 'NEVERSEEN  ' + Math.ceil(G.nev.t) + 's   POT ' + fmt(G.nev.pot); col = '#E9D8FF'; }
  else if (G.wizardT > 0) { line = 'KEEPER OF THE LOST CITIES  ' + Math.ceil(G.wizardT) + 's'; col = PAL.gold; }
  else if (G.alicornT > 0) { line = 'ALICORN BONUS  ' + Math.ceil(G.alicornT) + 's'; col = PAL.silver; }
  else if (G.multiball) { line = 'MULTIBALL'; col = PAL.gold; }
  if (!line) return;
  drawText(line, 200, 128, '700 12', col, 0.95, 'Rajdhani, sans-serif', 2);
}


/* ----- launch gate: swings open for a rising ball, then shuts so the lane is closed ----- */
const gate = { t: 0 };
function drawGate(dt) {
  const want = G.balls.some((b) => b.st === 'held' || (b.st === 'play' && b.x > 360 && b.y > 240 && b.vy < 0)) ? 1 : 0;
  gate.t += (want - gate.t) * Math.min(1, dt * 12);
  if (gate.t < 0.98) { ctx.globalAlpha = 0.5 * (1 - gate.t); ctx.fillStyle = '#04051A'; ctx.fillRect(364, 252, 28, 454); ctx.globalAlpha = 1; }
  const px = 362, py = 252, ang = lerp(-0.7137, -1.5, gate.t), ex = px + Math.cos(ang) * 40, ey = py + Math.sin(ang) * 40;
  const line = (ox, oy, c, w) => { ctx.strokeStyle = c; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(px + ox, py + oy); ctx.lineTo(ex + ox, ey + oy); ctx.stroke(); };
  line(5, 8, 'rgba(0,0,0,0.4)', 9); line(0, 4, '#6B4A0F', 8); line(0, 0, PAL.gold, 6.5); line(-1, -1.5, 'rgba(255,248,220,0.9)', 1.5);
  const led = gate.t > 0.5 ? PAL.teal : '#FF8A5B'; glow(ex, ey, 14, led, 0.7); ctx.globalAlpha = 1; ctx.fillStyle = led; ctx.beginPath(); ctx.arc(ex, ey, 2.6, 0, TAU); ctx.fill();
  const pg = ctx.createRadialGradient(px - 1.5, py - 2, 1, px, py, 6); pg.addColorStop(0, '#FFF7DA'); pg.addColorStop(1, '#8A6A1C'); ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(px, py, 5.5, 0, TAU); ctx.fill();
}

/* ----- perspective: the flat scene is drawn onto the visible canvas in thin strips that narrow toward the far end ----- */
function warp() {
  const vw = canvas.width, vh = canvas.height, sw = scene.width, sh = scene.height, a = PERSP.top, norm = a + (1 - a) / 2, n = Math.max(60, Math.ceil(vh / 4));
  const nu = (t) => (a * t + (1 - a) * t * t / 2) / norm;
  vctx.setTransform(1, 0, 0, 1, 0, 0); vctx.clearRect(0, 0, vw, vh);
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n, dw = vw * (a + (1 - a) * (t0 + t1) / 2), dy = nu(t0) * vh;
    vctx.drawImage(scene, 0, t0 * sh, sw, (t1 - t0) * sh, (vw - dw) / 2, dy, dw, nu(t1) * vh - dy + 0.7);
  }
}

let lastDrawT = 0;
function draw(dt) {
  const now = G.time;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
  const sh = G.shake, sx = sh > 0.02 ? rand(-1, 1) * 5 * sh : 0, sy = sh > 0.02 ? rand(-1, 1) * 5 * sh : 0;
  ctx.fillStyle = PAL.ink; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (bg) ctx.drawImage(bg, sx * pxScale, sy * pxScale);
  ctx.setTransform(pxScale, 0, 0, pxScale, sx * pxScale, sy * pxScale);

  // living backdrop: slow aurora shimmer and twinkling stars
  const tt = performance.now() / 1000, shim = R.reduced ? 0 : 1;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 2; i++) { ctx.globalAlpha = 0.05 + 0.03 * Math.sin(tt * 0.5 + i * 2) * shim; const gr = ctx.createLinearGradient(0, 30, W, 150); gr.addColorStop(0, i ? PAL.violet : PAL.teal); gr.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = gr; ctx.fillRect(-40, 20 + i * 30, W + 80, 120); }
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  if (!R.reduced) { ctx.fillStyle = '#fff'; for (let i = 0; i < 16; i++) { ctx.globalAlpha = 0.3 + 0.5 * Math.abs(Math.sin(tt * 1.4 + i * 1.7)); ctx.fillRect((i * 97) % W, (i * 53) % 330 + 6, 1.6, 1.6); } ctx.globalAlpha = 1; }

  // Light Leap beam
  ctx.globalCompositeOperation = 'lighter';
  drawShotLights(); ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // glass sheen sweeping across the table and drifting motes
  if (!R.reduced) {
    ctx.globalCompositeOperation = 'lighter'; const sw = ((tt * 0.08) % 1.6 - 0.3) * (W + 200) - 100;
    const sg = ctx.createLinearGradient(sw - 60, 0, sw + 60, 300); sg.addColorStop(0, 'rgba(255,255,255,0)'); sg.addColorStop(0.5, 'rgba(184,242,234,0.05)'); sg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = 1; ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#B8F2EA';
    for (let i = 0; i < 22; i++) { const x = (i * 83.7 + Math.sin(tt * 0.3 + i) * 14) % W, y = H - ((tt * (6 + (i % 5) * 3) + i * 61) % (H + 20)); ctx.globalAlpha = 0.12 + 0.12 * Math.sin(tt * 2 + i); ctx.fillRect(x, y, 1.6, 1.6); }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }
  // light flowing along the ramps toward their exits
  Object.keys(ramps).forEach((k) => {
    const rp = ramps[k]; const active = G.balls.some((b) => b.st === 'ramp' && b.rp === rp);
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'; ctx.setLineDash([2, 18]); ctx.lineDashOffset = -tt * (active ? 140 : 40);
    ctx.strokeStyle = active ? 'rgba(255,255,255,0.95)' : 'rgba(184,242,234,0.55)'; ctx.lineWidth = active ? 5 : 3;
    ctx.beginPath(); ctx.moveTo(rp.ex, rp.ey); ctx.quadraticCurveTo(rp.p1.x, rp.p1.y - 6, rp.p2.x, rp.p2.y - 12); ctx.stroke(); ctx.restore();
  });
  crystals.forEach((c) => { c.flash = Math.max(0, c.flash - dt * 3); c.cd -= dt; drawCrystal(c, (tt * 120 + c.note * 50) % 360); });
  orbs.forEach((o) => { o.flash = Math.max(0, o.flash - dt * 3); o.cd -= dt; });
  drawSpinner();                                     // far to near, so taller pieces overlap the ones behind them
  drawScoops();
  bumpers.forEach((b) => { b.flash = Math.max(0, b.flash - dt * 4); b.ring = Math.max(0, b.ring - dt * 2.5); drawBumper(b); });
  orbs.forEach(drawOrb);
  // sling glow
  segs.forEach((s) => { if (s.sling && s.glow > 0) { s.glow = Math.max(0, s.glow - dt * 4); ctx.globalCompositeOperation = 'lighter'; ctx.strokeStyle = 'rgba(255,240,190,' + s.glow + ')'; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(s.ax, s.ay); ctx.lineTo(s.bx, s.by); ctx.stroke(); ctx.globalCompositeOperation = 'source-over'; } });
  drawGate(dt);

  // Neverseen: lights go dark and violet
  if (G.dark > 0.01) {
    ctx.globalAlpha = 0.65 * G.dark; ctx.fillStyle = '#12052C'; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.18 * G.dark; const vg = ctx.createRadialGradient(200, 400, 40, 200, 400, 420); vg.addColorStop(0, PAL.violet); vg.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  }
  drawNevLights();

  flippers.forEach((f) => { f.glow += ((f.press ? 1 : 0) - f.glow) * Math.min(1, dt * 18); drawFlipper(f); });
  G.balls.forEach((b) => {
    if (b.st !== 'scoop') { b.trail.push([b.x, b.y]); if (b.trail.length > 9) b.trail.shift(); }
    drawBall(b);
  });
  drawParticles(dt);

  // beam of the Light Leap: a column of light down the playfield
  if (G.beam > 0.01) {
    G.beam = Math.max(0, G.beam - dt * 1.1); ctx.globalCompositeOperation = 'lighter';
    const bw = 40 + (1 - G.beam) * 60, gr = ctx.createLinearGradient(0, 80, 0, 700); gr.addColorStop(0, 'rgba(255,255,255,' + G.beam + ')'); gr.addColorStop(0.6, 'rgba(95,211,198,' + G.beam * 0.5 + ')'); gr.addColorStop(1, 'rgba(95,211,198,0)');
    ctx.fillStyle = gr; ctx.fillRect(200 - bw / 2, 80, bw, 620); ctx.globalCompositeOperation = 'source-over';
  }
  drawModeBanner(); drawCallout();
  popups.forEach((p) => { p.t += dt; ctx.globalAlpha = Math.max(0, 1 - p.t / 0.9); ctx.font = '700 12px Rajdhani, sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(5,6,26,0.8)'; ctx.strokeText(p.text, p.x, p.y - p.t * 28); ctx.fillStyle = p.color; ctx.fillText(p.text, p.x, p.y - p.t * 28); });
  for (let i = popups.length - 1; i >= 0; i--) if (popups[i].t > 0.9) popups.splice(i, 1);
  ctx.globalAlpha = 1;
  if (G.flash > 0.01) { ctx.fillStyle = 'rgba(255,255,255,' + clamp(G.flash * 0.7, 0, 0.7) + ')'; ctx.fillRect(0, 0, W, H); }
  warp();
}

function updateFx(dt) {
  G.shake *= Math.pow(0.001, dt); G.flash = Math.max(0, G.flash - dt * 2.2);
  if (call) { call.t += dt; if (call.t >= call.dur || (callQueue.length && call.t > 0.9)) call = null; }
  if (!call && callQueue.length) call = callQueue.shift();
}

/* ===================================================================
   8. Input, screens, HUD, main loop
   =================================================================== */
const stage = $('stage'), elScore = $('score'), elMult = $('mult'), elBest = $('best'), elBallNo = $('ballNo'), elPips = $('ballPips'), elModes = $('modePips');
let lastPips = '', lastModes = '';

function resize() {
  const aw = stage.clientWidth, ah = stage.clientHeight; if (!aw || !ah) return;
  const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.table.pixelRatioCap);
  cssK = Math.min(aw / W, ah / H);
  const cw = Math.floor(W * cssK), ch = Math.floor(H * cssK);
  canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
  canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); scene.width = canvas.width; scene.height = canvas.height;
  pxScale = canvas.width / W;
  buildBackground();
}

function updateHudFull() {
  elMult.textContent = 'x' + G.mult; elBallNo.textContent = G.ballNo;
  const n = Math.max(CONFIG.startBalls, G.ballsLeft), key = n + ':' + G.ballsLeft;
  if (key !== lastPips) {
    lastPips = key; elPips.innerHTML = ''; for (let i = 0; i < n; i++) { const d = document.createElement('i'); if (i >= G.ballsLeft) d.className = 'gone'; elPips.appendChild(d); }
    elPips.setAttribute('aria-label', 'Balls remaining: ' + G.ballsLeft);
  }
  const mk = MODE_KEYS.map((k) => (G.modes[k] ? 1 : 0)).join('');
  if (mk !== lastModes) {
    lastModes = mk; Array.prototype.forEach.call(elModes.children, (el) => el.classList.toggle('done', !!G.modes[el.dataset.m]));
    const done = MODE_KEYS.filter((k) => G.modes[k]).map((k) => MODE_NAMES[k]);
    elModes.setAttribute('aria-label', 'Modes completed: ' + (done.length ? done.join(', ') : 'none'));
  }
  elBest.textContent = fmt(Math.max(G.best, G.score));
}
function updateScoreDisplay(dt) {
  if (G.display === G.score) return;
  const diff = G.score - G.display, step = Math.max(1, Math.ceil(Math.abs(diff) * Math.min(1, dt * 8)));
  G.display = Math.abs(diff) <= step ? G.score : G.display + Math.sign(diff) * step;   // animated count-up
  elScore.textContent = fmt(G.display); elBest.textContent = fmt(Math.max(G.best, G.score));
}

function showScreen(id) {
  ['screenTitle', 'screenHow', 'screenPause', 'screenOver'].forEach((s) => { $(s).hidden = s !== id; });
  if (id) { const el = $(id).querySelector('.btn.primary'); if (el) setTimeout(() => el.focus({ preventScroll: true }), 30); }
  else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

function startFromUi() { SFX.init(); SFX.ui(); newGame(); }
function pauseGame() { if (G.phase !== 'play') return; G.phase = 'paused'; press.clear(); applyPress(); showScreen('screenPause'); $('btnPause').setAttribute('aria-label', 'Resume game'); }
function resumeGame() { if (G.phase !== 'paused') return; G.phase = 'play'; showScreen(null); $('btnPause').setAttribute('aria-label', 'Pause game'); last = performance.now(); }
let howFrom = 'screenTitle';
function openHow(from) { howFrom = from; showScreen('screenHow'); }

// ----- paddles: left half of the screen = left paddle, right half = right paddle. Multi-touch OK. -----
const press = new Map(); let keyL = false, keyR = false, lastL = false, lastR = false;
function applyPress() {
  let l = keyL, r = keyR; press.forEach((side) => { if (side === 'L') l = true; else r = true; });
  flippers[0].press = l && G.phase === 'play'; flippers[1].press = r && G.phase === 'play';
  if (flippers[0].press && !lastL) { SFX.flipper(); vibrate(8); } if (flippers[1].press && !lastR) { SFX.flipper(); vibrate(8); }
  lastL = flippers[0].press; lastR = flippers[1].press;
}
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest && e.target.closest('button, .screen')) return;
  SFX.init(); if (G.phase !== 'play') return;
  e.preventDefault(); press.set(e.pointerId, e.clientX < window.innerWidth / 2 ? 'L' : 'R'); applyPress();
}, { passive: false });
const release = (e) => { if (press.delete(e.pointerId)) applyPress(); };
document.addEventListener('pointerup', release); document.addEventListener('pointercancel', release);
document.addEventListener('contextmenu', (e) => e.preventDefault());
// no scroll / pull-to-refresh / pinch while playing (screens may still scroll)
document.addEventListener('touchmove', (e) => { if (!(e.target.closest && e.target.closest('.screen'))) e.preventDefault(); }, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.repeat && (e.code === 'Space' || e.code === 'Enter')) return;
  if (e.code === 'ArrowLeft' || e.code === 'KeyZ') { keyL = true; SFX.init(); e.preventDefault(); }
  else if (e.code === 'ArrowRight' || e.code === 'KeyM' || e.code === 'Slash') { keyR = true; SFX.init(); e.preventDefault(); }
  else if (e.code === 'Space') { if (G.phase === 'title' && !$('screenTitle').hidden) { startFromUi(); e.preventDefault(); } else if (G.phase === 'over') { startFromUi(); e.preventDefault(); } else if (G.phase === 'paused') { resumeGame(); e.preventDefault(); } }
  else if (e.code === 'Escape' || e.code === 'KeyP') { if (G.phase === 'play') pauseGame(); else if (G.phase === 'paused') resumeGame(); }
  applyPress();
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowLeft' || e.code === 'KeyZ') keyL = false;
  if (e.code === 'ArrowRight' || e.code === 'KeyM' || e.code === 'Slash') keyR = false;
  applyPress();
});
window.addEventListener('blur', () => { press.clear(); keyL = keyR = false; applyPress(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { pauseGame(); press.clear(); } });

$('btnPlay').addEventListener('click', startFromUi);
$('btnAgain').addEventListener('click', startFromUi);
$('btnMenu').addEventListener('click', () => { G.phase = 'title'; showScreen('screenTitle'); });
$('btnHow').addEventListener('click', () => { SFX.init(); openHow('screenTitle'); });
$('btnHowPause').addEventListener('click', () => openHow('screenPause'));
$('btnHowClose').addEventListener('click', () => showScreen(howFrom));
$('btnPause').addEventListener('click', () => { SFX.init(); if (G.phase === 'play') pauseGame(); else if (G.phase === 'paused') resumeGame(); });
$('btnResume').addEventListener('click', resumeGame);
$('btnQuit').addEventListener('click', () => { G.phase = 'title'; G.balls = []; SFX.droneOff(); showScreen('screenTitle'); });
$('btnMute').addEventListener('click', () => { SFX.init(); SFX.setMuted(!SFX.muted); syncToggles(); });
$('btnMotion').addEventListener('click', () => { R.reduced = !R.reduced; store.set('reduced', R.reduced ? '1' : '0'); syncToggles(); });
function syncToggles() {
  $('btnMute').setAttribute('aria-pressed', SFX.muted); $('btnMute').setAttribute('aria-label', SFX.muted ? 'Unmute sound' : 'Mute sound');
  $('btnMotion').setAttribute('aria-pressed', R.reduced); $('btnMotion').setAttribute('aria-label', R.reduced ? 'Reduced motion on' : 'Reduced motion off');
  document.documentElement.classList.toggle('reduce-motion', R.reduced);
}
{ const saved = store.get('reduced', null); R.reduced = saved === null ? !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) : saved === '1'; }
syncToggles();

// ----- main loop: fixed timestep with sub-stepping -----
let last = performance.now(), acc = 0;
function frame(now) {
  const dt = Math.min(CONFIG.physics.maxFrame, (now - last) / 1000); last = now;
  if (G.phase === 'play') {
    acc += dt; let n = 0;
    while (acc >= DT && n < 14) { stepWorld(DT); acc -= DT; n++; if (G.phase !== 'play') break; }
    if (n >= 14) acc = 0;
    updateRules(dt); updateFx(dt);
  } else if (G.phase !== 'paused') { G.time += dt; updateFx(dt); }
  if (G.phase !== 'paused') flippers.forEach((f) => { if (G.phase !== 'play') { f.a += (CONFIG.flipper.restAngle - f.a) * 0.2; f.omega = 0; } });
  draw(G.phase === 'paused' ? 0 : dt);
  updateScoreDisplay(dt); updateHudFull_cheap();
  requestAnimationFrame(frame);
}
function updateHudFull_cheap() { if (elMult.textContent !== 'x' + G.mult) updateHudFull(); }

$('best').textContent = fmt(G.best); $('titleBest').textContent = fmt(G.best);
window.addEventListener('resize', resize); window.addEventListener('orientationchange', () => setTimeout(resize, 150));
if (window.ResizeObserver) new ResizeObserver(resize).observe(stage);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(buildBackground);   // redraw the title text once Cinzel arrives
resize(); updateHudFull();
requestAnimationFrame(frame);

// Debug / test hook (open the page with ?debug)
if (/[?&]debug/.test(location.search)) window.LCP = { gate, draw, buildBackground, G, CONFIG, flippers, bumpers, crystals, orbs, ramps, scoops, spinner, stepWorld, updateRules, newGame, hitCrystal, hitOrb, startNeverseen, startWizard, startMultiball, towerLock, shotHit, swanAward, startAlicorn, lightLeap, spinCounted, SHOTS, press, R, applyPress, serve, launchBall, nevCollect };
})();
