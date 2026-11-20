// SPDX-License-Identifier: MIT
/**
 * The texture sources. Each renders a block of two decorrelated raw
 * channels (`a`, `b`) from its own seeded generator; the voice
 * (`voice.ts`) adds the envelope, distance (darkening and the FDN), width
 * and the DC blocker. Rates are per second and every random draw comes from
 * the voice's `Rng`, in a fixed order, so renders are byte-identical.
 */
import { Water, FieldCalls, CountryRoad } from "./nature.ts";
import type { TextureType } from "../../../core/texture.ts";
import { Brown, Drift, Hp1, Lp1, Pink, polyBlep, Rng, Svf } from "./dsp.ts";

/** What a source reads each control block. */
export type Controls = {
  /** Frames in this block before note-off. Materials may ring after this. */
  heldSamples: number;
  density: number;
  wear: number;
  distance: number;
  /** Motion's frequency factor (1 when steady). */
  sweep: number;
  /** Motion's 0..1 position (0.5 when steady). */
  shape: number;
};

export interface Source {
  /** Writes `n` samples of the two raw channels. */
  render(a: Float64Array, b: Float64Array, n: number, c: Controls): void;
}

const TAU = 2 * Math.PI;

// ---------------------------------------------------------------------------
// Room tone: HVAC-like shaped noise and the odd creak; the voice's FDN
// (sized as a room) does most of the work.

class Room implements Source {
  private readonly pinkA = new Pink();
  private readonly pinkB = new Pink();
  private readonly brownA: Brown;
  private readonly brownB: Brown;
  private readonly lpA = new Lp1();
  private readonly lpB = new Lp1();
  private readonly lp2A = new Lp1();
  private readonly lp2B = new Lp1();
  private readonly hpA = new Hp1();
  private readonly hpB = new Hp1();
  private readonly hum = new Svf();
  private readonly creak = new Svf();
  private next = 0;
  private readonly sway: Drift;

  constructor(
    private readonly rng: Rng,
    private readonly sr: number,
  ) {
    this.brownA = new Brown(sr);
    this.brownB = new Brown(sr);
    this.hpA.set(35, sr);
    this.hpB.set(35, sr);
    this.hum.set(110, 0.9, sr);
    this.creak.set(2200, 9, sr);
    this.sway = new Drift(rng);
    this.next = rng.wait(1) * sr;
  }

  render(a: Float64Array, b: Float64Array, n: number, c: Controls): void {
    const sr = this.sr;
    const cutoff = (500 + 2200 * c.density) * c.sweep;
    this.lpA.set(cutoff, sr);
    this.lpB.set(cutoff, sr);
    this.lp2A.set(cutoff * 1.6, sr);
    this.lp2B.set(cutoff * 1.6, sr);
    const sway = 0.8 + 0.4 * this.sway.step(n / sr, 4);
    const rumble = 0.25 + 0.9 * c.wear;
    const tickRate = 0.15 + 1.5 * c.density;
    for (let i = 0; i < n; i += 1) {
      const wa = this.rng.noise();
      const wb = this.rng.noise();
      const ba = this.brownA.process(this.rng.noise());
      const bb = this.brownB.process(this.rng.noise());
      // The air handler: a soft low-mid hump over pink noise.
      const hum = this.hum.process(ba + bb) * rumble;
      let x = this.lp2A.process(this.lpA.process(this.pinkA.process(wa)));
      let y = this.lp2B.process(this.lpB.process(this.pinkB.process(wb)));
      x = this.hpA.process(x * sway + 0.25 * ba * rumble) + hum;
      y = this.hpB.process(y * sway + 0.25 * bb * rumble) + hum;
      // A creak or tick now and then (the building settling).
      let impulse = 0;
      if ((this.next -= 1) <= 0) {
        this.next = this.rng.wait(tickRate) * sr;
        this.creak.set(this.rng.range(900, 3200), this.rng.range(5, 14), sr);
        impulse = this.rng.bi() * (0.6 + 1.4 * c.wear);
      }
      const creak = this.creak.process(impulse) * 1.5;
      a[i] = x + creak;
      b[i] = y + creak * 0.6;
    }
  }
}

// ---------------------------------------------------------------------------
// Rain (after Farnell, Designing Sound, and van den Doel's bubble model):
// Poisson drop impulses. A drop that traps a bubble rings as a sine whose
// pitch rises as it decays (Minnaert frequency 3.29/r Hz-m); the others are
// short impact ticks. Under them, a band-limited noise bed.

const MAX_DROPS = 48;

class Rain implements Source {
  private readonly shower: Drift;
  private readonly eave = new Svf();
  private nextDrip = 0;
  private dripPan = 0.5;
  private readonly pinkA = new Pink();
  private readonly pinkB = new Pink();
  private readonly bedHpA = new Hp1();
  private readonly bedHpB = new Hp1();
  private readonly bedLpA = new Svf();
  private readonly bedLpB = new Svf();
  private readonly tickA = new Svf();
  private readonly tickB = new Svf();
  // Active bubbles, struct of arrays.
  private readonly phase = new Float64Array(MAX_DROPS);
  private readonly freq = new Float64Array(MAX_DROPS);
  private readonly rise = new Float64Array(MAX_DROPS);
  private readonly amp = new Float64Array(MAX_DROPS);
  private readonly decay = new Float64Array(MAX_DROPS);
  private readonly panL = new Float64Array(MAX_DROPS);
  private readonly panR = new Float64Array(MAX_DROPS);
  private live = 0;
  private next = 0;

  constructor(
    private readonly rng: Rng,
    private readonly sr: number,
  ) {
    this.bedHpA.set(350, sr);
    this.shower = new Drift(rng);
    this.bedHpB.set(350, sr);
    this.tickA.set(4200, 0.8, sr);
    this.tickB.set(4200, 0.8, sr);
  }

  private drop(wear: number): void {
    // Radius 0.6..3.2 mm; wear favors big, heavy drops.
    const r = 0.6e-3 + 2.6e-3 * this.rng.next() ** (2.2 - 1.4 * wear);
    const pan = this.rng.bi();
    const left = Math.sqrt(0.5 * (1 - pan));
    const right = Math.sqrt(0.5 * (1 + pan));
    const strength = 0.25 + 0.75 * this.rng.next() ** 2;
    if (this.rng.next() < 0.45 + 0.3 * wear) {
      // Impact without a bubble: a tick into the shared impact filters.
      const hit = strength * (r / 2e-3) * 1.5;
      this.impactL += hit * left;
      this.impactR += hit * right;
      return;
    }
    if (this.live >= MAX_DROPS) return;
    const f0 = Math.min(3.29 / r, this.sr * 0.4);
    // van den Doel: d = 0.043 f + 0.0014 f^1.5 (1/s); the pitch rises by
    // xi * d per second.
    const d = 0.043 * f0 + 0.0014 * f0 ** 1.5;
    const k = this.live;
    this.live += 1;
    this.phase[k] = 0;
    this.freq[k] = f0 / this.sr;
    this.rise[k] = (0.9 * d * f0) / (this.sr * this.sr);
    this.decay[k] = Math.exp(-d / this.sr);
    this.amp[k] = strength * (r / 2e-3) ** 1.2 * 0.5;
    this.panL[k] = left;
    this.panR[k] = right;
  }

