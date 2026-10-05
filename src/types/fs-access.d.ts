// File System Access API members that lib.dom does not declare yet.
interface FileSystemHandle {
	queryPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>
	requestPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>
}

interface DataTransferItem {
	getAsFileSystemHandle?(): Promise<FileSystemHandle | null>
}

interface Window {
	showDirectoryPicker?(options?: { mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>
}
