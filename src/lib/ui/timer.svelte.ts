// Global running timer. Survives reloads via localStorage; stop() hands the
// rounded span to the zeiterfassung page through `lastStopped`.
import { stoppedTimes, type StoppedTimer } from './timer-math';

const KEY = 'bookie.timer';

type Persisted = {
	running: boolean;
	startedAt: string | null;
	description: string;
	customerId: string;
	projectId: string;
};

export type StoppedEntry = StoppedTimer & Pick<Persisted, 'description' | 'customerId' | 'projectId'>;

const idle = (): Persisted => ({ running: false, startedAt: null, description: '', customerId: '', projectId: '' });

function load(): Persisted {
	try {
		const raw = localStorage.getItem(KEY);
		if (raw) return { ...idle(), ...JSON.parse(raw) };
	} catch {
		/* no storage / bad JSON: start idle */
	}
	return idle();
}

class Timer {
	#s = $state<Persisted>(load());
	/** Set by stop(); consumed by /zeiterfassung?fromTimer=1. */
	lastStopped = $state<StoppedEntry | null>(null);

	get running() { return this.#s.running; }
	get startedAt() { return this.#s.startedAt; }
	get description() { return this.#s.description; }
	set description(v: string) { this.#s.description = v; this.#persist(); }
	get customerId() { return this.#s.customerId; }
	set customerId(v: string) { this.#s.customerId = v; this.#persist(); }
	get projectId() { return this.#s.projectId; }
	set projectId(v: string) { this.#s.projectId = v; this.#persist(); }

	#persist() {
		try {
			localStorage.setItem(KEY, JSON.stringify(this.#s));
		} catch {
			/* storage unavailable: timer just won't survive a reload */
		}
	}

	start() {
		if (this.#s.running) return;
		this.#s.running = true;
		this.#s.startedAt = new Date().toISOString();
		this.#persist();
	}

	stop(): StoppedEntry | null {
		if (!this.#s.running || !this.#s.startedAt) return null;
		const { description, customerId, projectId } = this.#s;
		this.lastStopped = { ...stoppedTimes(new Date(this.#s.startedAt), new Date()), description, customerId, projectId };
		this.discard();
		return this.lastStopped;
	}

	discard() {
		this.#s = idle();
		this.#persist();
	}
}

export const timer = new Timer();
