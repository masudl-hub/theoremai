import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { HStack } from '@astryxdesign/core/HStack';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { useState, useSyncExternalStore } from 'react';
import { reachesOthers, sharedAsk } from '../mod.ts';
import { askLine } from './file-place.tsx';
import type { StudioStore } from './lib/studio-store.ts';

const DIALOG_WIDTH = 520;

/**
 * The stop before a change to a value the project's files write once, or a change to a tool
 * other profiles allow: who else it changes and what other code reads it, and Cancel or Change for all. Closing the dialog is
 * Cancel, and no profile has the change.
 */
export function SharedChange({ store }: { store: StudioStore }) {
  const reach = useSyncExternalStore(store.subscribe, store.getPending, store.getPending);
  const [quiet, setQuiet] = useState(false);
  const ask = reach && sharedAsk(reach, store.getWorkspace());
  return (
    <Dialog
      isOpen={reach !== undefined}
      purpose="form"
      width={DIALOG_WIDTH}
      onOpenChange={(isOpen) => {
        if (!isOpen) store.cancelShared();
      }}
    >
      {ask && (
        <Layout
          header={<DialogHeader title={ask.title} subtitle={askLine(ask)} />}
          content={
            <LayoutContent>
              <CheckboxInput
                label="Don't ask again this session"
                value={quiet}
                onChange={setQuiet}
              />
            </LayoutContent>
          }
          footer={
            <LayoutFooter>
              <HStack gap={2} justify="end">
                <Button
                  label="Cancel"
                  variant="ghost"
                  onClick={() => {
                    store.cancelShared();
                  }}
                />
                <Button
                  label={reachesOthers(reach) ? 'Change for all' : 'Change'}
                  variant="primary"
                  onClick={() => {
                    store.confirmShared(quiet);
                  }}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      )}
    </Dialog>
  );
}
