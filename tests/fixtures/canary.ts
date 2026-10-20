/**
 * Token characters short of a leak run (16): enough to open a canary leak the
 * gate holds, too few to be a leak on their own. Tests that split a leak
 * across chunks cut it here.
 */
export const CANARY_OPENING = 12;
