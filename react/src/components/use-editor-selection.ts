import { type RefObject, useEffect, useState } from 'react';

/** Text currently selected inside `ref` (a contenteditable), or '' when the selection is elsewhere. */
export function useEditorSelection(ref: RefObject<HTMLElement | null>): string {
	const [selected, setSelected] = useState('');
	useEffect(() => {
		const read = () => {
			const root = ref.current;
			const selection = document.getSelection();
			const inside =
				root && selection && selection.rangeCount > 0 && root.contains(selection.getRangeAt(0).commonAncestorContainer);
			setSelected(inside ? selection.toString() : '');
		};
		document.addEventListener('selectionchange', read);
		return () => document.removeEventListener('selectionchange', read);
	}, [ref]);
	return selected;
}
