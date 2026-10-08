import type { SVGProps } from 'react';

/**
 * Geometry of `public/favicon.svg`: the tile's 24×24 mark, translated by the
 * favicon's own `(4 4)` inset. The tile's black rect is the page, so it is not drawn.
 */
export const THEOREM_MARK = {
	rise: 'M4.5 18.5c2 0 3-1.2 4.2-3.4l2.6-5c1-1.9 2.1-3.1 4.2-3.1',
	fall: 'M5.5 8.2c1.6-.9 3.2-.4 3.8 1.6l2.3 6.6c.6 1.7 2.1 2.4 3.9 1.7',
	dot: { cx: 19.5, cy: 4.5, r: 1.6 },
} as const;

export type TheoremMarkProps = SVGProps<SVGSVGElement> & {
	/** Stroke and dot paint. The boot and nav loaders pass white; the rail uses currentColor. */
	ink?: string;
};

/** The favicon mark. Strokes draw in order, then the dot lands. */
export function TheoremMark({ ink = 'currentColor', className, ...props }: TheoremMarkProps) {
	const { cx, cy, r } = THEOREM_MARK.dot;
	return (
		<svg
			viewBox="0 0 32 32"
			className={className ? `theorem-mark ${className}` : 'theorem-mark'}
			aria-hidden
			{...props}
		>
			<g transform="translate(4 4)" fill="none" stroke={ink} strokeWidth={2} strokeLinecap="round">
				{/* Hidden on the element itself so the first paint has no caps and no dot.
				    The draw animation reveals each stroke only once it has length. */}
				<path
					className="theorem-mark-stroke"
					pathLength={1}
					strokeDasharray={1}
					strokeDashoffset={1}
					opacity={0}
					d={THEOREM_MARK.rise}
				/>
				<path
					className="theorem-mark-stroke theorem-mark-stroke-late"
					pathLength={1}
					strokeDasharray={1}
					strokeDashoffset={1}
					opacity={0}
					d={THEOREM_MARK.fall}
				/>
				<circle
					className="theorem-mark-dot"
					cx={cx}
					cy={cy}
					r={r}
					fill={ink}
					stroke="none"
					opacity={0}
				/>
			</g>
		</svg>
	);
}

/** The mark as an icon beside Tabler's glyphs: drawn whole and still, in the current colour. */
export function IconTheorem(props: SVGProps<SVGSVGElement>) {
	const { cx, cy, r } = THEOREM_MARK.dot;
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			aria-hidden
			{...props}
		>
			<path d={THEOREM_MARK.rise} />
			<path d={THEOREM_MARK.fall} />
			<circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
		</svg>
	);
}
