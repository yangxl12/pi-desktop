export interface PerformanceMetric {
	name: string;
	durationMs: number;
	startedAt: string;
	endedAt: string;
}

import type { PerformanceSnapshot } from "@earendil-works/pi-desktop-protocol";

export type { PerformanceSnapshot } from "@earendil-works/pi-desktop-protocol";

/** Small bounded metric collector for release baselines; it never stores payloads. */
export class PerformanceMetrics {
	private readonly samples = new Map<string, number[]>();
	private readonly maxSamples: number;

	constructor(maxSamples = 200) {
		this.maxSamples = Math.max(10, maxSamples);
	}

	measure<T>(name: string, task: () => Promise<T> | T): Promise<{ value: T; metric: PerformanceMetric }> {
		const started = performance.now();
		const startedAt = new Date().toISOString();
		return Promise.resolve()
			.then(task)
			.then((value) => {
				const metric = this.record(name, started, startedAt);
				return { value, metric };
			});
	}

	record(name: string, startedAtMs: number, startedAt = new Date().toISOString()): PerformanceMetric {
		const endedAtMs = performance.now();
		const durationMs = Math.max(0, endedAtMs - startedAtMs);
		const samples = this.samples.get(name) ?? [];
		samples.push(durationMs);
		while (samples.length > this.maxSamples) samples.shift();
		this.samples.set(name, samples);
		return { name, durationMs, startedAt, endedAt: new Date().toISOString() };
	}

	snapshot(name: string): PerformanceSnapshot {
		const samples = [...(this.samples.get(name) ?? [])].sort((a, b) => a - b);
		if (samples.length === 0) return { count: 0, lastMs: null, averageMs: null, p95Ms: null };
		const total = samples.reduce((sum, value) => sum + value, 0);
		return {
			count: samples.length,
			lastMs: this.samples.get(name)?.at(-1) ?? null,
			averageMs: total / samples.length,
			p95Ms: samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)],
		};
	}

	all(): Record<string, PerformanceSnapshot> {
		return Object.fromEntries([...this.samples.keys()].map((name) => [name, this.snapshot(name)]));
	}
}
