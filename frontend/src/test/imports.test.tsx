import { describe, expect, it } from 'vitest';
import * as Primitives from '../components/Primitives';
import * as Evidence from '../components/Evidence';
import * as Tx from '../components/Tx';
import * as TheSeal from '../components/TheSeal';
import * as Guilloche from '../components/Guilloche';
import * as Reveal from '../components/Reveal';
import * as Toast from '../components/Toast';

// Every named import RecordDetail makes, asserted to actually be defined.
// React's "Element type is invalid" error names no component, so this checks the
// imports themselves rather than hunting through a render tree.
describe('RecordDetail imports', () => {
  it('has every primitive it renders', () => {
    for (const name of [
      'ConfidenceMeter',
      'EmptyState',
      'ErrorNotice',
      'OutcomeBadge',
      'Skeleton',
      'VerdictBadge',
    ] as const) {
      expect(Primitives[name], `Primitives.${name}`).toBeDefined();
    }
  });

  it('has every evidence component it renders', () => {
    for (const name of ['AddressLine', 'KeyValue', 'SourceList'] as const) {
      expect(Evidence[name], `Evidence.${name}`).toBeDefined();
    }
  });

  it('has every tx component it renders', () => {
    for (const name of ['CopyButton', 'TxLink', 'TxStatusPanel'] as const) {
      expect(Tx[name], `Tx.${name}`).toBeDefined();
    }
  });

  it('has the seal, the reveal and the toast', () => {
    expect(TheSeal.TheSeal, 'TheSeal.TheSeal').toBeDefined();
    expect(Guilloche.Guilloche, 'Guilloche.Guilloche').toBeDefined();
    expect(Reveal.Reveal, 'Reveal.Reveal').toBeDefined();
    expect(Toast.ToastProvider, 'Toast.ToastProvider').toBeDefined();
    expect(Toast.useToast, 'Toast.useToast').toBeDefined();
  });
});
