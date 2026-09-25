declare const Deno: {
	cwd(): string;
	readDir(path: string): AsyncIterable<{ name: string }>;
	remove(path: string): Promise<void>;
	stat(path: string): Promise<{ size?: number }>;
	mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
	writeTextFile(path: string, data: string, options?: { append?: boolean; mode?: number }): Promise<void>;
};
