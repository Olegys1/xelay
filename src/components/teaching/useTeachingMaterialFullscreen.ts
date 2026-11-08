import { useEffect, useRef, useState, type RefObject } from 'react'
import { createTeachingMaterialFullscreen, type MaterialFullscreenState } from '../../lib/teachingMaterialFullscreen'

export function useTeachingMaterialFullscreen(surface: RefObject<HTMLDivElement | null>, button: RefObject<HTMLButtonElement | null>) {
  const [state, setState] = useState<MaterialFullscreenState>({ expanded: false, native: false })
  const controller = useRef<ReturnType<typeof createTeachingMaterialFullscreen> | null>(null)
  useEffect(() => {
    const own = createTeachingMaterialFullscreen({ document: window.document, target: () => surface.current, change: setState,
      restoreFocus: () => { if (button.current?.isConnected) button.current.focus() } })
    controller.current = own
    return () => { if (controller.current === own) controller.current = null; own.dispose() }
  }, [surface, button])
  return { ...state, toggle: () => controller.current?.toggle(), leave: () => controller.current?.leave(), escape: () => controller.current?.escape() || false }
}
