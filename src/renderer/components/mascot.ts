/**
 * The Codeep mascot, for the terminal.
 *
 * The pixel creature from `Codeep Maskot.svg`, redrawn with half blocks
 * (`▀ ▄ ▌ ▐ █`): one terminal cell holds two pixels stacked vertically, so the
 * whole creature fits in 16 columns × 7 lines. Line 0 is the top of the eyes;
 * line 1 holds the pupils and is the ONLY line the frames change, which is
 * what lets the intro make it glance around and blink by swapping one row.
 *
 * Every line is exactly MASCOT_WIDTH code units and columns (all glyphs are
 * single-width BMP characters), so `.length` doubles as the display width.
 */
import { LOGO_LINES } from './uiConstants';

export const MASCOT_WIDTH = 16;
export const MASCOT_HEIGHT = 7;

/** Columns between the mascot and the wordmark when drawn side by side. */
export const MASCOT_GAP = 3;

const IDLE: readonly string[] = [
  ' █▀▀▀▀█  █▀▀▀▀█ ',
  ' █ ██ ████ ██ █ ',
  ' █▄▄▄▄████▄▄▄▄█ ',
  '████████████████',
  '▀▀▀██████████▀▀▀',
  '   ██████████   ',
  '   ███    ███   ',
];

/** The idle body with a different pupil row (line 1). */
const withPupils = (pupils: string): readonly string[] => [IDLE[0], pupils, ...IDLE.slice(2)];

/** Mascot frames, one string per terminal line. */
export const MASCOT_FRAMES = {
  idle: IDLE,
  lookLeft: withPupils(' █▐█▌ ████▐█▌ █ '),
  lookRight: withPupils(' █ ▐█▌████ ▐█▌█ '),
  blink: withPupils(' █ ▄▄ ████ ▄▄ █ '),
} as const;

/**
 * Horizontal placement of the wordmark, with the mascot to its left when it
 * fits. Shared by the intro and the static logo so both lay out the same way.
 */
export interface LogoLayout {
  /** Column of the mascot, or null when the terminal is too narrow for it. */
  mascotX: number | null;
  /** Column of the CODEEP wordmark. */
  logoX: number;
  /** Line of the wordmark below the top of the block (1 beside the mascot, so
   *  its 6 lines sit on mascot lines 1..6; 0 without it). */
  logoDy: number;
  /** Height of the whole block in lines. */
  height: number;
}

/**
 * Lay out the mascot + wordmark pair centred as one unit in `width` columns.
 *
 * Below `mascot + gap + wordmark + 4` columns the mascot is dropped and the
 * wordmark is centred on its own, exactly as before the mascot existed.
 */
export function layoutLogoWithMascot(width: number): LogoLayout {
  const logoWidth = LOGO_LINES[0].length;
  const pairWidth = MASCOT_WIDTH + MASCOT_GAP + logoWidth;
  if (width < pairWidth + 4) {
    return { mascotX: null, logoX: Math.max(0, Math.floor((width - logoWidth) / 2)), logoDy: 0, height: LOGO_LINES.length };
  }
  const mascotX = Math.floor((width - pairWidth) / 2);
  return { mascotX, logoX: mascotX + MASCOT_WIDTH + MASCOT_GAP, logoDy: 1, height: MASCOT_HEIGHT };
}

/** Each glance holds 1/GLANCE_STEPS of the decrypt phase: 250 ms of the App's 1.5 s. */
const GLANCE_STEPS = 6;
/** How long the closing blink lasts. */
const BLINK_MS = 150;
const GLANCES = [MASCOT_FRAMES.idle, MASCOT_FRAMES.lookLeft, MASCOT_FRAMES.idle, MASCOT_FRAMES.lookRight];

/**
 * Mascot frame at `elapsedMs` into the intro's decrypt phase: pupils step
 * centre → left → centre → right, hold centre, then one blink in the last
 * BLINK_MS as the wordmark finishes decrypting. Idle outside the phase.
 *
 * Steps scale with `decryptMs`, so a shorter decrypt still gets its centre
 * hold before the blink instead of cutting the right glance short.
 */
export function introMascotFrame(elapsedMs: number, decryptMs: number): readonly string[] {
  if (elapsedMs < 0 || elapsedMs >= decryptMs) return MASCOT_FRAMES.idle;
  if (elapsedMs >= decryptMs - BLINK_MS) return MASCOT_FRAMES.blink;
  return GLANCES[Math.floor((elapsedMs * GLANCE_STEPS) / decryptMs)] ?? MASCOT_FRAMES.idle;
}
