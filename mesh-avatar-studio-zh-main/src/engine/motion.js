// Drives parameters: idle ("auto idle"), mouse follow, blinking, expressions, motions.
import { PARAMS } from './rig.js';
import { MOTIONS, IDLE_MOTIONS, ADDITIVE, sampleTrack } from './motions.js';
import { VOWELS, kanaToMoras, sampleMoras } from './kana.js';

const ALL_MOTIONS = { ...MOTIONS, ...IDLE_MOTIONS };
// scales the head / body / arm tracks of idle motions (they are authored at full size, so 1)
// (gaze, eyes and brows are left alone)
export const IDLE_GAIN = { amp: 1, stiff: 1.8 };
const IDLE_SCALED = /^(angle|bodyAngle|armAngle|handAngle)/;

// motion tracks that replace the expression (the rest are additive or body targets)
const FACE_TRACKS = new Set(['eyeOpen', 'eyeOpenL', 'eyeSmileL', 'eyeSmile', 'mouthOpen',
  'mouthForm', 'blush', 'browY', 'browAngle']);
// articulated leg tracks are applied on top of the walk / drag pose by hand (below)
const LEG_TRACKS = new Set(['legLAngle', 'legRAngle', 'legLBend', 'legRBend', 'legLLift', 'legRLift']);
// likewise the rigid forearms
const ARM_TRACKS = new Set(['foreLAngle', 'foreRAngle']);
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// smooth 1D value noise
function noise(t, seed) {
  const i = Math.floor(t), f = t - i;
  const h = n => { const x = Math.sin((n + seed * 57.3) * 127.1) * 43758.5453; return x - Math.floor(x); };
  const u = f * f * (3 - 2 * f);
  return (h(i) * (1 - u) + h(i + 1) * u) * 2 - 1;
}
const fbm = (t, s) => noise(t, s) * 0.7 + noise(t * 2.3, s + 9) * 0.3;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const EXPRESSIONS = {
  normal: { label: 'Neutral', p: {} },
  smile: { label: 'Smile', p: { eyeOpen: 0, eyeSmile: 1, blush: 0.35, browY: 0.2 } },
  shy: { label: 'Blush', p: { eyeOpen: 0.78, eyeSmile: 0.5, blush: 1, browAngle: -0.5, browY: -0.1, glance: [0.7, 0.35] } },
  jito: { label: 'Half-lidded', p: { eyeOpen: 0.5, browY: -0.5, browAngle: 0.6 } },
  surprise: { label: 'Surprise', p: { eyeOpen: 1.22, browY: 1, mouthOpen: 0.6, mouthForm: 0.6 } },
  wink: { label: 'Wink', p: { eyeOpenL: 0, eyeSmileL: 1, blush: 0.3 } },
  // talking faces for AITuber OnAir emotion tags: eyes stay mostly open (closed / ^^ eyes are
  // what a single image fakes worst, and they would stay shut for a whole sentence)
  happyTalk: { label: 'happy', p: { eyeOpen: 0.8, eyeSmile: 0.45, blush: 0.35, browY: 0.25, mouthForm: -0.5 } },
  sadTalk: { label: 'sad', p: { eyeOpen: 0.78, browAngle: -0.8, browY: -0.2, mouthForm: 0.3, glance: [0, -0.35] } },
  angryTalk: { label: 'angry', p: { eyeOpen: 0.72, browAngle: 0.85, browY: -0.55, mouthForm: 0.2 } },
  surprisedTalk: { label: 'surprised', p: { eyeOpen: 1.18, browY: 0.9, mouthForm: 0.9 } },
  relaxedTalk: { label: 'relaxed', p: { eyeOpen: 0.82, eyeSmile: 0.35, blush: 0.15, browY: 0.1 } },
};

// emotion tag -> [expression, motion played when the line starts]
const EMOTIONS = {
  happy: ['happyTalk', 'nod'],
  sad: ['sadTalk', 'sigh'],
  angry: ['angryTalk', 'no'],
  surprised: ['surprisedTalk', 'surprise'],
  relaxed: ['relaxedTalk', 'sway'],
  neutral: ['normal', null],
};

// [stiffness, damping ratio] of the parameter smoothing; unlisted params use [120, 0.95]
const SPRINGS = {
  gazeX: [260, 0.9], gazeY: [260, 0.9],
  angleX: [55, 0.72], angleY: [55, 0.72], angleZ: [45, 0.75],
  bodyAngleX: [14, 0.9], bodyAngleZ: [12, 0.9],
  armAngle: [20, 0.85], handAngle: [30, 0.8],
};

