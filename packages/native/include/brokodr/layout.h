// Bro.Kodr — the shared-memory contract, in C.
//
// PHASE 5a. Every constant here MIRRORS a constant that already exists on the JS side and
// is load-bearing for the running app. The native host is not free to choose them: the UI
// decodes meters by absolute index and the command ring by fixed stride, so a single
// disagreement here shows up as garbage needles or misapplied parameters rather than as a
// compile error.
//
// Authoritative sources, in order of precedence:
//   packages/web/src/web/audio/backend.ts          — OP, *_KEY, meter bases (the contract)
//   packages/web/src/web/audio/worklet-backend.ts  — CMD_SLOTS, CMD_STRIDE, METER_FIELDS,
//                                                    SCOPE_SIZE
//   packages/web/public/dsp/worklet-processor.js    — the decoder these must satisfy
//
// `scripts/verify-native-core.mjs` parses those files and fails if any value below drifts,
// so this header cannot silently rot. Do not "tidy" a number here; change the JS source
// and let the check tell you what else must move.
//
// APPEND-ONLY RULE: meter fields may only be added past the current end of the block
// (BK_METER_USED). Inserting one renumbers every field above it in a build the user may
// already be running, which is the one mistake that silently breaks a calibrated rig.

#ifndef BROKODR_LAYOUT_H
#define BROKODR_LAYOUT_H

#include <stdint.h>

// ---------------------------------------------------------------- command ring

// Slots in the control ring. Power of two is NOT required — the JS uses `w % CMD_SLOTS`
// — but it is one, and the C keeps the modulo rather than a mask so the two index
// identically even if that ever changes.
#define BK_CMD_SLOTS 1024
// [op, id, key, value, aux1, aux2]. Doubles, because `value` carries raw parameter units
// (frequencies, sample offsets, milliseconds) and f32 would quantise them.
#define BK_CMD_STRIDE 6

// Opcodes. Must match OP in backend.ts. 9 is deliberately unused (a removed opcode; the
// gap is kept so the remaining ids never shift).
enum bk_op {
  BK_OP_PARAM = 1,
  BK_OP_MIX = 2,
  BK_OP_BYPASS = 3,
  BK_OP_MOVE = 4,
  BK_OP_IO = 5,
  BK_OP_CLIPRESET = 6,
  BK_OP_RESET = 7,
  BK_OP_PANIC = 8,
  BK_OP_FILE = 10,
  BK_OP_PAD = 11,
  BK_OP_DRUM = 12,
  BK_OP_PADFX = 13,
  BK_OP_LOOP = 14,
  BK_OP_LOOPER = 15,
  BK_OP_CLOCK = 16,
  BK_OP_LOOPFX = 17,
  BK_OP_VOICE = 18,
  BK_OP_VOICECAL = 19
};

// I/O stage fields. Must match IO_FIELD in backend.ts.
enum bk_io_field {
  BK_IO_IN_GAIN = 0,
  BK_IO_OUT_GAIN = 1,
  BK_IO_MUTE = 2,
  BK_IO_BYPASS = 3,
  BK_IO_MONO = 4,
  BK_IO_SWAP = 5,
  BK_IO_MASTER_MIX = 6
};

// ---------------------------------------------------------------- meter block

// Shared meter block length. Must match METER_FIELDS in worklet-backend.ts.
#define BK_METER_FIELDS 192

// Engine head: 0..3 peak inL/inR/outL/outR, 4..7 rms inL/inR/outL/outR.
#define BK_METER_PEAK_IN_L 0
#define BK_METER_PEAK_IN_R 1
#define BK_METER_PEAK_OUT_L 2
#define BK_METER_PEAK_OUT_R 3
#define BK_METER_RMS_IN_L 4
#define BK_METER_RMS_IN_R 5
#define BK_METER_RMS_OUT_L 6
#define BK_METER_RMS_OUT_R 7

// Loop deck. Must match LOOP_METER_BASE / LOOP_METER_STRIDE / LOOP_TRACKS in backend.ts.
#define BK_LOOP_TRACKS 4
#define BK_LOOP_METER_STRIDE 8
#define BK_LOOP_METER_BASE 68

// Transport, then Smart Voice. Derived exactly as backend.ts derives them, so the
// derivation itself is what gets verified rather than a hand-copied total.
#define BK_TRANSPORT_METER_BASE (BK_LOOP_METER_BASE + BK_LOOP_TRACKS * BK_LOOP_METER_STRIDE)
#define BK_TRANSPORT_METER_FIELDS 8
#define BK_VOICE_METER_BASE (BK_TRANSPORT_METER_BASE + BK_TRANSPORT_METER_FIELDS)
#define BK_VOICE_METER_STRIDE 12
// The voice block is the stride, then 3 live attack bands, then the class->pad map (4).
#define BK_VOICE_METER_FIELDS (BK_VOICE_METER_STRIDE + 3 + 4)

// One past the last field any current writer touches. New blocks start HERE.
#define BK_METER_USED (BK_VOICE_METER_BASE + BK_VOICE_METER_FIELDS)

// ---------------------------------------------------------------- scope ring

// Must match SCOPE_SIZE in worklet-backend.ts. Masked, so it must stay a power of two.
#define BK_SCOPE_SIZE 8192
// What `pollScope` asks for, and therefore the most a consumer may draw. See ScopeFrame
// `frames` in backend.ts — reading past the filled window is the bug fixed in 6c.
#define BK_SCOPE_WINDOW 1024

// ---------------------------------------------------------------- block sizes

// Render quantum the JS engine is driven at. The native host will run smaller blocks in
// exclusive mode, but parity tests drive both at this size so results are comparable.
#define BK_WEB_QUANTUM 128

#endif  // BROKODR_LAYOUT_H