  private impactL = 0;
  private impactR = 0;

  render(a: Float64Array, b: Float64Array, n: number, c: Controls): void {
    const sr = this.sr;
    const shower = this.shower.step(n / sr, 3.6);
    const rate =
      (12 + 520 * c.density * c.density) *
      (0.4 + 1.2 * c.shape) *
      (0.56 + 0.88 * shower);
    const bedHz = (2600 + 2600 * (1 - c.distance)) * c.sweep;
    this.bedLpA.set(bedHz, 0.6, sr);
    this.bedLpB.set(bedHz, 0.6, sr);
    const bed =
      (0.12 + 0.3 * c.density + 0.15 * c.wear) * (0.75 + 0.49 * shower);
    for (let i = 0; i < n; i += 1) {
      if ((this.next -= 1) <= 0) {
        this.next += this.rng.wait(rate) * sr;
        this.drop(c.wear);
      }
      let l = 0;
      let r = 0;
      for (let k = 0; k < this.live; k += 1) {
        const v = Math.sin(TAU * this.phase[k]!) * this.amp[k]!;
        l += v * this.panL[k]!;
        r += v * this.panR[k]!;
        this.phase[k]! += this.freq[k]!;
        if (this.phase[k]! >= 1) this.phase[k]! -= 1;
        this.freq[k]! += this.rise[k]!;
        this.amp[k]! *= this.decay[k]!;
        if (this.amp[k]! < 2e-4) {
          // Swap-remove: draws never depend on slot order.
          const last = this.live - 1;
          this.phase[k] = this.phase[last]!;
          this.freq[k] = this.freq[last]!;
          this.rise[k] = this.rise[last]!;
          this.amp[k] = this.amp[last]!;
          this.decay[k] = this.decay[last]!;
          this.panL[k] = this.panL[last]!;
          this.panR[k] = this.panR[last]!;
          this.live = last;
          k -= 1;
        }
      }
      l += this.tickA.process(this.impactL);
      r += this.tickB.process(this.impactR);
      // Water gathers on an edge before it falls. These quieter, lower
      // impacts remain distinguishable through the distant sheet of rain.
      let drip = 0;
      if (--this.nextDrip <= 0) {
        this.nextDrip = (0.16 + this.rng.wait(1.1 + c.density * 2.1)) * sr;
        this.eave.set(this.rng.range(380, 1100) * c.sweep, 8.5, sr);
        this.dripPan = this.rng.range(0.18, 0.82);
        drip = (0.7 + c.wear) * this.rng.range(0.65, 1.55);
      }
      const nearby = this.eave.process(drip);
      l += nearby * (1 - this.dripPan);
      r += nearby * this.dripPan;
      this.impactL = 0;
      this.impactR = 0;
      const na = this.bedLpA.process(
        this.bedHpA.process(this.pinkA.process(this.rng.noise())),
      );
      const nb = this.bedLpB.process(
        this.bedHpB.process(this.pinkB.process(this.rng.noise())),
      );
      a[i] = l + this.bedLpA.low * bed + na * 0.2 * bed;
      b[i] = r + this.bedLpB.low * bed + nb * 0.2 * bed;
    }
  }
}

// ---------------------------------------------------------------------------
// Wind: noise through band-passes whose center and Q follow a gust
// envelope (a slow swell plus a faster flutter), and resonant whistles that
// sing at the gust peaks.

class Wind implements Source {
  private readonly pinkA = new Pink();
  private readonly pinkB = new Pink();
  private readonly brownA: Brown;
  private readonly brownB: Brown;
  private readonly bodyA = new Svf();
  private readonly bodyB = new Svf();
  private readonly airA = new Svf();
  private readonly airB = new Svf();
  private readonly whistle1 = new Svf();
  private readonly whistle2 = new Svf();
  private readonly gust: Drift;
  private readonly flutter: Drift;
  private readonly skew: Drift;
  private readonly ratio: number;

  constructor(
    private readonly rng: Rng,
    private readonly sr: number,
  ) {
    this.brownA = new Brown(sr);
    this.brownB = new Brown(sr);
    this.gust = new Drift(rng, 0.4);
    this.flutter = new Drift(rng);
    this.skew = new Drift(rng);
    this.ratio = rng.range(1.33, 1.62);
  }

  render(a: Float64Array, b: Float64Array, n: number, c: Controls): void {
    const sr = this.sr;
    const dt = n / sr;
    const depth = 0.35 + 0.65 * c.density;
    const g0 = this.gust.step(dt, 4.5 - 2.5 * c.density, depth);
    const fl = this.flutter.step(dt, 0.35 - 0.2 * c.density) - 0.5;
    const g = Math.min(1, Math.max(0, g0 + fl * 0.25 * c.density));
    const skew = (this.skew.step(dt, 3) - 0.5) * 0.3;
    const center = (220 + 950 * g * g) * c.sweep;
    const q = 0.7 + 3.2 * g;
    this.bodyA.set(center * (1 + skew), q, sr);
    this.bodyB.set(center * (1 - skew), q, sr);
    this.airA.set(center * 2.7, 1.2, sr);
    this.airB.set(center * 2.9, 1.2, sr);
    const whistle = (600 + 1300 * g) * c.sweep;
    this.whistle1.set(whistle, 28 + 30 * c.wear, sr);
    this.whistle2.set(whistle * this.ratio, 36 + 30 * c.wear, sr);
    const level = (0.25 + g) ** 2;
    const sing = c.wear * c.wear * Math.max(0, g - 0.35) * 2.2;
    const low = 0.35 * (1 - g);
    for (let i = 0; i < n; i += 1) {
      const pa = this.pinkA.process(this.rng.noise());
      const pb = this.pinkB.process(this.rng.noise());
      const ba = this.brownA.process(this.rng.noise());
      const bb = this.brownB.process(this.rng.noise());
      const white = this.rng.noise();
      const w =
        (this.whistle1.process(white) + 0.7 * this.whistle2.process(white)) *
        sing;
      a[i] =
        level *
          (this.bodyA.process(pa + ba) * 1.6 + this.airA.process(pa) * 0.4) +
        low * ba * 0.3 +
        w;
      b[i] =
        level *
          (this.bodyB.process(pb + bb) * 1.6 + this.airB.process(pb) * 0.4) +
        low * bb * 0.3 +
        w * 0.8;
    }
  }
}

// ---------------------------------------------------------------------------
// Vinyl: crackle (dense small clicks with a heavy-tailed size), pops, the
// once-a-turn scratch when worn, surface hiss and turntable rumble.

/** 33 1/3 rpm in turns per second. */
const TURN_HZ = 100 / 3 / 60;

class Vinyl implements Source {
  private readonly clickA = new Svf();
  private readonly clickB = new Svf();
  private readonly popA = new Lp1();
  private readonly popB = new Lp1();
  private readonly popA2 = new Lp1();
  private readonly popB2 = new Lp1();
  private readonly hissA = new Svf();
  private readonly hissB = new Svf();
  private readonly pinkA = new Pink();
  private readonly pinkB = new Pink();
  private readonly brown: Brown;
  private readonly rumble = new Lp1();
  private readonly rumble2 = new Lp1();
  private nextClick = 0;
  private nextPop = 0;
  private turn: number;
  private readonly scratchAt: number;

