// Bro.Kodr — interleaved device PCM <-> the engine's de-interleaved float.
//
// PHASE 5b. Portable on purpose: WASAPI hands the driver an interleaved buffer in
// whatever format the endpoint accepted (shared mode: float32; exclusive mode: usually
// int24-in-int32 or packed int24 on a USB interface like the UMC1820), and this is the
// only code that knows the byte layouts. Keeping it out of the Windows TU is what lets
// tests/test-pcm.cc check it on Linux, where the driver itself cannot run.
//
// Real-time safe: no allocation, no branches on anything but the format, no libm.
//
// Conventions, stated because each one is a classic source of a 1-LSB or a full-scale bug:
//   - int -> float divides by 2^(bits-1): int16 -32768 is exactly -1.0, +32767 is
//     32767/32768. Symmetric with the float -> int direction below.
//   - float -> int scales by 2^(bits-1), rounds to nearest (ties away from zero, via
//     lrint-free arithmetic so the result does not depend on the FP rounding mode), and
//     clamps to [-2^(bits-1), 2^(bits-1)-1]. +1.0 therefore clips to max, not wraps.
//     NaN becomes 0: the engine sanitizes, but a device buffer must never carry garbage.
//   - Int32Valid24 is 24 valid bits left-justified in a 32-bit container (the WASAPI
//     "24 in 32" format, wValidBitsPerSample = 24): full 32-bit scale on read, and the
//     low 8 bits written as zero.
//   - Packed Int24 is three little-endian bytes per sample, sign-extended on read.

#ifndef BROKODR_PCM_H
#define BROKODR_PCM_H

#include <cstdint>
#include <cstring>

namespace brokodr {

enum class PcmFormat : uint8_t { Float32 = 0, Int16 = 1, Int24 = 2, Int32 = 3, Int32Valid24 = 4 };

inline uint32_t pcmBytes(PcmFormat f) {
  switch (f) {
    case PcmFormat::Int16:
      return 2;
    case PcmFormat::Int24:
      return 3;
    default:
      return 4;
  }
}

inline const char* pcmName(PcmFormat f) {
  switch (f) {
    case PcmFormat::Float32:
      return "float32";
    case PcmFormat::Int16:
      return "int16";
    case PcmFormat::Int24:
      return "int24 packed";
    case PcmFormat::Int32:
      return "int32";
    case PcmFormat::Int32Valid24:
      return "int24 in int32";
  }
  return "unknown";
}

namespace pcm_detail {

// Round half away from zero and clamp, for a value already scaled to integer range.
// Written without lrint/round so the result is independent of the FP environment.
inline int64_t quantize(double v, int64_t lo, int64_t hi) {
  if (!(v == v)) return 0;  // NaN
  if (v >= static_cast<double>(hi)) return hi;
  if (v <= static_cast<double>(lo)) return lo;
  const double r = v < 0.0 ? v - 0.5 : v + 0.5;
  int64_t q = static_cast<int64_t>(r);  // truncation toward zero after the half offset
  if (q > hi) q = hi;
  if (q < lo) q = lo;
  return q;
}

inline float readOne(const uint8_t* p, PcmFormat f) {
  switch (f) {
    case PcmFormat::Float32: {
      float x;
      std::memcpy(&x, p, 4);
      return x;
    }
    case PcmFormat::Int16: {
      const int16_t v = static_cast<int16_t>(static_cast<uint16_t>(p[0] | (p[1] << 8)));
      return static_cast<float>(static_cast<double>(v) / 32768.0);
    }
    case PcmFormat::Int24: {
      int32_t v = static_cast<int32_t>(static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) |
                                       (static_cast<uint32_t>(p[2]) << 16));
      if (v & 0x800000) v -= 0x1000000;
      return static_cast<float>(static_cast<double>(v) / 8388608.0);
    }
    case PcmFormat::Int32:
    case PcmFormat::Int32Valid24: {
      int32_t v;
      std::memcpy(&v, p, 4);
      return static_cast<float>(static_cast<double>(v) / 2147483648.0);
    }
  }
  return 0.0f;
}

inline void writeOne(uint8_t* p, PcmFormat f, float x) {
  switch (f) {
    case PcmFormat::Float32: {
      const float y = (x == x) ? x : 0.0f;
      std::memcpy(p, &y, 4);
      return;
    }
    case PcmFormat::Int16: {
      const int64_t q = quantize(static_cast<double>(x) * 32768.0, -32768, 32767);
      const uint16_t u = static_cast<uint16_t>(static_cast<int16_t>(q));
      p[0] = static_cast<uint8_t>(u & 0xff);
      p[1] = static_cast<uint8_t>(u >> 8);
      return;
    }
    case PcmFormat::Int24: {
      const int64_t q = quantize(static_cast<double>(x) * 8388608.0, -8388608, 8388607);
      const uint32_t u = static_cast<uint32_t>(static_cast<int32_t>(q));
      p[0] = static_cast<uint8_t>(u & 0xff);
      p[1] = static_cast<uint8_t>((u >> 8) & 0xff);
      p[2] = static_cast<uint8_t>((u >> 16) & 0xff);
      return;
    }
    case PcmFormat::Int32: {
      const int32_t v = static_cast<int32_t>(quantize(static_cast<double>(x) * 2147483648.0, INT32_MIN, INT32_MAX));
      std::memcpy(p, &v, 4);
      return;
    }
    case PcmFormat::Int32Valid24: {
      const int64_t q = quantize(static_cast<double>(x) * 8388608.0, -8388608, 8388607);
      const int32_t v = static_cast<int32_t>(static_cast<uint32_t>(static_cast<int32_t>(q)) << 8);
      std::memcpy(p, &v, 4);
      return;
    }
  }
}

}  // namespace pcm_detail

