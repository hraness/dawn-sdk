// SPDX-License-Identifier: MIT
import { Brown, Drift, Pink, Rng, Svf } from "./dsp.ts";
import type { Controls, Source } from "./sources.ts";

const TAU = Math.PI * 2;

export class Water implements Source {
  private readonly pink = [new Pink(), new Pink()] as const;
  private readonly rumble: Brown;
  private readonly foam = [new Svf(), new Svf()] as const;
  private readonly sand = [new Svf(), new Svf()] as const;
  private readonly bubble = new Svf();
  private readonly farBubble = new Svf();
  private readonly flow: Drift;
  private nextFarBubble = 0;
  private farPan = 0.65;
  private age = 1.8;
  private period = 8;
  private height = 0.7;
  private count = 0;
  private group = 0.9;
  private shoreDelay = 0.05;
  private nextBubble = 0;

  constructor(
    private readonly kind: "ocean" | "stream" | "waterfall",
    private readonly random: Rng,
    private readonly rate: number,
  ) {
    this.rumble = new Brown(rate);
    this.flow = new Drift(random);
    if (kind === "ocean") {
      this.age = random.range(1.2, 3.9);
      this.height = random.range(0.5, 0.9);
      this.shoreDelay = random.range(-0.087, 0.087);
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
    const flow = ocean
      ? 0.5
      : this.flow.step(n / this.rate, stream ? 1.7 : 3.4);
    const arrival = Math.min(1, this.age / this.period);
    const crest = Math.exp(-28 * (arrival - 0.36) ** 2);
    const center =
      (ocean
        ? 550 + this.height * (420 + 1160 * crest)
        : stream
          ? 1460 + 820 * flow
          : 740 + 520 * flow) * controls.sweep;
    this.foam[0].set(center, 0.65, this.rate);
    this.foam[1].set(center * 1.12, 0.72, this.rate);
    if (ocean) {
      this.sand[0].set((420 + 360 * arrival) * controls.sweep, 1.15, this.rate);
      this.sand[1].set((490 + 380 * arrival) * controls.sweep, 1.05, this.rate);
    }
    if (this.kind === "waterfall") {
      this.sand[0].set((1720 + 690 * flow) * controls.sweep, 0.73, this.rate);
      this.sand[1].set((2450 - 430 * flow) * controls.sweep, 0.81, this.rate);
    }
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
        this.shoreDelay = this.random.range(-0.087, 0.087);
      }
      const phase = this.age / this.period;
      const swell = Math.sin(Math.PI * Math.min(1, phase)) ** 2;
      const collapse =
        phase < 0.36 ? (phase / 0.36) ** 3 : Math.exp(-5 * (phase - 0.36));
      const bed = ocean
        ? 0.12 + 0.69 * this.height * swell
        : stream
          ? 0.4 + 0.2 * flow
          : 0.72 + 0.23 * flow;
      const low =
        this.rumble.process(this.random.noise()) *
        (ocean
          ? (0.28 + swell) * this.height
          : stream
            ? 0.11
            : 0.62 + 0.36 * flow);
      let impulse = 0;
      if ((stream || ocean) && --this.nextBubble <= 0) {
        const events = stream
          ? (11 + 27 * controls.density) * (0.76 + flow * 0.48)
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
      let far = 0;
      if (stream) {
        // A second cluster behind the stones has its own size, timing and position.
        let hit = 0;
        if (--this.nextFarBubble <= 0) {
          this.nextFarBubble =
            this.random.wait(5 + 14 * controls.density) * this.rate;
          this.farBubble.set(
            this.random.range(710, 1880) * controls.sweep,
            13,
            this.rate,
          );
          this.farPan = this.random.range(0.54, 0.91);
          hit = this.random.bi() * (2.2 + 1.7 * controls.wear);
        }
        far = this.farBubble.process(hit);
      }
      const foamLevel = ocean
        ? 0.27 + collapse * this.height
        : stream
          ? 0.86
          : 0.62;
      for (let channel = 0; channel < 2; channel++) {
        const output = channels[channel]!;
        const pink = this.pink[channel]!.process(this.random.noise());
        let wash = foamLevel,
          backwash = 0;
        if (ocean) {
          const breakAt = 0.36 + (channel ? this.shoreDelay : 0);
          const shore =
            phase < breakAt
              ? (phase / breakAt) ** 3
              : Math.exp(-5 * (phase - breakAt));
          const retreat =
            Math.sin(
              Math.PI *
                Math.min(1, Math.max(0, (phase - breakAt - 0.09) / 0.49)),
            ) ** 2;
          wash = 0.18 + shore * this.height;
          backwash =
            this.sand[channel]!.process(pink) *
            retreat *
            (0.35 + controls.wear) *
            this.height;
        } else if (!stream) {
          // The fine spray and the heavier plunge change independently.
          backwash = this.sand[channel]!.process(pink) * (0.37 + flow * 0.42);
        }
        output[i] =
          pink * bed +
          this.foam[channel]!.process(pink) * wash +
          backwash +
          low +
          bubbles * (channel ? (stream ? 0.37 : 0.67) : 1) +
          far * (channel ? this.farPan : 1 - this.farPan);
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
  private lastBirdPitch = 0;
  private birdAnswer = false;
  private distantPhase = 0;
  private distantClock = 0;
  private readonly distantPitch: number;
  private readonly distantPeriod: number;

  constructor(
    private readonly kind: "birds" | "crickets",
    private readonly random: Rng,
    private readonly rate: number,
  ) {
    this.distantPitch = kind === "crickets" ? random.range(2870, 3590) : 0;
    this.distantPeriod = kind === "crickets" ? random.range(0.74, 1.13) : 1;
    if (kind === "crickets")
      this.distantClock = random.range(0, this.distantPeriod);
  }

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
        if (birds) {
          // An answering phrase stays near the first singer's register.
          this.birdAnswer = !this.birdAnswer;
          if (!this.birdAnswer && this.lastBirdPitch)
            this.pitch = this.lastBirdPitch * this.random.range(0.87, 1.16);
          this.lastBirdPitch = this.pitch;
        }
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
        const syllable = Math.floor(position * this.accents);
        const within = (position * this.accents) % 1;
        const sung = birds
          ? Math.min(1, within / (syllable % 2 ? 0.86 : 0.73))
          : within;
        const pulse = Math.sin(Math.PI * sung) ** (birds ? 1.65 : 7);
        const bend = birds
          ? (syllable % 2 ? -1 : 1) * Math.sin(Math.PI * (sung - 0.18)) +
            (this.birdAnswer ? -0.18 : 0.19) * syllable
          : within - 0.5;
        const hz = Math.min(
          this.rate * 0.42,
          (this.pitch + bend * this.sweep) * controls.sweep,
        );
        this.phase = (this.phase + hz / this.rate) % 1;
        const carrier = Math.sin(TAU * this.phase);
        const harmonics = birds
          ? 2 * hz < 0.45 * this.rate
            ? Math.sin(TAU * 2 * this.phase) *
              (0.08 + 0.15 * controls.wear) *
              (1 - sung)
            : 0
          : this.random.noise() * (0.04 + controls.wear * 0.13);
        call =
          (carrier + harmonics) * pulse * Math.sin(Math.PI * position) * 0.55;
      }
      this.age += 1 / this.rate;
      const background =
        this.bed.process(this.random.noise()) * (birds ? 0.15 : 0.08);
      let distant = 0;
      if (!birds) {
        this.distantClock += (0.78 + controls.density * 0.43) / this.rate;
        if (this.distantClock >= this.distantPeriod)
          this.distantClock -= this.distantPeriod;
        const phrase = this.distantClock / this.distantPeriod;
        if (phrase < 0.38) {
          const pulse = Math.sin((Math.PI * phrase * 12) / 0.38) ** 6;
          this.distantPhase =
            (this.distantPhase +
              Math.min(
                0.43,
                (this.distantPitch * controls.sweep) / this.rate,
              )) %
            1;
          distant =
            Math.sin(TAU * this.distantPhase) *
            Math.sin((Math.PI * phrase) / 0.38) *
            pulse *
            0.16;
        }
      }
      left[i] = background + call * (1 - this.pan) + distant * 0.6;
      right[i] = background + call * (1 + this.pan) + distant;
    }
  }
}

