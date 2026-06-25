export async function translateText(
  text: string,
  targetLanguage: string
) {
  if (!text) {
    return ''
  }

  try {
    const response = await fetch(
      'https://translate.argosopentech.com/translate',
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
        },

        body: JSON.stringify({
          q: text,
          source: 'auto',
          target: targetLanguage,
          format: 'text',
        }),
      }
    )

    const data =
      await response.json()

    return (
      data.translatedText ||
      text
    )
  } catch (error) {
    console.error(
      'Translation error:',
      error
    )

    return text
  }
}