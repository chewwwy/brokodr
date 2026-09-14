import { ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const BG = "#0d0e10";
const PANEL = "#191b1d";
const EDGE = "#2c2f33";
const TEXT = "#e7e9ea";
const DIM = "#8b9094";
const AMBER = "#f0a83c";

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ backgroundColor: PANEL, borderColor: EDGE, borderWidth: 1, borderRadius: 6, padding: 12, gap: 8 }}>
      <Text style={{ color: AMBER, fontSize: 11, letterSpacing: 2 }}>{title}</Text>
      {children}
    </View>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <Text style={{ color: DIM, fontSize: 13, lineHeight: 20 }}>{children}</Text>;
}

export default function ReportScreen() {
  return (
    <SafeAreaView edges={["top", "left", "right"]} style={{ flex: 1, backgroundColor: BG }}>
      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 40, gap: 12 }}>
        <Text style={{ color: TEXT, fontSize: 20, fontWeight: "800", letterSpacing: 1 }}>WHAT TO REPORT</Text>
        <P>
          Run each test below and send me the numbers off the SPIKE tab. This is the whole decision gate: 30-60 ms
          round-trip means Android is real and we plan the UI rebuild. Around 250 ms means we spent a day finding
          out instead of three weeks.
        </P>

        <Block title="1 — DOES THE DSP SURVIVE">
          <P>
            Start it with all three effects on. DSP CLASSES ALIVE must read YES and VERDICT must not read FAILED. If
            it says DSP DEAD or shows an AUDIO THREAD ERROR, send me that exact error text — that is the answer to
            the only question I could not settle in the sandbox: whether our 22 effect classes can be constructed
            inside a worklet runtime.
          </P>
        </Block>

        <Block title="2 — LATENCY">
          <P>
            Quiet room, phone speaker unobstructed, hit MEASURE five times and send the spread. Then repeat with
            PITCH off — the phase vocoder adds 1024 samples (~21 ms at 48k) of algorithmic delay on top of the
            hardware buffers, and separating the two tells us what is fixable.
          </P>
        </Block>

        <Block title="3 — CPU AND DROPOUTS">
          <P>
            Note DSP LOAD mean and worst for: EQ only, EQ+COMP, all three. Leave all three running for two full
            minutes and report DROPOUTS. One dropout is audible; a rising count means the block budget is being
            missed and the 22-module rack is not going to fit.
          </P>
        </Block>

        <Block title="4 — BATTERY">
          <P>
            Note the battery percentage, run all three effects for 15 minutes with the screen on, note it again.
            Anything past roughly 15%/hour makes this a "plug in to use it" app, which changes how we position it.
          </P>
        </Block>

        <Block title="5 — BLUETOOTH">
          <P>
            Repeat test 2 with bluetooth earbuds. Expect it to be bad — 150-300 ms is normal for A2DP and there is
            nothing we can do about it. I need to know how bad so the app can warn users instead of looking broken.
            Then repeat with wired earbuds or a USB-C interface for the honest best case.
          </P>
        </Block>

        <Block title="6 — DOES IT SOUND RIGHT">
          <P>
            Toggle BYPASS while talking. Processed should be an obviously brighter, compressed voice pitched up five
            semitones with formants preserved. If it sounds granular, metallic or aliased in a way the desktop build
            does not, the FFT path is being fed a block size it was not built for — tell me and send the BLOCK SIZE
            reading.
          </P>
        </Block>

        <Block title="WHY THIS IS ONLY A SPIKE">
          <P>
            No rack UI, no metal skin, no presets — none of that transfers. The 5,457 lines of DSP port as a
            one-line change per file, which is the payoff of keeping the DSP core backend-agnostic from day one. The
            ~900-line audio host and 10,182 lines of UI are a rewrite, and that decision waits on your numbers.
          </P>
        </Block>
      </ScrollView>
    </SafeAreaView>
  );
}
