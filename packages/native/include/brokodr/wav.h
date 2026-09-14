// Bro.Kodr — minimal WAV reader/writer for the offline ("null/file") device driver.
//
// PHASE 5a. This is what makes the native host testable without Windows and without an
// audio interface: a device backend that pulls its input from a WAV file and writes its
// output to one, driven at a fixed block size by a plain loop instead of by a driver
// callback. Run the same signal through the JS engine and this, diff the results, and a
// bad port is caught before it is ever heard.
//
// Deliberately small. It handles exactly what the harness needs — 16-bit PCM and 32-bit
// float, mono or stereo, little-endian — and refuses everything else loudly rather than
// guessing. It is NOT a general WAV library and must never grow into one; a parser that
// accepts sloppy files is a parser that hides a broken test fixture.

#ifndef BROKODR_WAV_H
#define BROKODR_WAV_H

#include <cstdint>
#include <string>
#include <vector>

namespace brokodr {

/** De-interleaved float audio, which is what the engine works in. */
struct AudioBuffer {
  std::vector<float> left;
  std::vector<float> right;
  uint32_t sampleRate = 48000;

  size_t frames() const { return left.size(); }
  bool stereo() const { return !right.empty(); }

  void resize(size_t n, bool withRight = true) {
    left.assign(n, 0.0f);
    if (withRight) right.assign(n, 0.0f);
    else right.clear();
  }
};

/**
 * Read a WAV file. Returns false and fills `error` rather than throwing — this runs in
 * test harnesses and a future addon, and neither wants exceptions crossing the boundary.
 *
 * A mono file is expanded to both channels, because the engine is stereo throughout and
 * a harness feeding it mono should be testing the engine, not the loader.
 */
bool readWav(const std::string& path, AudioBuffer& out, std::string& error);

/** Write 32-bit float WAV. Float, not 16-bit: parity tests compare exact samples, and
 *  quantising to int16 would mask precisely the small divergences worth catching. */
bool writeWav(const std::string& path, const AudioBuffer& in, std::string& error);

}  // namespace brokodr

#endif  // BROKODR_WAV_H
