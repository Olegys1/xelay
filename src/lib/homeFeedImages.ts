type ObjectUrlApi = Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>

/** Preview URLs belong to the selected files, not to every render. */
export function createHomeImagePreviews<T extends Blob>(files: T[], api: ObjectUrlApi = URL) {
  const previews: Array<{ file: T; url: string }> = []
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    previews.forEach(({ url }) => api.revokeObjectURL(url))
  }
  try {
    files.forEach((file) => previews.push({ file, url: api.createObjectURL(file) }))
  } catch (error) {
    dispose()
    throw error
  }
  return { previews, dispose }
}
