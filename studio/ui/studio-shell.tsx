/**
 * The shell the studio sits in: the icon rail on the black base, and the page beside it. The
 * website frames every page with these; the studio on its own frames its one page the same way.
 */
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { type DefinedTheme, Theme } from '@astryxdesign/core/theme';
import { IconBook2, IconBrandGithub, IconBrandNpm, IconPlayerPlay } from '@tabler/icons-react';
import { type ComponentProps, type ReactNode, type SVGProps, useEffect } from 'react';
import { type PackageLinks, SITE_PAGES } from './studio-nav.ts';
import { IconTheorem } from './theorem-mark.tsx';
import './studio-shell.css';

/**
 * JSR brand mark (from jsr.io's icon), filled in the current colour. It spans the
 * full 24-unit box, as Tabler's brand-npm does with its stroke, so Astryx's icon
 * sizing sets both at the same visual size.
 */
function IconJsr(props: SVGProps<SVGSVGElement>) {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
			<path d="M3.692 5.538v3.693H0v7.384h7.385v1.847h12.923v-3.693H24V7.385h-7.385V5.538Zm1.846 1.847h1.847v7.384H1.846v-3.692h1.846v1.846h1.846zm3.693 0h5.538V9.23h-3.692v1.846h3.692v5.538H9.231V14.77h3.692v-1.846H9.231Zm7.384 1.846h5.539v3.692h-1.846v-1.846h-1.846v5.538h-1.847z" />
		</svg>
	);
}

/**
 * Astryx link component for off-site destinations: opens in a new tab with no opener.
 * Astryx hands custom link components `to` alongside `href` (for routers); a plain anchor drops it.
 */
function NewTabLink({ to: _to, ...props }: ComponentProps<'a'> & { to?: string }) {
	return <a {...props} target="_blank" rel="noopener noreferrer" />;
}

/** The icon each of the rail's rows carries, by its label. */
export const PAGE_ICONS = { Studio: IconPlayerPlay, Docs: IconBook2 } as const;
export const PACKAGE_ICONS = { GitHub: IconBrandGithub, JSR: IconJsr, npm: IconBrandNpm } as const;

export interface StudioRailProps {
	/** The theme the page is drawn in. The rail is always its dark mode, so its icons read on black. */
	theme: DefinedTheme;
	/** The path of the page on screen, which picks the selected row. */
	pathname: string;
	/** Where the package is published. */
	packages: PackageLinks;
	/**
	 * The website's address, given when the studio runs away from it. The studio is then this
	 * page, and every other page opens on the website.
	 */
	site?: string;
	/** What sits at the foot of the rail. */
	footerIcons?: ReactNode;
}

/** The icon rail: the mark, the website's pages, and where the package is published. */
export function StudioRail({ theme, pathname, packages, site, footerIcons }: StudioRailProps) {
	const at = (href: string) => {
		if (site === undefined) return href;
		return href === '/studio' ? '/studio/' : `${site}${href}`;
	};
	return (
		<Theme theme={theme} mode="dark">
			<SideNav
				collapsible={{ isCollapsed: true, hasButton: false }}
				header={<SideNavHeading heading="theorem" headingHref={at('/')} icon={<IconTheorem width="1em" height="1em" />} />}
				footerIcons={footerIcons}
			>
				<SideNavSection title="Site" isHeaderHidden>
					{SITE_PAGES.map(({ label, href }) => (
						<SideNavItem
							key={href}
							label={label}
							href={at(href)}
							icon={PAGE_ICONS[label]}
							isSelected={pathname === href || pathname.startsWith(`${href}/`)}
							data-home-nav-anchor={href}
						/>
					))}
				</SideNavSection>
				<SideNavSection title="Packages" isHeaderHidden>
					{packages.map(({ label, href }) => (
						<SideNavItem
							key={href}
							label={label}
							href={href}
							icon={PACKAGE_ICONS[label]}
							as={NewTabLink}
							data-home-nav-anchor={href}
						/>
					))}
				</SideNavSection>
			</SideNav>
		</Theme>
	);
}

const MAIN_ID = 'astryx-app-shell-main';
const VARS = ['top', 'right', 'bottom', 'left'] as const;

/**
 * Publishes where the shell's page sits as `--shell-top|right|bottom|left` (distance from each
 * viewport edge). Popups live in the browser's top layer, which a clip cannot reach, so
 * studio-shell.css insets them to this box and the browser flips and shifts them inside it.
 */
export function ShellBounds() {
	useEffect(() => {
		const root = document.documentElement;
		const main = document.getElementById(MAIN_ID);
		if (!main) return;
		const measure = () => {
			const box = main.getBoundingClientRect();
			const edges = {
				top: box.top,
				right: globalThis.innerWidth - box.right,
				bottom: globalThis.innerHeight - box.bottom,
				left: box.left,
			};
			for (const edge of VARS)
				root.style.setProperty(`--shell-${edge}`, `${String(Math.max(0, edges[edge]))}px`);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(main);
		globalThis.addEventListener('resize', measure);
		/* The shell moves between pages without resizing; re-measure as a popup opens. */
		document.addEventListener('beforetoggle', measure, true);
		return () => {
			observer.disconnect();
			globalThis.removeEventListener('resize', measure);
			document.removeEventListener('beforetoggle', measure, true);
			for (const edge of VARS) root.style.removeProperty(`--shell-${edge}`);
		};
	}, []);
	return null;
}
