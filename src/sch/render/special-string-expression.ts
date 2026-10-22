// Special strings written as expressions: =Copy(DocumentName, 1, Length(DocumentName) - 7) or
// ='Sheet ' + SheetNumber + ' of ' + SheetTotal. Names are parameters; strings are quoted with '
// (doubled to escape); + joins when either side is text and adds numbers otherwise.

type Value = string | number

const FUNCTIONS: Record<string, (args: Value[]) => Value> = {
	copy: ([s, index, count]) => {
		const text = String(s ?? "")
		const start = Math.max(0, Math.trunc(Number(index ?? 1)) - 1)
		return text.substr(start, Math.max(0, Math.trunc(Number(count ?? text.length))))
	},
	length: ([s]) => String(s ?? "").length,
	uppercase: ([s]) => String(s ?? "").toUpperCase(),
	lowercase: ([s]) => String(s ?? "").toLowerCase(),
	trim: ([s]) => String(s ?? "").trim(),
	pos: ([sub, s]) => String(s ?? "").indexOf(String(sub ?? "")) + 1,
	inttostr: ([n]) => String(Math.trunc(Number(n))),
	strtoint: ([s]) => Math.trunc(Number(s)),
}

// The expression's value, or undefined when it does not parse or names something unknown.
export function evaluateSpecialString(expression: string, lookup: (name: string) => string | undefined): string | undefined {
	const tokens = tokenize(expression)
	if (!tokens) return undefined
	let at = 0
	const peek = () => tokens[at]
	const fail = (): never => {
		throw new Error("bad expression")
	}
	const expect = (t: string) => (tokens[at] === t ? at++ : fail())

	const sum = (): Value => {
		let left = product()
		while (peek() === "+" || peek() === "-") {
			const op = tokens[at++]
			const right = product()
			if (op === "+") left = typeof left === "string" || typeof right === "string" ? `${left}${right}` : left + right
			else left = asNumber(left) - asNumber(right)
		}
		return left
	}
	const product = (): Value => {
		let left = unary()
		while (peek() === "*" || peek() === "/") {
			const op = tokens[at++]
			const right = asNumber(unary())
			left = op === "*" ? asNumber(left) * right : right === 0 ? fail() : Math.trunc(asNumber(left) / right)
		}
		return left
	}
	const unary = (): Value => (peek() === "-" ? (at++, -asNumber(unary())) : primary())
	const primary = (): Value => {
		const t = tokens[at++] ?? fail()
		if (t === "(") {
			const v = sum()
			expect(")")
			return v
		}
		if (t.startsWith("'")) return t.slice(1, -1).replaceAll("''", "'")
		if (/^\d/.test(t)) return Number(t)
		if (!/^[A-Za-z_]/.test(t)) fail()
		if (peek() === "(") {
			const fn = FUNCTIONS[t.toLowerCase()] ?? fail()
			at++
			const args: Value[] = []
			if (peek() !== ")")
				for (;;) {
					args.push(sum())
					if (peek() !== ",") break
					at++
				}
			expect(")")
			return fn(args)
		}
		return lookup(t) ?? fail()
	}

	try {
		const value = sum()
		return at === tokens.length ? String(value) : undefined
	} catch {
		return undefined
	}
}

// A parameter's text used as a number (SheetNumber "3"); text that is not one makes it fail.
function asNumber(v: Value): number {
	const n = typeof v === "number" ? v : Number(v.trim())
	if (!Number.isFinite(n)) throw new Error("not a number")
	return n
}

function tokenize(s: string): string[] | null {
	const out: string[] = []
	const re = /\s*(?:('(?:[^']|'')*')|(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|([-+*/(),]))/y
	let at = 0
	while (at < s.length) {
		if (/^\s*$/.test(s.slice(at))) break
		re.lastIndex = at
		const m = re.exec(s)
		if (!m) return null
		out.push(m[1] ?? m[2] ?? m[3] ?? m[4]!)
		at = re.lastIndex
	}
	return out
}
