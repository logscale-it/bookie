// Pure helpers for the running timer (kept rune-free so bun test can import them).

const pad = (n: number) => String(n).padStart(2, '0');

/** Elapsed ms → "hh:mm:ss" (hours may exceed 24). */
export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

export type StoppedTimer = { date: string; startTime: string; endTime: string };

/**
 * Timer span → entry fields in local time, rounded to the minute. A span
 * shorter than a minute still books one; a span past midnight is capped at
 * 24:00 on the start day.
 */
// ponytail: multi-day spans are capped, not split; split into per-day entries if that ever matters.
export function stoppedTimes(startedAt: Date, stoppedAt: Date): StoppedTimer {
	const start = new Date(startedAt);
	start.setSeconds(start.getSeconds() + 30, 0); // round to nearest minute
	start.setSeconds(0, 0);
	const date = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
	const dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
	const startMin = Math.round((start.getTime() - dayStart) / 60000);
	const endMin = Math.min(24 * 60, Math.max(startMin + 1, Math.round((stoppedAt.getTime() - dayStart) / 60000)));
	const hm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
	return { date, startTime: hm(startMin), endTime: hm(endMin) };
}
