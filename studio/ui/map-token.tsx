import { Icon, type IconType } from '@astryxdesign/core/Icon';
import { Token, type TokenColor } from '@astryxdesign/core/Token';
import { type HTMLAttributes, type RefObject, useLayoutEffect, useState } from 'react';
import './map-token.css';

export interface MapTokenProps extends Omit<HTMLAttributes<HTMLDivElement>, 'id' | 'color'> {
	id: string;
	label: string;
	icon?: IconType | undefined;
	/** The left side, and the middle from the top. */
	x: number;
	y: number;
	color?: TokenColor | undefined;
	description?: string | undefined;
	onOpen?: (() => void) | undefined;
}

export function MapToken({ id, label, icon, x, y, color, description, onOpen, className, style, ...rest }: MapTokenProps) {
	return (
		<div
			{...rest}
			className={className ? `map-token ${className}` : 'map-token'}
			data-map-token={id}
			style={{ ...style, left: x, top: y }}
		>
			<Token
				size="sm"
				label={label}
				icon={icon && <Icon icon={icon} size="sm" />}
				{...(color === undefined ? {} : { color })}
				{...(description === undefined ? {} : { description })}
				{...(onOpen === undefined ? {} : { onClick: onOpen })}
			/>
		</div>
	);
}

/** Each token's width under `root`, by id, measured again whenever `drawn` changes. */
export function useTokenWidths(root: RefObject<HTMLElement | null>, drawn: unknown): Record<string, number> {
	const [widths, setWidths] = useState<Record<string, number>>({});
	useLayoutEffect(() => {
		const next: Record<string, number> = {};
		for (const each of root.current?.querySelectorAll<HTMLElement>('[data-map-token]') ?? []) {
			next[each.dataset.mapToken ?? ''] = each.offsetWidth;
		}
		setWidths((last) =>
			Object.keys(next).length === Object.keys(last).length && Object.entries(next).every(([id, width]) => last[id] === width)
				? last
				: next,
		);
	}, [root, drawn]);
	return widths;
}
