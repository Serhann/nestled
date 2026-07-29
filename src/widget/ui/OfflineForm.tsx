import { useState } from 'react';
import type { Copy } from '../copy';
import { FormRenderer } from './FormRenderer';

/**
 * "Leave us a message" — the path when nobody is around and no AI will answer.
 *
 * Posts to `/api/v1/widget/offline-message`, which creates the conversation,
 * stores the message and emails the team in one call. Deliberately NOT the
 * ordinary create-then-send pair: this is the one flow where the visitor closes
 * the tab immediately afterwards, so it must not be able to half-succeed.
 */
export function OfflineForm({
  copy,
  onSubmit,
}: {
  copy: Copy;
  onSubmit(email: string, message: string): Promise<boolean>;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'failed'>('idle');

  if (state === 'sent') {
    return (
      <div className="n-body">
        <div className="n-grow" />
        <p className="n-hero-title" style={{ textAlign: 'center' }}>
          {copy.offlineSent}
        </p>
        <div className="n-grow" />
      </div>
    );
  }

  return (
    <div className="n-body">
      <FormRenderer
        heading={copy.offlineHeading}
        description={copy.offlineBody}
        submitLabel={copy.offlineSubmit}
        busy={state === 'busy'}
        fields={[
          { name: 'email', label: copy.offlineEmailLabel, type: 'email', required: true },
          { name: 'message', label: copy.offlineMessageLabel, type: 'textarea', required: true },
        ]}
        onSubmit={(values) => {
          setState('busy');
          void onSubmit(values.email, values.message).then((ok) => setState(ok ? 'sent' : 'failed'));
        }}
      />
      {state === 'failed' && <p className="n-error">{copy.genericError}</p>}
    </div>
  );
}