  constructor(
    private readonly rng: Rng,
    private readonly sr: number,
  ) {
    this.clickA.set(2600, 1.1, sr);
    this.clickB.set(2900, 1.1, sr);
    this.popA.set(1800, sr);
    this.popB.set(1800, sr);
    this.popA2.set(1800, sr);
    this.popB2.set(1800, sr);
    this.hissA.set(3200, 0.5, sr);
    this.hissB.set(3400, 0.5, sr);
    this.brown = new Brown(sr);
    this.rumble.set(28, sr);
    this.rumble2.set(28, sr);
    this.turn = rng.next();
    this.scratchAt = rng.next();
  }

  render(a: Float64Array, b: Float64Array, n: number, c: Controls): void {
    const sr = this.sr;
    const clickRate = 25 + 1400 * c.density * c.density;
    const popRate = 0.08 + 2.5 * c.wear * c.wear;
    const scratch = Math.max(0, c.wear - 0.45) * 2;
    const hiss = 0.1 + 0.15 * c.wear;
    const rumble = 0.25 + 0.75 * c.wear;
    const step = TURN_HZ / sr;
    for (let i = 0; i < n; i += 1) {
      let ia = 0;
      let ib = 0;
      if ((this.nextClick -= 1) <= 0) {
        this.nextClick += this.rng.wait(clickRate) * sr;
        const size =
          (0.1 + 0.25 * this.rng.next() ** 6) *
          (this.rng.next() < 0.5 ? -1 : 1);
        const side = this.rng.next();
        // Most crackle sits in one groove wall.
        if (side < 0.4) ia = size;
        else if (side < 0.8) ib = size;
        else {
          ia = size;
          ib = size * 0.8;
        }
      }
      let pa = 0;
      let pb = 0;
      if ((this.nextPop -= 1) <= 0) {
        this.nextPop += this.rng.wait(popRate) * sr;
        const size = 0.4 + 0.5 * this.rng.next();
        pa = size;
        pb = size * this.rng.range(0.5, 1);
      }
      const before = this.turn;
      this.turn += step;
      if (this.turn >= 1) this.turn -= 1;
      if (
        scratch > 0 &&
        before < this.scratchAt &&
        this.turn >= this.scratchAt
      ) {
        pa += 0.8 * scratch;
        pb += 0.8 * scratch;
      }
      const turnWobble = 1 + 0.4 * Math.sin(TAU * this.turn);
      const r =
        this.rumble2.process(
          this.rumble.process(this.brown.process(this.rng.noise())),
        ) *
        rumble *
        turnWobble *
        0.8;
      a[i] =
        this.clickA.process(ia) * 1.4 +
        this.popA2.process(this.popA.process(pa)) * 1.5 +
        this.hissA.process(this.pinkA.process(this.rng.noise())) * hiss +
        r;
      b[i] =
        this.clickB.process(ib) * 1.4 +
        this.popB2.process(this.popB.process(pb)) * 1.5 +
        this.hissB.process(this.pinkB.process(this.rng.noise())) * hiss +
        r;
    }
  }
}

// ---------------------------------------------------------------------------
// Tape: hiss whose level and tilt breathe with wow (about 0.6 Hz) and
// flutter (6-11 Hz) as modulation noise does, the transport's head bump
// (a resonance near 70 Hz), dropouts and worn heads losing the top.

class Tape implements Source {
  private readonly pinkA = new Pink();
  private readonly pinkB = new Pink();
  private readonly hpA = new Hp1();
  private readonly hpB = new Hp1();
  private readonly lpA = new Svf();
  private readonly lpB = new Svf();
  private readonly bump = new Svf();
  private readonly brown: Brown;
  private wow: number;
  private flutter: number;
  private readonly wowHz: number;
  private readonly flutterHz: number;
  private readonly drift: Drift;
  private dropout = 1;
  private dropTarget = 1;
  private nextDrop = 0;
  private dropLeft = 0;

  constructor(
    private readonly rng: Rng,
    private readonly sr: number,
  ) {
    this.hpA.set(500, sr);
    this.hpB.set(500, sr);
    this.bump.set(rng.range(62, 82), 1.4, sr);
    this.brown = new Brown(sr);
    this.wow = rng.next();
    this.flutter = rng.next();
    this.wowHz = rng.range(0.45, 0.9);
    this.flutterHz = rng.range(6, 11);
    this.drift = new Drift(rng);
  }

  render(a: Float64Array, b: Float64Array, n: number, c: Controls): void {
    const sr = this.sr;
    const top = (6800 - 4200 * c.wear) * c.sweep;
    this.lpA.set(top, 0.6, sr);
    this.lpB.set(top * 1.03, 0.6, sr);
    const hiss = 0.35 + 0.65 * c.density;
    const depth = 0.08 + 0.35 * c.wear;
    const head = 0.25 + 0.6 * c.wear;
    const dropRate = 0.03 + 1.2 * c.wear * c.wear;
    const drift = 0.85 + 0.3 * this.drift.step(n / sr, 2.5);
    for (let i = 0; i < n; i += 1) {
      this.wow += this.wowHz / sr;
      if (this.wow >= 1) this.wow -= 1;
      this.flutter += this.flutterHz / sr;
      if (this.flutter >= 1) this.flutter -= 1;
      const mod =
        1 +
        depth *
          (0.6 * Math.sin(TAU * this.wow) + 0.4 * Math.sin(TAU * this.flutter));
      if ((this.nextDrop -= 1) <= 0) {
        this.nextDrop += this.rng.wait(dropRate) * sr;
        this.dropLeft = Math.round(this.rng.range(0.03, 0.2) * sr);
        this.dropTarget = this.rng.range(0.15, 0.6);
      }
      if (this.dropLeft > 0) this.dropLeft -= 1;
      else this.dropTarget = 1;
      this.dropout += 0.004 * (this.dropTarget - this.dropout);
      const gain = hiss * mod * drift * this.dropout;
      const wa = this.rng.noise();
      const wb = this.rng.noise();
      const ha = this.hpA.process(this.pinkA.process(wa) * 0.7 + wa * 0.3);
      const hb = this.hpB.process(this.pinkB.process(wb) * 0.7 + wb * 0.3);
      this.lpA.process(ha);
      this.lpB.process(hb);
      const bump =
        this.bump.process(this.brown.process(this.rng.noise())) * head * mod;
      a[i] = this.lpA.low * gain + bump;
      b[i] = this.lpB.low * gain + bump;
    }
  }
}

// ---------------------------------------------------------------------------
// Mains hum: a harmonic series on 50 or 60 Hz (even harmonics from the
// rectifier, odd ones from a saturating transformer as it wears), a buzz
// gated on each half cycle, a slow drift and a little noise.

class Hum implements Source {
  private readonly count: number;
  private readonly p: Float64Array;
  private readonly q: Float64Array;
  private readonly odd: Float64Array;
  private phase = 0;
  private readonly drift: Drift;
  private readonly flicker: Drift;
  private readonly buzzA = new Svf();
  private readonly buzzB = new Svf();
  private readonly pinkA = new Pink();
  private readonly pinkB = new Pink();

