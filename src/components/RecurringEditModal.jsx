import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDayPlannerCtx } from '../context/DayPlannerContext.jsx';

// Asked when the task editor saves a change to one occurrence of a recurring
// series (#2042): the change is for that occurrence or for every occurrence.
// The editor stays open underneath; cancelling returns to it.
const RecurringEditModal = () => {
  const {
    recurringEditConfirm, setRecurringEditConfirm,
    cardBg, borderClass, textPrimary, textSecondary, darkMode, hoverBg,
    saveMobileEditTask,
  } = useDayPlannerCtx();

  const { t } = useTranslation();

  if (!recurringEditConfirm) return null;

  const optionClass = `w-full text-left px-4 py-2.5 rounded-lg ${darkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-stone-100 hover:bg-stone-200'} ${textPrimary}`;

  return (
        // z-[90]: above the task editor (z-80) it is spawned from, like
        // RecurringDeleteModal.
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[90]" onClick={() => setRecurringEditConfirm(null)} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRecurringEditConfirm(null); } }} tabIndex={-1} ref={(el) => el && el.focus()}>
          <div
            className={`${cardBg} rounded-lg shadow-xl p-6 ${borderClass} border max-w-sm w-full mx-4`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 rounded-full bg-blue-100 dark:bg-blue-900/30">
                <RefreshCw size={20} className="text-blue-600 dark:text-blue-400" />
              </div>
              <h3 className={`text-lg font-semibold ${textPrimary}`}>{t('modal.editRecurring')}</h3>
            </div>
            <p className={`${textSecondary} mb-4`}>
              {t('modal.editRecurringMessage')}
            </p>
            <div className="flex flex-col gap-2">
              <button type="button" onClick={() => saveMobileEditTask('this')} className={optionClass}>
                <div className="font-medium">{t('modal.editThisOccurrence')}</div>
                <div className={`text-xs ${textSecondary}`}>{t('modal.editThisOccurrenceHint', { date: recurringEditConfirm.dateStr })}</div>
              </button>
              <button type="button" onClick={() => saveMobileEditTask('all')} className={optionClass}>
                <div className="font-medium">{t('modal.editAllOccurrences')}</div>
                <div className={`text-xs ${textSecondary}`}>{t('modal.editAllOccurrencesHint')}</div>
              </button>
              <button
                type="button"
                onClick={() => setRecurringEditConfirm(null)}
                className={`w-full px-4 py-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-stone-200'} ${textPrimary} ${hoverBg} mt-1`}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
  );
};

export default RecurringEditModal;
