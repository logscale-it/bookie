/// <reference types="bun" />
import { test, expect } from 'bun:test';
import { formatElapsed, stoppedTimes } from '../../../src/lib/ui/timer-math';

test('formatElapsed', () => {
	expect(formatElapsed(0)).toBe('00:00:00');
	expect(formatElapsed(3_723_900)).toBe('01:02:03');
	expect(formatElapsed(-5)).toBe('00:00:00');
});

test('stoppedTimes rounds to the minute', () => {
	const r = stoppedTimes(new Date(2026, 10, 1, 9, 14, 40), new Date(2026, 10, 1, 10, 2, 20));
	expect(r).toEqual({ date: '2026-11-01', startTime: '09:15', endTime: '10:02' });
});

test('stoppedTimes books at least one minute', () => {
	const r = stoppedTimes(new Date(2026, 10, 1, 9, 0, 0), new Date(2026, 10, 1, 9, 0, 10));
	expect(r.endTime).toBe('09:01');
});

test('stoppedTimes caps past midnight at 24:00', () => {
	const r = stoppedTimes(new Date(2026, 10, 1, 23, 0, 0), new Date(2026, 10, 2, 1, 0, 0));
	expect(r).toEqual({ date: '2026-11-01', startTime: '23:00', endTime: '24:00' });
});
