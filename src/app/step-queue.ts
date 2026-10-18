// Quarter turns (Q / E, the view cube's arrows) queue: the view keeps turning while any are waiting and
// comes to rest square on the last one, however fast they are pressed.

export interface Step<K extends string = string> {
	key: K // what it turns about: steps about the same thing can cancel or add up
	dir: 1 | -1
}

// The queue holds at most this many, the running one first. Four quarter turns are a whole turn, so past
// that the waiting ones about the same axis are counted modulo four (five clockwise: just one).
export const MAX_STEPS = 4

export function queueStep<K extends string>(queue: Step<K>[], step: Step<K>) {
	queue.push(step)
	if (queue.length <= MAX_STEPS) return
	const waiting = queue.slice(1)
	if (waiting.some(s => s.key !== step.key)) {
		queue.pop() // turns about different axes don't commute: no room, so this one is dropped
		return
	}
	const net = waiting.reduce((n, s) => n + s.dir, 0) % MAX_STEPS
	queue.length = 1
	for (let k = 0; k < Math.abs(net); k++) queue.push({ key: step.key, dir: net > 0 ? 1 : -1 })
}

// In quarter turns per second (squared): a lone quarter takes 2·√(1/ACCEL) ≈ 0.35 s, speeding up then
// braking; a run of them cruises at TOP_SPEED.
const ACCEL = 32
const TOP_SPEED = 5

// One run of quarter turns about one axis, as a position in quarters from where the run began. It is
// driven by speed, not a fixed curve: it speeds up toward the last quarter queued and brakes only as
// late as it can to stop exactly there, so a press that comes mid-turn moves the end further on without
// the turn ever slowing in between. A quarter leaves the queue the moment it has been turned through.
export class QuarterTurns<K extends string> {
	readonly queue: Step<K>[] = []
	key: K | null = null // the run's axis (the head's)
	private p = 0
	private v = 0
	private done = 0 // quarters completed this run, signed

	push(step: Step<K>) {
		queueStep(this.queue, step)
	}

	clear() {
		this.queue.length = 0
		this.key = null
	}

	// Starts a run from rest, about the head's axis. False with nothing queued.
	begin(): boolean {
		this.key = this.queue[0]?.key ?? null
		this.p = this.v = this.done = 0
		return this.key !== null
	}

	// Where the run comes to rest: the steps about its axis, from the head on.
	private target() {
		let t = this.done
		for (const s of this.queue) {
			if (s.key !== this.key) break
			t += s.dir
		}
		return t
	}

	// Moves on by dt seconds. ended: at rest on the target, the run's steps gone from the queue (anything
	// left is about another axis and needs a new run).
	advance(dt: number): { quarters: number; ended: boolean } {
		const goal = this.target()
		const d = goal - this.p
		const want = Math.sign(d) * Math.min(TOP_SPEED, Math.sqrt(2 * ACCEL * Math.abs(d)))
		this.v += Math.max(-ACCEL * dt, Math.min(ACCEL * dt, want - this.v))
		const before = this.p
		this.p += this.v * dt
		// Quarters turned through leave the queue.
		for (let head = this.queue[0]; head && head.key === this.key; head = this.queue[0]) {
			const mark = this.done + head.dir
			if ((this.p - mark) * head.dir < 0) break
			this.queue.shift()
			this.done = mark
		}
		// At (or just past) the end and slow: rest exactly on it.
		const crossed = (goal - before) * (goal - this.p) <= 0
		if ((crossed && Math.abs(this.v) < 2 * Math.sqrt(2 * ACCEL * 0.02)) || (Math.abs(goal - this.p) < 1e-3 && Math.abs(this.v) < 0.05)) {
			this.p = goal
			this.v = 0
			while (this.queue[0]?.key === this.key) this.queue.shift() // any left netted out (a Q against an E)
			this.done = goal
			return { quarters: goal, ended: true }
		}
		return { quarters: this.p, ended: false }
	}
}
