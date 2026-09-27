/**
 * pi-rewind picker layout — how many checkpoint rows the dialog may show.
 *
 * Why this exists: pi-tui renders only the **last** `terminal.rows` lines of
 * the document (`TuiMainScreen.render()`: `viewportStart = max(0, height -
 * terminal.rows)`), so a dialog taller than the terminal loses its top. pi's
 * built-in extension selector renders one row per option and never scrolls
 * (`ExtensionSelectorComponent.updateList()`), which means a long checkpoint
 * list pushes the title — and the `→` cursor row the dialog opens on — off the
 * top of the screen, leaving the user with no visible cursor.
 *
 * The picker therefore sizes its window to the terminal and scrolls instead.
 * The rows it must leave alone are named here, in one place:
 *
 *   - `PICKER_CHROME_ROWS`: the dialog's own non-list lines — top border,
 *     title, key hint, bottom border, plus `SelectList`'s `(12/37)` line that
 *     only appears while the list is scrolled. One row of slack is included so
 *     a surprising extra line (a truncated hint that still wraps) cannot push
 *     the title out of view.
 *   - `PICKER_TAIL_RESERVE_ROWS`: what pi renders **below** the editor
 *     container, which is where the custom component lives — the footer
 *     (`🅼 model | Ctx …`), the extra statusline rows, and any
 *     `placement: belowEditor` widget such as pi-subagents' fleet line. Those
 *     rows are painted after the dialog and would otherwise cover its bottom.
 */

/** Lines the picker dialog spends outside the list. */
export const PICKER_CHROME_ROWS = 6;
/** Lines to leave for what pi paints below the editor container. */
export const PICKER_TAIL_RESERVE_ROWS = 4;
/** Upper bound, so the picker does not take over a tall terminal. */
export const PICKER_MAX_LIST_ROWS = 20;
/** Assumed height when the host cannot report a terminal size. */
export const DEFAULT_TERMINAL_ROWS = 24;

/** Rows the picker dialog can show, for a terminal height that may be unknown. */
export function pickerListRows(terminalRows: number | undefined): number {
  const available = resolveTerminalRows(terminalRows) - PICKER_CHROME_ROWS - PICKER_TAIL_RESERVE_ROWS;
  return Math.max(1, Math.min(PICKER_MAX_LIST_ROWS, available));
}

/** Terminal height with the non-TTY cases folded into a usable number. */
export function resolveTerminalRows(terminalRows: number | undefined): number {
  if (typeof terminalRows !== "number" || !Number.isFinite(terminalRows) || terminalRows <= 0) {
    return DEFAULT_TERMINAL_ROWS;
  }
  return Math.floor(terminalRows);
}
