/**
 * All inline-button callback_data strings used by the bot, in one place, so producers
 * and parsers can never drift apart. Format is always colon-separated: `namespace:action:...ids`.
 */

export const cb = {
  addCoin: () => "addcoin",
  watchlist: (page: number) => `watchlist:${page}`,
  help: () => "help",
  settingsOpen: () => "settings:open",
  mainMenu: () => "mainmenu",

  tokenCard: (tokenId: number) => `token:card:${tokenId}`,
  tokenCancel: () => "token:cancel",
  tokenAddRuleMcap: (tokenId: number) => `token:rule:mcap:${tokenId}`,
  tokenAddRulePrice: (tokenId: number) => `token:rule:price:${tokenId}`,
  tokenAddRuleLiquidity: (tokenId: number) => `token:rule:liq:${tokenId}`,
  tokenAddRuleTrend: (tokenId: number) => `token:rule:trend:${tokenId}`,
  tokenAddRulePercent: (tokenId: number) => `token:rule:pct:${tokenId}`,
  tokenViewRules: (watchId: number) => `watch:rules:${watchId}`,
  tokenRemove: (watchId: number) => `watch:remove:${watchId}`,

  ruleDirBelow: () => "dir:below",
  ruleDirAbove: () => "dir:above",
  ruleTrendUp: () => "trend:up",
  ruleTrendDown: () => "trend:down",
  ruleTrendDefault: () => "trend:default",
  ruleTrendCustom: () => "trend:custom",
  ruleModeOneShot: () => "mode:one_shot",
  ruleModeRepeating: () => "mode:repeating",
  confirmYes: () => "confirm:yes",
  confirmEdit: () => "confirm:edit",
  confirmCancel: () => "confirm:cancel",

  rulePause: (ruleId: number) => `rule:pause:${ruleId}`,
  ruleResume: (ruleId: number) => `rule:resume:${ruleId}`,
  ruleDelete: (ruleId: number) => `rule:delete:${ruleId}`,
  ruleDisable: (ruleId: number) => `rule:disable:${ruleId}`,
  ruleRearm: (ruleId: number) => `rule:rearm:${ruleId}`,

  settingsQuietHours: () => "settings:quiet",
  settingsTimezone: () => "settings:tz",
};

export function parseIdSuffix(data: string): number | null {
  const parts = data.split(":");
  const last = parts[parts.length - 1];
  const id = last ? Number(last) : NaN;
  return Number.isFinite(id) ? id : null;
}
