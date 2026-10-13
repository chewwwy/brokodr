// Bro.Kodr — the WASAPI device driver (shared and exclusive, event-driven).
//
// PHASE 5b. Cross-compiled in the Linux sandbox with mingw-w64 and smoke-run under Wine
// against PulseAudio null sinks. The shared-mode event path therefore runs end to end
// there, against a clock. Exclusive mode, real USB timing and the UMC1820 specifically are
// verified only on the user's machine, with tools/brokodr-probe.cc. Read every claim
// below with that in mind.
//
// Shape:
//   - All COM lives on the driver's own thread (MTA). open() starts that thread, waits for
//     it to report whether both endpoints initialised, and returns that. enumerate() does
//     the same on a short-lived thread. The caller's apartment never matters.
//   - Capture and render are two IAudioClients on the same mode and roughly the same
//     period. The thread waits on the RENDER event only. On each wake it drains every
//     capture packet into the DuplexPump, then fills whatever the render buffer can take
//     through the engine (duplex.h has the FIFO policy).
//   - Exclusive is opt-in. If either endpoint refuses exclusive, both fall back to shared
//     and the reason goes into StreamStatus.note with exclusiveDenied set. The device
//     panel shows that rather than failing to open (plan decision, 2026-09).
//   - Shared mode uses IAudioClient3 low-latency periods when the requested rate is the
//     engine's mix rate (Windows 10+). Otherwise it uses classic shared mode, with
//     AUTOCONVERTPCM when the rates differ.
//   - The render loop does not allocate, lock, log or throw. Scratch is sized at setup.
//     Counters are atomics read by status().

#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
// initguid must come before the headers whose GUIDs / PROPERTYKEYs this TU defines.
#include <initguid.h>
#include <audioclient.h>
#include <avrt.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mmdeviceapi.h>
#include <mmreg.h>

#include <atomic>
#include <cmath>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "brokodr/device.h"
#include "brokodr/duplex.h"
#include "brokodr/pcm.h"