  constructor(
    private readonly rng: Rng,
    private readonly sr: number,
    private readonly mains: number,
  ) {
    this.count = Math.max(
      1,
      Math.min(48, Math.floor((sr * 0.42) / mains), Math.floor(4000 / mains)),
    );
    this.p = new Float64Array(this.count + 1);
    this.q = new Float64Array(this.count + 1);
    this.odd = new Float64Array(this.count + 1);
    for (let h = 1; h <= this.count; h += 1) {
      const theta = TAU * rng.next();
      this.p[h] = Math.cos(theta);
      this.q[h] = Math.sin(theta);
      this.odd[h] = h % 2 === 1 ? 1 : 0;
    }
    this.drift = new Drift(rng);
    this.flicker = new Drift(rng);
    this.buzzA.set(2400, 0.7, sr);
    this.buzzB.set(2600, 0.7, sr);
  }

  render(a: Float64Array, b: Float64Array, n: number, c: Controls): void {
    const sr = this.sr;
    const dt = n / sr;
    const hz = this.mains * (1 + 0.0008 * (this.drift.step(dt, 3) - 0.5));
    const step = hz / sr;
    const flicker = 1 + 0.25 * c.density * (this.flicker.step(dt, 0.4) - 0.5);
    // Harmonic amplitudes for this block.
    const amps = new Float64Array(this.count + 1);
    const tilt = 1.6 - 0.8 * c.wear;
    for (let h = 1; h <= this.count; h += 1) {
      const even = h % 2 === 0 ? 1 : 0.25 + 1.2 * c.wear;
      amps[h] = (even / h ** tilt) * (h === 1 ? 0.8 : 1);
    }
    const buzz = (0.05 + 0.5 * c.wear) * (0.4 + c.density);
    const noise = 0.02 + 0.05 * c.density;
    for (let i = 0; i < n; i += 1) {
      this.phase += step;
      if (this.phase >= 1) this.phase -= 1;
      const theta = TAU * this.phase;
      const c1 = Math.cos(theta);
      const s1 = Math.sin(theta);
      let cn = c1;
      let sn = s1;
      let sum = 0;
      for (let h = 1; h <= this.count; h += 1) {
        // sin(h theta + theta_h) = sin(h theta) cos(theta_h) + cos(h theta) sin(theta_h)
        sum += amps[h]! * (sn * this.p[h]! + cn * this.q[h]!);
        const nc = cn * c1 - sn * s1;
        sn = sn * c1 + cn * s1;
        cn = nc;
      }
      // Rectifier buzz: noise gated near each half-cycle's peak.
      const gate = Math.abs(s1) ** 12;
      const na = this.pinkA.process(this.rng.noise());
      const nb = this.pinkB.process(this.rng.noise());
      const hum = sum * flicker * 0.6;
      a[i] =
        hum + this.buzzA.process(this.rng.noise()) * gate * buzz + na * noise;
      b[i] =
        hum + this.buzzB.process(this.rng.noise()) * gate * buzz + nb * noise;
    }
  }
}

// ---------------------------------------------------------------------------
// City: a distant traffic bed that swells, cars passing across the image
// (band-passed noise with a Doppler glide and tire hiss) and, as it wears,
// metal clatter. The voice's FDN is set long, as a street canyon.

const MAX_CARS = 6;

class City implements Source {
  private readonly brownA: Brown;
  private readonly brownB: Brown;
  private readonly bedA = new Lp1();
  private readonly bedB = new Lp1();
  private readonly bed2A = new Lp1();
  private readonly bed2B = new Lp1();
  private readonly swell: Drift;
  private readonly pink = new Pink();
  private readonly clank = new Svf();
  private nextCar = 0;
  private nextClank = 0;
  private readonly carAge = new Float64Array(MAX_CARS);
  private readonly carLength = new Float64Array(MAX_CARS);
  private readonly carHz = new Float64Array(MAX_CARS);
  private readonly carDir = new Float64Array(MAX_CARS);
  private readonly carAmp = new Float64Array(MAX_CARS);
  private readonly carBody: Svf[] = [];
  private readonly carTire: Svf[] = [];
  private cars = 0;

  constructor(
    private readonly rng: Rng,
    private readonly sr: number,
  ) {
    this.brownA = new Brown(sr);
    this.brownB = new Brown(sr);
    this.swell = new Drift(rng);
    for (let k = 0; k < MAX_CARS; k += 1) {
      this.carBody.push(new Svf());
      this.carTire.push(new Svf());
    }
    this.nextCar = rng.wait(0.6) * sr;
    this.nextClank = rng.wait(0.5) * sr;
  }

  render(a: Float64Array, b: Float64Array, n: number, c: Controls): void {
    const sr = this.sr;
    const dt = n / sr;
    const swell = 0.6 + 0.8 * this.swell.step(dt, 6);
    const bedHz = (180 + 260 * c.density) * c.sweep;
    this.bedA.set(bedHz, sr);
    this.bedB.set(bedHz, sr);
    this.bed2A.set(bedHz * 1.5, sr);
    this.bed2B.set(bedHz * 1.5, sr);
    const carRate = 0.05 + 0.7 * c.density;
    const clankRate = 0.05 + 2 * c.wear * c.wear;
    // Spawn cars for this block (at block resolution: they last seconds).
    this.nextCar -= n;
    while (this.nextCar <= 0) {
      this.nextCar += this.rng.wait(carRate) * sr;
      if (this.cars < MAX_CARS) {
        const k = this.cars;
        this.cars += 1;
        this.carAge[k] = 0;
        this.carLength[k] = this.rng.range(2.5, 7);
        this.carHz[k] = this.rng.range(260, 800);
        this.carDir[k] = this.rng.next() < 0.5 ? -1 : 1;
        this.carAmp[k] = this.rng.range(0.3, 1);
      }
    }
    // Car gains and pans for the block.
    const carL = new Float64Array(this.cars);
    const carR = new Float64Array(this.cars);
    for (let k = 0; k < this.cars; k += 1) {
      const x = this.carAge[k]! / this.carLength[k]!;
      const level = Math.sin(Math.PI * x) ** 3 * this.carAmp[k]!;
      const pan = this.carDir[k]! * (2 * x - 1);
      carL[k] = level * Math.sqrt(0.5 * (1 - pan));
      carR[k] = level * Math.sqrt(0.5 * (1 + pan));
      // Doppler: about 6 % above on approach, 6 % below going away.
      const doppler = 1 + 0.06 * Math.tanh(4 * (0.5 - x));
      this.carBody[k]!.set(this.carHz[k]! * doppler * c.sweep, 0.9, sr);
      this.carTire[k]!.set(2600 * doppler, 0.8, sr);
      this.carAge[k]! += dt;
    }
    for (let i = 0; i < n; i += 1) {
      const ba = this.brownA.process(this.rng.noise());
      const bb = this.brownB.process(this.rng.noise());
      let l = this.bed2A.process(this.bedA.process(ba)) * swell * 0.6;
      let r = this.bed2B.process(this.bedB.process(bb)) * swell * 0.6;
      if (this.cars > 0) {
        const p = this.pink.process(this.rng.noise());
        for (let k = 0; k < this.cars; k += 1) {
          const v =
            this.carBody[k]!.process(p + ba * 0.3) * 2.4 +
            this.carTire[k]!.process(p) * 0.4;
          l += v * carL[k]!;
          r += v * carR[k]!;
        }
      }
      let impulse = 0;
      if ((this.nextClank -= 1) <= 0) {
        this.nextClank += this.rng.wait(clankRate) * sr;
        this.clank.set(this.rng.range(700, 2600), this.rng.range(8, 20), sr);
        impulse = this.rng.bi() * 3;
      }
      const clank = this.clank.process(impulse);
      a[i] = l + clank * 0.7;
      b[i] = r + clank * 0.5;
    }
    // Retire finished cars (swap-remove keeps the order deterministic).
    for (let k = this.cars - 1; k >= 0; k -= 1)
      if (this.carAge[k]! >= this.carLength[k]!) {
        const last = this.cars - 1;
        this.carAge[k] = this.carAge[last]!;
        this.carLength[k] = this.carLength[last]!;
        this.carHz[k] = this.carHz[last]!;
        this.carDir[k] = this.carDir[last]!;
        this.carAmp[k] = this.carAmp[last]!;
        const body = this.carBody[k]!;
        const tire = this.carTire[k]!;
        this.carBody[k] = this.carBody[last]!;
        this.carTire[k] = this.carTire[last]!;
        this.carBody[last] = body;
        this.carTire[last] = tire;
        this.cars = last;
      }
  }
}

