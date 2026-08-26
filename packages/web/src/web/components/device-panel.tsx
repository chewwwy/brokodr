/**
 * Bro.Kodr — audio device and latency panel.
 *
 * Deliberately explicit: changing the device or buffer size tears the graph down and
 * rebuilds it, so the panel says so rather than pretending the change is free. Buffer
 * choices map onto Chromium's latency hint; the engine reports back what it actually got,
 * which is often not what was asked for.
 */

import { useEffect, useState } from "react";
import type { AudioDeviceInfo } from "../audio/backend";
import { BUFFER_CHOICES, SAMPLE_RATE_CHOICES } from "../audio/engine-client";
import { useEngine, useEngineState } from "../hooks/use-engine";
import { LabeledSelect, Toggle } from "./controls";

function deviceOptions(list: AudioDeviceInfo[], fallback: string) {
  const opts = list.map((d) => ({
    value: d.deviceId,
    label: d.isDefault ? `${d.label} (default)` : d.label,
  }));
  if (!opts.some((o) => o.value === "default")) opts.unshift({ value: "default", label: fallback });
  return opts;
}

export function DevicePanel() {
  const client = useEngine();
  const { devices, settings, status, info, nativeAvailable, nativeNote } = useEngineState();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void client.refreshDevices();
  }, [client]);

  const apply = async (patch: Parameters<typeof client.applySettings>[0]) => {
    setBusy(true);
    if (status !== "running") setPending(true);
    try {
      await client.applySettings(patch);
    } finally {
      setBusy(false);
    }
  };

  const grantLabels = async () => {
    setBusy(true);
    try {
      await client.requestPermission();
    } finally {
      setBusy(false);
    }
  };

  const bufMs = (frames: number) => ((frames / (info?.sampleRate ?? settings.sampleRate)) * 1000).toFixed(1);
  const srMismatch = info && info.sampleRate !== settings.sampleRate;

  return (
    <div className="flex flex-col gap-2">
      {!devices.labelsAvailable && (
        <button className="vk-btn vk-focus-ring w-full justify-center" onClick={grantLabels} disabled={busy}>
          GRANT MIC ACCESS
        </button>
      )}

      <LabeledSelect
        label="Input device"
        value={settings.inputDeviceId}
        onChange={(v) => void apply({ inputDeviceId: v })}
        options={deviceOptions(devices.inputs, "System default input")}
        disabled={busy}
        title="Microphone or interface input the engine captures from"
      />

      <LabeledSelect
        label="Output device"
        value={settings.outputDeviceId}
        onChange={(v) => void apply({ outputDeviceId: v })}
        options={deviceOptions(devices.outputs, "System default output")}
        disabled={busy}
        title="Where processed audio is monitored. Requires setSinkId support."
      />

      <div className="grid grid-cols-2 gap-2">
        <LabeledSelect
          label="Sample rate"
          value={String(settings.sampleRate)}
          onChange={(v) => void apply({ sampleRate: Number(v) })}
          options={SAMPLE_RATE_CHOICES.map((r) => ({ value: String(r), label: `${r / 1000} kHz` }))}
          disabled={busy}
          title="Requested rate. The OS may refuse and keep its own — the top bar shows what you actually got."
        />
        <LabeledSelect
          label="Buffer"
          value={String(settings.bufferFrames)}
          onChange={(v) => void apply({ bufferFrames: Number(v) })}
          options={BUFFER_CHOICES.map((b) => ({ value: String(b), label: `${b} · ${bufMs(b)}ms` }))}
          disabled={busy}
          title="Smaller buffers cut latency and raise CPU. If you hear crackles, go up one step."
        />
      </div>

      {srMismatch && (
        <div className="vk-well vk-mono px-2 py-1 text-[10px]" style={{ color: "var(--vk-amber)" }}>
          Device is running at {info!.sampleRate} Hz, not the requested {settings.sampleRate} Hz. Change it in Windows
          Sound settings to match.
        </div>
      )}

      {pending && status !== "running" && (
        <div className="vk-well vk-mono px-2 py-1 text-[10px]" style={{ color: "var(--vk-text-mid)" }}>
          Saved. Applies when you press ENGAGE.
        </div>
      )}

      <div className="flex flex-col gap-[4px]">
        <div className="vk-label">Browser pre-processing</div>
        <Toggle
          on={settings.echoCancellation}
          onChange={(v) => void apply({ echoCancellation: v })}
          label="ECHO CANCEL"
          title="Leave off. Chromium's AEC mangles the signal before our chain ever sees it."
        />
        <Toggle
          on={settings.noiseSuppression}
          onChange={(v) => void apply({ noiseSuppression: v })}
          label="NOISE SUPPRESS"
          title="Leave off unless your room is bad — it pumps and eats sibilance."
        />
        <Toggle
          on={settings.autoGainControl}
          onChange={(v) => void apply({ autoGainControl: v })}
          label="AUTO GAIN"
          title="Leave off. It fights the compressor."
        />
      </div>

      <div className="vk-well px-2 py-[6px]">
        <div className="vk-label mb-1">Backend</div>
        <div className="vk-mono text-[10px]" style={{ color: "var(--vk-text-mid)", lineHeight: 1.5 }}>
          {nativeAvailable ? "Native WASAPI/ASIO host attached." : nativeNote}
        </div>
      </div>

      <button
        className="vk-btn vk-focus-ring w-full justify-center"
        onClick={() => void client.refreshDevices()}
        disabled={busy}
      >
        RESCAN DEVICES
      </button>
    </div>
  );
}
