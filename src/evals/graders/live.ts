import type { EvalGrader } from '../types.ts';
import { codeGrader, deliveredText, passFail } from './shared.ts';

const OUTPUT_TRANSCRIPTION = 'output_transcription';

/** Graders for the transcript of a live model's spoken output. */
interface TranscriptionGraders {
  includes: (text?: string) => EvalGrader;
  regex: (pattern?: string, flags?: string) => EvalGrader;
}

/** Graders for a live reply's output transcription: `includes` (a substring) and `regex`, each taking its pattern as an argument or from the case's `expect.transcription`. */
const transcription: TranscriptionGraders = {
  includes(text?: string): EvalGrader {
    const identity = `transcription.includes:${text ?? 'case'}`;
    return codeGrader('transcription_includes', identity, text === undefined, (trial) => {
      const want = text ?? trial.case?.expect?.transcription?.includes;
      if (want === undefined) {
        return passFail(
          'transcription_includes',
          false,
          'case has no expect.transcription.includes',
        );
      }
      const passed = deliveredText(trial, OUTPUT_TRANSCRIPTION).includes(want);
      return passFail(
        'transcription_includes',
        passed,
        passed
          ? `transcript includes ${JSON.stringify(want)}`
          : `transcript lacks ${JSON.stringify(want)}`,
      );
    });
  },
  regex(pattern?: string, flags = ''): EvalGrader {
    const identity = `transcription.regex:${pattern === undefined ? 'case' : `/${pattern}/${flags}`}`;
    return codeGrader('transcription_regex', identity, pattern === undefined, (trial) => {
      const source = pattern ?? trial.case?.expect?.transcription?.regex;
      if (source === undefined) {
        return passFail('transcription_regex', false, 'case has no expect.transcription.regex');
      }
      const passed = new RegExp(source, flags).test(deliveredText(trial, OUTPUT_TRANSCRIPTION));
      return passFail(
        'transcription_regex',
        passed,
        passed
          ? `transcript matches /${source}/${flags}`
          : `transcript does not match /${source}/${flags}`,
      );
    });
  },
};

/** A grader that passes when the model was interrupted at most `max` times in the trial. */
function interruptions(options: { max: number }): EvalGrader {
  return codeGrader('interruptions', `interruptions:${options.max}`, false, (trial) => {
    const count = trial
      .spans('generate_content')
      .filter((span) => span.attributes['theorem.stop.kind'] === 'interrupted').length;
    const passed = count <= options.max;
    return passFail(
      'interruptions',
      passed,
      `${count} interruption(s); at most ${options.max} allowed`,
    );
  });
}

export type { TranscriptionGraders };
export { interruptions, transcription };
