import SendIcon from '@expo/material-symbols/send.xml';
import { useServices } from '@/components/app-shell/services-provider';
import { SegmentedGroup, SegmentListFormElement } from '@/components/foundation/segmented-list';
import { SettingsPage } from '@/components/layout/settings-page';
import type { WatchSyncResult } from '@/services/watch-sync/watch-sync-service';
import { TranslationKey, useTranslate } from '@tolgee/react';
import { useState } from 'react';
import { ActivityIndicator } from 'react-native';

const failureText: Record<Exclude<WatchSyncResult, { ok: true }>['reason'], TranslationKey> = {
  unsupported: 'garmin.watch.result.unsupported',
  sdk: 'garmin.watch.result.sdk',
  'no-watch': 'garmin.watch.result.no_watch',
  'send-failed': 'garmin.watch.result.send_failed',
  'no-reply': 'garmin.watch.result.no_reply',
  rejected: 'garmin.watch.result.rejected',
  error: 'garmin.watch.result.error',
};

export default function GarminWatchPage() {
  const { t } = useTranslate();
  const { watchSyncService, logger } = useServices();
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<WatchSyncResult>();

  const send = async () => {
    setSending(true);
    setResult(undefined);
    try {
      const outcome = await watchSyncService.sendProgramme();
      if (!outcome.ok) {
        logger.error('Send plan to watch failed', outcome);
      }
      setResult(outcome);
    } finally {
      setSending(false);
    }
  };

  const status = result
    ? result.ok
      ? t('garmin.watch.result.sent', { watch: result.watch })
      : `${t(failureText[result.reason])}${result.detail ? ` (${result.detail})` : ''}`
    : t('garmin.watch.send.body');

  return (
    <SettingsPage title={t('garmin.watch.title')} caption={t('garmin.watch.subtitle')}>
      <SegmentedGroup>
        <SegmentListFormElement
          label={t('garmin.watch.send.button')}
          icon={SendIcon}
          systemImage="paperplane"
          supportingText={status}
          testID="garmin-send-programme"
          onPress={sending ? undefined : () => void send()}
          right={sending ? <ActivityIndicator /> : undefined}
        />
      </SegmentedGroup>
    </SettingsPage>
  );
}
