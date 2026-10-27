import { passageQuestions } from './researcher.ts';

/** The researcher registers its tools and profiles as it loads, and exports how it runs its turns. */
export const entry = './researcher.ts';

/** The page reader asks one question per passage in the state it is given. */
export const questions = { 'research.pagereader': passageQuestions };