// ---------------------------------------------------------------------------
// Crowd: granular murmur. Each grain is one syllable from one of a dozen
// seeded talkers: a band-limited glottal saw plus breath noise through two
// formant band-passes gliding between two vowels, under a Hann window. It
// is never speech: the vowels and pitches are random.

const MAX_GRAINS = 24;
/** F1 and F2 of a handful of vowels, Hz (Peterson and Barney averages). */
const VOWELS: readonly (readonly [number, number])[] = [
  [730, 1090],
  [530, 1840],
  [270, 2290],
  [570, 840],
  [300, 870],
  [660, 1720],
  [490, 1350],
];

type Talker = { hz: number; pan: number; scale: number };

class Crowd implements Source {
  private readonly talkers: Talker[] = [];
  private readonly f1: Svf[] = [];
  private readonly f2: Svf[] = [];
  private readonly age = new Float64Array(MAX_GRAINS);
  private readonly length = new Float64Array(MAX_GRAINS);
  private readonly phase = new Float64Array(MAX_GRAINS);
  private readonly hz = new Float64Array(MAX_GRAINS);
  private readonly amp = new Float64Array(MAX_GRAINS);
  private readonly left = new Float64Array(MAX_GRAINS);
  private readonly right = new Float64Array(MAX_GRAINS);
  private readonly va = new Int32Array(MAX_GRAINS);
  private readonly vb = new Int32Array(MAX_GRAINS);
  private readonly scale = new Float64Array(MAX_GRAINS);
  private grains = 0;
  private next = 0;
  private readonly lpA = new Lp1();
  private readonly lpB = new Lp1();
  private readonly swell: Drift;

  constructor(
    private readonly rng: Rng,
    private readonly sr: number,
  ) {
    for (let t = 0; t < 12; t += 1)
      this.talkers.push({
        hz: rng.next() < 0.5 ? rng.range(95, 140) : rng.range(170, 240),
        pan: rng.bi(),
        scale: rng.range(0.9, 1.15),
      });
    for (let k = 0; k < MAX_GRAINS; k += 1) {
      this.f1.push(new Svf());
      this.f2.push(new Svf());
    }
    this.swell = new Drift(rng);
  }

  private spawn(wear: number): void {
    if (this.grains >= MAX_GRAINS) return;
    const k = this.grains;
    this.grains += 1;
    const talker =
      this.talkers[Math.floor(this.rng.next() * this.talkers.length)]!;
    this.age[k] = 0;
    this.length[k] = this.rng.range(0.07, 0.22) * this.sr;
    this.phase[k] = this.rng.next();
    this.hz[k] =
      talker.hz *
      (1 + 0.25 * wear * this.rng.next()) *
      this.rng.range(0.92, 1.1);
    this.amp[k] = (0.25 + 0.75 * this.rng.next() ** (1.5 - wear)) * 0.5;
    const pan = Math.max(-1, Math.min(1, talker.pan + 0.2 * this.rng.bi()));
    this.left[k] = Math.sqrt(0.5 * (1 - pan));
    this.right[k] = Math.sqrt(0.5 * (1 + pan));
    this.va[k] = Math.floor(this.rng.next() * VOWELS.length);
    this.vb[k] = Math.floor(this.rng.next() * VOWELS.length);
    this.scale[k] = talker.scale;
  }

  private retire(k: number): void {
    const last = this.grains - 1;
    this.age[k] = this.age[last]!;
    this.length[k] = this.length[last]!;
    this.phase[k] = this.phase[last]!;
    this.hz[k] = this.hz[last]!;
    this.amp[k] = this.amp[last]!;
    this.left[k] = this.left[last]!;
    this.right[k] = this.right[last]!;
    this.va[k] = this.va[last]!;
    this.vb[k] = this.vb[last]!;
    this.scale[k] = this.scale[last]!;
    const f1 = this.f1[k]!;
    const f2 = this.f2[k]!;
    this.f1[k] = this.f1[last]!;
    this.f2[k] = this.f2[last]!;
    this.f1[last] = f1;
    this.f2[last] = f2;
    this.grains = last;
  }

  render(a: Float64Array, b: Float64Array, n: number, c: Controls): void {
    const sr = this.sr;
    const swell = 0.7 + 0.6 * this.swell.step(n / sr, 5);
    const rate = (3 + 70 * c.density) * swell;
    const top = 3800 * c.sweep;
    this.lpA.set(top, sr);
    this.lpB.set(top, sr);
    // Formants for this block: each grain glides from vowel a to vowel b.
    for (let k = 0; k < this.grains; k += 1) {
      const x = this.age[k]! / this.length[k]!;
      const A = VOWELS[this.va[k]!]!;
      const B = VOWELS[this.vb[k]!]!;
      const s = this.scale[k]!;
      this.f1[k]!.set((A[0] + (B[0] - A[0]) * x) * s, 5, sr);
      this.f2[k]!.set((A[1] + (B[1] - A[1]) * x) * s, 7, sr);
    }
    for (let i = 0; i < n; i += 1) {
      if ((this.next -= 1) <= 0) {
        this.next += this.rng.wait(rate) * sr;
        this.spawn(c.wear);
      }
      let l = 0;
      let r = 0;
      for (let k = 0; k < this.grains; k += 1) {
        const dt = this.hz[k]! / sr;
        let t = this.phase[k]! + dt;
        if (t >= 1) t -= 1;
        this.phase[k] = t;
        const saw = 2 * t - 1 - polyBlep(t, dt);
        const src = saw * 0.8 + this.rng.noise() * 0.25;
        const x = this.age[k]! / this.length[k]!;
        const window = 0.5 - 0.5 * Math.cos(TAU * x);
        const v =
          (this.f1[k]!.process(src) + 0.6 * this.f2[k]!.process(src)) *
          window *
          this.amp[k]!;
        l += v * this.left[k]!;
        r += v * this.right[k]!;
        this.age[k]! += 1;
        if (this.age[k]! >= this.length[k]!) {
          this.retire(k);
          k -= 1;
        }
      }
      a[i] = this.lpA.process(l);
      b[i] = this.lpB.process(r);
    }
  }
}

