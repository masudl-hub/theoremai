import {
	Children,
	cloneElement,
	type FocusEvent,
	type MouseEvent,
	type ReactElement,
	useId,
	useState,
} from 'react';

export type InkTooltipProps = {
	label: string;
	children: ReactElement;
	/** Prefer showing above the control when space is tight near the footer. */
	placement?: 'top' | 'bottom';
};

/**
 * Clean ink tooltip for run/live chrome — monospace label, zero radius, no card chrome.
 * Wraps a single interactive child and mirrors its disabled state.
 */
export function InkTooltip({ label, children, placement = 'top' }: InkTooltipProps) {
	const tipId = useId();
	const [open, setOpen] = useState(false);
	const child = Children.only(children) as ReactElement<{
		'aria-describedby'?: string;
		disabled?: boolean;
		onBlur?: (event: FocusEvent) => void;
		onFocus?: (event: FocusEvent) => void;
		onMouseEnter?: (event: MouseEvent) => void;
		onMouseLeave?: (event: MouseEvent) => void;
	}>;
	const disabled = Boolean(child.props.disabled);

	const show = () => {
		if (!disabled && label.trim()) setOpen(true);
	};
	const hide = () => setOpen(false);

	const trigger = cloneElement(child, {
		'aria-describedby': open ? tipId : child.props['aria-describedby'],
		onBlur: (event: FocusEvent) => {
			child.props.onBlur?.(event);
			hide();
		},
		onFocus: (event: FocusEvent) => {
			child.props.onFocus?.(event);
			show();
		},
		onMouseEnter: (event: MouseEvent) => {
			child.props.onMouseEnter?.(event);
			show();
		},
		onMouseLeave: (event: MouseEvent) => {
			child.props.onMouseLeave?.(event);
			hide();
		},
	});

	return (
		<span className={['ink-tooltip', open ? 'ink-tooltip--open' : ''].filter(Boolean).join(' ')}>
			{trigger}
			{open ? (
				<span
					id={tipId}
					className={['ink-tooltip__label', `ink-tooltip__label--${placement}`].join(' ')}
					role="tooltip"
				>
					{label}
				</span>
			) : null}
		</span>
	);
}