export class CountryRoad implements Source {
  private readonly earth: Brown;
  private readonly air = new Pink();
  private readonly gravel = new Svf();
  private readonly tires = [new Svf(), new Svf()] as const;
  private age = 0;
  private duration = 3.8;
  private gap = 6;
  private heading = 1;
  private motor = 0;
  private motorHz: number;

  constructor(
    private readonly random: Rng,
    private readonly rate: number,
  ) {
    this.earth = new Brown(rate);
    this.motorHz = random.range(55, 76);
  }

  render(
    left: Float64Array,
    right: Float64Array,
    n: number,
    controls: Controls,
  ) {
    this.gravel.set(720 * controls.sweep, 0.8, this.rate);
    const near = Math.sin(Math.PI * Math.min(1, this.age / this.duration));
    this.tires[0].set((380 + 920 * near) * controls.sweep, 0.8, this.rate);
    this.tires[1].set((510 + 1020 * near) * controls.sweep, 0.75, this.rate);
    for (let i = 0; i < n; i++) {
      this.age += 1 / this.rate;
      if (this.age >= this.duration + this.gap) {
        this.age = 0;
        this.duration = this.random.range(3.2, 6.2);
        this.gap = (12 - 10 * controls.density) * this.random.range(0.45, 1.4);
        this.heading = this.random.next() < 0.5 ? -1 : 1;
        this.motorHz = this.random.range(51, 83);
      }
      const position = Math.min(1, this.age / this.duration);
      const proximity = Math.sin(Math.PI * position) ** 3;
      const pan = (position * 2 - 1) * this.heading * 0.65;
      const offset = 2 * position - 1;
      const doppler = 1 - (0.12 * offset) / Math.sqrt(offset * offset + 0.06);
      this.motor = (this.motor + (this.motorHz * doppler) / this.rate) % 1;
      const wind = this.air.process(this.random.noise());
      const dust = this.gravel.process(this.random.noise());
      const car =
        (this.earth.process(this.random.noise()) * 0.62 +
          (Math.sin(TAU * this.motor) + 0.38 * Math.sin(2 * TAU * this.motor)) *
            0.145 +
          dust * (0.15 + controls.wear * 0.42)) *
        proximity;
      const tread = proximity * (0.19 + controls.wear * 0.23);
      left[i] =
        wind * 0.12 +
        (car + tread * this.tires[0].process(this.random.noise())) * (1 - pan);
      right[i] =
        wind * 0.12 +
        (car + tread * this.tires[1].process(this.random.noise())) * (1 + pan);
    }
  }
}
