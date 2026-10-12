import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useDirectAccessStatus from '../hooks/useDirectAccessStatus.js';
import { isNativeIOS } from '../native.js';
import { directAccessTransport } from '../sync/directAccessTransport.js';

/**
 * On iPhone and iPad the Direct Access bookmark is of a file, not a folder:
 * the Files providers (Nextcloud, Drive, Dropbox) cannot hand over a folder
 * (DirectAccessBridge.swift). So the household roster and the intents event
 * set are bookmarked files of their own, and each is picked (the one another
 * device already created) or created (a first device) from the settings
 * section that uses it: the roster from Multi-user, the event set from the
 * Direct Access intents opt-in. Renders nothing off iOS, and nothing until a
 * sync file is connected, since the folder tree is the same one.
 *
 * @param {{slot: 'users'|'events'}} props
 */
const DirectAccessFileRow = ({ slot, darkMode, textPrimary, textSecondary, borderClass, transport = directAccessTransport }) => {
  const { t } = useTranslation();
  const status = useDirectAccessStatus(transport);
  const [busy, setBusy] = useState(false);
  if (!isNativeIOS() || !status.supported || !status.connected) return null;
  const file = slot === 'users' ? status.roster : status.events;
  if (!file) return null;

  const run = (fn) => async () => {
    setBusy(true);
    try { await fn(); }
    finally { setBusy(false); }
  };
  const pick = run(() => (slot === 'users' ? transport.pickUsersFile() : transport.pickEventsFile()));
  const create = run(() => (slot === 'users' ? transport.createUsersFile() : transport.createEventsFile()));
  const forget = run(() => (slot === 'users' ? transport.forgetUsersFile() : transport.forgetEventsFile()));
  const k = slot === 'users' ? 'roster' : 'events';
  const button = `px-3 py-1.5 text-sm rounded-lg border ${borderClass} ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-stone-100'} ${textPrimary} disabled:opacity-50`;

  return (
    <div className={`rounded-lg border ${borderClass} p-3 space-y-2`}>
      <p className={`text-xs ${textSecondary}`}>{t(slot === 'users' ? 'directAccess.iosRosterHint' : 'directAccess.iosEventsHint')}</p>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className={`text-xs ${textPrimary}`} title={file.path ?? undefined}>
          {file.configured ? t(`directAccess.${k}Chosen`, { name: file.name }) : t(`directAccess.${k}NotChosen`)}
        </p>
        <div className="flex gap-2">
          {file.configured ? (
            <>
              <button type="button" onClick={pick} disabled={busy} className={button}>{t(`directAccess.${k}Change`)}</button>
              <button type="button" onClick={forget} disabled={busy} className={button}>{t(`directAccess.${k}Forget`)}</button>
            </>
          ) : (
            <>
              <button type="button" onClick={pick} disabled={busy} className={button}>{t(`directAccess.${k}Choose`)}</button>
              <button type="button" onClick={create} disabled={busy} className={button}>{t(`directAccess.${k}Create`)}</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default DirectAccessFileRow;
