'use client';
// Full-screen New request / Edit / Needs-attention editor (spec §8 New request, v2.1 A22–A24):
//   ?new=1                       → mode 'new'
//   ?r=<id>&edit=person|friend|all → mode 'edit' (prefilled, sends only changed keys with the base version)
//   ?outbox=<mutationId>         → mode 'outbox' (fix and resend a needs-attention item, same mutationId):
//                                  prefill formValuesFromCreateBody(item.payload); photos read-only; point at
//                                  the rejected field with errors={formErrorsFromField(item.lastError?.field,
//                                  item.lastError.message)}; save with
//                                  actions.outbox.update(id, toCreateBody(values, id)) then outbox.resend(id)
// PLACEHOLDER (Phase 1a): the exported name and props are FINAL; F (Phase 2) builds it with the draft.
import { Text } from '@radix-ui/themes';
import { useState } from 'react';
import { goBack } from '@/lib/client/nav';
import { EMPTY_FORM_VALUES, canSend, type RequestFormValues } from '@/lib/client/form-values';
import { useActions } from '@/lib/client/store-contract';
import type { EditSection, PhotoTiming } from '@/lib/domain';
import type { DraftPhoto } from '@/lib/client/store-contract';
import { RequestForm } from './RequestForm';

export type RequestFormViewProps =
  | { mode: 'new' }
  | { mode: 'edit'; id: string; section: EditSection }
  | { mode: 'outbox'; mutationId: string };

export function RequestFormView(props: RequestFormViewProps) {
  const actions = useActions();
  const [values, setValues] = useState<RequestFormValues>({ ...EMPTY_FORM_VALUES });
  const [photos, setPhotos] = useState<DraftPhoto[]>([]);
  const [timing, setTiming] = useState<PhotoTiming>('today');
  const [busy, setBusy] = useState(false);
  const [clientMutationId] = useState(() => crypto.randomUUID());

  return (
    <div style={{ minHeight: '100dvh' }}>
      <Text as="div" size="3" weight="medium" style={{ padding: 16, textAlign: 'center' }}>
        {props.mode === 'new' ? 'New request' : props.mode === 'edit' ? 'Edit request' : 'Not sent'}
      </Text>
      <RequestForm
        mode={props.mode === 'new' ? 'create' : props.mode}
        section={props.mode === 'edit' ? props.section : 'all'}
        values={values}
        onChange={setValues}
        photos={photos}
        onPhotosChange={setPhotos}
        photoTiming={timing}
        onPhotoTimingChange={setTiming}
        offline={false}
        busy={busy}
        submitLabel="Send request"
        submitDisabled={props.mode !== 'new' || !canSend(values, photos.length)}
        onSubmit={async () => {
          if (props.mode !== 'new') return;
          setBusy(true);
          const result = await actions.create({ values, clientMutationId, photos, photoTiming: timing });
          setBusy(false);
          if (result.outcome === 'sent' || result.outcome === 'queued') goBack({});
        }}
        onCancel={() => goBack({})}
      />
    </div>
  );
}
