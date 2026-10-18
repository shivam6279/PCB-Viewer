import { describe, expect, it } from "vitest"
import { MAX_STEPS, QuarterTurns, queueStep, type Step } from "./step-queue"

const press = (queue: Step[], ...dirs: (1 | -1)[]) => {
	for (const dir of dirs) queueStep(queue, { key: "z", dir })
	return queue.map(s => s.dir)
}

describe("queueStep", () => {
	it("keeps up to four, the running one first", () => {
		expect(press([], 1, 1, 1, 1)).toEqual([1, 1, 1, 1])
	})

	it("past four, counts the waiting ones modulo four", () => {
		expect(press([], 1, 1, 1, 1, 1)).toEqual([1]) // five clockwise: one
		expect(press([], 1, 1, 1, 1, 1, 1)).toEqual([1, 1])
		expect(press([], -1, -1, -1, -1, -1, -1, -1)).toEqual([-1, -1, -1])
	})

	it("opposite turns waiting cancel once it collapses", () => {
		expect(press([], 1, 1, -1, 1, 1)).toEqual([1, 1, 1]) // waiting +1 -1 +1 +1 = 2
	})

	it("never holds more than four", () => {
		const q: Step[] = []
		for (let k = 0; k < 50; k++) {
			queueStep(q, { key: "z", dir: k % 3 === 0 ? -1 : 1 })
			expect(q.length).toBeLessThanOrEqual(MAX_STEPS)
		}
	})

	it("drops a step about another axis when full", () => {
		const q: Step[] = []
		for (let k = 0; k < 4; k++) queueStep(q, { key: "x", dir: 1 })
		queueStep(q, { key: "y", dir: 1 })
		expect(q.map(s => s.key)).toEqual(["x", "x", "x", "x"])
	})
})

// Presses at the given times (s), stepped at 60 fps until at rest: where it is each frame.
function simulate(presses: { at: number; dir: 1 | -1 }[]) {
	const q = new QuarterTurns<"z">()
	const dt = 1 / 60
	const path: number[] = []
	let running = false
	for (let t = 0, k = 0; t < 10; t += dt) {
		while (k < presses.length && presses[k]!.at <= t) {
			q.push({ key: "z", dir: presses[k++]!.dir })
			if (!running) running = q.begin()
		}
		if (!running) {
			if (k >= presses.length) break
			continue
		}
		const { quarters, ended } = q.advance(dt)
		path.push(quarters)
		if (ended) running = false
	}
	return { path, queue: q.queue }
}

describe("QuarterTurns", () => {
	it("a lone press turns one quarter and rests on it in about a third of a second", () => {
		const { path } = simulate([{ at: 0, dir: 1 }])
		expect(path.at(-1)).toBe(1)
		expect(path.length / 60).toBeGreaterThan(0.25)
		expect(path.length / 60).toBeLessThan(0.5)
	})

	it("presses mid-turn never let it slow to a stop before the last one", () => {
		const { path, queue } = simulate([{ at: 0, dir: 1 }, { at: 0.2, dir: 1 }, { at: 0.35, dir: 1 }])
		expect(path.at(-1)).toBe(3)
		expect(queue).toEqual([])
		// From the first press until near the end, it keeps moving at a good pace.
		const speeds = path.slice(1).map((p, i) => (p - path[i]!) * 60)
		const cruising = speeds.slice(8, speeds.length - 8)
		expect(Math.min(...cruising)).toBeGreaterThan(2)
	})

	it("a quarter leaves the queue the moment it is turned through", () => {
		const q = new QuarterTurns<"z">()
		q.push({ key: "z", dir: 1 })
		q.push({ key: "z", dir: 1 })
		q.begin()
		let out = 0
		while (q.queue.length === 2) out = q.advance(1 / 60).quarters
		expect(out).toBeGreaterThanOrEqual(1)
		expect(out).toBeLessThan(1.2)
	})

	it("comes back when the other way is pressed, and rests square", () => {
		const { path } = simulate([{ at: 0, dir: 1 }, { at: 0.05, dir: -1 }])
		expect(path.at(-1)).toBe(0)
		const { path: back } = simulate([{ at: 0, dir: 1 }, { at: 0.1, dir: -1 }, { at: 0.12, dir: -1 }])
		expect(back.at(-1)).toBe(-1)
	})
})
