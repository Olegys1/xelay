export function participantMessageError(error: unknown): string {
  const value = error as { code?: string; message?: string }
  if (['PGRST202', 'PGRST205', '42P01', '42883'].includes(value?.code || '')) return 'Нові можливості ще підключаються. Спробуйте пізніше.'
  const message = value?.message || ''
  const translations: Record<string, string> = {
    PARTICIPANT_REQUIRED: 'Ця можливість доступна з активною підпискою «Учасник».',
    SCHEDULE_WORKER_UNAVAILABLE: 'Відкладена відправка тимчасово недоступна. Ваш текст не надіслано.',
    SCHEDULE_INVALID_INPUT: 'Оберіть час від 1 хвилини до 90 днів уперед і додайте текст до 5000 символів.',
    SCHEDULE_LIMIT: 'Можна мати до 50 відкладених повідомлень. Скасуйте непотрібне.',
    SCHEDULE_CLOSED: 'Це повідомлення вже надіслано або скасовано. Оновіть список.',
    SCHEDULE_NOT_FOUND: 'Це відкладене повідомлення більше не доступне.',
    SCHEDULE_ID_CONFLICT: 'Не вдалося підтвердити цю відправку. Оновіть список перед повторною спробою.',
    SCHEDULE_CONFIRM_LIMIT: 'Спершу підтвердьте попередні відкладені відправки, збереження яких не вдалося перевірити.',
    CHAT_AUTH_REQUIRED: 'Увійдіть у профіль, щоб продовжити.',
    CHAT_AUTH_CHANGED: 'Акаунт змінився. Відкрийте чат знову перед відправкою.',
    CHAT_MEMBER_REQUIRED: 'Ви більше не маєте доступу до цього чату.',
    CHAT_CONNECTION_REQUIRED: 'Для відправки потрібен прийнятий запит на спілкування.',
    CHAT_INVALID_REPLY: 'Повідомлення, на яке ви відповідаєте, більше не доступне.',
    CHAT_INVALID_INPUT: 'Перевірте фільтри пошуку.',
  }
  for (const [code, text] of Object.entries(translations)) if (message.includes(code)) return text
  return 'Не вдалося виконати дію. Перевірте з’єднання та спробуйте ще раз.'
}
