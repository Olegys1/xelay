export async function translateText(
  text: string,
  targetLanguage: string,
  questionId?: string,
  answerId?: string
) {
  if (!text) return text;

  try {
    const response = await fetch("/api/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        targetLanguage,
        questionId,
        answerId,
      }),
    });

    if (!response.ok) {
      throw new Error("Translation failed");
    }

    const data = await response.json();

    return data.translation || text;
  } catch (err) {
    console.error(err);
    return text;
  }
}