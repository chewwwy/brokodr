'worklet';
/**
 * Bro.Kodr — effect module contract.
 *
 * Every effect implements exactly this interface. The chain runner knows nothing
 * about individual effects, which is what makes the rack reorderable and the DSP
 * portable: a native/WASM backend only has to honour the same four methods.
 *
 *   constructor(sampleRate, maxBlock)
 *   setParam(id: string, value: number): void   — called off the param queue, pre-block
 *   process(L: Float32Array, R: Float32Array, frames: number): void  — in place, wet only
 *   reset(): void                               — flush state (device change / preset load)
 *
 * Optional:
 *   meter: number   — module-specific readout (e.g. gain reduction in dB), polled per block
 *   visual: Float32Array — module-specific display data (e.g. EQ curve), polled on demand
 *
 * Dry/wet mixing and bypass are handled generically by the chain runner, so effects
 * always render 100% wet and never need to know their mix setting.
 */
export class Effect {
  constructor(sampleRate, maxBlock) {
    this.sr = sampleRate;
    this.maxBlock = maxBlock;
    this.meter = 0;
  }

  setParam(_id, _value) {}

  process(_L, _R, _frames) {}

  reset() {}
}
