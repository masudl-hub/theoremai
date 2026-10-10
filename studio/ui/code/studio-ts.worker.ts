import { initialize } from 'monaco-editor/internal/common/initialize';
import { TypeScriptWorker } from 'monaco-editor/languages/features/typescript/tsWorker';

/**
 * The package declarations are resolved when the file imports them. They are
 * not compilation roots: a root is typechecked, and that is what held the
 * memory.
 */
class StudioTypeScriptWorker extends TypeScriptWorker {
	override getScriptFileNames(): string[] {
		return super.getScriptFileNames().filter((name) => name.startsWith('file:///agent'));
	}
}

const scope = self as unknown as { onmessage: (event: MessageEvent) => void };
scope.onmessage = () => {
	initialize((ctx, createData) => new StudioTypeScriptWorker(ctx, createData));
};
