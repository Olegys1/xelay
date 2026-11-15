import { AssistantCloudError, createAssistantCloudClient } from './assistant-v2/cloudClient'
import { supabase } from './supabase'
import { prepareTeachingTestImage } from './teachingTestQuestionImages'

export type TeachingQuestionAiScope = { courseId: string; userId: string }

export async function recognizeTeachingQuestionSource(scope: TeachingQuestionAiScope, source: { text: string; photo?: File }, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!source.photo && (source.text.length > 12000 || new TextEncoder().encode(source.text).length > 20000)) {
    throw new Error('Для ШІ залиште до 12 000 символів або поділіть документ на менші частини.')
  }
  const payload = source.photo ? { image: await prepareTeachingTestImage(source.photo, 1280) } : { sourceText: source.text }
  signal.throwIfAborted()
  const assistant = createAssistantCloudClient({
    currentUserId: () => scope.userId,
    async session() {
      const { data, error } = await supabase.auth.getSession()
      return !error && data.session ? { userId: data.session.user.id, accessToken: data.session.access_token } : null
    },
  })
  try {
    return await assistant.previewTestQuestions(scope.courseId, payload, signal)
  } catch (failure) {
    if (failure instanceof AssistantCloudError && failure.code === 'model_not_connected') {
      throw new Error('Розпізнавання з ШІ зараз недоступне. Ви можете продовжити звичайний імпорт.')
    }
    throw failure
  }
}
