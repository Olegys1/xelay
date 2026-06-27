export async function translateText(
  text: string,
  targetLanguage: string
) {
  if (!text || targetLanguage === 'en') {
    return text
  }

  try {
    const response = await fetch(
      'https://libretranslate.com/translate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: text,
          source: 'auto',
          target: targetLanguage,
          format: 'text',
        }),
      }
    )

    if (!response.ok) {
      throw new Error('Translation failed')
    }

    const data = await response.json()

    return data.translatedText || text
  } catch (err) {
    console.error(err)
    return text
  }
}