// "<library>[/<table>]\<item>": how a BOM document keys a library item (undefined when unknown).
export function libraryItem(library: string | undefined, table: string | undefined, item: string | undefined): string | undefined {
	if (!library || !item) return undefined
	return `${library}${table ? `/${table}` : ""}\\${item}`
}