namespace brokodr {
namespace {

// KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT, spelled out so this TU does not depend on how
// a given SDK's ksmedia.h defines them (MSVC and mingw-w64 differ).
const GUID kSubtypePcm = {0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};
const GUID kSubtypeFloat = {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

template <class T>
class Com {
 public:
  Com() = default;
  Com(const Com&) = delete;
  Com& operator=(const Com&) = delete;
  ~Com() { reset(); }
  T** put() {
    reset();
    return &p_;
  }
  void reset() {
    if (p_) p_->Release();
    p_ = nullptr;
  }
  T* operator->() const { return p_; }
  T* get() const { return p_; }
  explicit operator bool() const { return p_ != nullptr; }

 private:
  T* p_ = nullptr;
};

std::string narrow(const wchar_t* w) {
  if (!w) return {};
  const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return {};
  std::string s(static_cast<size_t>(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, &s[0], n, nullptr, nullptr);
  return s;
}

std::wstring widen(const std::string& s) {
  if (s.empty()) return {};
  const int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  std::wstring w(static_cast<size_t>(n > 0 ? n - 1 : 0), L'\0');
  if (n > 1) MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, &w[0], n);
  return w;
}

std::string hrText(HRESULT hr) {
  char b[16];
  std::snprintf(b, sizeof b, "0x%08lX", static_cast<unsigned long>(hr));
  return b;
}

/** Why an Initialize failed, in words a user can act on. */
std::string hrReason(HRESULT hr, uint32_t rate, uint32_t frames) {
  switch (hr) {
    case AUDCLNT_E_DEVICE_IN_USE:
      return "another application holds the device in exclusive mode";
    case AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED:
      return "exclusive mode is disabled for this device (Sound settings > device Properties > Advanced > "
             "'Allow applications to take exclusive control')";
    case AUDCLNT_E_UNSUPPORTED_FORMAT:
      return "the device accepts none of float32 / int24 / int32 / int16 at " + std::to_string(rate) +
             " Hz in exclusive mode";
    case AUDCLNT_E_BUFFER_SIZE_ERROR:
    case AUDCLNT_E_INVALID_DEVICE_PERIOD:
      return "the device refused a " + std::to_string(frames) + "-frame period";
    case AUDCLNT_E_DEVICE_INVALIDATED:
      return "the device was removed or disabled";
    case AUDCLNT_E_ENDPOINT_CREATE_FAILED:
      return "the endpoint could not be created (driver error)";
    case E_ACCESSDENIED:
      return "access denied (microphone privacy setting?)";
    default:
      return "WASAPI error " + hrText(hr);
  }
}

REFERENCE_TIME framesToHns(uint32_t frames, uint32_t rate) {
  return static_cast<REFERENCE_TIME>(10000000.0 * frames / rate + 0.5);
}
uint32_t hnsToFrames(REFERENCE_TIME hns, uint32_t rate) {
  return static_cast<uint32_t>(static_cast<double>(hns) * rate / 10000000.0 + 0.5);
}

/** The PcmFormat a WAVEFORMATEX describes, or false if it is not one we can convert. */
bool formatOf(const WAVEFORMATEX* w, PcmFormat& out) {
  WORD tag = w->wFormatTag;
  WORD valid = w->wBitsPerSample;
  if (tag == WAVE_FORMAT_EXTENSIBLE && w->cbSize >= 22) {
    const auto* x = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(w);
    valid = x->Samples.wValidBitsPerSample ? x->Samples.wValidBitsPerSample : w->wBitsPerSample;
    if (IsEqualGUID(x->SubFormat, kSubtypeFloat)) tag = WAVE_FORMAT_IEEE_FLOAT;
    else if (IsEqualGUID(x->SubFormat, kSubtypePcm)) tag = WAVE_FORMAT_PCM;
    else return false;
  }
  if (tag == WAVE_FORMAT_IEEE_FLOAT && w->wBitsPerSample == 32) return (out = PcmFormat::Float32), true;
  if (tag != WAVE_FORMAT_PCM) return false;
  if (w->wBitsPerSample == 16) return (out = PcmFormat::Int16), true;
  if (w->wBitsPerSample == 24) return (out = PcmFormat::Int24), true;
  if (w->wBitsPerSample == 32) return (out = valid == 24 ? PcmFormat::Int32Valid24 : PcmFormat::Int32), true;
  return false;
}

WAVEFORMATEXTENSIBLE makeFormat(PcmFormat f, uint32_t channels, uint32_t rate) {
  WAVEFORMATEXTENSIBLE x{};
  const WORD container = static_cast<WORD>(pcmBytes(f) * 8);
  x.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  x.Format.nChannels = static_cast<WORD>(channels);
  x.Format.nSamplesPerSec = rate;
  x.Format.wBitsPerSample = container;
  x.Format.nBlockAlign = static_cast<WORD>(channels * pcmBytes(f));
  x.Format.nAvgBytesPerSec = rate * x.Format.nBlockAlign;
  x.Format.cbSize = 22;
  x.Samples.wValidBitsPerSample =
      static_cast<WORD>(f == PcmFormat::Int32Valid24 ? 24 : container);
  x.dwChannelMask = channels == 1 ? 0x4 /* FRONT_CENTER */ : channels == 2 ? 0x3 /* FL|FR */ : 0;
  x.SubFormat = f == PcmFormat::Float32 ? kSubtypeFloat : kSubtypePcm;
  return x;
}

struct Endpoint {
  bool capture = false;
  Com<IMMDevice> dev;
  Com<IAudioClient> client;
  Com<IAudioRenderClient> render;
  Com<IAudioCaptureClient> cap;
  HANDLE event = nullptr;
  std::string name;
  PcmFormat fmt = PcmFormat::Float32;
  uint32_t channels = 0;
  uint32_t rate = 0;
  uint32_t bufferFrames = 0;
  uint32_t periodFrames = 0;
  bool exclusive = false;
  std::string how;  // e.g. "IAudioClient3 low-latency" — for the status note

  void release() {
    if (client) client->Stop();
    render.reset();
    cap.reset();
    client.reset();
    if (event) CloseHandle(event);
    event = nullptr;
  }
  /** Back to a freshly constructed state (Com<> is move-less on purpose, so no assignment). */
  void clear() {
    release();
    dev.reset();
    capture = false;
    name.clear();
    fmt = PcmFormat::Float32;
    channels = rate = bufferFrames = periodFrames = 0;
    exclusive = false;
    how.clear();
  }
};

std::string friendlyName(IMMDevice* d) {
  Com<IPropertyStore> props;
  if (FAILED(d->OpenPropertyStore(STGM_READ, props.put()))) return {};
  PROPVARIANT v;
  PropVariantInit(&v);
  std::string s;
  if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) s = narrow(v.pwszVal);
  PropVariantClear(&v);
  return s;
}

std::string endpointId(IMMDevice* d) {
  LPWSTR id = nullptr;
  if (FAILED(d->GetId(&id))) return {};
  std::string s = narrow(id);
  CoTaskMemFree(id);
  return s;
}

/** Get the endpoint for an id, or the console default for the direction when id is empty. */
HRESULT getEndpoint(IMMDeviceEnumerator* en, const std::string& id, EDataFlow flow, IMMDevice** out) {
  if (id.empty()) return en->GetDefaultAudioEndpoint(flow, eConsole, out);
  return en->GetDevice(widen(id).c_str(), out);
}

HRESULT activate(Endpoint& ep) {
  return ep.dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(ep.client.put()));
}

/** Common tail of every successful Initialize: event, buffer, service. */
HRESULT finishInit(Endpoint& ep) {
  ep.event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!ep.event) return HRESULT_FROM_WIN32(GetLastError());
  HRESULT hr = ep.client->SetEventHandle(ep.event);
  if (FAILED(hr)) return hr;
  UINT32 n = 0;
  hr = ep.client->GetBufferSize(&n);
  if (FAILED(hr)) return hr;
  ep.bufferFrames = n;
  if (ep.capture)
    return ep.client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(ep.cap.put()));
  return ep.client->GetService(__uuidof(IAudioRenderClient), reinterpret_cast<void**>(ep.render.put()));
}

