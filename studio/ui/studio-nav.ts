/** Where the website is. A studio running on its own sends its other pages there. */
export const THEOREM_SITE = 'https://theorem.masudlewis.com';

/** The website's pages, in the rail's order. */
export const SITE_PAGES = [
	{ label: 'Studio', href: '/studio' },
	{ label: 'Docs', href: '/docs' },
] as const;

/** Where the package is published, in the rail's order. */
export function packageLinks(name: string, repository: string) {
	return [
		{ label: 'GitHub', href: repository },
		{ label: 'JSR', href: `https://jsr.io/${name}` },
		{ label: 'npm', href: `https://www.npmjs.com/package/${encodeURIComponent(name)}` },
	] as const;
}

export type PackageLinks = ReturnType<typeof packageLinks>;
