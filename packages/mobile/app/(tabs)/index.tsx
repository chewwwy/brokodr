import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  readMetrics,
  resetCounters,
  setControl,
  startSpike,
  stopSpike,
  unsupportedReason,
  type SpikeControl,
  type SpikeMetrics,
} from "@/audio/spike-engine";

const BG = "#0d0e10";
const PANEL = "#191b1d";
const EDGE = "#2c2f33";
const TEXT = "#e7e9ea";
const DIM = "#8b9094";
const AMBER = "#f0a83c";
const GOOD = "#4ade80";
const BAD = "#f87171";
const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

const STAGES: { bit: number; label: string; cost: string }[] = [
  { bit: 1, label: "EQ", cost: "12 biquads/frame" },
  { bit: 2, label: "COMP", cost: "env + lookahead" },
  { bit: 4, label: "PITCH", cost: "1024pt FFT vocoder" },
];

function verdict(m: SpikeMetrics): { text: string; color: string } {
  if (!m.running) return { text: "IDLE", color: DIM };
  if (m.error) return { text: "FAILED", color: BAD };
  if (!m.rackAlive) return { text: "DSP DEAD", color: BAD };
  if (m.dropouts > 0) return { text: "DROPOUTS", color: BAD };
  if (m.cpuPeakPct > 80) return { text: "AT THE EDGE", color: AMBER };
  return { text: "CLEAN", color: GOOD };
}

