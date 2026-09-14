#include "brokodr/wav.h"

#include <cstdio>
#include <cstring>

namespace brokodr {
namespace {

// WAV is little-endian regardless of host. Read byte-wise rather than memcpy-ing a struct
// so this stays correct on a big-endian target and needs no packing pragmas.
uint32_t rd32(const unsigned char* p) {
  return static_cast<uint32_t>(p[0]) | (static_cast<uint32_t>(p[1]) << 8) | (static_cast<uint32_t>(p[2]) << 16) |
         (static_cast<uint32_t>(p[3]) << 24);
}
uint16_t rd16(const unsigned char* p) {
  return static_cast<uint16_t>(static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8));
}
void wr32(unsigned char* p, uint32_t v) {
  p[0] = static_cast<unsigned char>(v & 0xff);
  p[1] = static_cast<unsigned char>((v >> 8) & 0xff);
  p[2] = static_cast<unsigned char>((v >> 16) & 0xff);
  p[3] = static_cast<unsigned char>((v >> 24) & 0xff);
}
void wr16(unsigned char* p, uint16_t v) {
  p[0] = static_cast<unsigned char>(v & 0xff);
  p[1] = static_cast<unsigned char>((v >> 8) & 0xff);
}

}  // namespace

bool readWav(const std::string& path, AudioBuffer& out, std::string& error) {
  FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) {
    error = "cannot open " + path;
    return false;
  }
  std::vector<unsigned char> buf;
  {
    std::fseek(f, 0, SEEK_END);
    const long size = std::ftell(f);
    std::fseek(f, 0, SEEK_SET);
    if (size <= 44) {
      std::fclose(f);
      error = "file too short to be a WAV";
      return false;
    }
    buf.resize(static_cast<size_t>(size));
    const size_t got = std::fread(buf.data(), 1, buf.size(), f);
    std::fclose(f);
    if (got != buf.size()) {
      error = "short read";
      return false;
    }
  }

  if (std::memcmp(buf.data(), "RIFF", 4) != 0 || std::memcmp(buf.data() + 8, "WAVE", 4) != 0) {
    error = "not a RIFF/WAVE file";
    return false;
  }

  // Walk the chunk list rather than assuming fmt-then-data at fixed offsets: real files
  // carry LIST/JUNK/fact chunks in between, and a fixed-offset reader silently reads
  // metadata as audio.
  uint16_t format = 0, channels = 0, bits = 0;
  uint32_t rate = 0;
  const unsigned char* data = nullptr;
  uint32_t dataBytes = 0;

  size_t pos = 12;
  while (pos + 8 <= buf.size()) {
    const char* id = reinterpret_cast<const char*>(buf.data() + pos);
    const uint32_t len = rd32(buf.data() + pos + 4);
    const size_t body = pos + 8;
    if (body + len > buf.size()) break;  // truncated chunk: stop, don't over-read
    if (std::memcmp(id, "fmt ", 4) == 0 && len >= 16) {
      format = rd16(buf.data() + body);
      channels = rd16(buf.data() + body + 2);
      rate = rd32(buf.data() + body + 4);
      bits = rd16(buf.data() + body + 14);
    } else if (std::memcmp(id, "data", 4) == 0) {
      data = buf.data() + body;
      dataBytes = len;
    }
    pos = body + len + (len & 1);  // chunks are word-aligned
  }

  if (!data) {
    error = "no data chunk";
    return false;
  }
  if (channels != 1 && channels != 2) {
    error = "only mono or stereo supported, got " + std::to_string(channels);
    return false;
  }
  // 0xFFFE is WAVE_FORMAT_EXTENSIBLE; the real format lives in the extension. The harness
  // never writes those, so reject rather than half-support it.
  const bool pcm16 = (format == 1 && bits == 16);
  const bool f32 = (format == 3 && bits == 32);
  if (!pcm16 && !f32) {
    error = "unsupported format=" + std::to_string(format) + " bits=" + std::to_string(bits);
    return false;
  }

  const uint32_t bytesPerSample = bits / 8;
  const size_t frames = dataBytes / (bytesPerSample * channels);
  out.sampleRate = rate ? rate : 48000;
  out.resize(frames, true);

  for (size_t i = 0; i < frames; i++) {
    for (uint32_t c = 0; c < channels; c++) {
      const unsigned char* p = data + (i * channels + c) * bytesPerSample;
      float v;
      if (pcm16) {
        const int16_t s = static_cast<int16_t>(rd16(p));
        // 32768 so full-scale negative maps to exactly -1.0 and nothing exceeds unity.
        v = static_cast<float>(s) / 32768.0f;
      } else {
        uint32_t bitsv = rd32(p);
        std::memcpy(&v, &bitsv, 4);
      }
      if (c == 0) out.left[i] = v;
      else out.right[i] = v;
    }
    if (channels == 1) out.right[i] = out.left[i];
  }
  return true;
}

bool writeWav(const std::string& path, const AudioBuffer& in, std::string& error) {
  const uint16_t channels = in.stereo() ? 2 : 1;
  const size_t frames = in.frames();
  const uint32_t dataBytes = static_cast<uint32_t>(frames * channels * 4);

  unsigned char header[44];
  std::memcpy(header, "RIFF", 4);
  wr32(header + 4, 36 + dataBytes);
  std::memcpy(header + 8, "WAVE", 4);
  std::memcpy(header + 12, "fmt ", 4);
  wr32(header + 16, 16);
  wr16(header + 20, 3);  // IEEE float
  wr16(header + 22, channels);
  wr32(header + 24, in.sampleRate);
  wr32(header + 28, in.sampleRate * channels * 4);  // byte rate
  wr16(header + 32, static_cast<uint16_t>(channels * 4));
  wr16(header + 34, 32);
  std::memcpy(header + 36, "data", 4);
  wr32(header + 40, dataBytes);

  FILE* f = std::fopen(path.c_str(), "wb");
  if (!f) {
    error = "cannot write " + path;
    return false;
  }
  std::fwrite(header, 1, sizeof(header), f);

  // Interleave in a small fixed buffer: a parity run can be minutes long and building one
  // giant vector first is needless peak memory.
  float chunk[512];
  size_t i = 0;
  while (i < frames) {
    size_t n = 0;
    while (i < frames && n + channels <= 512) {
      chunk[n++] = in.left[i];
      if (channels == 2) chunk[n++] = in.right[i];
      i++;
    }
    std::fwrite(chunk, 4, n, f);
  }
  std::fclose(f);
  return true;
}

}  // namespace brokodr