// ---------------------------------------------------------------------------
// Data: a faint digital floor broken by seeded events: modem bursts
// (phase-continuous FSK, Bell 103 tones), sample-rate sweeps
// (sample-and-hold sweeping its rate), click clusters and crushed noise,
// with buffer-repeat stutters over the result and bit-flips as it wears.

type DataEvent = "modem" | "sweep" | "clicks" | "crush";
const STUTTER_SECONDS = 0.5;

class Data implements Source {
  private readonly hiss = new Pink();
  private readonly lpA = new Lp1();
  private readonly lpB = new Lp1();
  private readonly lp2A = new Lp1();
  private readonly lp2B = new Lp1();
  private nextEvent = 0;
  private event: DataEvent | undefined;
  private eventLeft = 0;
  private eventLength = 1;
  private phase = 0;
  private bitLeft = 0;
  private bit = 0;
  private baud = 300;
  private mark = 1270;
  private space = 1070;
  private hold = 0;
  private holdLeft = 0;
  private sweepFrom = 300;
  private sweepTo = 8000;
  private tone = 440;
  private pan = 0;
  private clicksLeft = 0;
  private nextClick = 0;
  private crushBits = 3;
  // Stutter: the last half second of output and a repeating slice of it.
  private readonly ringA: Float64Array;
  private readonly ringB: Float64Array;
  private writeAt = 0;
  private sliceStart = 0;
  private sliceLength = 0;
  private sliceAt = 0;
  private repeats = 0;
  private nextStutter = 0;
  private readonly fade: number;

  constructor(
    private readonly rng: Rng,
    private readonly sr: number,
  ) {
    const size = Math.ceil(STUTTER_SECONDS * sr);
    this.ringA = new Float64Array(size);
    this.ringB = new Float64Array(size);
    this.nextEvent = rng.wait(2) * sr;
    this.nextStutter = rng.wait(0.5) * sr;
    this.fade = Math.max(1, Math.round(0.002 * sr));
  }

  private start(c: Controls): void {
    const roll = this.rng.next();
    this.event =
      roll < 0.3
        ? "modem"
        : roll < 0.55
          ? "sweep"
          : roll < 0.8
            ? "clicks"
            : "crush";
    const seconds =
      this.event === "modem"
        ? this.rng.range(0.4, 1.4)
        : this.event === "sweep"
          ? this.rng.range(0.25, 1)
          : this.event === "clicks"
            ? this.rng.range(0.05, 0.4)
            : this.rng.range(0.05, 0.3);
    this.eventLength = Math.max(1, Math.round(seconds * this.sr));
    this.eventLeft = this.eventLength;
    this.pan = 0.6 * this.rng.bi();
    if (this.event === "modem") {
      const answer = this.rng.next() < 0.5;
      this.mark = answer ? 2225 : 1270;
      this.space = answer ? 2025 : 1070;
      this.baud = this.rng.next() < 0.6 ? 300 : 1200;
      this.bitLeft = 0;
    } else if (this.event === "sweep") {
      const up = this.rng.next() < 0.5 + 0.4 * (c.shape - 0.5);
      const lo = this.rng.range(150, 600);
      const hi = this.rng.range(3000, 9000);
      this.sweepFrom = up ? lo : hi;
      this.sweepTo = up ? hi : lo;
      this.tone = this.rng.range(180, 900);
    } else if (this.event === "clicks") {
      this.clicksLeft = 1 + Math.floor(this.rng.next() * 6);
      this.nextClick = 0;
    } else {
      this.crushBits = 2 + Math.floor(this.rng.next() * 3);
      this.sweepFrom = this.rng.range(800, 5000);
    }
  }

  render(a: Float64Array, b: Float64Array, n: number, c: Controls): void {
    const sr = this.sr;
    const rate = (0.8 + 9 * c.density) * (0.4 + 1.2 * c.shape);
    const stutterRate = 0.2 + 2.5 * c.density;
    const flipRate = (0.5 + 60 * c.wear * c.wear) / sr;
    const bits = Math.round(16 - 10 * c.wear * c.wear);
    const steps = 2 ** (bits - 1);
    const top = Math.min(5200, 4200 * c.sweep);
    this.lpA.set(top, sr);
    this.lpB.set(top, sr);
    this.lp2A.set(top * 1.2, sr);
    this.lp2B.set(top * 1.2, sr);
    for (let i = 0; i < n; i += 1) {
      if (this.event === undefined && (this.nextEvent -= 1) <= 0) {
        this.nextEvent = this.rng.wait(rate) * sr;
        this.start(c);
      }
      let v = this.hiss.process(this.rng.noise()) * 0.03;
      let left = 1;
      let right = 1;
      if (this.event !== undefined) {
        const x = 1 - this.eventLeft / this.eventLength;
        // 3 ms edges so events never click unless they are clicks.
        const edge = Math.min(
          1,
          this.eventLeft / (0.003 * sr),
          (x * this.eventLength) / (0.003 * sr),
        );
        let e = 0;
        if (this.event === "modem") {
          if (this.bitLeft <= 0) {
            this.bit = this.rng.next() < 0.5 ? 1 : 0;
            this.bitLeft = sr / this.baud;
          }
          this.bitLeft -= 1;
          this.phase += (this.bit ? this.mark : this.space) / sr;
          if (this.phase >= 1) this.phase -= 1;
          e = Math.sin(TAU * this.phase) * 0.35 * edge;
        } else if (this.event === "sweep") {
          const hz = this.sweepFrom * (this.sweepTo / this.sweepFrom) ** x;
          this.phase += this.tone / sr;
          if (this.phase >= 1) this.phase -= 1;
          if ((this.holdLeft -= 1) <= 0) {
            this.holdLeft += sr / hz;
            this.hold = this.phase < 0.5 ? 0.3 : -0.3;
          }
          e = this.hold * edge;
        } else if (this.event === "clicks") {
          if (this.clicksLeft > 0 && (this.nextClick -= 1) <= 0) {
            this.nextClick = this.rng.range(0.004, 0.05) * sr;
            this.clicksLeft -= 1;
            e = this.rng.next() < 0.5 ? -0.9 : 0.9;
          }
        } else {
          if ((this.holdLeft -= 1) <= 0) {
            this.holdLeft += sr / this.sweepFrom;
            const q = 2 ** (this.crushBits - 1);
            this.hold = Math.round(this.rng.bi() * q) / q;
          }
          e = this.hold * 0.25 * edge;
        }
        left = Math.sqrt(1 - this.pan);
        right = Math.sqrt(1 + this.pan);
        v += e;
        this.eventLeft -= 1;
        if (this.eventLeft <= 0) this.event = undefined;
      }
      let l = this.lp2A.process(this.lpA.process(v * left));
      let r = this.lp2B.process(this.lpB.process(v * right));
      // Bit depth and bit-flips on a 16-bit view of the signal.
      l = Math.round(l * steps) / steps;
      r = Math.round(r * steps) / steps;
      if (this.rng.next() < flipRate) {
        const bit = 2 ** (5 + Math.floor(this.rng.next() * 6));
        const word = Math.round(l * 32768);
        l = (word ^ bit) / 32768;
      }
      // Buffer-repeat stutter over the last half second.
      const size = this.ringA.length;
      this.ringA[this.writeAt] = l;
      this.ringB[this.writeAt] = r;
      if (this.repeats === 0 && (this.nextStutter -= 1) <= 0) {
        this.nextStutter = this.rng.wait(stutterRate) * sr;
        this.sliceLength = Math.round(this.rng.range(0.015, 0.12) * sr);
        this.sliceStart = (this.writeAt - this.sliceLength + size) % size;
        this.sliceAt = 0;
        this.repeats = 2 + Math.floor(this.rng.next() * 6);
      }
      if (this.repeats > 0) {
        const at = (this.sliceStart + this.sliceAt) % size;
        const f = this.fade;
        const edge = Math.min(
          1,
          this.sliceAt / f,
          (this.sliceLength - this.sliceAt) / f,
        );
        l = this.ringA[at]! * edge;
        r = this.ringB[at]! * edge;
        this.sliceAt += 1;
        if (this.sliceAt >= this.sliceLength) {
          this.sliceAt = 0;
          this.repeats -= 1;
        }
      }
      this.writeAt = (this.writeAt + 1) % size;
      a[i] = l;
      b[i] = r;
    }
  }
}

