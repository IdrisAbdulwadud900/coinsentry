import { InlineKeyboard } from "grammy";

/** Single "Refresh" button, used on any message that can be re-rendered in place. */
export function refreshButton(callbackData: string): InlineKeyboard {
  return new InlineKeyboard().text("🔄 Refresh", callbackData);
}

/** Top-level menu shown after /start: Status, Dead Tokens, Performance. */
export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📊 Status", "status:refresh")
    .row()
    .text("💀 Dead Tokens", "dead:0:all")
    .row()
    .text("🚀 Performance", "performance:refresh");
}

/** Refresh button for the /performance leaderboard. */
export function performanceKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🔄 Refresh", "performance:refresh");
}

export type DeadListFilter = "all" | "grad" | "ungrad";

const NEXT_FILTER: Record<DeadListFilter, DeadListFilter> = { all: "grad", grad: "ungrad", ungrad: "all" };
const FILTER_LABEL: Record<DeadListFilter, string> = { all: "All", grad: "🎓 Graduated", ungrad: "🌱 Ungraduated" };

/** Paginated dead-tokens list keyboard: Prev/Next (omitted at boundaries), a graduation
 * filter toggle, and a refresh button. */
export function deadListKeyboard(page: number, totalPages: number, filter: DeadListFilter = "all"): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  const hasPrev = page > 0;
  const hasNext = page < totalPages - 1;
  if (hasPrev) keyboard.text("◀️ Prev", `dead:${page - 1}:${filter}`);
  if (hasNext) keyboard.text("▶️ Next", `dead:${page + 1}:${filter}`);
  if (hasPrev || hasNext) keyboard.row();

  keyboard.text(`Filter: ${FILTER_LABEL[filter]}`, `dead:0:${NEXT_FILTER[filter]}`).row();
  keyboard.text("🔄 Refresh", `dead:${page}:${filter}`);

  return keyboard;
}
