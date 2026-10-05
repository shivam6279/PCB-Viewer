import "fake-indexeddb/auto"
import { expect, test } from "vitest"
import { addRecent, isGitRecent, listRecents } from "./recents"

const handle = (name: string) => ({ name, kind: "directory" }) as unknown as FileSystemDirectoryHandle

test("recents are newest first, deduped, capped at 8", async () => {
	await addRecent({ name: "A", prjPath: "A.PrjPcb", handle: handle("A"), openedAt: 1 })
	await addRecent({ name: "B", prjPath: "B.PrjPcb", handle: handle("B"), openedAt: 2 })
	await addRecent({ name: "A", prjPath: "A.PrjPcb", handle: handle("A"), openedAt: 3 })
	expect((await listRecents()).map(r => [r.name, r.openedAt])).toEqual([["A", 3], ["B", 2]])
	for (let i = 0; i < 10; i++) await addRecent({ name: `P${i}`, prjPath: null, handle: handle(`P${i}`), openedAt: 10 + i })
	expect(await listRecents()).toHaveLength(8)
})

test("a GitHub project keeps one entry, at the commit last opened", async () => {
	const gh = (sha: string, openedAt: number) => ({ name: "Cubli", github: { owner: "o", repo: "PCB", sha, prjPath: "Cubli/Cubli.PrjPcb" }, openedAt })
	await addRecent(gh("aaa", 100))
	await addRecent(gh("bbb", 101))
	const mine = (await listRecents()).filter(isGitRecent)
	expect(mine.map(r => r.github.sha)).toEqual(["bbb"])
})
