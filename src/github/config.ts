// The site is made for one account's designs: it reads these repos (public, so no sign-in is needed)
// and nothing else. A token, if pasted, only lifts GitHub's per-visitor request limit.
export const OWNER = "shivam6279"
export const REPOS: readonly string[] = ["PCB"]

export function defaultOwner(): string {
	return OWNER
}