export class Motion {
  /** @param {number[]} gazeCenter */
  constructor(gazeCenter) {
    this.mode = 'auto';           // auto | mouse | manual
    this.P = Object.fromEntries(PARAMS.map(p => [p.id, p.def]));
    this.manual = { ...this.P };
    this.cur = { ...this.P };      // smoothed values
    this.vel = Object.fromEntries(PARAMS.map(p => [p.id, 0]));
    this.expr = 'normal';
    this.exprMix = {};             // smoothed expression values
    this.t = 0;
    this.blink = { t: 0, start: 1.5, double: false };
    this.gaze = { x: 0, y: 0, next: 0 };
    this.tap = { next: 4, until: -1 };
    this.pointer = null;           // image px
    this.follow = null;            // {x, y, gain}: cursor offset blended into auto idle
    this.walk = { amp: 0, phase: 0, wanted: false, rate: 5.0 }; // desktop walking gait
    // cursor dragging: vx/vy are normalised speeds, the phase drives a slow pendulum;
    // carry is the whole-figure lag inside the window (inertia) and springs back on release
    this.drag = {
      amp: 0, wanted: false, vx: 0, vy: 0, tx: 0, ty: 0, phase: 0, px: 0, py: 0,
      held: 0,                     // seconds it has been carried without going anywhere
      carry: { x: 0, y: 0, vx: 0, vy: 0 },
    };
    // the shell's own release physics: the window keeps travelling after the hand lets go, so
    // the figure has a pose for falling (limbs up, leaning back) and a crouch for landing.
    // fall = nothing supports it, land = the shrinking impulse of the last floor contact.
    // hit is the hardest impact of the current bounce chain; it holds the arms up and the
    // balance wobble a few tenths of a second after the crouch is over.
    this.flight = {
      amp: 0, wanted: false, fall: false, vx: 0, vy: 0, tx: 0, ty: 0, land: 0,
      hit: 0, bounce: 0, stagger: 0, kick: 0,
    };
    // the moment the cursor closes on it: a crouch, a hitch upward, then the legs dangle.
    // age runs from 0 to dur, k is how hard it was grabbed and amp the resulting envelope.
    this.pick = { age: 9, amp: 0, k: 0, dur: 0.62 };
    // occasional ear flick: a quick independent twitch of one ear (or both), the reflex of a
    // cat at ease. Variety comes from the deterministic noise hash, so it never disturbs the
    // Math.random stream the breath and glances draw from. side: -1 left, +1 right, 0 both.
    this.ear = { next: 3.5, age: 9, dur: 0.4, k: 0.8, side: 1, double: false, n: 0 };
    this.faceCenter = [...gazeCenter];
    this.lipOpen = null;           // external mouth value from lip sync
    this.lipForm = 0;
    this.speaking = false;         // TTS audio playing (setSpeaking)
    this.voice = 0;                // 0..1 loudness (setVoiceLevel)
    this.mouth = 0;
    this.vowel = 'a';
    this.vowelForm = 0;
    this.syllableArmed = true;
    this.voicePeak = 0;
    this.voiceTrough = 0;
    this.kana = null;
    this.lipHold = null;
    this.emotionUntil = 0;         // when the emotion face goes back to normal
    this.talkGain = 1;             // how much the head moves along with the voice
    this.play = null;              // { id, t } of the motion being played
    this.autoMotion = true;        // "auto idle" plays a reaction motion now and then
    this.nextAuto = 14;
    this.autoIdle = true;          // ...and small idle motions more often
    this.nextIdle = 3;
    this.lastAuto = null;
    this.onMotion = null;          // UI callback (id or null)
  }

  setExpression(k) { this.expr = k; }

  /** Walk gait on/off (the shell moves the window; this animates limbs and bounce). */
  setWalk(on) {
    const w = this.walk;
    // the last step has to land: a small absorb, so stopping mid-stride does not freeze one
    // leg in the air
    if (w.wanted && !on && w.amp > 0.3) this.land(0.16 + 0.2 * w.amp);
    w.wanted = !!on;
  }

  /** Held by the cursor; speeds in CSS px/s. The body tilts and the legs trail after it. */
  setDrag(on, vx = 0, vy = 0) {
    const d = this.drag;
    const wasOn = d.wanted;
    d.wanted = !!on;
    // being picked up interrupts whatever it was doing; the grab beat then hands over to the
    // dangle
    if (d.wanted && !wasOn) {
      if (this.play) { this.play = null; this.onMotion?.(null); }
      this.pickUp(1);
    } else if (!d.wanted) {
      d.held = 0;
    }
    // ~1200 px/s reads as a full-strength tilt; flicks may push a little past it
    d.tx = d.wanted ? clamp(Number(vx) / 1200, -1.4, 1.4) : 0;
    d.ty = d.wanted ? clamp(Number(vy) / 1200, -1.4, 1.4) : 0;
    d.px = Number(vx) || 0;
    d.py = Number(vy) || 0;
  }

  /** The instant the cursor closes on it and pulls: a crouch, a sag, then the feet come up. */
  pickUp(strength = 1) {
    const a = clamp(Number(strength) || 0, 0, 1);
    if (a <= 0.01) return;
    const p = this.pick;
    p.age = 0;
    p.k = a;
    this.drag.held = 0;
    // the window leaves the floor before the body does, so it sags inside the frame and springs
    // back into the hang
    this.drag.carry.vy += 55 + 45 * a;
  }

  /** The window is moving under its own release physics; `vx`/`vy` in CSS px/s. */
  setFlight(on, fall = false, vx = 0, vy = 0) {
    const f = this.flight;
    f.wanted = !!on;
    f.fall = !!fall;
    // the same scale as the drag: a fall from mid screen reads as a full-strength lean
    f.tx = f.wanted ? clamp(Number(vx) / 1200, -1.4, 1.4) : 0;
    f.ty = f.wanted ? clamp(Number(vy) / 1200, -1.4, 1.4) : 0;
  }

  /** The shell hit the floor: `strength` 0..1 squashes the figure and folds the knees. */
  land(strength) {
    const a = clamp(Number(strength) || 0, 0, 1);
    if (a <= 0.01) return;
    const fl = this.flight;
    fl.land = Math.max(fl.land, a);
    // the body is still travelling while the window has stopped: it dips and springs back. Only
    // the hardest hit of the bounce chain is kept, and the rebound lags behind it on its own.
    fl.hit = Math.max(fl.hit, a);
    this.drag.carry.vy += 70 + 120 * a;
  }

  /** The shell rebounded off a screen edge: it is shoved sideways and has to keep its balance. */
  bump(strength, dir = 0) {
    const a = clamp(Number(strength) || 0, 0, 1);
    if (a <= 0.01) return;
    const fl = this.flight;
    fl.stagger = Math.max(fl.stagger, a);
    // the figure keeps travelling while the window has already come back off the edge. dir says
    // which way that was; 0 means the ceiling, where it carries on upwards instead.
    const s = Math.sign(Number(dir) || 0);
    if (!s) {
      this.drag.carry.vy -= 70 + 100 * a;
      return;
    }
    // head and torso springs are far too stiff to follow a fast wiggle, so the shove goes in as
    // a velocity kick and each spring swings back through its own natural frequency.
    fl.kick = s * (55 + 85 * a);
    this.drag.carry.vx += s * (60 + 90 * a);
    this.drag.carry.vy += 25 + 40 * a;
  }

  hasMotion(id) { return id in ALL_MOTIONS; }
  // ---- speech (driven from outside, e.g. by the TTS audio analyser) ----
  setVoiceLevel(v) { this.voice = Math.min(1, Math.max(0, Number(v) || 0)); }

  setSpeaking(on) {
    if (on === this.speaking) return;
    this.speaking = !!on;
    if (!on) {
      // hold the emotion a moment after the line, then go back to the plain face
      this.emotionUntil = this.t + 1.2;
      this.voice = 0;
    }
  }

