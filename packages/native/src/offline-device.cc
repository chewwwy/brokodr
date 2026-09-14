// Bro.Kodr — the offline (WAV in / WAV out) device driver.
//
// PHASE 5a. This is the deliverable that makes the native engine testable in a Linux
// sandbox with no audio hardware: it presents the same `Device` interface WASAPI will,
// but its "clock" is a for-loop. Deterministic, so a parity diff against the JS engine is
// meaningful; and because it goes through the identical seam, a bug in block handling
// shows up here rather than on the user's machine.
//
// One deliberate asymmetry worth knowing: this driver runs the callback on the CALLING
// thread and blocks until the file is finished. The real drivers will call back from a
// driver-owned high-priority thread. That means this harness cannot catch thread-safety
// or priority bugs — only DSP and block-handling ones. Stated here so nobody mistakes a
// green offline run for proof the real-time path is sound.

#include <algorithm>
#include <string>
#include <vector>

#include "brokodr/device.h"
#include "brokodr/wav.h"

namespace brokodr {

const char* driverName(DriverKind k) {
  switch (k) {
    case DriverKind::Offline:
      return "offline";
    case DriverKind::WasapiShared:
      return "WASAPI shared";
    case DriverKind::WasapiExclusive:
      return "WASAPI exclusive";
    case DriverKind::Asio:
      return "ASIO";
  }
  return "unknown";
}

namespace {

class OfflineDevice final : public Device {
 public:
  OfflineDevice(std::string inPath, std::string outPath, uint32_t silentFrames)
      : inPath_(std::move(inPath)), outPath_(std::move(outPath)), silentFrames_(silentFrames) {}

  std::vector<DeviceInfo> enumerate() override {
    DeviceInfo d;
    d.id = "offline";
    d.name = inPath_.empty() ? "Offline (silence)" : "Offline (" + inPath_ + ")";
    d.pairLabel = "file";
    d.inputChannels = 2;
    d.outputChannels = 2;
    d.defaultSampleRate = 48000;
    d.isDefault = true;
    return {d};
  }

  bool open(const StreamConfig& cfg, RenderSink* sink, std::string& error) override {
    if (!sink) {
      error = "no render sink";
      return false;
    }
    if (cfg.blockFrames == 0) {
      error = "blockFrames must be > 0";
      return false;
    }

    AudioBuffer input;
    if (inPath_.empty()) {
      input.sampleRate = cfg.sampleRate;
      input.resize(silentFrames_, true);
    } else if (!readWav(inPath_, input, error)) {
      return false;
    }

    const size_t frames = input.frames();
    AudioBuffer output;
    output.sampleRate = input.sampleRate ? input.sampleRate : cfg.sampleRate;
    output.resize(frames, true);

    // Fixed scratch, allocated ONCE before the loop. The loop body must stay
    // allocation-free because it stands in for the real-time callback; if a test passes
    // here only because this driver was allowed to allocate, the test is worthless.
    std::vector<float> inL(cfg.blockFrames, 0.0f), inR(cfg.blockFrames, 0.0f);
    std::vector<float> outL(cfg.blockFrames, 0.0f), outR(cfg.blockFrames, 0.0f);
    const float* inPtrs[2] = {inL.data(), inR.data()};
    float* outPtrs[2] = {outL.data(), outR.data()};

    size_t pos = 0;
    while (pos < frames) {
      const uint32_t n = static_cast<uint32_t>(std::min<size_t>(cfg.blockFrames, frames - pos));
      // A short final block is a real driver behaviour, not a harness quirk, so it is
      // passed through as-is. The engine must tolerate n < blockFrames.
      std::copy(input.left.begin() + static_cast<long>(pos), input.left.begin() + static_cast<long>(pos + n),
                inL.begin());
      std::copy(input.right.begin() + static_cast<long>(pos), input.right.begin() + static_cast<long>(pos + n),
                inR.begin());
      // Zero the output scratch each block: a sink that writes nothing must produce
      // silence, not the previous block again. That failure mode is audible and obvious
      // on hardware but invisible in a file diff if the scratch is left dirty.
      std::fill(outL.begin(), outL.begin() + n, 0.0f);
      std::fill(outR.begin(), outR.begin() + n, 0.0f);

      sink->render(inPtrs, 2, outPtrs, 2, n);

      std::copy(outL.begin(), outL.begin() + n, output.left.begin() + static_cast<long>(pos));
      std::copy(outR.begin(), outR.begin() + n, output.right.begin() + static_cast<long>(pos));
      pos += n;
      blocks_++;
    }

    if (!outPath_.empty() && !writeWav(outPath_, output, error)) return false;

    status_.open = false;  // the run is already finished; nothing is streaming
    status_.kind = DriverKind::Offline;
    status_.sampleRate = output.sampleRate;
    status_.blockFrames = cfg.blockFrames;
    status_.roundTripMs = 0.0;  // honest: there is no device, so there is no latency
    status_.note = "offline run: " + std::to_string(blocks_) + " blocks, " + std::to_string(frames) + " frames";
    return true;
  }

  void close() override { status_.open = false; }
  StreamStatus status() const override { return status_; }

 private:
  std::string inPath_;
  std::string outPath_;
  uint32_t silentFrames_;
  uint64_t blocks_ = 0;
  StreamStatus status_{};
};

}  // namespace

Device* makeOfflineDriver(const std::string& inputPath, const std::string& outputPath, uint32_t silentFrames) {
  return new OfflineDevice(inputPath, outputPath, silentFrames);
}

}  // namespace brokodr
