// SPDX-License-Identifier: MIT
import { Brown, Pink, Rng, Svf } from "./dsp.ts";
import type { Controls, Source } from "./sources.ts";

const TAU = Math.PI * 2;

export class Water implements Source {
  private readonly pink = [new Pink(), new Pink()] as const;
  private readonly rumble: Brown;
  private readonly foam = [new Svf(), new Svf()] as const;
  private readonly bubble = new Svf();
  private age = 1.8;
  private period = 8;
  private height = 0.7;
  private count = 0;
  private group = 0.9;
  private nextBubble = 0;

  constructor(
    private readonly kind: "ocean" | "stream" | "waterfall",
    private readonly random: Rng,
    private readonly rate: number,
  ) {
    this.rumble = new Brown(rate);
    if (kind === "ocean") {
      this.age = random.range(1.2, 3.9);
      this.height = random.range(0.5, 0.9);
    }
  }

  render(
    left: Float64Array,
    right: Float64Array,
    n: number,
    controls: Controls,
  ) {
    const ocean = this.kind === "ocean";
    const stream = this.kind === "stream";
    const center =
      (ocean ? 760 + this.height * 700 : stream ? 2100 : 950) * controls.sweep;
    this.foam[0].set(center, 0.65, this.rate);
    this.foam[1].set(center * 1.12, 0.72, this.rate);
    const channels = [left, right] as const;
    for (let i = 0; i < n; i++) {
      this.age += 1 / this.rate;
      if (ocean && this.age >= this.period) {
        this.age -= this.period;
        if (this.count++ % 6 === 0) this.group = this.random.range(0.7, 1.15);
        const rayleigh = Math.sqrt(-2 * Math.log(1 - this.random.next()));
        this.height =
          0.52 * this.height + 0.48 * Math.min(1.5, rayleigh * this.group);
        this.period =
          (15 - 9.8 * controls.density) * this.random.range(0.85, 1.17);
      }
      const phase = this.age / this.period;
      const swell = Math.sin(Math.PI * Math.min(1, phase)) ** 2;
      const collapse =
        phase < 0.36 ? (phase / 0.36) ** 3 : Math.exp(-5 * (phase - 0.36));
      const bed = ocean
        ? 0.12 + 0.69 * this.height * swell
        : stream
          ? 0.56
          : 0.94;
      const low =
        this.rumble.process(this.random.noise()) *
        (ocean ? (0.28 + swell) * this.height : stream ? 0.11 : 0.76);
      let impulse = 0;
      if ((stream || ocean) && --this.nextBubble <= 0) {
        const events = stream
          ? 14 + 34 * controls.density
          : 5 + 34 * collapse * this.height;
        this.nextBubble = this.random.wait(events) * this.rate;
        this.bubble.set(
          this.random.range(520, 2700) * controls.sweep,
          stream ? 16 : 5,
          this.rate,
        );
        impulse = this.random.bi() * (stream ? 4.2 : 2.6 * collapse);
      }
      const bubbles = this.bubble.process(impulse) * (0.5 + controls.wear);
      const foamLevel = ocean
        ? 0.27 + collapse * this.height
        : stream
          ? 0.86
          : 0.62;
      for (let channel = 0; channel < 2; channel++) {
        const output = channels[channel]!;
        const pink = this.pink[channel]!.process(this.random.noise());
        output[i] =
          pink * bed +
          this.foam[channel]!.process(pink) * foamLevel +
          low +
          bubbles * (channel ? 0.67 : 1);
      }
    }
  }
}

export class FieldCalls implements Source {
  private readonly bed = new Pink();
  private age = 0;
  private next = 0;
  private phase = 0;
  private pitch = 1800;
  private sweep = 0;
  private pan = 0;
  private accents = 3;
  private length = 0.38;

  constructor(
    private readonly kind: "birds" | "crickets",
    private readonly random: Rng,
    private readonly rate: number,
  ) {}

  render(
    left: Float64Array,
    right: Float64Array,
    n: number,
    controls: Controls,
  ) {
    const birds = this.kind === "birds";
    for (let i = 0; i < n; i++) {
      if (--this.next <= 0) {
        this.age = 0;
        this.pan = this.random.bi() * 0.52;
        this.pitch = birds
          ? this.random.range(1150, 2750)
          : this.random.range(3150, 4880);
        this.sweep = this.random.bi() * (birds ? 1050 : 140);
        this.accents = Math.floor(this.random.range(2, birds ? 5 : 7));
        this.length = birds
          ? this.random.range(0.37, 0.83)
          : this.accents * 0.064;
        this.next =
          this.rate *
          (this.length +
            this.random.range(0.09, birds ? 1.25 : 0.8) /
              (0.46 + controls.density));
      }
      const position = this.age / this.length;
      let call = 0;
      if (position < 1) {
        const within = (position * this.accents) % 1;
        const pulse = Math.sin(Math.PI * within) ** (birds ? 2.2 : 7);
        const bend = birds ? Math.sin(TAU * within * 0.82) : within - 0.5;
        const hz = Math.min(
          this.rate * 0.42,
          (this.pitch + bend * this.sweep) * controls.sweep,
        );
        this.phase = (this.phase + hz / this.rate) % 1;
        const carrier = Math.sin(TAU * this.phase);
        const harmonics = birds
          ? Math.sin(TAU * 2 * this.phase) * 0.19 * controls.wear
          : this.random.noise() * (0.04 + controls.wear * 0.13);
        call =
          (carrier + harmonics) * pulse * Math.sin(Math.PI * position) * 0.55;
      }
      this.age += 1 / this.rate;
      const background =
        this.bed.process(this.random.noise()) * (birds ? 0.15 : 0.08);
      left[i] = background + call * (1 - this.pan);
      right[i] = background + call * (1 + this.pan);
    }
  }
}

export class CountryRoad implements Source {
  private readonly earth: Brown;
  private readonly air = new Pink();
  private readonly gravel = new Svf();
  private age = 0;
  private duration = 3.8;
  private gap = 6;
  private heading = 1;
  private motor = 0;

  constructor(
    private readonly random: Rng,
    private readonly rate: number,
  ) {
    this.earth = new Brown(rate);
  }

  render(
    left: Float64Array,
    right: Float64Array,
    n: number,
    controls: Controls,
  ) {
    this.gravel.set(720 * controls.sweep, 0.8, this.rate);
    for (let i = 0; i < n; i++) {
      this.age += 1 / this.rate;
      if (this.age >= this.duration + this.gap) {
        this.age = 0;
        this.duration = this.random.range(3.2, 6.2);
        this.gap = (12 - 10 * controls.density) * this.random.range(0.45, 1.4);
        this.heading = this.random.next() < 0.5 ? -1 : 1;
      }
      const position = Math.min(1, this.age / this.duration);
      const proximity = Math.sin(Math.PI * position) ** 3;
      const pan = (position * 2 - 1) * this.heading * 0.65;
      this.motor = (this.motor + (81 - 28 * position) / this.rate) % 1;
      const wind = this.air.process(this.random.noise());
      const dust = this.gravel.process(this.random.noise());
      const car =
        (this.earth.process(this.random.noise()) * 0.62 +
          Math.sin(TAU * this.motor) * 0.17 +
          dust * (0.15 + controls.wear * 0.42)) *
        proximity;
      left[i] = wind * 0.12 + car * (1 - pan);
      right[i] = wind * 0.12 + car * (1 + pan);
    }
  }
}