HRESULT initExclusive(Endpoint& ep, uint32_t rate, uint32_t block, std::string& reason) {
  HRESULT hr = activate(ep);
  if (FAILED(hr)) return reason = hrReason(hr, rate, block), hr;
  WAVEFORMATEX* mix = nullptr;
  hr = ep.client->GetMixFormat(&mix);
  if (FAILED(hr)) return reason = hrReason(hr, rate, block), hr;
  const uint32_t channels = mix->nChannels;
  CoTaskMemFree(mix);

  // Float first (no conversion), then 24-in-32 (what most USB interfaces expose), packed
  // 24, full 32, 16. The first one IsFormatSupported accepts wins.
  const PcmFormat order[] = {PcmFormat::Float32, PcmFormat::Int32Valid24, PcmFormat::Int24, PcmFormat::Int32,
                             PcmFormat::Int16};
  bool found = false;
  WAVEFORMATEXTENSIBLE fmt{};
  for (PcmFormat f : order) {
    fmt = makeFormat(f, channels, rate);
    if (ep.client->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &fmt.Format, nullptr) == S_OK) {
      ep.fmt = f;
      found = true;
      break;
    }
  }
  if (!found) return reason = hrReason(AUDCLNT_E_UNSUPPORTED_FORMAT, rate, block), AUDCLNT_E_UNSUPPORTED_FORMAT;

  REFERENCE_TIME defP = 0, minP = 0;
  ep.client->GetDevicePeriod(&defP, &minP);
  REFERENCE_TIME period = std::max(minP, framesToHns(block, rate));
  hr = ep.client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, period, period,
                             &fmt.Format, nullptr);
  if (hr == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED) {
    // The documented dance: ask for the aligned size, then start again on a fresh client.
    UINT32 aligned = 0;
    ep.client->GetBufferSize(&aligned);
    ep.client.reset();
    period = framesToHns(aligned, rate);
    hr = activate(ep);
    if (SUCCEEDED(hr))
      hr = ep.client->Initialize(AUDCLNT_SHAREMODE_EXCLUSIVE, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, period, period,
                                 &fmt.Format, nullptr);
  }
  if (FAILED(hr)) return reason = hrReason(hr, rate, hnsToFrames(period, rate)), hr;
  ep.channels = channels;
  ep.rate = rate;
  ep.exclusive = true;
  hr = finishInit(ep);
  if (FAILED(hr)) return reason = hrReason(hr, rate, block), hr;
  ep.periodFrames = ep.bufferFrames;  // exclusive event mode: each event is one whole buffer
  ep.how = "exclusive";
  return S_OK;
}