export default function SpikeScreen() {
  const blocked = unsupportedReason();
  const web = blocked !== null;
  const [m, setM] = useState<SpikeMetrics>(readMetrics());
  const [ctl, setCtl] = useState<SpikeControl>({ stages: 1 | 2 | 4, bypass: false, clickSeq: 0 });
  const [err, setErr] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (web) return;
    timer.current = setInterval(() => setM(readMetrics()), 200);
    return () => {
      if (timer.current) clearInterval(timer.current);
      void stopSpike();
    };
  }, [web]);

  const toggleRun = useCallback(async () => {
    setBusy(true);
    setErr("");
    if (m.running) {
      await stopSpike();
      setM(readMetrics());
    } else {
      const res = await startSpike();
      if (!res.ok) setErr(res.error ?? "unknown error");
    }
    setBusy(false);
  }, [m.running]);

  const patch = useCallback((p: Partial<SpikeControl>) => setCtl(setControl(p)), []);
  const v = verdict(m);

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: BG }}>
      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 40, gap: 12 }}>
        <View>
          <Text style={{ color: TEXT, fontSize: 22, fontWeight: "800", letterSpacing: 1 }}>BRO.KODR</Text>
          <Text style={{ color: AMBER, fontSize: 11, letterSpacing: 2, marginTop: 2 }}>ANDROID DSP SPIKE</Text>
        </View>

        {web ? (
          <View style={{ backgroundColor: PANEL, borderColor: EDGE, borderWidth: 1, borderRadius: 6, padding: 14, gap: 8 }}>
            <Text style={{ color: AMBER, fontWeight: "700", fontSize: 13 }}>CANNOT MEASURE HERE</Text>
            <Text style={{ color: TEXT, fontSize: 13, lineHeight: 19 }}>{blocked}</Text>
            <Text style={{ color: DIM, fontSize: 13, lineHeight: 19 }}>
              This screen measures the native Android audio thread. Build the custom dev client from the mobile
              preview dashboard's publish option, install that on the phone, and open this screen there — every
              number below stays blank until then.
            </Text>
          </View>
        ) : null}

        <Pressable
          onPress={toggleRun}
          disabled={busy || web}
          style={{
            backgroundColor: m.running ? "#3a1d1d" : "#1d3a25",
            borderColor: m.running ? BAD : GOOD,
            borderWidth: 1,
            borderRadius: 6,
            paddingVertical: 16,
            alignItems: "center",
            opacity: busy || web ? 0.5 : 1,
          }}
        >
          <Text style={{ color: m.running ? BAD : GOOD, fontWeight: "800", letterSpacing: 2, fontSize: 15 }}>
            {m.running ? "STOP" : "START MIC -> DSP -> OUT"}
          </Text>
        </Pressable>

        {err ? (
          <Text style={{ color: BAD, fontFamily: MONO, fontSize: 12 }}>{err}</Text>
        ) : null}

        <View style={{ backgroundColor: PANEL, borderColor: EDGE, borderWidth: 1, borderRadius: 6, padding: 12, gap: 10 }}>
          <Row label="VERDICT" value={v.text} color={v.color} big />
          <Row label="SAMPLE RATE" value={m.sampleRate ? `${m.sampleRate} Hz` : "--"} />
          <Row label="BLOCK SIZE" value={m.blockSize ? `${m.blockSize} frames` : "--"} />
          <Row
            label="BLOCK BUDGET"
            value={m.blockMs ? `${m.blockMs.toFixed(2)} ms` : "--"}
          />
          <Row
            label="DSP LOAD (mean)"
            value={m.running ? `${m.cpuPct.toFixed(1)} %` : "--"}
            color={m.cpuPct > 70 ? BAD : m.cpuPct > 40 ? AMBER : GOOD}
          />
          <Row
            label="DSP LOAD (worst)"
            value={m.running ? `${m.cpuPeakPct.toFixed(1)} %  (${m.peakMs.toFixed(2)} ms)` : "--"}
            color={m.cpuPeakPct > 90 ? BAD : m.cpuPeakPct > 60 ? AMBER : GOOD}
          />
          <Row
            label="DROPOUTS"
            value={m.running ? String(m.dropouts) : "--"}
            color={m.dropouts > 0 ? BAD : GOOD}
          />
          <Row label="BLOCKS SEEN" value={m.running ? String(m.blocks) : "--"} />
          <Row label="MIC PEAK" value={m.running ? `${m.inPeakDb.toFixed(1)} dB` : "--"} />
          <Row label="OUT PEAK" value={m.running ? `${m.outPeakDb.toFixed(1)} dB` : "--"} />
          <Row
            label="DSP CLASSES ALIVE"
            value={m.running ? (m.rackAlive ? "YES" : "NO") : "--"}
            color={m.rackAlive ? GOOD : BAD}
          />
        </View>

        <View style={{ backgroundColor: PANEL, borderColor: EDGE, borderWidth: 1, borderRadius: 6, padding: 12, gap: 10 }}>
          <Text style={{ color: AMBER, fontSize: 11, letterSpacing: 2 }}>ROUND-TRIP LATENCY</Text>
          <Text style={{ color: TEXT, fontFamily: MONO, fontSize: 30, fontWeight: "700" }}>
            {m.latencyMs === -1 ? "--" : m.latencyMs === -2 ? "listening" : `${m.latencyMs.toFixed(1)} ms`}
          </Text>
          <Text style={{ color: DIM, fontSize: 12, lineHeight: 18 }}>
            Emits a 2 ms 3 kHz burst and listens for it on the mic. Speaker to air to mic, so it includes about
            3 ms per metre of air — hold the phone close, speaker not muffled, in a quiet room.
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              onPress={() => patch({ clickSeq: ctl.clickSeq + 1 })}
              disabled={!m.running}
              style={{
                flex: 1,
                borderColor: AMBER,
                borderWidth: 1,
                borderRadius: 5,
                paddingVertical: 12,
                alignItems: "center",
                opacity: m.running ? 1 : 0.4,
              }}
            >
              <Text style={{ color: AMBER, fontWeight: "700", letterSpacing: 1 }}>MEASURE</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                resetCounters();
                setM(readMetrics());
              }}
              disabled={!m.running}
              style={{
                flex: 1,
                borderColor: EDGE,
                borderWidth: 1,
                borderRadius: 5,
                paddingVertical: 12,
                alignItems: "center",
                opacity: m.running ? 1 : 0.4,
              }}
            >
              <Text style={{ color: DIM, fontWeight: "700", letterSpacing: 1 }}>RESET</Text>
            </Pressable>
          </View>
        </View>

        <View style={{ backgroundColor: PANEL, borderColor: EDGE, borderWidth: 1, borderRadius: 6, padding: 12, gap: 10 }}>
          <Text style={{ color: AMBER, fontSize: 11, letterSpacing: 2 }}>REAL BRO.KODR EFFECTS</Text>
          {STAGES.map((s) => {
            const on = (ctl.stages & s.bit) !== 0;
            return (
              <Pressable
                key={s.bit}
                onPress={() => patch({ stages: on ? ctl.stages & ~s.bit : ctl.stages | s.bit })}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderColor: on ? AMBER : EDGE,
                  borderWidth: 1,
                  borderRadius: 5,
                  padding: 12,
                  backgroundColor: on ? "#241d10" : "transparent",
                }}
              >
                <View>
                  <Text style={{ color: on ? AMBER : DIM, fontWeight: "800", letterSpacing: 1 }}>{s.label}</Text>
                  <Text style={{ color: DIM, fontSize: 11, marginTop: 2 }}>{s.cost}</Text>
                </View>
                <Text style={{ color: on ? AMBER : DIM, fontFamily: MONO, fontSize: 12 }}>{on ? "ON" : "OFF"}</Text>
              </Pressable>
            );
          })}

          <Pressable
            onPress={() => patch({ bypass: !ctl.bypass })}
            style={{
              borderColor: ctl.bypass ? BAD : EDGE,
              borderWidth: 1,
              borderRadius: 5,
              padding: 12,
              alignItems: "center",
              backgroundColor: ctl.bypass ? "#2a1717" : "transparent",
            }}
          >
            <Text style={{ color: ctl.bypass ? BAD : DIM, fontWeight: "800", letterSpacing: 1 }}>
              {ctl.bypass ? "BYPASSED — RAW MIC" : "BYPASS (A/B AGAINST RAW)"}
            </Text>
          </Pressable>
        </View>

        {m.error ? (
          <View style={{ borderColor: BAD, borderWidth: 1, borderRadius: 6, padding: 12 }}>
            <Text style={{ color: BAD, fontSize: 11, letterSpacing: 2, marginBottom: 6 }}>AUDIO THREAD ERROR</Text>
            <Text style={{ color: TEXT, fontFamily: MONO, fontSize: 12 }}>{m.error}</Text>
          </View>
        ) : null}

        <Text style={{ color: DIM, fontSize: 11, lineHeight: 17 }}>
          Use wired earbuds or hold the phone away from your ear for the listening test — mic and speaker in a
          loop will howl. Bro.Kodr — Kane Bateman, Australia.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({
  label,
  value,
  color,
  big,
}: {
  label: string;
  value: string;
  color?: string;
  big?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
      <Text style={{ color: DIM, fontSize: 11, letterSpacing: 1.5 }}>{label}</Text>
      <Text
        style={{
          color: color ?? TEXT,
          fontFamily: MONO,
          fontSize: big ? 18 : 13,
          fontWeight: big ? "800" : "600",
        }}
      >
        {value}
      </Text>
    </View>
  );
}
