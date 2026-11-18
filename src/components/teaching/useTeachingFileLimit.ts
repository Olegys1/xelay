import { useEffect, useState } from 'react'
import type { TeachingRepository } from '../../lib/teaching'
import { TEACHING_FREE_FILE_BYTES, TEACHING_LIBRARY_MAX_FILE_BYTES } from '../../lib/teachingFileLimits'

export function useTeachingFileLimit(repository: TeachingRepository, userId: string) {
  const [state, setState] = useState({ userId: '', bytes: TEACHING_FREE_FILE_BYTES })
  useEffect(() => {
    let current = true
    void repository.fileUploadLimit?.().then(bytes => {
      if (current) setState({ userId, bytes: Number.isSafeInteger(bytes) && bytes >= TEACHING_FREE_FILE_BYTES && bytes <= TEACHING_LIBRARY_MAX_FILE_BYTES ? bytes : TEACHING_FREE_FILE_BYTES })
    }).catch(() => { if (current) setState({ userId, bytes: TEACHING_FREE_FILE_BYTES }) })
    return () => { current = false }
  }, [repository, userId])
  return state.userId === userId ? state.bytes : TEACHING_FREE_FILE_BYTES
}
