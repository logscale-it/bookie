/** Net minutes between two clock times (minutes since midnight); end < start means the end is on the next day. */
export function spanMinutes(
	startMinutes: number,
	endMinutes: number,
	pauseMinutes: number,
): number {
	if (endMinutes < startMinutes) endMinutes += 24 * 60;
	return endMinutes - startMinutes - pauseMinutes;
}