// ---------------------------------------------------------------------------
// Air: high band noise in three shimmering bands (each with its own slow
// random level) over a high-passed hush, with sparse glints.

class Air implements Source {
  private readonly bandsA: Svf[] = [new Svf(), new Svf(), new Svf()];
  private readonly bandsB: Svf[] = [new Svf(), new Svf(), new Svf()];
  private readonly shimmer: Drift[];
  private readonly hpA = new Svf();
  private readonly hpB = new Svf();
  private readonly hpA2 = new Svf();
  private readonly hpB2 = new Svf();
  private readonly glint = new Svf();
  private nextGlint = 0;
  private readonly centers: readonly number[];

  constructor(
    private readonly rng: Rng,
    private readonly sr: number,
  ) {
    this.shimmer = [new Drift(rng), new Drift(rng), new Drift(rng)];
    this.centers = [
      rng.range(2200, 2700),
      rng.range(3300, 3900),
      rng.range(4700, 5300),
    ];
    this.nextGlint = rng.wait(1) * sr;
  }

  render(a: Float64Array, b: Float64Array, n: number, c: Controls): void {
    const sr = this.sr;
    const dt = n / sr;
    const period = 1.6 - 1.2 * c.density;
    const levels = this.shimmer.map((d, k) => {
      const v = d.step(dt, period * (1 + 0.3 * k));
      return (0.35 + 1.3 * v * v) * [1, 0.6, 0.08][k]!;
    });
    for (let k = 0; k < 3; k += 1) {
      const hz = this.centers[k]! * c.sweep;
      this.bandsA[k]!.set(hz, 2.5, sr);
      this.bandsB[k]!.set(hz * 1.04, 2.5, sr);
    }
    const hp = 1600 * Math.min(2, c.sweep);
    this.hpA.set(hp, 0.7, sr);
    this.hpB.set(hp, 0.7, sr);
    this.hpA2.set(hp, 0.7, sr);
    this.hpB2.set(hp, 0.7, sr);
    const hush = 0.12 + 0.1 * c.wear;
    const glintRate = 0.3 + 6 * c.density;
    for (let i = 0; i < n; i += 1) {
      const wa = this.rng.noise();
      const wb = this.rng.noise();
      let l = 0;
      let r = 0;
      // The bands hear 24 dB/oct high-passed noise, so their skirts stay
      // out of the low mids.
      this.hpA.process(wa);
      this.hpB.process(wb);
      this.hpA2.process(this.hpA.high);
      this.hpB2.process(this.hpB.high);
      const ha = this.hpA2.high;
      const hb = this.hpB2.high;
      for (let k = 0; k < 3; k += 1) {
        l += this.bandsA[k]!.process(ha) * levels[k]!;
        r += this.bandsB[k]!.process(hb) * levels[k]!;
      }
      let impulse = 0;
      if ((this.nextGlint -= 1) <= 0) {
        this.nextGlint += this.rng.wait(glintRate) * sr;
        this.glint.set(this.rng.range(2800, 4800) * c.sweep, 40, sr);
        impulse = this.rng.bi() * 2;
      }
      const glint = this.glint.process(impulse);
      a[i] = l + ha * hush * 0.3 + glint;
      b[i] = r + hb * hush * 0.3 + glint * 0.7;
    }
  }
}

/**
 * A wire fan drawing alternating arcs on a coated snare head. Friction
 * excites a broad skin resonance and a softer, filtered wire buzz. Brief
 * notes land with the brush tips; firmer contact brings up two damped head
 * modes, while a long note keeps the fan against the head through the turn.
 */
class SnareBrush implements Source {
  private readonly skin = new Svf();
  private readonly wires = new Svf();
  private readonly wireDamping = new Svf();
  private readonly headHz: number;
  private readonly headDecay: number;
  private readonly rimDecay: number;
  private readonly bristleDecay: number;
  private age = 0;
  private length = 0;
  private direction = 1;
  private nextBristles = 0;
  private bristles = 0;
  private head = 0;
  private rim = 0;
  private angle = 0;

  constructor(
    private readonly rng: Rng,
    private readonly sr: number,
    private readonly heldSeconds: number,
    private readonly velocity: number,
  ) {
    this.headHz = rng.range(177, 191);
    this.headDecay = Math.exp(-1 / (sr * 0.038));
    this.rimDecay = Math.exp(-1 / (sr * 0.022));
    this.bristleDecay = Math.exp(-1 / (sr * 0.009));
  }

  render(a: Float64Array, b: Float64Array, n: number, c: Controls) {
    const sr = this.sr;
    this.skin.set(440 * c.sweep, 1.1, sr);
    this.wires.set((1250 + 800 * c.wear) * c.sweep, 0.85, sr);
    this.wireDamping.set((2300 + 1100 * c.wear) * c.sweep, 0.62, sr);
    // Short strokes emphasize the contact of the tips. Use a continuous
    // blend so trimming a note by one tick cannot switch its articulation.
    const dab = Math.max(0, 1 - this.heldSeconds / 0.38);
    const headAngle = (TAU * this.headHz * Math.sqrt(c.sweep)) / sr;
    for (let i = 0; i < n; i++) {
      if (this.age >= this.length && i < c.heldSamples) {
        const sweepSeconds =
          (0.77 - 0.39 * c.density) * this.rng.range(0.86, 1.14);
        this.length = Math.max(
          1,
          Math.round(Math.min(this.heldSeconds, sweepSeconds) * sr),
        );
        this.age = 0;
        this.angle = 0;
        this.direction *= -1;
        const touch =
          this.rng.range(0.85, 1.08) * (0.12 + 0.88 * this.velocity);
        this.head = touch * (0.065 + 0.4 * dab);
        this.rim = touch * (0.035 + 0.15 * dab);
      }
      const phase = Math.min(1, this.age / this.length);
      const arc = 4 * phase * (1 - phase);
      const pressure = i < c.heldSamples ? 0.19 + 0.81 * arc : 0;
      if (--this.nextBristles <= 0) {
        const speed = (50 + 105 * c.density) * (0.5 + arc);
        this.nextBristles = (this.rng.range(0.55, 1.45) * sr) / speed;
        this.bristles = this.rng.range(0.22, 0.62) * pressure;
      }
      this.bristles *= this.bristleDecay;
      const noise = this.rng.noise();
      const friction = noise * (this.bristles + 0.48 * pressure);
      const skin = this.skin.process(friction) * 0.8;
      // The snares beneath the shell buzz briefly in sympathy with a tip
      // stroke, including the interval after the brush lifts.
      const headWave = Math.sin(this.angle);
      const rattle = this.head * (0.5 + 0.8 * Math.abs(headWave));
      const wire = this.wires.process(friction + noise * rattle);
      this.wireDamping.process(wire);
      const sweep = this.wireDamping.low * (0.62 + 0.28 * c.wear);
      const tap = this.head * headWave + this.rim * Math.sin(1.68 * this.angle);
      this.angle += headAngle;
      this.age++;
      this.head *= this.headDecay;
      this.rim *= this.rimDecay;
      const pan = this.direction * (phase - 0.5) * 0.42;
      a[i] = tap + skin + sweep * (1 - pan);
      b[i] = tap + skin + sweep * (1 + pan);
    }
  }
}

