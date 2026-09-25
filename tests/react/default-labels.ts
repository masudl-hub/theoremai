import { IntlMessageFormat } from 'intl-messageformat';
import { type LabelText, THEOREM_UI_CATALOG } from '../../react/src/ui/labels.ts';

/** The default UI's words, formatted as Astryx's translator formats them, without React. */
export const defaultLabels: LabelText = (key, values) =>
  String(new IntlMessageFormat(THEOREM_UI_CATALOG[key].defaultMessage, 'en').format(values));