HRESULT initShared(Endpoint& ep, uint32_t rate, uint32_t block, std::string& reason) {
  HRESULT hr = activate(ep);
  if (FAILED(hr)) return reason = hrReason(hr, rate, block), hr;
  WAVEFORMATEX* mix = nullptr;
  hr = ep.client->GetMixFormat(&mix);
  if (FAILED(hr)) return reason = hrReason(hr, rate, block), hr;
  ep.channels = mix->nChannels;

  if (mix->nSamplesPerSec == rate) {
    // Low-latency shared mode: the smallest engine period >= the block, on the engine's
    // fundamental grid. Falls through to classic shared mode if the interface or the
    // call is unavailable (pre-Windows 10, or a driver that does not support it).
    Com<IAudioClient3> c3;
    if (SUCCEEDED(ep.client->QueryInterface(__uuidof(IAudioClient3), reinterpret_cast<void**>(c3.put())))) {
      UINT32 defF = 0, fundF = 0, minF = 0, maxF = 0;
      if (SUCCEEDED(c3->GetSharedModeEnginePeriod(mix, &defF, &fundF, &minF, &maxF)) && fundF > 0) {
        uint32_t p = std::max<uint32_t>(minF, ((block + fundF - 1) / fundF) * fundF);
        if (p > maxF) p = maxF;
        if (SUCCEEDED(c3->InitializeSharedAudioStream(AUDCLNT_STREAMFLAGS_EVENTCALLBACK, p, mix, nullptr)) &&
            formatOf(mix, ep.fmt)) {
          ep.rate = rate;
          ep.periodFrames = p;
          ep.how = "shared (IAudioClient3, " + std::to_string(p) + "-frame engine period)";
          CoTaskMemFree(mix);
          hr = finishInit(ep);
          if (FAILED(hr)) reason = hrReason(hr, rate, block);
          return hr;
        }
      }
    }
    // c3 may have half-initialised the client; start the classic path on a fresh one.
    ep.client.reset();
    hr = activate(ep);
    if (FAILED(hr)) {
      CoTaskMemFree(mix);
      return reason = hrReason(hr, rate, block), hr;
    }
  }

  DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
  WAVEFORMATEXTENSIBLE want{};
  const WAVEFORMATEX* use = mix;
  if (mix->nSamplesPerSec != rate) {
    // Ask for float32 at our rate and let the audio engine resample. Costs latency and a
    // resampler; the status note says so.
    want = makeFormat(PcmFormat::Float32, mix->nChannels, rate);
    use = &want.Format;
    flags |= AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
  }
  const bool parsed = formatOf(use, ep.fmt);
  const uint32_t mixRate = mix->nSamplesPerSec;
  hr = parsed ? ep.client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, use, nullptr) : AUDCLNT_E_UNSUPPORTED_FORMAT;
  CoTaskMemFree(mix);
  if (FAILED(hr)) return reason = hrReason(hr, rate, block), hr;
  ep.rate = rate;
  REFERENCE_TIME defP = 0, minP = 0;
  ep.client->GetDevicePeriod(&defP, &minP);
  ep.periodFrames = hnsToFrames(defP, rate);
  ep.how = mixRate == rate ? "shared" : "shared, resampled from " + std::to_string(mixRate) + " Hz";
  hr = finishInit(ep);
  if (FAILED(hr)) reason = hrReason(hr, rate, block);
  return hr;
}

