// Hand-written types for rack.js (the DSP is plain JS, shared verbatim with the
// web build). TS resolves "./dsp/rack" here; Metro resolves it to rack.js.

export interface SpikeRack {
  eq: unknown;
  comp: unknown;
  pitch: unknown;
  /** stages bitmask: 1 = EQ, 2 = COMP, 4 = PITCH, 0 = passthrough */
  process(L: Float32Array, R: Float32Array, frames: number, stages: number): void;
  reset(): void;
}

export function createRack(sampleRate: number, maxBlock: number): SpikeRack;