  /** `playMotion: false` changes only the face (a caller that picks motions itself). */
  setEmotion(tag, { playMotion = true } = {}) {
    const e = EMOTIONS[tag] ?? EMOTIONS.neutral;
    this.expr = e[0];
    this.emotionUntil = Infinity;
    if (e[1] && playMotion) this.playMotion(e[1]);
  }

  /** Mouth shapes from kana text, without audio (preview / tuning). */
  /** @param {string} text @param {{ speed?: number, loop?: boolean }} [options] */
  speakKana(text, { speed, loop = false } = {}) {
    this.lipHold = null;
    const moras = kanaToMoras(text, speed === undefined ? 0.14 : 1 / clamp(Number(speed) || 7, 4, 12));
    this.kana = moras.length ? { moras, t: 0, loop, duration: moras.reduce((sum, m) => sum + m.dur, 0) } : null;
  }

  holdMouth(vowel) {
    this.kana = null;
    this.lipHold = Object.hasOwn(VOWELS, vowel) ? vowel : null;
  }

  stopLipSync() {
    this.kana = null; this.lipHold = null; this.lipOpen = null; this.mouth = 0;
  }

  getLipSyncState() {
    return { active: this.kana !== null || this.lipHold !== null, open: this.P.mouthOpen, form: this.P.mouthForm };
  }

  // Mouth from the TTS loudness. A volume signal has no vowel information, so each syllable
  // (the voice dipping and rising again) gets one vowel at random, weighted towards a, and
  // keeps it until the next syllable: the drawn mouths must not change shape mid-syllable.
  // Syllables are found relative to the recent peak (not an absolute level), and the mouth
  // is scaled by where the voice sits between the recent trough and peak, so it closes in
  // the dip before each mora even when a loud voice never gets quiet.
  speechMouth(dt) {
    if (this.kana || this.lipHold) {
      let m;
      if (this.lipHold) m = VOWELS[this.lipHold];
      else {
        this.kana.t += dt;
        if (this.kana.loop) this.kana.t %= this.kana.duration;
        m = sampleMoras(this.kana.moras, this.kana.t);
      }
      if (!m) { this.kana = null; return this.mouth > 0.01 ? [this.mouth *= 0.6, this.vowelForm] : null; }
      const k = m.open > this.mouth ? 1 - Math.exp(-dt * 30) : 1 - Math.exp(-dt * 22);
      this.mouth += (m.open - this.mouth) * k;
      if (m.form !== null) this.vowelForm = m.form;
      return [this.mouth, this.vowelForm];
    }
    const v = this.speaking ? this.voice : 0;
    // recent peak / trough: follow at once, then relax over ~0.2 s
    const relax = 1 - Math.exp(-dt * 5);
    this.voicePeak = v > this.voicePeak ? v : this.voicePeak + (v - this.voicePeak) * relax;
    this.voiceTrough = v < this.voiceTrough ? v : this.voiceTrough + (v - this.voiceTrough) * relax;
    const peak = Math.max(this.voicePeak, 0.05);
    if (v < peak * 0.6) this.syllableArmed = true;
    else if (this.syllableArmed && v > peak * 0.8 && v > 0.1) {
      this.syllableArmed = false;
      const r = Math.random();
      this.vowel = r < 0.4 ? 'a' : r < 0.58 ? 'o' : r < 0.74 ? 'e' : r < 0.88 ? 'i' : 'u';
    }
    const range = this.voicePeak - this.voiceTrough;
    const rise = range < peak * 0.3 ? 1 : Math.max(0, (v - this.voiceTrough) / range);
    const shape = VOWELS[this.vowel ?? 'a'];
    const level = Math.min(1, Math.pow(v, 0.7) * 1.15) * Math.pow(rise, 0.3);
    const target = this.speaking ? Math.min(0.95, level) * (0.45 + 0.55 * shape.open / 0.9) : 0;
    // quick attack, quick release: the mouth has to shut between morae (~7 per second)
    const k = target > this.mouth ? 1 - Math.exp(-dt * 40) : 1 - Math.exp(-dt * 32);
    this.mouth += (target - this.mouth) * k;
    if (this.speaking) this.vowelForm = shape.form;   // after the line: close in the last shape
    return this.speaking || this.mouth > 0.01 ? [this.mouth, this.vowelForm] : null;
  }

  // Breathing: inhale ~40% of the cycle, a slower exhale, a short pause at the bottom,
  // and a period that drifts between ~3.2 and 4.6 s so it never looks metronomic.
  breathValue(dt) {
    this.breathPhase = (this.breathPhase ?? 0) + dt / (this.breathPeriod ?? 3.8);
    if (this.breathPhase >= 1) { this.breathPhase -= 1; this.breathPeriod = 3.2 + Math.random() * 1.4; }
    const x = this.breathPhase;
    if (x < 0.4) return sstep(0, 0.4, x);
    if (x < 0.88) return 1 - sstep(0.4, 0.88, x);
    return 0;
  }

  // pick one at random, never the one that just played
  playRandom(ids) {
    const pool = ids.filter(k => k !== this.lastAuto);
    this.playMotion(pool[Math.floor(Math.random() * pool.length)]);
  }

  playMotion(id) {
    this.lastAuto = id;
    this.play = { id, t: 0 };
    this.onMotion?.(id);
  }

  blinkValue(dt) {
    const b = this.blink;
    b.t += dt;
    if (b.t < b.start) return 1;
    const x = (b.t - b.start) / 0.17;
    if (x >= 1) {
      if (b.double) { b.double = false; b.start = b.t + 0.07; }
      else { b.start = b.t + 1.8 + Math.random() * 4.2; b.double = Math.random() < 0.18; }
      return 1;
    }
    return x < 0.45 ? 1 - x / 0.45 : (x - 0.45) / 0.55;
  }

