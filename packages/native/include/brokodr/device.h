// Bro.Kodr — the device-driver seam.
//
// PHASE 5a. Everything platform-specific in Phase 5 lives behind this one interface, so
// the engine, the ring, the meters and the parity harness never learn what a WASAPI
// client is. Three implementations are planned and the seam is sized for all three from
// the start, because retrofitting a third driver later is how abstractions end up leaking
// Windows types into portable code:
//
//   OfflineDriver  — WAV in, WAV out, driven by a loop. Built and tested here. (5a)
//   WasapiDriver   — shared and exclusive mode. Cross-compiled here, verified on the
//                    user's machine. Shared is the default; exclusive is opt-in and must
//                    FALL BACK to shared with a stated reason rather than fail to open.
//   AsioDriver     — deferred. Needs the licence-gated Steinberg SDK, so it is a separate
//                    opt-in build target that cannot live in this repo.
//
// The callback contract is the strict part, and it is strict because it is the whole point
// of the phase. Inside `render`, an implementation may not: allocate, free, lock, log,
// touch a file or socket, throw, or call anything that might. Breaking any of those turns
// a 5 ms buffer into a dropout, and a dropout is worse than the latency we came to fix.

#ifndef BROKODR_DEVICE_H
#define BROKODR_DEVICE_H

#include <cstdint>
#include <string>
#include <vector>

namespace brokodr {

enum class DriverKind { Offline = 0, WasapiShared = 1, WasapiExclusive = 2, Asio = 3 };

const char* driverName(DriverKind k);

struct DeviceInfo {
  std::string id;
  std::string name;
  /**
   * Which stereo pair this device exposes, where the hardware presents several. The
   * UMC1820's Windows driver splits eighteen mono, hard-panned inputs into four stereo
   * pair devices ("Line 1&2", "Line 3&4", …), and Chromium reports them under names that
   * do not say so. Carrying it here is what lets the UI stop lying about a silent channel.
   */
  std::string pairLabel;
  uint32_t inputChannels = 0;
  uint32_t outputChannels = 0;
  uint32_t defaultSampleRate = 48000;
  bool isDefault = false;
};

struct StreamConfig {
  uint32_t sampleRate = 48000;
  /** Frames per callback. The whole latency argument is this number and the driver mode. */
  uint32_t blockFrames = 128;
  DriverKind kind = DriverKind::Offline;
  /** Ask for exclusive mode. Advisory: the driver may report back that it fell back. */
  bool wantExclusive = false;
};

/** What the device layer actually achieved, as opposed to what was requested. */
struct StreamStatus {
  bool open = false;
  DriverKind kind = DriverKind::Offline;
  uint32_t sampleRate = 0;
  uint32_t blockFrames = 0;
  /** Measured, not computed from the block size — the UI shows this number verbatim. */
  double roundTripMs = 0.0;
  /** Set when exclusive was requested and refused, with the reason, e.g. another client. */
  bool exclusiveDenied = false;
  std::string note;
  /** Callbacks that overran their budget. Non-zero means the user heard something. */
  uint64_t underruns = 0;
};

/**
 * The audio callback. De-interleaved, engine-native layout.
 *
 * `in` and `out` are arrays of `channels` pointers to `frames` floats. Separate in/out
 * pointers rather than in-place, because the engine's dry/wet mix reads the input after
 * writing part of the output.
 */
class RenderSink {
 public:
  virtual ~RenderSink() = default;
  virtual void render(const float* const* in, uint32_t inChannels, float* const* out, uint32_t outChannels,
                      uint32_t frames) = 0;
};

class Device {
 public:
  virtual ~Device() = default;
  virtual std::vector<DeviceInfo> enumerate() = 0;
  virtual bool open(const StreamConfig& cfg, RenderSink* sink, std::string& error) = 0;
  virtual void close() = 0;
  virtual StreamStatus status() const = 0;
};

/**
 * The offline driver: reads `inputPath`, renders through the sink in `blockFrames` blocks,
 * writes `outputPath`. `open()` runs the whole file to completion synchronously — there is
 * no thread and no real time, which is exactly what makes a parity diff deterministic.
 *
 * Pass an empty `inputPath` to render silence for `silentFrames` instead, which is how
 * tail behaviour (reverb decay, loop playback, a click track with no input) gets tested.
 */
Device* makeOfflineDriver(const std::string& inputPath, const std::string& outputPath, uint32_t silentFrames = 0);

}  // namespace brokodr

#endif  // BROKODR_DEVICE_H
