/**
 * The first frame, before any stylesheet has loaded: the shell is already the full-bleed panel the
 * mark draws in. A document that shows the boot mark puts `data-boot-pending` on `<html>` and this
 * in an inline `<style>`. Literal colours: nothing of the theme has loaded yet.
 */
export const BOOT_PAINT =
	'html{color-scheme:dark}html,body{margin:0;background:#000}html[data-boot-pending],html[data-boot-pending] body{background:#262626}html[data-boot-pending] .astryx-app-shell{height:100dvh}html[data-boot-pending] .astryx-app-shell-sidenav{position:absolute;inset-block:0;inset-inline-start:0;z-index:0;width:3rem}html[data-boot-pending] #astryx-app-shell-main{position:relative;z-index:1;width:100%;height:100%;max-width:none;margin:0;border-radius:0;clip-path:none;background:#262626;color:#fff}html[data-boot-pending] #astryx-app-shell-main>:not([data-boot]){visibility:hidden}html[data-boot-pending] [data-boot]{position:absolute;inset:0;z-index:2;display:grid;place-items:center;background:#262626;color:#fff}';

/** Without scripts nothing lifts the cover, so the page shows at once. Goes in a `<noscript>` style. */
export const BOOT_PAINT_NOSCRIPT =
	'html[data-boot-pending],html[data-boot-pending] body{background:#000}html[data-boot-pending] #astryx-app-shell-main>:not([data-boot]){visibility:visible !important}[data-boot]{display:none !important}';