class WasapiDevice final : public Device {
 public:
  ~WasapiDevice() override { close(); }

  std::vector<DeviceInfo> enumerate() override {
    std::vector<DeviceInfo> out;
    // A thread of its own, so the enumeration runs in an MTA whatever the caller is in.
    std::thread t([&out] {
      if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return;
      {
        Com<IMMDeviceEnumerator> en;
        if (SUCCEEDED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                       __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(en.put())))) {
          for (EDataFlow flow : {eCapture, eRender}) {
            std::string defId;
            {
              Com<IMMDevice> d;
              if (SUCCEEDED(en->GetDefaultAudioEndpoint(flow, eConsole, d.put()))) defId = endpointId(d.get());
            }
            Com<IMMDeviceCollection> col;
            if (FAILED(en->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, col.put()))) continue;
            UINT n = 0;
            col->GetCount(&n);
            for (UINT i = 0; i < n; i++) {
              Com<IMMDevice> d;
              if (FAILED(col->Item(i, d.put()))) continue;
              DeviceInfo info;
              info.id = endpointId(d.get());
              info.name = friendlyName(d.get());
              // Windows names an interface's pair endpoints "<pair> (<interface>)", e.g.
              // "IN 1-2 (BEHRINGER UMC 1820)". The part before the bracket is the pair.
              const size_t br = info.name.rfind(" (");
              info.pairLabel = br == std::string::npos ? std::string() : info.name.substr(0, br);
              info.isDefault = info.id == defId;
              Com<IAudioClient> c;
              if (SUCCEEDED(d->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                                        reinterpret_cast<void**>(c.put())))) {
                WAVEFORMATEX* mix = nullptr;
                if (SUCCEEDED(c->GetMixFormat(&mix))) {
                  (flow == eCapture ? info.inputChannels : info.outputChannels) = mix->nChannels;
                  info.defaultSampleRate = mix->nSamplesPerSec;
                  CoTaskMemFree(mix);
                }
              }
              out.push_back(std::move(info));
            }
          }
        }
      }
      CoUninitialize();
    });
    t.join();
    return out;
  }

  bool open(const StreamConfig& cfg, RenderSink* sink, std::string& error) override {
    if (thread_.joinable()) {
      error = "already open";
      return false;
    }
    if (!sink || cfg.blockFrames == 0 || cfg.sampleRate == 0) {
      error = !sink ? "no render sink" : "blockFrames and sampleRate must be > 0";
      return false;
    }
    cfg_ = cfg;
    sink_ = sink;
    stop_.store(false);
    // A Device may be reopened (the panel's Apply); counters describe one stream.
    for (auto* a : {&underruns_, &callbacks_, &captureGlitches_, &underflow_, &dropped_, &warmup_})
      a->store(0, std::memory_order_relaxed);
    started_.store(false, std::memory_order_relaxed);
    maxWorkUs_.store(0.0, std::memory_order_relaxed);
    ready_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    setupOk_ = false;
    setupError_.clear();
    thread_ = std::thread([this] { threadMain(); });
    // Setup is COM activation plus at most two Initialize retries per endpoint; 10 s is
    // far beyond any healthy driver and short enough not to hang the UI on a dead one.
    if (WaitForSingleObject(ready_, 10000) != WAIT_OBJECT_0) {
      stop_.store(true);
      if (thread_.joinable()) thread_.join();
      CloseHandle(ready_);
      ready_ = nullptr;
      error = "device setup timed out";
      return false;
    }
    CloseHandle(ready_);
    ready_ = nullptr;
    if (!setupOk_) {
      if (thread_.joinable()) thread_.join();
      error = setupError_;
      return false;
    }
    return true;
  }

  void close() override {
    if (!thread_.joinable()) return;
    stop_.store(true);
    if (wake_) SetEvent(wake_);
    thread_.join();
    std::lock_guard<std::mutex> g(mu_);
    status_.open = false;
  }

  StreamStatus status() const override {
    std::lock_guard<std::mutex> g(mu_);
    StreamStatus s = status_;
    s.underruns = underruns_.load(std::memory_order_relaxed);
    s.callbacks = callbacks_.load(std::memory_order_relaxed);
    s.maxCallbackUs = maxWorkUs_.load(std::memory_order_relaxed);
    s.captureGlitches = captureGlitches_.load(std::memory_order_relaxed);
    s.inputUnderflowFrames = underflow_.load(std::memory_order_relaxed);
    s.inputStarted = !hasCapture_ || started_.load(std::memory_order_relaxed);
    s.inputWarmupMs = hasCapture_ && s.sampleRate ? 1000.0 * static_cast<double>(warmup_.load(std::memory_order_relaxed)) / s.sampleRate : 0.0;
    s.inputDroppedFrames = dropped_.load(std::memory_order_relaxed);
    return s;
  }

 private:
  void threadMain() {
    const HRESULT ci = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(ci)) {
      setupError_ = "COM init failed: " + hrText(ci);
      SetEvent(ready_);
      return;
    }
    setupOk_ = setup(setupError_);
    if (setupOk_) prefillAndStart();
    SetEvent(ready_);  // after this line open() may return; never touch ready_ again
    if (setupOk_) loop();
    render_.release();
    capture_.release();
    if (wake_) CloseHandle(wake_);
    wake_ = nullptr;
    CoUninitialize();
  }

  bool setup(std::string& error) {
    Com<IMMDeviceEnumerator> en;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator),
                                  reinterpret_cast<void**>(en.put()));
    if (FAILED(hr)) return error = "no MMDeviceEnumerator: " + hrText(hr), false;

    render_.clear();
    capture_.clear();
    capture_.capture = true;
    hasCapture_ = cfg_.inputId != "none";
    hr = getEndpoint(en.get(), cfg_.outputId, eRender, render_.dev.put());
    if (FAILED(hr)) return error = "output device not found: " + hrReason(hr, cfg_.sampleRate, cfg_.blockFrames), false;
    render_.name = friendlyName(render_.dev.get());
    if (hasCapture_) {
      hr = getEndpoint(en.get(), cfg_.inputId, eCapture, capture_.dev.put());
      if (FAILED(hr))
        return error = "input device not found: " + hrReason(hr, cfg_.sampleRate, cfg_.blockFrames), false;
      capture_.name = friendlyName(capture_.dev.get());
    }

    const uint32_t rate = cfg_.sampleRate, block = cfg_.blockFrames;
    bool exclusive = false, denied = false;
    std::string why;
    if (cfg_.wantExclusive) {
      std::string r;
      hr = initExclusive(render_, rate, block, r);
      if (SUCCEEDED(hr) && hasCapture_) {
        hr = initExclusive(capture_, rate, block, r);
        if (FAILED(hr)) r = "input: " + r;
      } else if (FAILED(hr)) {
        r = "output: " + r;
      }
      if (SUCCEEDED(hr)) {
        exclusive = true;
      } else {
        denied = true;
        why = r;
        render_.release();
        capture_.release();
      }
    }
    if (!exclusive) {
      std::string r;
      hr = initShared(render_, rate, block, r);
      if (FAILED(hr)) return error = "output: " + r, false;
      if (hasCapture_) {
        hr = initShared(capture_, rate, block, r);
        if (FAILED(hr)) return error = "input: " + r, false;
      }
    }

    // Duplex FIFO: target one capture period, slack one render buffer, room for the
    // largest capture packet on top (duplex.h).
    const uint32_t capPeriod = hasCapture_ ? std::max<uint32_t>(capture_.periodFrames, 1) : block;
    const uint32_t target = capPeriod;
    const uint32_t slack = std::max(render_.bufferFrames, capPeriod);
    const uint32_t capBuf = hasCapture_ ? capture_.bufferFrames : 0;
    if (!pump_.init(block, target + slack + capBuf + render_.bufferFrames + 1, target, slack))
      return error = "duplex FIFO init failed", false;
    outL_.assign(render_.bufferFrames, 0.0f);
    outR_.assign(render_.bufferFrames, 0.0f);
    capL_.assign(std::max<uint32_t>(capBuf, 1), 0.0f);
    capR_.assign(std::max<uint32_t>(capBuf, 1), 0.0f);
    wake_ = CreateEventW(nullptr, FALSE, FALSE, nullptr);

    LARGE_INTEGER f;
    QueryPerformanceFrequency(&f);
    qpcPerUs_ = static_cast<double>(f.QuadPart) / 1e6;
    periodUs_ = 1e6 * std::max<uint32_t>(render_.periodFrames, 1) / rate;

    std::lock_guard<std::mutex> g(mu_);
    status_ = StreamStatus{};
    status_.open = true;
    status_.kind = exclusive ? DriverKind::WasapiExclusive : DriverKind::WasapiShared;
    status_.sampleRate = rate;
    status_.blockFrames = block;
    status_.periodFrames = render_.periodFrames;
    status_.bufferFrames = render_.bufferFrames;
    status_.exclusiveDenied = denied;
    status_.format = std::string(pcmName(render_.fmt)) + " x" + std::to_string(render_.channels) +
                     (hasCapture_ ? std::string(" out, ") + pcmName(capture_.fmt) + " x" +
                                        std::to_string(capture_.channels) + " in"
                                  : std::string(" out, no input"));
    status_.outputName = render_.name;
    status_.inputName = hasCapture_ ? capture_.name : "(none)";
    // Estimate: the render buffer, one capture period, and the FIFO target. Not a
    // measurement, which is why it has its own field; see StreamStatus.
    const uint32_t est = render_.bufferFrames + (hasCapture_ ? capture_.periodFrames : 0) + target;
    status_.estimatedRoundTripMs = 1000.0 * est / rate;
    status_.note = "output " + render_.how + (hasCapture_ ? ", input " + capture_.how : "") +
                   (denied ? "; exclusive refused, fell back to shared: " + why : "");
    return true;
  }

  void prefillAndStart() {
    // Start with one buffer of silence queued, so the first event is a refill rather than
    // an immediate starve.
    BYTE* buf = nullptr;
    UINT32 pad = 0;
    if (!render_.exclusive) render_.client->GetCurrentPadding(&pad);
    const UINT32 n = render_.bufferFrames - pad;
    if (n && SUCCEEDED(render_.render->GetBuffer(n, &buf))) render_.render->ReleaseBuffer(n, AUDCLNT_BUFFERFLAGS_SILENT);
    if (hasCapture_) capture_.client->Start();
    render_.client->Start();
  }

  void drainCapture() {
    UINT32 packet = 0;
    while (SUCCEEDED(capture_.cap->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture_.cap->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      // Windows routinely flags the FIRST packet of a stream as a discontinuity (there was
      // nothing before it). Only a discontinuity after audio has started is a glitch.
      if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) && pump_.started())
        captureGlitches_.fetch_add(1, std::memory_order_relaxed);
      const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
      uint32_t off = 0;
      while (off < frames) {  // capL_ holds one capture buffer; a packet never exceeds it,
        const uint32_t n = std::min<uint32_t>(frames - off, static_cast<uint32_t>(capL_.size()));  // but be safe
        pcmToFloat(silent ? nullptr : data + static_cast<size_t>(off) * pcmBytes(capture_.fmt) * capture_.channels,
                   capture_.fmt, capture_.channels, cfg_.inputChannelL, cfg_.inputChannelR, capL_.data(),
                   capR_.data(), n);
        pump_.push(capL_.data(), capR_.data(), n);
        off += n;
      }
      capture_.cap->ReleaseBuffer(frames);
    }
  }

  void loop() {
    DWORD task = 0;
    HANDLE mmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &task);
    if (!mmcss) SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    HANDLE waits[2] = {render_.event, wake_};
    while (!stop_.load(std::memory_order_relaxed)) {
      const DWORD w = WaitForMultipleObjects(2, waits, FALSE, 2000);
      if (stop_.load(std::memory_order_relaxed)) break;
      if (w == WAIT_TIMEOUT) {
        // No render event in 2 s: the device stopped clocking. Counted, and the loop keeps
        // waiting; close() still works.
        underruns_.fetch_add(1, std::memory_order_relaxed);
        continue;
      }
      LARGE_INTEGER t0, t1;
      QueryPerformanceCounter(&t0);
      if (hasCapture_) drainCapture();

      UINT32 avail = render_.bufferFrames;
      if (!render_.exclusive) {
        UINT32 pad = 0;
        const HRESULT hp = render_.client->GetCurrentPadding(&pad);
        if (hp == AUDCLNT_E_DEVICE_INVALIDATED) {
          deviceLost();
          break;
        }
        // Padding at zero on a wake means the engine consumed everything we had queued:
        // it played silence for some interval. A starve, counted as an underrun.
        if (pad == 0 && callbacks_.load(std::memory_order_relaxed) > 0) underruns_.fetch_add(1, std::memory_order_relaxed);
        avail = render_.bufferFrames - pad;
      }
      if (avail > 0) {
        BYTE* buf = nullptr;
        const HRESULT hb = render_.render->GetBuffer(avail, &buf);
        if (hb == AUDCLNT_E_DEVICE_INVALIDATED) {
          deviceLost();
          break;
        }
        if (SUCCEEDED(hb)) {
          pump_.render(sink_, outL_.data(), outR_.data(), avail);
          floatToPcm(outL_.data(), outR_.data(), buf, render_.fmt, render_.channels, avail);
          render_.render->ReleaseBuffer(avail, 0);
        }
      }
      QueryPerformanceCounter(&t1);
      const double us = static_cast<double>(t1.QuadPart - t0.QuadPart) / qpcPerUs_;
      if (us > maxWorkUs_.load(std::memory_order_relaxed)) maxWorkUs_.store(us, std::memory_order_relaxed);
      // Work longer than one period cannot have made the next deadline.
      if (us > periodUs_) underruns_.fetch_add(1, std::memory_order_relaxed);
      callbacks_.fetch_add(1, std::memory_order_relaxed);
      const DuplexCounters& c = pump_.counters();
      underflow_.store(c.underflowFrames, std::memory_order_relaxed);
      dropped_.store(c.overflowFrames + c.trimFrames, std::memory_order_relaxed);
      warmup_.store(c.warmupFrames, std::memory_order_relaxed);
      started_.store(pump_.started(), std::memory_order_relaxed);
    }
    if (mmcss) AvRevertMmThreadCharacteristics(mmcss);
  }

  void deviceLost() {
    std::lock_guard<std::mutex> g(mu_);
    status_.open = false;
    status_.note += "; device removed or disabled while streaming";
  }

  StreamConfig cfg_{};
  RenderSink* sink_ = nullptr;
  std::thread thread_;
  std::atomic<bool> stop_{false};
  HANDLE ready_ = nullptr;
  HANDLE wake_ = nullptr;
  bool setupOk_ = false;
  std::string setupError_;

  Endpoint render_, capture_;
  bool hasCapture_ = false;
  DuplexPump pump_;
  std::vector<float> outL_, outR_, capL_, capR_;
  double qpcPerUs_ = 1.0, periodUs_ = 0.0;

  mutable std::mutex mu_;
  StreamStatus status_{};
  std::atomic<uint64_t> underruns_{0}, callbacks_{0}, captureGlitches_{0}, underflow_{0}, dropped_{0}, warmup_{0};
  std::atomic<bool> started_{false};
  std::atomic<double> maxWorkUs_{0.0};
};

}  // namespace

Device* makeWasapiDriver() { return new WasapiDevice(); }

}  // namespace brokodr

#endif  // _WIN32