/**
 * Read `frames` frames of an interleaved `channels`-wide device buffer into two engine
 * channels. `chL` / `chR` pick the device channels (the UMC1820 mic on input 2 is
 * chL = chR = 1 for a mono-to-both feed). A channel index >= `channels` reads silence.
 * `src == nullptr` (WASAPI's AUDCLNT_BUFFERFLAGS_SILENT) reads silence.
 */
inline void pcmToFloat(const void* src, PcmFormat f, uint32_t channels, uint32_t chL, uint32_t chR, float* outL,
                       float* outR, uint32_t frames) {
  const uint32_t bps = pcmBytes(f);
  const uint32_t stride = bps * channels;
  const uint8_t* b = static_cast<const uint8_t*>(src);
  for (uint32_t i = 0; i < frames; i++) {
    outL[i] = (b && chL < channels) ? pcm_detail::readOne(b + i * stride + chL * bps, f) : 0.0f;
    outR[i] = (b && chR < channels) ? pcm_detail::readOne(b + i * stride + chR * bps, f) : 0.0f;
  }
}

/**
 * Write two engine channels into an interleaved `channels`-wide device buffer. Device
 * channel 0 gets L, 1 gets R, any further channels get silence (a 4-channel endpoint
 * plays the engine on its first pair rather than garbage on the rest). A mono endpoint
 * gets L only.
 */
inline void floatToPcm(const float* inL, const float* inR, void* dst, PcmFormat f, uint32_t channels,
                       uint32_t frames) {
  const uint32_t bps = pcmBytes(f);
  const uint32_t stride = bps * channels;
  uint8_t* b = static_cast<uint8_t*>(dst);
  for (uint32_t i = 0; i < frames; i++) {
    uint8_t* fr = b + i * stride;
    for (uint32_t c = 0; c < channels; c++) {
      const float x = c == 0 ? inL[i] : c == 1 ? inR[i] : 0.0f;
      pcm_detail::writeOne(fr + c * bps, f, x);
    }
  }
}

}  // namespace brokodr

#endif  // BROKODR_PCM_H