/** A sheet buckles at a succession of creases as it moves. */
class Paper implements Source {
  private readonly surface = new Svf();
  private readonly body = new Svf();
  private nextStroke = 0;
  private nextGrain = 0;
  private age = 0;
  private duration = 1;
  private pan = 0;
  private grain = 0;
  private readonly grainDecay: number;

  constructor(
    private readonly rng: Rng,
    private readonly sr: number,
  ) {
    this.grainDecay = Math.exp(-1 / (sr * 0.0012));
  }

  render(a: Float64Array, b: Float64Array, n: number, c: Controls) {
    this.surface.set(3100 * (0.7 + c.wear) * c.sweep, 0.85, this.sr);
    this.body.set(840 * c.sweep, 3.8, this.sr);
    for (let i = 0; i < n; i++) {
      if (--this.nextStroke <= 0 && i < c.heldSamples) {
        this.duration = this.rng.range(0.12, 0.38) * this.sr;
        this.nextStroke =
          this.duration + this.rng.wait(1.6 + 7 * c.density) * this.sr;
        this.age = 0;
        this.nextGrain = 0;
        this.pan = this.rng.bi() * 0.48;
      }
      const phase = Math.min(1, this.age++ / this.duration);
      const pressure = Math.sin(Math.PI * phase);
      let buckle = 0;
      if (phase < 1 && --this.nextGrain <= 0) {
        const rate = 28 * (0.25 + pressure * (0.55 + c.density));
        this.nextGrain = Math.max(1, this.rng.wait(rate) * this.sr);
        this.grain += this.rng.range(0.18, 0.75) * pressure;
        buckle = this.rng.bi() * pressure * 2.4;
      }
      this.grain *= this.grainDecay;
      const noise = this.rng.noise();
      const scrape = this.surface.process(
        noise * (this.grain + pressure * 0.07),
      );
      const body = this.body.process(buckle + noise * pressure * 0.11);
      const movement = this.pan + (phase - 0.5) * 0.22;
      a[i] = body + scrape * (1 - movement);
      b[i] = body + scrape * (1 + movement);
    }
  }
}

/** A contact impulse excites a cup's paired rim modes and shorter body modes. */
class Porcelain implements Source {
  private readonly modes = [1, 1.006, 2.51, 3.87, 5.43];
  private readonly weights = [0.31, 0.21, 0.18, 0.09, 0.045];
  private readonly loss: number[];
  private readonly y1 = new Float64Array(5);
  private readonly y2 = new Float64Array(5);
  private readonly coeff = new Float64Array(5);
  private readonly excitation = new Float64Array(5);
  private readonly fundamental: number;
  private next = 0;
  private rebound = -1;
  private pan = 0;

  constructor(
    private readonly rng: Rng,
    private readonly sr: number,
  ) {
    this.fundamental = rng.range(510, 870);
    this.loss = [0.29, 0.34, 0.16, 0.094, 0.048].map((seconds) =>
      Math.exp(-1 / (sr * seconds)),
    );
  }

  render(a: Float64Array, b: Float64Array, n: number, c: Controls) {
    for (let k = 0; k < this.modes.length; k++) {
      const hz = this.fundamental * this.modes[k]! * c.sweep;
      const angle = TAU * Math.min(0.45, hz / this.sr);
      this.coeff[k] = 2 * this.loss[k]! * Math.cos(angle);
      const fade = Math.min(1, Math.max(0, (0.48 - hz / this.sr) / 0.08));
      this.excitation[k] =
        Math.sin(angle) * this.weights[k]! * fade * (k < 2 ? 1 : 0.4 + c.wear);
    }
    for (let i = 0; i < n; i++) {
      let impulse = 0;
      if (--this.next <= 0 && i < c.heldSamples) {
        impulse = this.rng.range(0.55, 1);
        this.next = (0.25 + this.rng.wait(0.7 + 3 * c.density)) * this.sr;
        this.rebound = Math.floor(this.rng.range(0.009, 0.023) * this.sr);
        this.pan = this.rng.bi() * 0.42;
      } else if (--this.rebound === 0) impulse = 0.15 + 0.16 * c.wear;
      let sum = 0;
      for (let k = 0; k < this.modes.length; k++) {
        const loss = this.loss[k]!;
        const y =
          this.coeff[k]! * this.y1[k]! -
          loss * loss * this.y2[k]! +
          impulse * this.excitation[k]!;
        this.y2[k] = this.y1[k]!;
        this.y1[k] = y;
        sum += y;
      }
      a[i] = sum * (1 - this.pan);
      b[i] = sum * (1 + this.pan) - this.y1[1]! * 0.16;
    }
  }
}

/** A fresh source of `type`, drawing from `rng`. */
export function makeSource(
  type: TextureType,
  rng: Rng,
  sampleRate: number,
  mains: number,
  heldSeconds: number,
  velocity: number,
): Source {
  switch (type) {
    case "brush":
      return new SnareBrush(rng, sampleRate, heldSeconds, velocity);
    case "paper":
      return new Paper(rng, sampleRate);
    case "porcelain":
      return new Porcelain(rng, sampleRate);
    case "room":
      return new Room(rng, sampleRate);
    case "rain":
      return new Rain(rng, sampleRate);
    case "wind":
      return new Wind(rng, sampleRate);
    case "vinyl":
      return new Vinyl(rng, sampleRate);
    case "tape":
      return new Tape(rng, sampleRate);
    case "hum":
      return new Hum(rng, sampleRate, mains);
    case "city":
      return new City(rng, sampleRate);
    case "crowd":
      return new Crowd(rng, sampleRate);
    case "data":
      return new Data(rng, sampleRate);
    case "air":
      return new Air(rng, sampleRate);
    case "ocean":
    case "stream":
    case "waterfall":
      return new Water(type, rng, sampleRate);
    case "crickets":
    case "birds":
      return new FieldCalls(type, rng, sampleRate);
    case "country-road":
      return new CountryRoad(rng, sampleRate);
  }
}