  update(dt) {
    this.t += dt;
    const t = this.t;
    const T = {};                  // targets
    for (const p of PARAMS) T[p.id] = p.def;
    const walk = this.walk;
    // start each walk from the neutral pose, then ramp in softly and settle out a bit quicker
    if (walk.wanted && walk.amp < 0.01) walk.phase = 0;
    walk.amp += ((walk.wanted ? 1 : 0) - walk.amp) * Math.min(1, dt * (walk.wanted ? 3.2 : 5.0));
    if (walk.amp > 0.002) walk.phase += dt * walk.rate * (0.5 + 0.5 * walk.amp);

    const drag = this.drag;
    const dragOn = drag.wanted && this.mode === 'auto';
    drag.amp += ((dragOn ? 1 : 0) - drag.amp) * Math.min(1, dt * (dragOn ? 6 : 4));
    const dk = Math.min(1, dt * 12);
    drag.vx += (drag.tx - drag.vx) * dk;
    drag.vy += (drag.ty - drag.vy) * dk;
    if (drag.amp > 0.002) drag.phase += dt * (2.6 + Math.min(1.4, Math.hypot(drag.vx, drag.vy)) * 4);

    // Inertia: the figure lags inside the window while carried. The spring is deliberately
    // soft while held and lightly damped on release, so putting the pet down gives a small
    // bounce instead of a snap. Gravity adds a hint of sag while it hangs from the cursor.
    //
    // After a release the window moves on its own (the shell integrates the fall), so the lag
    // reads as real inertia: it keeps trailing the travel, floats up in free fall, and the
    // impulse of each floor contact is injected straight into this spring.
    const fl = this.flight;
    const fallOn = fl.wanted && this.mode === 'auto';
    fl.amp += ((fallOn ? 1 : 0) - fl.amp) * Math.min(1, dt * (fallOn ? 7 : 4.5));
    fl.vx += (fl.tx - fl.vx) * dk;
    fl.vy += (fl.ty - fl.vy) * dk;
    fl.land *= Math.exp(-dt * 5.5);
    if (fl.land < 0.004) fl.land = 0;
    // hit is what the crouch is graded from and how long the spring-back keeps going; stagger
    // is the same for a screen edge, where the shove is sideways instead of downwards
    fl.hit *= Math.exp(-dt * 3.2);
    if (fl.hit < 0.01) fl.hit = 0;
    fl.stagger *= Math.exp(-dt * 3.6);
    if (fl.stagger < 0.01) fl.stagger = 0;
    // The screen-edge shove has to be felt by the head and torso, but their springs are far too
    // stiff to follow a fast wiggle. Kicking the spring velocity instead makes each one swing
    // back through its own natural frequency, which is what being shoved actually looks like.
    if (fl.kick) {
      const k = fl.kick;
      fl.kick = 0;
      if (this.mode === 'auto') {
        this.vel.angleZ += k;
        this.vel.bodyAngleZ += k * 0.3;
      }
    }
    // the rebound lags the crouch by about a tenth of a second, which is the difference between
    // a squash and a landing
    fl.bounce += ((fl.hit > 0.1 ? 1 : 0) - fl.bounce) * Math.min(1, dt * (fl.hit > 0.1 ? 6.5 : 8));

    // The grab beat. age runs from 0, so the three lobes are fixed fractions of its length:
    // the knees fold and the chin tucks in, the window pulls away underneath (which is what
    // the carry spring below turns into a sag), and only then do the feet clear the floor.
    const pick = this.pick;
    pick.age = Math.min(pick.dur + 1, pick.age + dt);
    const pa = pick.age / pick.dur;
    const pickOn = pa < 1 && this.mode === 'auto' && drag.wanted;
    pick.amp = pickOn ? pick.k * (1 - pa * pa) : 0;
    const crouch = pickOn ? pick.amp * (1 - sstep(0.10, 0.42, pa)) : 0;
    const lift = pickOn ? pick.amp * sstep(0.16, 0.40, pa) : 0;
    // carried along but nowhere to go: after a couple of seconds of being held still it starts
    // to fidget, which the idle playback below picks up
    const still = dragOn && Math.hypot(drag.vx, drag.vy) < 0.09;
    drag.held = still ? drag.held + dt : 0;
    const fidget = dragOn ? clamp((drag.held - 1.8) / 1.2, 0, 1) * (1 - clamp((drag.held - 6) / 2, 0, 1)) : 0;
    const wD = drag.amp, wF = fl.amp, wS = wD + wF;
    const secVX = wS > 0.001 ? (drag.vx * wD + fl.vx * wF) / wS : 0;
    const secVY = wS > 0.001 ? (drag.vy * wD + fl.vy * wF) / wS : 0;
    const carry = drag.carry;
    const cvx = secVX * 1200, cvy = secVY * 1200;
    const cTarget = wS > 0.002
      ? [clamp(-cvx * 0.024, -42, 42), clamp(-cvy * 0.02, -30, 30) + 5 * drag.amp - 12 * fl.amp]
      : [0, 0];
    const cK = dragOn ? 70 : 58, cZ = dragOn ? 0.52 : 0.2;
    const cDamp = 2 * Math.sqrt(cK) * cZ;
    carry.vx += (cK * (cTarget[0] - carry.x) - cDamp * carry.vx) * dt;
    carry.vy += (cK * (cTarget[1] - carry.y) - cDamp * carry.vy) * dt;
    carry.x += carry.vx * dt;
    carry.y += carry.vy * dt;

    if (this.mode === 'manual') {
      Object.assign(T, this.manual);
    } else if (this.mode === 'auto') {
      // wandering plus following the gaze: the eyes jump first, the head turns after them
      T.angleX = fbm(t * 0.18, 1) * 10 + this.gaze.x * 11;
      T.angleY = fbm(t * 0.15, 2) * 6 - 1 + this.gaze.y * 7;
      T.angleZ = fbm(t * 0.12, 3) * 10;
      T.bodyAngleX = fbm(t * 0.1, 4) * 5;
      T.bodyAngleZ = fbm(t * 0.09, 5) * 4;
      T.armAngle = fbm(t * 0.14, 6) * 5;
      T.handAngle = fbm(t * 0.21, 7) * 5;
      // glances
      if (t > this.gaze.next) {
        const r = Math.random();
        this.gaze.x = r < 0.45 ? 0 : (Math.random() * 2 - 1) * 0.8;
        this.gaze.y = r < 0.45 ? 0 : (Math.random() * 2 - 1) * 0.5;
        this.gaze.next = t + 0.8 + Math.random() * 2.5;
      }
      T.gazeX = this.gaze.x + T.angleX / 60;
      T.gazeY = this.gaze.y + T.angleY / 60;
      // cursor follow: layered on top of the wandering idle, so blinking / random motions keep running
      if (this.follow) {
        const fx = clamp(this.follow.x, -1, 1);
        const fy = clamp(this.follow.y, -1, 1);
        const g = this.follow.gain ?? 1;
        T.angleX += fx * 20 * g;
        T.angleY += -fy * 16 * g;
        T.angleZ += -fx * fy * 10 * g;
        T.bodyAngleX += fx * 6 * g;
        T.gazeX = clamp(fx * 1.25 * g + T.angleX / 60, -1, 1);
        T.gazeY = clamp(-fy * 1.25 * g + T.angleY / 60, -1, 1);
      }
      // walking: a small side-to-side sway, arm swing and vertical bob on top of the idle drift
      if (walk.amp > 0.01) {
        const a = walk.amp, ph = walk.phase;
        T.bodyAngleZ += Math.sin(ph) * 3.4 * a;
        T.bodyAngleX += Math.cos(ph * 2) * 1.8 * a;
        T.angleZ += Math.sin(ph) * 2.2 * a;
        T.angleY += Math.sin(ph * 2) * 1.8 * a;
        // arms trail the body by a fraction of a step, so the swing is not a stiff copy
        T.armAngle += Math.sin(ph - 0.45) * 7.5 * a;
        T.handAngle += Math.sin(ph + 0.25) * 5 * a;
      }
      // the grab: for a tenth of a second the knees fold and the chin tucks in - it does not
      // know it is being picked up yet - and then the window pulls away underneath, the head
      // lolls back, the arms fly out and it looks up at whoever is carrying it
      if (crouch > 0.004) {
        T.angleY -= 4.5 * crouch;
        T.bodyAngleX -= 2.2 * crouch;
        T.armAngle += 3.5 * crouch;
      }
      if (lift > 0.004) {
        T.angleY += 6 * lift;
        T.angleZ += 3 * lift;
        T.bodyAngleX += 2.6 * lift;
        T.armAngle += 7 * lift;
        T.handAngle += 5 * lift;
        T.gazeY = clamp(T.gazeY - 0.2 * lift, -1, 1);
      }
      // dangling while dragged: tilt away from the motion, slow pendulum on top
      if (drag.amp > 0.002) {
        const a = drag.amp;
        const nx = clamp(drag.vx, -1, 1), ny = clamp(drag.vy, -1, 1);
        const sway = Math.sin(drag.phase);
        T.angleX += nx * 8 * a;
        T.angleY += -ny * 5 * a;
        T.angleZ += nx * 12 * a + sway * 3 * a;
        T.bodyAngleX += nx * 5 * a;
        T.bodyAngleZ += nx * 7 * a + sway * 1.8 * a;
        T.armAngle += (nx * 6 + sway * 5) * a;
        T.handAngle += (nx * 4 + sway * 4) * a;
        T.gazeX = clamp(T.gazeX + nx * 0.25 * a, -1, 1);
        T.gazeY = clamp(T.gazeY - ny * 0.12 * a, -1, 1);
        // while it is being carried around, keep the reactions for when it is put down again;
        // once it has been hanging still for a while it may do something small about it
        if (fidget < 0.5) {
          this.nextIdle = Math.max(this.nextIdle, t + 1.5);
          this.nextAuto = Math.max(this.nextAuto, t + 3);
        } else {
          this.nextAuto = Math.max(this.nextAuto, t + 3);
        }
      }
      // flying: the pet leans back against the travel, tucks its legs up and flails a little,
      // chin up and eyes down at whatever it is about to hit. Sliding along the floor uses the
      // same channels at a quarter of the strength: braced and trailing, not airborne.
      if (fl.amp > 0.002) {
        const a = fl.amp, nx = clamp(fl.vx, -1, 1), ny = clamp(fl.vy, -1, 1);
        const up = fl.fall ? 1 : 0.22;
        const flap = Math.sin(t * 7.5) * a * (fl.fall ? 1 : 0.35);
        T.angleX += nx * 5 * a;
        T.angleY += (4 + 6 * up - ny * 3 * up) * a + flap * 0.8;
        T.angleZ += -nx * 10 * a + flap * 2;
        T.bodyAngleZ += -nx * 6 * a;
        T.bodyAngleX += (2 + 3 * up) * a + flap * 0.6;
        T.armAngle += (4 + 8 * up + flap * 3) * a;
        T.handAngle += (3 + 6 * up + flap * 2) * a;
        T.gazeX = clamp(T.gazeX + nx * 0.3 * a, -1, 1);
        T.gazeY = clamp(T.gazeY - ny * 0.22 * a, -1, 1);
        // no idle chatter mid-air either
        this.nextIdle = Math.max(this.nextIdle, t + 1.2);
        this.nextAuto = Math.max(this.nextAuto, t + 2.5);
      }
      // the impact: a crouch the body springs back from
      if (fl.land > 0.004) {
        T.angleY -= 7 * fl.land;
        T.bodyAngleX -= 3 * fl.land;
        T.armAngle -= 6 * fl.land;
      }
      // ...and the way back up: whatever the crouch folded, this unfolds, chin and arms coming
      // up with it. hit keeps the rebound alive after the crouch itself has died away.
      if (fl.bounce > 0.01 && fl.hit > 0.02) {
        const B = fl.bounce * fl.hit;
        T.angleY += 5 * B;
        T.bodyAngleX += 2.5 * B;
        T.armAngle += 5 * B;
        T.handAngle += 3 * B;
      }
      // off a screen edge: the springs above take the shove, this keeps the shoulders loose
      // while it gets its balance back
      if (fl.stagger > 0.01) {
        const S = fl.stagger;
        T.armAngle += Math.sin(t * 7) * 5 * S;
        this.nextIdle = Math.max(this.nextIdle, t + 0.8);
      }
      // held up and nowhere to go: after a couple of seconds it starts doing something about it
      if (fidget > 0.01) {
        T.angleZ += Math.sin(t * 2.3) * 3.5 * fidget;
        T.handAngle += Math.sin(t * 3.1) * 2.5 * fidget;
      }
      // occasional finger tapping on the chin
      if (t > this.tap.next) { this.tap.until = t + 1.1; this.tap.next = t + 5 + Math.random() * 6; }
      // random playback: reactions every ~15-25 s, small idle motions every few seconds in between
      // while talking: no random motions, just nod along with the voice
      if (this.speaking) {
        this.nextIdle = Math.max(this.nextIdle, t + 2.5);
        this.nextAuto = Math.max(this.nextAuto, t + 6);
        const g = this.talkGain;
        this.talkNod = (this.talkNod ?? 0) + (this.voice * 7 * g - (this.talkNod ?? 0)) * Math.min(1, dt * 6);
        T.angleY -= this.talkNod;
        T.angleX += fbm(t * 0.6, 11) * 5 * g;
        T.angleZ += fbm(t * 0.5, 12) * 4 * g;
      }
      if (!this.speaking && t > this.emotionUntil) { this.expr = 'normal'; this.emotionUntil = Infinity; }
      // while it hangs from the cursor nothing plays until it has been still there for a
      // couple of seconds, and then only one of the small idle motions
      const carried = drag.amp >= 0.05 && fidget < 0.5;
      if (this.speaking) { /* no random playback */ }
      else if (!this.play && !carried && drag.amp < 0.05 && fl.amp < 0.05 && this.autoMotion && t > this.nextAuto) {
        this.playRandom(Object.keys(MOTIONS).filter(k => k !== 'surprise'));
        this.nextAuto = t + 15 + Math.random() * 10;
        this.nextIdle = Math.max(this.nextIdle, t + 5);
      } else if (!this.play && !carried && fl.amp < 0.05 && crouch < 0.05 && lift < 0.05
        && this.autoIdle && t > this.nextIdle) {
        this.playRandom(Object.keys(IDLE_MOTIONS));
        this.nextIdle = t + 5 + Math.random() * 5;   // counted from the start, so 1-5 s of plain idling after it
        if (drag.amp >= 0.05) drag.held = 0;         // one fidget at a time while it is carried
      }
    } else if (this.mode === 'mouse' && this.pointer) {
      const dx = (this.pointer[0] - this.faceCenter[0]) / 500, dy = (this.pointer[1] - this.faceCenter[1]) / 500;
      T.angleX = clamp(dx * 30, -30, 30);
      T.angleY = clamp(-dy * 30, -30, 30);
      T.angleZ = clamp(-dx * dy * 25, -12, 12);
      T.bodyAngleX = clamp(dx * 10, -10, 10) * 0.6;
      T.gazeX = clamp(dx * 1.4, -1, 1);
      T.gazeY = clamp(-dy * 1.4, -1, 1);
      T.handAngle = clamp(dx * 4, -5, 5);
    }
    if (this.mode !== 'manual') {
      T.breath = this.breathValue(dt);
      if (t < this.tap.until) T.fingerTap = Math.max(0, Math.sin((this.tap.until - t) * Math.PI * 3.6)) ** 2;
    }

    // motion: body/head tracks go into the targets, so the springs smooth them too
    let M = null, mw = 0;
    if (this.play) {
      const def = ALL_MOTIONS[this.play.id];
      this.play.t += dt;
      if (this.play.t >= def.dur) { this.play = null; this.onMotion?.(null); }
      else {
        M = {};
        for (const [id, keys] of Object.entries(def.tracks))
          M[id] = sampleTrack(keys, this.play.t) * (def.idle && IDLE_SCALED.test(id) ? IDLE_GAIN.amp : 1);
        mw = sstep(0, 0.15, this.play.t) * (1 - sstep(def.dur - 0.25, def.dur, this.play.t));
        for (const [id, v] of Object.entries(M)) {
          if (ADDITIVE.has(id)) T[id] += v;
          else if (id === 'breath') T[id] += (v - T[id]) * mw;   // a motion sets its own breathing
          else if (!FACE_TRACKS.has(id) && !LEG_TRACKS.has(id) && !ARM_TRACKS.has(id)) T[id] = Math.max(T[id], Math.max(0, v));
        }
      }
    }

    if (this.mode !== 'manual') T.angleY += T.breath * 1.6;

    // expression layer (smoothed so switching is not a jump)
    const E = EXPRESSIONS[this.expr].p;
    const keys = ['eyeOpen', 'eyeOpenL', 'eyeSmileL', 'eyeSmile', 'mouthOpen', 'mouthForm', 'blush', 'browY', 'browAngle', 'gx', 'gy'];
    const target = { eyeOpen: E.eyeOpen ?? 1, eyeOpenL: E.eyeOpenL ?? E.eyeOpen ?? 1, eyeSmileL: E.eyeSmileL ?? E.eyeSmile ?? 0,
      eyeSmile: E.eyeSmile ?? 0, mouthOpen: E.mouthOpen ?? 0, mouthForm: E.mouthForm ?? 0,
      blush: E.blush ?? 0, browY: E.browY ?? 0, browAngle: E.browAngle ?? 0,
      gx: E.glance?.[0] ?? 0, gy: E.glance?.[1] ?? 0 };
    const k = 1 - Math.exp(-dt * 9);
    for (const key of keys) {
      if (this.exprMix[key] === undefined) this.exprMix[key] = target[key];
      this.exprMix[key] += (target[key] - this.exprMix[key]) * k;
    }
    const X = this.exprMix;

    // spring-damper towards the targets for body params
    const out = {};
    for (const p of PARAMS) {
      const id = p.id;
      if (this.mode === 'manual' && !M) { out[id] = T[id]; this.cur[id] = T[id]; this.vel[id] = 0; continue; }
      // eyes lead, the head follows with a slight overshoot, the body trails behind
      let [stiff, zeta] = SPRINGS[id] ?? [120, 0.95];
      // keyframed motions are already smooth; follow them more tightly than idle wandering
      // keyframed motions are followed more tightly than the idle wandering; idle motions a
      // bit less so they stay soft but still reach their poses
      if (M && /^angle|^body/.test(id)) {
        if (ALL_MOTIONS[this.play?.id ?? '']?.idle) { stiff *= IDLE_GAIN.stiff; zeta = 0.8; }
        else if (/^angle/.test(id)) { stiff *= 4.5; zeta = 0.75; }
      }
      const damp = 2 * Math.sqrt(stiff) * zeta;
      this.vel[id] += (stiff * (T[id] - this.cur[id]) - damp * this.vel[id]) * dt;
      this.cur[id] += this.vel[id] * dt;
      out[id] = this.cur[id];
    }
    let blink = 1;
    if (this.mode !== 'manual') {
      // startled for the grab beat and for a moment after a hard landing: brows up, eyes and
      // mouth open. It scales with the eyes the expression already has, so a smiling ^^ face
      // does not pop half open.
      const startle = clamp(Math.max(lift * 0.9, fl.hit * 0.75), 0, 1);
      blink = this.blinkValue(dt);
      out.eyeROpen = Math.min(1.25, X.eyeOpen + 0.3 * startle * X.eyeOpen) * blink;
      out.eyeLOpen = Math.min(1.25, X.eyeOpenL + 0.3 * startle * X.eyeOpenL) * blink;
      out.eyeSmile = X.eyeSmile;
      out.eyeSmileL = X.eyeSmileL;
      out.mouthOpen = Math.max(X.mouthOpen, 0.32 * startle);
      out.mouthForm = X.mouthForm;
      out.blush = X.blush;
      // brows dip a little with each blink and lift when looking up
      out.browY = X.browY + 0.35 * startle + (out.angleY > 0 ? out.angleY / 60 : 0) - (1 - blink) * 0.18;
      out.browAngle = X.browAngle;
      out.gazeX = clamp(out.gazeX + X.gx, -1, 1);
      out.gazeY = clamp(out.gazeY + X.gy, -1, 1);
    } else {
      out.eyeSmileL = out.eyeSmile;
    }
    if (M) {
      const mix = (key, v) => { out[key] += (v - out[key]) * mw; };
      const clampEye = v => Math.min(1.3, Math.max(0, v));
      if ('eyeOpen' in M) { mix('eyeROpen', clampEye(M.eyeOpen) * blink); if (!('eyeOpenL' in M)) mix('eyeLOpen', clampEye(M.eyeOpen) * blink); }
      if ('eyeOpenL' in M) mix('eyeLOpen', clampEye(M.eyeOpenL) * blink);
      if ('eyeSmile' in M) { mix('eyeSmile', M.eyeSmile); if (!('eyeSmileL' in M)) mix('eyeSmileL', M.eyeSmile); }
      if ('eyeSmileL' in M) mix('eyeSmileL', M.eyeSmileL);
      for (const id of ['mouthOpen', 'mouthForm', 'blush', 'browY', 'browAngle'])
        if (id in M) mix(id, id === 'mouthOpen' || id === 'blush' ? Math.max(0, M[id]) : M[id]);
    }
    const sm = this.speechMouth(dt);
    if (sm) { this.lipOpen = sm[0]; this.lipForm = sm[1]; }
    else if (this.lipOpen !== null && !this.speaking && !this.kana) this.lipOpen = null;
    if (this.lipOpen !== null) {
      out.mouthOpen = Math.max(out.mouthOpen * 0.3, this.lipOpen);
      // while talking the voice decides the vowel; the expression's form would shift it
      out.mouthForm = clamp(this.lipForm, -1, 1);
    }
    out.walkAmp = walk.amp;
    out.walkPhase = walk.phase;
    // articulated legs: thigh and shin are separate rigid layers, so both angles are absolute
    // tilts from vertical (+ = towards +x). A knee only folds one way: keep the shin trailing
    // the thigh (|Bend - Angle| small) instead of forcing it past a straight leg.
    const legOut = { la: 0, ra: 0, lb: 0, rb: 0, ll: 0, rl: 0 };
    if (walk.amp > 0.002) {
      const wa = walk.amp, ph = walk.phase;
      const upL = Math.pow(Math.max(0, Math.sin(ph)), 1.25);
      const upR = Math.pow(Math.max(0, -Math.sin(ph)), 1.25);
      legOut.ll = upL * 40 * wa;
      legOut.rl = upR * 40 * wa;
      // the lifted thigh swings out; the shin folds under the knee while the leg is airborne
      // and straightens again as it plants, so the knee only ever bends one way
      legOut.la = (-upL * 10 + upR * 2) * wa;
      legOut.ra = (upR * 10 - upL * 2) * wa;
      legOut.lb = legOut.la * 0.55 + upL * 10 * wa;
      legOut.rb = legOut.ra * 0.55 - upR * 10 * wa;
    }
    if (drag.amp > 0.002) {
      const a = drag.amp;
      const nx = clamp(drag.vx, -1, 1), ny = clamp(drag.vy, -1, 1);
      const sway = Math.sin(drag.phase);
      // carried along: the thighs trail the movement, the shins trail the thighs
      const tL = -nx * 12 + sway * 4, tR = -nx * 12 - sway * 4;
      legOut.la += tL * a;
      legOut.ra += tR * a;
      legOut.lb += (tL * 1.5 - 3) * a;
      legOut.rb += (tR * 1.5 + 3) * a;
      legOut.ll += Math.min(0, ny) * 6 * a;
      legOut.rl += Math.min(0, ny) * 6 * a;
    }
    // the grab: the knees load first, then both feet come off the floor and dangle slightly
    // out of step, which is what the legs of a lifted cat actually do
    if (crouch > 0.004) {
      legOut.lb += 12 * crouch;
      legOut.rb -= 12 * crouch;
    }
    if (lift > 0.004) {
      const tuck = 20 * lift;
      legOut.la -= 2 * lift;
      legOut.ra -= 2 * lift;
      legOut.lb += tuck;
      legOut.rb -= tuck;
      const off = Math.sin(t * 8.5) * 3 * lift;
      legOut.ll += 15 * lift + off;
      legOut.rl += 12 * lift - off;
    }
    if (fl.amp > 0.002) {
      const a = fl.amp, nx = clamp(fl.vx, -1, 1);
      const up = fl.fall ? 1 : 0.22;
      const flutter = Math.sin(t * 6.5);
      // airborne: the feet tuck up, the knees fold and the legs kick out of step; on the
      // floor the same trail shows up as a brace instead
      const tuck = -nx * 8 * a;
      legOut.la += tuck + flutter * 3 * up * a;
      legOut.ra += tuck - flutter * 3 * up * a;
      legOut.lb += tuck + (16 * up + flutter * 4) * a;
      legOut.rb += tuck - (16 * up - flutter * 4) * a;
      legOut.ll += (9 * up + flutter * 3) * a;
      legOut.rl += (9 * up - flutter * 3) * a;
    }
    if (fl.land > 0.004) {
      // the knees take the impact, feet stay where they are
      const L = fl.land;
      legOut.la += -4 * L;
      legOut.lb += 22 * L;
      legOut.ra += 4 * L;
      legOut.rb -= 22 * L;
    }
    if (fl.bounce > 0.01 && fl.hit > 0.02) {
      // the rebound unfolds exactly the knees the crouch folded, never past straight
      const e = 20 * fl.bounce * fl.hit;
      legOut.lb -= clamp(legOut.lb - legOut.la, 0, e);
      legOut.rb += clamp(legOut.ra - legOut.rb, 0, e);
    }
    if (fl.stagger > 0.01) {
      // shoved sideways: one foot then the other steps out to keep the balance
      const S = fl.stagger, step = Math.sin(t * 11);
      const upL = Math.max(0, step), upR = Math.max(0, -step);
      legOut.ll += upL * 16 * S;
      legOut.rl += upR * 16 * S;
      legOut.lb += upL * 11 * S;
      legOut.rb -= upR * 11 * S;
    }
    if (M) {
      for (const [id, key] of [['legLAngle', 'la'], ['legRAngle', 'ra'], ['legLBend', 'lb'],
        ['legRBend', 'rb'], ['legLLift', 'll'], ['legRLift', 'rl']]) {
        if (id in M) legOut[key] += M[id];
      }
    }
    out.legLAngle = legOut.la;
    out.legRAngle = legOut.ra;
    out.legLBend = legOut.lb;
    out.legRBend = legOut.rb;
    out.legLLift = legOut.ll;
    out.legRLift = legOut.rl;
    // rigid forearms counter-swing with the legs, and lag behind when the pet is carried.
    // The left forearm lies across the bodice, so it stays much nearer its rest angle than the
    // right: whatever it uncovers is only an inpainted guess of the dress.
    const armOut = { l: 0, r: 0 };
    if (walk.amp > 0.002) {
      const wa = walk.amp, ph = walk.phase;
      armOut.l = -Math.sin(ph) * 5 * wa;
      armOut.r = Math.sin(ph) * 9 * wa;
    }
    if (drag.amp > 0.002) {
      const a = drag.amp, nx = clamp(drag.vx, -1, 1);
      armOut.l += (-nx * 6 + Math.sin(drag.phase + 0.7) * 3) * a;
      armOut.r += (-nx * 11 + Math.sin(drag.phase) * 5) * a;
    }
    if (fl.amp > 0.002) {
      const a = fl.amp, nx = clamp(fl.vx, -1, 1);
      const up = fl.fall ? 1 : 0.22;
      const flutter = Math.sin(t * 6.5 + 0.8);
      armOut.l += (-nx * 9 - 12 * up + flutter * 5) * a;
      armOut.r += (-nx * 14 + 24 * up + flutter * 6) * a;   // the free arm flies up
    }
    if (fl.land > 0.004) {
      armOut.l -= 7 * fl.land;
      armOut.r -= 12 * fl.land;                        // and comes back down to brace
    }
    if (fl.bounce > 0.01 && fl.hit > 0.02) {
      // the arms are the last thing to stop moving after a bounce
      armOut.r += 14 * fl.bounce * fl.hit;
      armOut.l += 5 * fl.bounce * fl.hit;
    }
    if (crouch > 0.004 || lift > 0.004) {
      // tucked in at the grab, then thrown out against the lift
      armOut.l -= 8 * crouch;
      armOut.r -= 6 * crouch;
      armOut.r += 22 * lift;
      armOut.l += 9 * lift;
    }
    if (fl.stagger > 0.01) {
      // windmilled once towards the wall it just came off
      armOut.r += Math.sin(t * 11) * 18 * fl.stagger;
      armOut.l += Math.sin(t * 11 - 0.6) * 8 * fl.stagger;
    }
    if (M) {
      for (const [id, key] of [['foreLAngle', 'l'], ['foreRAngle', 'r']])
        if (id in M) armOut[key] += M[id];
    }
    out.foreLAngle = clamp(armOut.l, -35, 35);
    out.foreRAngle = clamp(armOut.r, -40, 115);
    out.carryX = carry.x;
    out.carryY = carry.y;
    // the secondary channels the hair, skirt and tassels already read: held by the cursor or
    // flying under its own momentum, whichever owns the motion right now (or a blend of both).
    // The grab and the rebound are not real travel, so they are folded in here as a virtual
    // speed: pulled up drags the hair down, and a landing leaves it going the other way.
    const vSec = secVY - 0.55 * lift + 0.4 * fl.land + 0.25 * fl.bounce * fl.hit;
    out.dragAmp = Math.min(1.25, wS + 0.8 * pick.amp + 0.4 * fl.stagger);
    out.dragVX = secVX;
    out.dragVY = clamp(vSec, -1.4, 1.4);
    out.dragPhase = drag.phase;
    out.flightAmp = fl.amp;
    out.flightLand = fl.land;
    out.flightHit = fl.hit;
    out.grabAmp = pick.amp;
    // ear flick: an instant channel independent of the head turn, so it reads as a reflex
    // rather than the head moving. Only while idle on the floor - not mid-drag or mid-air,
    // where the limbs already have plenty going on. The envelope is a fast attack and a
    // slower release, sometimes a second smaller flick.
    const ear = this.ear;
    ear.age += dt;
    if (this.mode === 'auto' && drag.amp < 0.05 && fl.amp < 0.05 && ear.age >= ear.dur && t > ear.next) {
      ear.n++;
      const h = noise(ear.n * 1.7, 31) * 0.5 + 0.5;
      ear.side = h < 0.42 ? -1 : h < 0.84 ? 1 : 0;
      ear.k = 0.55 + (noise(ear.n * 2.3, 37) * 0.5 + 0.5) * 0.45;
      ear.double = (noise(ear.n * 3.1, 41) * 0.5 + 0.5) < 0.28;
      ear.dur = ear.double ? 0.66 : 0.4;
      ear.age = 0;
      ear.next = t + 3.5 + (noise(ear.n * 4.7, 43) * 0.5 + 0.5) * 5.5;
    }
    let earEnv = 0;
    if (this.mode !== 'manual' && ear.age < ear.dur) {
      const u = ear.age / ear.dur;
      const pulse = x => x < 0.24 ? sstep(0, 0.24, x) : 1 - sstep(0.24, 1, x);
      earEnv = ear.double ? (u < 0.5 ? pulse(u / 0.5) : 0.72 * pulse((u - 0.5) / 0.5)) : pulse(u);
    }
    const earAmt = earEnv * ear.k;
    out.earL = ear.side <= 0 ? earAmt : 0;
    out.earR = ear.side >= 0 ? earAmt : 0;
    this.P = out;
    return out;
  }
}
