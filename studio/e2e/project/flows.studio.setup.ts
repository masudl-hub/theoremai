/** The project the studio's browser test opens: every kind of agent, on the fake model. */
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

export const host = (_request: Request, actingAs?: { person: { id: string } }) => ({
  person: actingAs?.person.id ?? 'no one',
});

export const people = {
  places: [
    { id: 'north', label: 'North' },
    { id: 'south', label: 'South' },
  ],
  existing: (place: string) => [{ id: `${place}-ana`, label: `Ana of ${place}` }],
};
