import { HStack } from '@astryxdesign/core/HStack';
import { Selector, type SelectorProps } from '@astryxdesign/core/Selector';
import { StackItem } from '@astryxdesign/core/Stack';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';

const CompactContext = createContext(false);

/** The footer's controls scroll inside their room when even their icons do not fit. */
const ROW_SCROLL: CSSProperties = { minWidth: 0, overflowX: 'auto', scrollbarWidth: 'thin' };

/**
 * The room the composer's footer row leaves its controls: the row's content box, less the send
 * cluster beside them and the gap between.
 * why: Astryx wraps `footerActions` in a box that cannot shrink below its content, so the
 * controls take a measured `max-width`, which also caps what they ask of that box.
 */
function footerRoom(controls: HTMLElement): number | null {
  const row = controls.parentElement?.parentElement;
  const send = row?.lastElementChild;
  if (!row || !(send instanceof HTMLElement) || send === controls.parentElement) return null;
  const style = getComputedStyle(row);
  const inner =
    row.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
  return Math.max(0, inner - send.offsetWidth - (Number.parseFloat(style.columnGap) || 0));
}

/**
 * The composer's footer controls. Their labels fold to icons, each with its name and value in a
 * tooltip, when the labels do not fit the row; if the icons do not fit either, the row scrolls.
 * `fit` names what the controls show: when it changes they unfold and measure again.
 */
export function ComposerControls(props: { fit: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [room, setRoom] = useState<number | null>(null);
  // invariant: The width the labels need, measured when they last overflowed; null while they fit.
  const [needed, setNeeded] = useState<{ fit: string; width: number } | null>(null);
  const [, remeasure] = useReducer((n: number) => n + 1, 0);
  const compact = needed !== null && needed.fit === props.fit && (room ?? 0) < needed.width;

  useLayoutEffect(() => {
    const el = ref.current;
    const row = el?.parentElement?.parentElement;
    if (!el || !row) return;
    const observer = new ResizeObserver(remeasure);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = footerRoom(el);
    if (next !== room) {
      setRoom(next);
      return;
    }
    if (!compact && el.scrollWidth > el.clientWidth) {
      setNeeded({ fit: props.fit, width: el.scrollWidth });
    }
  });

  return (
    <CompactContext.Provider value={compact}>
      <HStack
        ref={ref}
        gap={1}
        style={room === null ? ROW_SCROLL : { ...ROW_SCROLL, maxWidth: room }}
      >
        {props.children}
      </HStack>
    </CompactContext.Provider>
  );
}

const NO_VALUE = () => null;

/**
 * A footer selector. Folded, it shows only its icon, and a tooltip gives its name and value; the
 * name stays its accessible label either way.
 */
export function ComposerSelector(selector: SelectorProps) {
  const compact = useContext(CompactContext);
  const value = selector.value;
  return (
    // why: A static item keeps its natural width, so the row folds or scrolls instead of
    // squeezing a value to an ellipsis and its icon to nothing.
    <StackItem size="static">
      <Tooltip
        isEnabled={compact}
        content={value ? `${selector.label}: ${value}` : selector.label}
        hasHoverIndication={false}
      >
        <Selector {...selector} renderValue={compact ? NO_VALUE : selector.renderValue} />
      </Tooltip>
    </StackItem>
  );
}
