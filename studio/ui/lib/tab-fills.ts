type TabPress = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'preventDefault' | 'shiftKey'
>;

/**
 * Tab in an empty field takes its placeholder up as the text, to edit rather than retype. Only for a
 * placeholder that is a value (an example, or the default it stands for); anywhere else Tab moves on.
 */
export function tabFills(
  value: string,
  placeholder: string | undefined,
  onChange: (next: string) => void,
) {
  return (event: TabPress) => {
    if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey)
      return;
    if (value !== '' || !placeholder) return;
    event.preventDefault();
    onChange(placeholder);
  };
}
