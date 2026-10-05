declare module "occt-import-js" {
	const factory: (options?: { locateFile?: (path: string) => string }) => Promise<any>
	export default factory
}
