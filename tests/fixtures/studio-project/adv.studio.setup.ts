export const entry = './app.ts';

export const questions = {
  triage: {
    next: {
      type: 'choice',
      instructions: 'Choose the safest next step.',
      criteria: { ask: 'Ask the person first.', act: 'Go ahead.' },
    },
  },
};
