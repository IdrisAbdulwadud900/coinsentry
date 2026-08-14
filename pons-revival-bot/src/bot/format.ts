export function formatAgo(ts: number | undefined): string {
  if (ts == null) return "never";
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

export function formatDeadDuration(statusChangedAt: number): string {
  const hours = (Date.now() - statusChangedAt) / (1000 * 60 * 60);
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours % 24);
  return `${days}d ${rem}h`;
}

export function formatUsd(value: number | null): string {
  if (value == null) return "n/a";
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
